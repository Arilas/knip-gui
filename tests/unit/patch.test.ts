import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatches, hashContent, hashFile, type FilePatch } from '../../src/fix/patch.js';
import { renderDiff } from '../../src/fix/diff.js';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'knip-gui-patch-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Seeds a fixture file for a test, creating parent directories as needed
// (fixture paths use nested dirs like 'src/foo.ts' under the tmp sandbox).
async function seedFile(absPath: string, content: string): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, content, 'utf8');
}

describe('hashContent / hashFile', () => {
  it('hashContent is deterministic and matches sha256 hex length', () => {
    const h1 = hashContent('hello world');
    const h2 = hashContent('hello world');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashContent('different')).not.toBe(h1);
  });

  it('hashFile roundtrips with hashContent for an existing file', async () => {
    await withTmpDir(async (dir) => {
      const file = join(dir, 'a.txt');
      await writeFile(file, 'roundtrip content', 'utf8');
      const fileHash = await hashFile(file);
      expect(fileHash).toBe(hashContent('roundtrip content'));
    });
  });

  it('hashFile returns null for a missing file', async () => {
    await withTmpDir(async (dir) => {
      const fileHash = await hashFile(join(dir, 'does-not-exist.txt'));
      expect(fileHash).toBeNull();
    });
  });
});

describe('applyPatches: modify', () => {
  it('writes exact new content when hashBefore matches', async () => {
    await withTmpDir(async (dir) => {
      const rel = 'src/foo.ts';
      const abs = join(dir, rel);
      await seedFile(abs, 'old content');

      const patch: FilePatch = {
        filePath: rel,
        kind: 'modify',
        hashBefore: hashContent('old content'),
        contentAfter: 'new content',
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toEqual([{ filePath: rel, ok: true }]);
      expect(await readFile(abs, 'utf8')).toBe('new content');
    });
  });

  it('detects staleness when the file was mutated between plan and apply, and leaves it untouched', async () => {
    await withTmpDir(async (dir) => {
      const rel = 'src/foo.ts';
      const abs = join(dir, rel);
      await seedFile(abs, 'original content');
      const staleHashBefore = hashContent('original content');

      // Simulate a concurrent edit after the patch was planned.
      await writeFile(abs, 'mutated content', 'utf8');

      const patch: FilePatch = {
        filePath: rel,
        kind: 'modify',
        hashBefore: staleHashBefore,
        contentAfter: 'new content',
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toEqual([{ filePath: rel, ok: false, reason: 'stale' }]);
      expect(await readFile(abs, 'utf8')).toBe('mutated content');
    });
  });

  it('reports missing when the target file no longer exists', async () => {
    await withTmpDir(async (dir) => {
      const rel = 'src/gone.ts';
      const patch: FilePatch = {
        filePath: rel,
        kind: 'modify',
        hashBefore: hashContent('whatever it used to be'),
        contentAfter: 'new content',
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toEqual([{ filePath: rel, ok: false, reason: 'missing' }]);
      expect(existsSync(join(dir, rel))).toBe(false);
    });
  });
});

describe('applyPatches: delete', () => {
  it('removes the file when hashBefore matches current content', async () => {
    await withTmpDir(async (dir) => {
      const rel = 'src/bye.ts';
      const abs = join(dir, rel);
      await seedFile(abs, 'delete me');

      const patch: FilePatch = {
        filePath: rel,
        kind: 'delete',
        hashBefore: hashContent('delete me'),
        contentAfter: null,
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toEqual([{ filePath: rel, ok: true }]);
      expect(existsSync(abs)).toBe(false);
    });
  });

  it('refuses to delete (stale) when hashBefore does not match current content', async () => {
    await withTmpDir(async (dir) => {
      const rel = 'src/bye.ts';
      const abs = join(dir, rel);
      await seedFile(abs, 'edited after plan');

      const patch: FilePatch = {
        filePath: rel,
        kind: 'delete',
        hashBefore: hashContent('original plan content'),
        contentAfter: null,
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toEqual([{ filePath: rel, ok: false, reason: 'stale' }]);
      expect(existsSync(abs)).toBe(true);
      expect(await readFile(abs, 'utf8')).toBe('edited after plan');
    });
  });
});

describe('applyPatches: create', () => {
  it('writes a new file that does not yet exist', async () => {
    await withTmpDir(async (dir) => {
      const rel = 'src/new-file.ts';
      const patch: FilePatch = {
        filePath: rel,
        kind: 'create',
        hashBefore: null,
        contentAfter: 'brand new content',
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toEqual([{ filePath: rel, ok: true }]);
      expect(await readFile(join(dir, rel), 'utf8')).toBe('brand new content');
    });
  });

  it('treats create-onto-existing-file as stale when hashBefore is null', async () => {
    await withTmpDir(async (dir) => {
      const rel = 'src/already-there.ts';
      const abs = join(dir, rel);
      await seedFile(abs, 'preexisting content');

      const patch: FilePatch = {
        filePath: rel,
        kind: 'create',
        hashBefore: null,
        contentAfter: 'clobbering content',
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toEqual([{ filePath: rel, ok: false, reason: 'stale' }]);
      expect(await readFile(abs, 'utf8')).toBe('preexisting content');
    });
  });

  it('allows create-onto-existing-file when hashBefore matches current content', async () => {
    await withTmpDir(async (dir) => {
      const rel = 'src/already-there.ts';
      const abs = join(dir, rel);
      await seedFile(abs, 'preexisting content');

      const patch: FilePatch = {
        filePath: rel,
        kind: 'create',
        hashBefore: hashContent('preexisting content'),
        contentAfter: 'overwritten content',
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toEqual([{ filePath: rel, ok: true }]);
      expect(await readFile(abs, 'utf8')).toBe('overwritten content');
    });
  });
});

describe('applyPatches: containment', () => {
  it('rejects a path that escapes the project via ../ and performs no write', async () => {
    await withTmpDir(async (dir) => {
      const rel = '../escaped-evil.ts';
      const patch: FilePatch = {
        filePath: rel,
        kind: 'create',
        hashBefore: null,
        contentAfter: 'pwned',
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toHaveLength(1);
      expect(results[0]?.ok).toBe(false);
      expect(results[0]?.reason).toBe('io-error');
      expect(results[0]?.detail).toBeTruthy();

      // No write anywhere near the parent of the sandbox.
      expect(existsSync(join(dirname(dir), 'escaped-evil.ts'))).toBe(false);
    });
  });

  it('rejects a symlink inside the project that points outside it', async () => {
    await withTmpDir(async (outside) => {
      await withTmpDir(async (proj) => {
        const secretAbs = join(outside, 'secret.txt');
        await writeFile(secretAbs, 'top secret', 'utf8');
        await symlink(secretAbs, join(proj, 'link.txt'));

        const patch: FilePatch = {
          filePath: 'link.txt',
          kind: 'modify',
          hashBefore: hashContent('top secret'),
          contentAfter: 'overwritten via symlink',
        };

        const results = await applyPatches(proj, [patch]);
        expect(results).toEqual([
          expect.objectContaining({ filePath: 'link.txt', ok: false, reason: 'io-error' }),
        ]);
        expect(await readFile(secretAbs, 'utf8')).toBe('top secret');
      });
    });
  });

  it('rejects a create under a symlinked directory that points outside the project', async () => {
    await withTmpDir(async (outside) => {
      await withTmpDir(async (proj) => {
        // proj/linkdir -> outside; a 'create' targeting linkdir/newfile.txt
        // does not exist yet, so leaf-only realpath checks miss the escaping
        // ancestor symlink and the write lands outside the project.
        await symlink(outside, join(proj, 'linkdir'));

        const patch: FilePatch = {
          filePath: 'linkdir/newfile.txt',
          kind: 'create',
          hashBefore: null,
          contentAfter: 'escaped payload',
        };

        const results = await applyPatches(proj, [patch]);
        expect(results).toEqual([
          expect.objectContaining({
            filePath: 'linkdir/newfile.txt',
            ok: false,
            reason: 'io-error',
          }),
        ]);
        expect(existsSync(join(outside, 'newfile.txt'))).toBe(false);
      });
    });
  });

  it('rejects a create under a nested non-existent path below an escaping symlinked directory', async () => {
    await withTmpDir(async (outside) => {
      await withTmpDir(async (proj) => {
        await symlink(outside, join(proj, 'linkdir'));

        const patch: FilePatch = {
          filePath: 'linkdir/deep/nested/newfile.txt',
          kind: 'create',
          hashBefore: null,
          contentAfter: 'escaped payload',
        };

        const results = await applyPatches(proj, [patch]);
        expect(results).toEqual([
          expect.objectContaining({ ok: false, reason: 'io-error' }),
        ]);
        expect(existsSync(join(outside, 'deep'))).toBe(false);
      });
    });
  });

  it('rejects an absolute filePath outside the project', async () => {
    await withTmpDir(async (outside) => {
      await withTmpDir(async (proj) => {
        const target = join(outside, 'abs-target.txt');
        const patch: FilePatch = {
          filePath: target,
          kind: 'create',
          hashBefore: null,
          contentAfter: 'absolute escape',
        };

        const results = await applyPatches(proj, [patch]);
        expect(results).toEqual([
          expect.objectContaining({ filePath: target, ok: false, reason: 'io-error' }),
        ]);
        expect(existsSync(target)).toBe(false);
      });
    });
  });

  it('still allows a create under a new nested directory inside the project', async () => {
    await withTmpDir(async (dir) => {
      const rel = 'brand/new/dirs/file.ts';
      const patch: FilePatch = {
        filePath: rel,
        kind: 'create',
        hashBefore: null,
        contentAfter: 'nested create',
      };

      const results = await applyPatches(dir, [patch]);
      expect(results).toEqual([{ filePath: rel, ok: true }]);
      expect(await readFile(join(dir, rel), 'utf8')).toBe('nested create');
    });
  });

  it('allows a create under a symlinked directory that points inside the project', async () => {
    await withTmpDir(async (proj) => {
      // proj/alias -> proj/real; the canonical target stays inside the
      // project, so the write is allowed and lands in proj/real.
      await mkdir(join(proj, 'real'));
      await symlink(join(proj, 'real'), join(proj, 'alias'));

      const patch: FilePatch = {
        filePath: 'alias/inside.txt',
        kind: 'create',
        hashBefore: null,
        contentAfter: 'contained via internal symlink',
      };

      const results = await applyPatches(proj, [patch]);
      expect(results).toEqual([{ filePath: 'alias/inside.txt', ok: true }]);
      expect(await readFile(join(proj, 'real', 'inside.txt'), 'utf8')).toBe(
        'contained via internal symlink',
      );
    });
  });
});

describe('applyPatches: partial failure and ordering', () => {
  it('applies the good patch even when another patch in the same call is stale, preserving input order', async () => {
    await withTmpDir(async (dir) => {
      const goodRel = 'src/good.ts';
      const staleRel = 'src/stale.ts';
      await seedFile(join(dir, goodRel), 'good before');
      await seedFile(join(dir, staleRel), 'stale actual content');

      const patches: FilePatch[] = [
        {
          filePath: staleRel,
          kind: 'modify',
          hashBefore: hashContent('stale planned content'),
          contentAfter: 'should not be written',
        },
        {
          filePath: goodRel,
          kind: 'modify',
          hashBefore: hashContent('good before'),
          contentAfter: 'good after',
        },
      ];

      const results = await applyPatches(dir, patches);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ filePath: staleRel, ok: false, reason: 'stale' });
      expect(results[1]).toEqual({ filePath: goodRel, ok: true });

      expect(await readFile(join(dir, staleRel), 'utf8')).toBe('stale actual content');
      expect(await readFile(join(dir, goodRel), 'utf8')).toBe('good after');
    });
  });
});

describe('renderDiff', () => {
  it('renders a unified diff with headers and changed lines for a modify patch', () => {
    const patch: FilePatch = {
      filePath: 'src/foo.ts',
      kind: 'modify',
      hashBefore: hashContent('line one\nline two\n'),
      contentAfter: 'line one\nline TWO changed\n',
    };

    const diff = renderDiff(patch, 'line one\nline two\n');
    expect(diff).toContain('---');
    expect(diff).toContain('+++');
    expect(diff).toContain('-line two');
    expect(diff).toContain('+line TWO changed');
  });

  it('renders a full-file removal for a delete patch', () => {
    const patch: FilePatch = {
      filePath: 'src/bye.ts',
      kind: 'delete',
      hashBefore: hashContent('a\nb\nc\n'),
      contentAfter: null,
    };

    const diff = renderDiff(patch, 'a\nb\nc\n');
    expect(diff).toContain('---');
    expect(diff).toContain('+++');
    expect(diff).toContain('-a');
    expect(diff).toContain('-b');
    expect(diff).toContain('-c');
    expect(diff).not.toContain('+a');
    expect(diff).not.toContain('+b');
    expect(diff).not.toContain('+c');
  });
});
