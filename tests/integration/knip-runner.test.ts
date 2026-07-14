import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveKnip, runScan, KnipError } from '../../src/core/knip-runner.js';
import { normalize } from '../../src/core/normalize.js';

const single = new URL('../fixtures/single/', import.meta.url).pathname;
const monorepo = new URL('../fixtures/monorepo/', import.meta.url).pathname;

// `.tmp-tests/` is gitignored (see tests/integration/cli.test.ts for the same
// convention) — used here to fabricate a local, fully-controlled fake `knip`
// install so these tests can assert on the exact argv `runScan` invokes it
// with, and can spawn a deliberately slow child to exercise abort/reap
// behavior, without depending on real knip's actual scan semantics.
const tmpTestsDir = new URL('../../.tmp-tests/', import.meta.url).pathname;
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFakeKnipProject(binScript: string): string {
  mkdirSync(tmpTestsDir, { recursive: true });
  const dir = mkdtempSync(join(tmpTestsDir, 'knip-runner-fake-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'node_modules', 'knip', 'bin'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'knip', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  // `main` must sit one directory below the package root (dist/index.js), not
  // at the package root itself — resolveKnip walks up two dirname() calls
  // from the resolved main entry to find the package root (see its comment in
  // src/core/knip-runner.ts), matching real knip's own dist/ layout.
  writeFileSync(join(dir, 'node_modules', 'knip', 'dist', 'index.js'), 'module.exports = {};\n');
  writeFileSync(
    join(dir, 'node_modules', 'knip', 'package.json'),
    JSON.stringify({ name: 'knip', version: '0.0.0-fake', main: 'dist/index.js', bin: { knip: 'bin/knip.js' } }),
  );
  writeFileSync(join(dir, 'node_modules', 'knip', 'bin', 'knip.js'), binScript);
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('knip runner', () => {
  it('resolves the walk-up knip install', () => {
    const k = resolveKnip(single);
    expect(k).not.toBeNull();
    expect(k!.version).toMatch(/^\d+\./);
  });

  it('returns null for a dir with no reachable knip', () => {
    expect(resolveKnip('/')).toBeNull();
  });

  it('scans the single fixture and finds the known issues', async () => {
    const raw = await runScan(single);
    const issues = normalize(raw, ['.']);
    const types = new Set(issues.map((i) => i.type));
    expect(types).toContain('files');
    expect(types).toContain('exports');
    expect(types).toContain('dependencies');
  });

  it('scans the monorepo fixture and finds per-workspace issues', async () => {
    const raw = await runScan(monorepo);
    const issues = normalize(raw, ['packages/app', 'packages/lib', '.']);
    expect(issues.some((i) => i.workspace === 'packages/lib')).toBe(true);
  });

  it('throws KnipError with stderr on hard failure', async () => {
    await expect(runScan('/nonexistent-dir-xyz')).rejects.toBeInstanceOf(KnipError);
  });

  it('appends --production only when opts.production is set', async () => {
    const dir = makeFakeKnipProject('process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n');

    const withProd = (await runScan(dir, { production: true })) as { argv: string[] };
    expect(withProd.argv).toContain('--production');

    const without = (await runScan(dir, {})) as { argv: string[] };
    expect(without.argv).not.toContain('--production');
  });

  it('kills the child process when opts.signal aborts', async () => {
    const dir = makeFakeKnipProject(
      'require("fs").writeFileSync(require("path").join(__dirname, "pid.txt"), String(process.pid));\n' +
        'setTimeout(() => {}, 30000);\n',
    );
    const pidFile = join(dir, 'node_modules', 'knip', 'bin', 'pid.txt');

    const controller = new AbortController();
    const promise = runScan(dir, { signal: controller.signal });
    promise.catch(() => {}); // asserted below via rejects.toThrow — avoid an unhandled-rejection warning in between

    let pid = 0;
    for (let i = 0; i < 40 && !pid; i++) {
      await sleep(50);
      try {
        pid = Number(readFileSync(pidFile, 'utf8'));
      } catch {
        // pid file not written yet
      }
    }
    expect(pid).toBeGreaterThan(0);

    controller.abort();
    await expect(promise).rejects.toThrow();

    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
