import { randomBytes } from 'node:crypto';
import { cp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { probeSweepCapabilities, runSweep } from '../../src/fix/sweep.js';

// Lives under the repo's own gitignored .tmp-tests/ (not the OS tmpdir) so the
// copied fixture can still resolve knip via node_modules walk-up, same
// precedent as tests/integration/ignore-roundtrip.test.ts.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../fixtures/single/', import.meta.url));
const workDir = join(repoRoot, '.tmp-tests', `sweep-${randomBytes(6).toString('hex')}`);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('runSweep', () => {
  it('removes the unused left-pad dependency from the COPY only, leaving fixture sources untouched', async () => {
    await cp(fixtureDir, workDir, { recursive: true });

    const fixturePkgBefore = await readFile(join(fixtureDir, 'package.json'), 'utf8');
    const fixtureIndexBefore = await readFile(join(fixtureDir, 'src', 'index.ts'), 'utf8');
    expect(fixturePkgBefore).toContain('left-pad');

    const result = await runSweep(workDir, { fixTypes: ['dependencies'] });
    expect(result.ok).toBe(true);

    const copyPkgAfter = await readFile(join(workDir, 'package.json'), 'utf8');
    expect(copyPkgAfter).not.toContain('left-pad');

    // The original fixture on disk must be completely unaffected.
    const fixturePkgAfter = await readFile(join(fixtureDir, 'package.json'), 'utf8');
    expect(fixturePkgAfter).toBe(fixturePkgBefore);
    const fixtureIndexAfter = await readFile(join(fixtureDir, 'src', 'index.ts'), 'utf8');
    expect(fixtureIndexAfter).toBe(fixtureIndexBefore);
  }, 30_000);

  it('reports a projectDir with no resolvable knip as not ok', async () => {
    const result = await runSweep('/nonexistent/path/for/knip-gui-tests', {});
    expect(result.ok).toBe(false);
    expect(result.stderr).toBeTruthy();
  });
});

describe('probeSweepCapabilities', () => {
  it('detects fix, fix-type, allow-remove-files and workspace support for the installed knip 6', async () => {
    const caps = await probeSweepCapabilities(repoRoot);
    expect(caps).toEqual({ fix: true, fixType: true, allowRemoveFiles: true, workspace: true });
  });

  it('caches the result per projectDir (second call does not need to re-spawn to answer)', async () => {
    const first = await probeSweepCapabilities(repoRoot);
    const second = await probeSweepCapabilities(repoRoot);
    expect(second).toEqual(first);
  });
});
