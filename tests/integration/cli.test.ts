import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCli } from '../../src/cli.js';

const single = new URL('../fixtures/single/', import.meta.url).pathname;
const root = new URL('../../', import.meta.url).pathname;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Fabricates a fake local `knip` install whose bin script sleeps ~30s instead
// of ever producing a report — long enough to reliably still be "scanning"
// when the test calls close(), without actually depending on real knip.
// Mirrors tests/integration/knip-runner.test.ts's fake-knip fixture builder.
function makeSlowFakeKnipProject(): { dir: string; pidFile: string } {
  const tmpTestsDir = new URL('../../.tmp-tests/', import.meta.url).pathname;
  mkdirSync(tmpTestsDir, { recursive: true });
  const dir = mkdtempSync(join(tmpTestsDir, 'cli-slow-'));
  mkdirSync(join(dir, 'node_modules', 'knip', 'bin'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'knip', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0' }));
  writeFileSync(join(dir, 'node_modules', 'knip', 'dist', 'index.js'), 'module.exports = {};\n');
  writeFileSync(
    join(dir, 'node_modules', 'knip', 'package.json'),
    JSON.stringify({ name: 'knip', version: '0.0.0-fake', main: 'dist/index.js', bin: { knip: 'bin/knip.js' } }),
  );
  const pidFile = join(dir, 'node_modules', 'knip', 'bin', 'pid.txt');
  writeFileSync(
    join(dir, 'node_modules', 'knip', 'bin', 'knip.js'),
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`,
  );
  return { dir, pidFile };
}

async function pollUntilReady(url: string, token: string): Promise<string> {
  let status = '';
  for (let i = 0; i < 60 && status !== 'ready'; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const rep = await (await fetch(`${url}/api/report`, { headers: { 'x-knip-gui-token': token } })).json();
    status = rep.status;
    if (status === 'error') break;
  }
  return status;
}

describe('cli', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Regression pin for the previously-silent initial-scan-failure path (Task
  // 6): a broken project used to leave the CLI printing nothing at all once
  // the fire-and-forget initial scan failed, stranding a terminal-only user
  // with no clue anything went wrong (the error only ever landed in the store,
  // visible via /api/report). Deleting knip.json alone doesn't reproduce a
  // scan failure here — knip's own default entry/project discovery still
  // matches this fixture's src/index.ts fine (verified manually: exit 0) —
  // so this corrupts the config's JSON instead, which knip's own config
  // loader rejects with exit code 2 (>= runScan's exitCode >= 2 failure
  // threshold), the same failure class (KnipError w/ code:'knip-failed', a
  // numeric exitCode) a real-world fatal knip error of any kind lands as.
  it('prints a friendlier hint once the initial scan fails', async () => {
    // Must live under the repo tree (not the OS tmpdir): resolveKnip's
    // require.resolve('knip', { paths: [dir] }) walks UP from `dir` through
    // ancestor node_modules the way Node's own module resolution does — under
    // the repo tree that eventually reaches this repo's node_modules/knip;
    // anywhere else (e.g. os.tmpdir()) it resolves to nothing, `resolveKnip`
    // returns null, and the CLI takes the separate "knip not found" branch
    // instead of ever attempting (and failing) a scan — which is a different
    // regression than this test pins. `.tmp-tests/` is gitignored, matching
    // this repo's other throwaway-fixture convention (scripts/e2e-fixture.ts).
    const tmpTestsDir = new URL('../../.tmp-tests/', import.meta.url).pathname;
    mkdirSync(tmpTestsDir, { recursive: true });
    const tmp = mkdtempSync(join(tmpTestsDir, 'cli-badconfig-'));
    tmpDirs.push(tmp);
    cpSync(single, tmp, { recursive: true });
    writeFileSync(join(tmp, 'knip.json'), '{ not valid json');

    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    try {
      const { url, close, token } = await startCli({ dir: tmp, open: false, port: 0 });
      try {
        expect(await pollUntilReady(url, token)).toBe('error');
        // The hint print is chained off the same fire-and-forget fetch as the
        // scan itself, so it can land a tick after /api/report already shows
        // 'error' — poll briefly rather than asserting immediately.
        for (let i = 0; i < 20 && errors.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        await close();
      }
    } finally {
      spy.mockRestore();
    }
    expect(errors.some((m) => m.includes('open the UI for details and setup help'))).toBe(true);
  });

  it('starts the server, serves the shell, and scans in the background', async () => {
    const { url, close, token } = await startCli({ dir: single, open: false, port: 0 });
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const html = await (await fetch(url)).text();
      expect(html).toContain('knip-gui');

      expect(await pollUntilReady(url, token)).toBe('ready');
    } finally {
      await close();
    }
  });

  it('resolves a relative --dir against cwd and scans to ready', async () => {
    // Vitest runs with cwd = project root; hand startCli a cwd-relative path.
    const relDir = relative(process.cwd(), single);
    expect(relDir.startsWith('/')).toBe(false);
    const { url, close, token } = await startCli({ dir: relDir, open: false, port: 0 });
    try {
      expect(await pollUntilReady(url, token)).toBe('ready');
    } finally {
      await close();
    }
  });

  it('auto-starts when executed through a bin-style symlink with a different basename', async () => {
    // npm link / global install invoke dist/cli.js through a symlinked shim named
    // `knip-gui`. Node realpath-resolves import.meta.url but leaves argv[1] as the
    // symlink path, so a naive URL comparison never matches and the CLI exits 0
    // silently. Pin the regression by executing the built cli.js through a symlink.
    execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
    const tmp = mkdtempSync(join(tmpdir(), 'knip-gui-bin-'));
    const link = join(tmp, 'knip-gui'); // deliberately not named cli.js
    symlinkSync(join(root, 'dist/cli.js'), link);

    const child = spawn(
      process.execPath,
      [link, '--dir', single, '--no-open', '--port', '0'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const url = await new Promise<string>((res, rej) => {
        let out = '';
        const timer = setTimeout(
          () => rej(new Error(`timed out waiting for URL; output so far: ${out}`)),
          15_000,
        );
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          const m = out.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);
          if (m) {
            clearTimeout(timer);
            res(m[1]!);
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          rej(new Error(`cli exited before printing URL (code=${code}); output: ${out}`));
        });
      });
      const html = await (await fetch(url)).text();
      expect(html).toContain('knip-gui');
    } finally {
      child.kill();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects an invalid --port before starting anything, with no stack trace', async () => {
    execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'pipe' });

    for (const badPort of ['abc', '-1', '99999', '3.5', '']) {
      // `--port=<value>` (rather than `--port <value>`) sidesteps node's own
      // parseArgs treating a negative-looking value like "-1" as an ambiguous
      // second option rather than this option's argument.
      const child = spawn(
        process.execPath,
        [join(root, 'dist/cli.js'), '--dir', single, '--no-open', `--port=${badPort}`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      const code = await new Promise<number | null>((res) => child.on('exit', res));
      expect(code).toBe(1);
      expect(stderr).toContain(`invalid --port: ${badPort}`);
      // No bare stack trace from an unhandled throw — just the one-line message.
      expect(stderr).not.toContain('at ');
    }
  });

  it('close() reaps a stalled knip child process (aborts the in-flight initial scan)', async () => {
    const { dir, pidFile } = makeSlowFakeKnipProject();
    tmpDirs.push(dir);

    const { close } = await startCli({ dir, open: false, port: 0 });

    // Wait for the fake knip child to actually start and record its own pid.
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

    const closeStarted = Date.now();
    await close();
    expect(Date.now() - closeStarted).toBeLessThan(1000);

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
