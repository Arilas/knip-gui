import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it('serves the shell with the token embedded', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(token);
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

  it('serves file content within the project only', async () => {
    const { app, token } = makeServer();
    const h = { 'x-knip-gui-token': token };
    const ok = await app.request('/api/file?path=src/index.ts', { headers: h });
    expect(ok.status).toBe(200);
    expect((await ok.json()).content).toContain('usedHelper');

    expect((await app.request('/api/file?path=../../../etc/passwd', { headers: h })).status).toBe(400);
    expect((await app.request('/api/file?path=src/nope.ts', { headers: h })).status).toBe(404);
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
