import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCli } from '../../src/cli.js';

const single = new URL('../fixtures/single/', import.meta.url).pathname;
const root = new URL('../../', import.meta.url).pathname;

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
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
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
});
