import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';

const single = new URL('../fixtures/single/', import.meta.url).pathname;

const fakeRaw = {
  issues: [
    { file: 'src/used.ts', exports: [{ name: 'unusedHelper', line: 5, col: 17, pos: 80 }] },
  ],
};

function makeServer(scan = async () => fakeRaw) {
  return createServer({ projectDir: single, scan });
}

describe('server security', () => {
  it('rejects api calls without token', async () => {
    const { app } = makeServer();
    const res = await app.request('/api/report');
    expect(res.status).toBe(401);
  });

  it('rejects cross-origin requests even with token', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/report', {
      headers: { 'x-knip-gui-token': token, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a non-loopback origin even when Host matches a legit loopback port', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/report', {
      headers: { 'x-knip-gui-token': token, origin: 'https://evil.example', host: '127.0.0.1:6173' },
    });
    expect(res.status).toBe(403);
  });

  it('allows an Origin that matches the request Host exactly (same host:port)', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/report', {
      headers: { 'x-knip-gui-token': token, origin: 'http://127.0.0.1:6173', host: '127.0.0.1:6173' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects an Origin from a different loopback port than the request Host', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/report', {
      headers: { 'x-knip-gui-token': token, origin: 'http://127.0.0.1:9999', host: '127.0.0.1:6173' },
    });
    expect(res.status).toBe(403);
  });

  it('allows a localhost Origin that matches the request Host exactly', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/report', {
      headers: { 'x-knip-gui-token': token, origin: 'http://localhost:6173', host: 'localhost:6173' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects an Origin when Host is absent, even for a loopback-looking origin', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/report', {
      headers: { 'x-knip-gui-token': token, origin: 'http://127.0.0.1:6173' },
    });
    expect(res.status).toBe(403);
  });

  it('compares the Origin hostname to Host case-insensitively', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/report', {
      headers: { 'x-knip-gui-token': token, origin: 'http://LOCALHOST:6173', host: 'localhost:6173' },
    });
    expect(res.status).toBe(200);
  });

  it('serves the shell with the token embedded', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(token);
  });

  it('rejects a non-loopback Host header on the token-serving shell (DNS-rebind guard)', async () => {
    const { app } = makeServer();
    const res = await app.request('/', { headers: { host: 'evil.example.com' } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('knip-gui-token');
  });

  it('rejects a non-loopback Host header on the API even with a valid token', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/report', {
      headers: { 'x-knip-gui-token': token, host: 'attacker.test:6173' },
    });
    expect(res.status).toBe(403);
  });

  it('allows loopback Host variants', async () => {
    const { app } = makeServer();
    for (const host of ['127.0.0.1:6173', 'localhost:6173', '[::1]:6173']) {
      const res = await app.request('/', { headers: { host } });
      expect(res.status, host).toBe(200);
    }
  });
});

describe('static client serving', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeClientDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'knip-gui-client-'));
    tmpDirs.push(dir);
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(
      join(dir, 'index.html'),
      '<!doctype html><html><head><meta name="knip-gui-token" content="__KNIP_GUI_TOKEN__">' +
        '<title>knip-gui</title></head><body><div id="root"></div>' +
        '<script type="module" src="/assets/app.js"></script></body></html>',
    );
    await writeFile(join(dir, 'assets', 'app.js'), 'console.log("hi");');
    return dir;
  }

  it('falls back to the inline shell when dist/client is absent', async () => {
    const missing = join(await mkdtemp(join(tmpdir(), 'knip-gui-missing-')), 'dist', 'client');
    tmpDirs.push(missing);
    const { app, token } = createServer({ projectDir: single, scan: async () => fakeRaw, clientDir: missing });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(token);
    expect(body).toContain('UI ships in a later phase');
  });

  it('serves the built index.html with the real token substituted for the placeholder', async () => {
    const clientDir = await makeClientDir();
    const { app, token } = createServer({ projectDir: single, scan: async () => fakeRaw, clientDir });
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`content="${token}"`);
    expect(body).not.toContain('__KNIP_GUI_TOKEN__');
  });

  it('serves /assets/* statically without requiring a token', async () => {
    const clientDir = await makeClientDir();
    const { app } = createServer({ projectDir: single, scan: async () => fakeRaw, clientDir });
    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("hi");');
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('never leaks a file escaping the client dir via an asset traversal', async () => {
    const clientDir = await makeClientDir();
    const { app } = createServer({ projectDir: single, scan: async () => fakeRaw, clientDir });
    // The WHATWG URL constructor normalizes the `..` segments away before this
    // ever reaches the server (`/assets/../../etc/passwd` -> `/etc/passwd`), so
    // it never matches `/assets/*` — it lands on the SPA fallback. A dotless
    // target serves the SPA shell (harmless: the app's own token page, not the
    // target file); a dotted target 404s under the fallback's asset carve-out.
    // Either way the escaped file's bytes are NEVER returned.
    const dotless = await app.request('/assets/../../etc/passwd');
    expect(dotless.status).toBe(200);
    const dotlessBody = await dotless.text();
    expect(dotlessBody).not.toContain('root:');

    const dotted = await app.request('/assets/../../etc/hosts.txt');
    expect(dotted.status).toBe(404);
  });

  it('404s an asset that does not exist', async () => {
    const clientDir = await makeClientDir();
    const { app } = createServer({ projectDir: single, scan: async () => fakeRaw, clientDir });
    const res = await app.request('/assets/nope.js');
    expect(res.status).toBe(404);
  });
});

describe('SPA fallback (client-side routes)', () => {
  it('serves the token-substituted shell for a client-side path so a deep-link/reload lands in the SPA', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/code');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // Same token-bearing shell GET / hands out — the client boots and its
    // router resolves /code itself.
    expect(await res.text()).toContain(token);
  });

  it('serves the shell for a nested client-side path too', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/review');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(token);
  });

  it('404s an unknown /api/* path as JSON (never the HTML shell — an API 404 must stay machine-readable)', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/nope', { headers: { 'x-knip-gui-token': token } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('404s a path whose last segment has a file extension (a missing asset must not fall through to the shell)', async () => {
    const { app } = makeServer();
    const res = await app.request('/foo.png');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('knip-gui-token');
  });

  it('still guards the fallback against a non-loopback Host (the shell hands out the token)', async () => {
    const { app } = makeServer();
    const res = await app.request('/code', { headers: { host: 'evil.example.com' } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('knip-gui-token');
  });
});

describe('scan + report + file', () => {
  it('scan populates the report', async () => {
    const { app, token } = makeServer();
    const h = { 'x-knip-gui-token': token };
    const scanRes = await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    expect(scanRes.status).toBe(200);

    const rep = await (await app.request('/api/report', { headers: h })).json();
    expect(rep.status).toBe('ready');
    expect(rep.report.issues).toHaveLength(1);
    expect(rep.report.issues[0].symbol).toBe('unusedHelper');
    expect(rep.report.workspaces).toEqual(['.']);
  });

  it('GET /api/status returns status + scannedAt without the report body', async () => {
    const { app, token } = makeServer();
    const h = { 'x-knip-gui-token': token };
    await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });

    const res = await app.request('/api/status', { headers: { 'x-knip-gui-token': token } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(typeof body.scannedAt).toBe('string');
    expect('report' in body).toBe(false);
  });

  it('a malformed (null) scan body does not clobber the store — treated as no workspace', async () => {
    // Regression: a body of literal `null` parses fine, but `body.workspace` on it
    // threw a TypeError that was caught and flipped the store to 'error'.
    const { app, token } = makeServer();
    const h = { 'x-knip-gui-token': token, 'content-type': 'application/json' };
    const res = await app.request('/api/scan', { method: 'POST', headers: h, body: 'null' });
    expect(res.status).toBe(200);
    const rep = await (await app.request('/api/report', { headers: h })).json();
    expect(rep.status).toBe('ready');
  });

  it('scan failure surfaces error payload', async () => {
    const { app, token } = makeServer(async () => {
      const { KnipError } = await import('../../src/core/knip-runner.js');
      throw new KnipError('boom', { code: 'knip-failed', stderr: 'stack...' });
    });
    const h = { 'x-knip-gui-token': token };
    const res = await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    expect(res.status).toBe(500);
    const rep = await (await app.request('/api/report', { headers: h })).json();
    expect(rep.status).toBe('error');
    expect(rep.error.stderr).toBe('stack...');
  });

  // SetupScreen (Task 6) decides whether a knip-failed error is "setup help"
  // territory (exitCode >= 2) purely off this field, so it must survive the
  // KnipError -> StoreError -> JSON round trip, not just message/stderr.
  it('scan failure surfaces the knip exit code for a knip-failed error', async () => {
    const { app, token } = makeServer(async () => {
      const { KnipError } = await import('../../src/core/knip-runner.js');
      throw new KnipError('knip exited with 7', { code: 'knip-failed', exitCode: 7, stderr: 'stack...' });
    });
    const h = { 'x-knip-gui-token': token };
    await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    const rep = await (await app.request('/api/report', { headers: h })).json();
    expect(rep.status).toBe('error');
    expect(rep.error.code).toBe('knip-failed');
    expect(rep.error.exitCode).toBe(7);
  });

  it('a failed POST /api/scan returns the flat error envelope (string error, code, stderr)', async () => {
    const { app, token } = makeServer(async () => {
      const { KnipError } = await import('../../src/core/knip-runner.js');
      throw new KnipError('knip exited 7', { code: 'knip-failed', stderr: 'stack...', exitCode: 7 });
    });
    const h = { 'x-knip-gui-token': token };
    const res = await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('knip exited 7'); // string, not an object
    expect(body.code).toBe('knip-failed');
    expect(body.stderr).toBe('stack...');
  });

  it('serves file content within the project only', async () => {
    const { app, token } = makeServer();
    const h = { 'x-knip-gui-token': token };
    const ok = await app.request('/api/file?path=src/index.ts', { headers: h });
    expect(ok.status).toBe(200);
    expect((await ok.json()).content).toContain('usedHelper');

    expect((await app.request('/api/file?path=../../../etc/passwd', { headers: h })).status).toBe(400);
    expect((await app.request('/api/file?path=src/nope.ts', { headers: h })).status).toBe(404);
  });

  it('threads production:true through to the scan call and the resulting report', async () => {
    const calls: Array<{ workspace?: string; production?: boolean }> = [];
    const { app, token, store } = createServer({
      projectDir: single,
      production: true,
      scan: async (_dir, opts = {}) => {
        calls.push({ workspace: opts.workspace, production: opts.production });
        return fakeRaw;
      },
    });
    const h = { 'x-knip-gui-token': token };
    await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    expect(calls).toEqual([{ workspace: undefined, production: true }]);
    expect(store.report!.production).toBe(true);
  });

  it('defaults production to false and still records it on the report', async () => {
    const { app, token, store } = makeServer();
    const h = { 'x-knip-gui-token': token };
    await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    expect(store.report!.production).toBe(false);
  });

  it('rejects a concurrent scan while one is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const { app, token } = makeServer(async () => {
      calls++;
      await gate;
      return fakeRaw;
    });
    const h = { 'x-knip-gui-token': token };

    const first = app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    const second = app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    release();

    const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(calls).toBe(1);
  });

  it('rejects symlinks that point outside the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'knip-gui-outside-'));
    const proj = await mkdtemp(join(tmpdir(), 'knip-gui-proj-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'top secret');
      await symlink(join(outside, 'secret.txt'), join(proj, 'link.txt'));
      await writeFile(join(proj, 'inside.txt'), 'safe content');

      const { app, token } = createServer({ projectDir: proj, scan: async () => fakeRaw });
      const h = { 'x-knip-gui-token': token };

      const escaped = await app.request('/api/file?path=link.txt', { headers: h });
      expect(escaped.status).toBe(400);

      // Sanity: a real file inside the project still works even when the
      // project dir itself lives under a symlinked tmpdir (macOS /tmp).
      const ok = await app.request('/api/file?path=inside.txt', { headers: h });
      expect(ok.status).toBe(200);
      expect((await ok.json()).content).toBe('safe content');
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(proj, { recursive: true, force: true });
    }
  });
});
