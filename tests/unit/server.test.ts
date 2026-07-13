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
});
