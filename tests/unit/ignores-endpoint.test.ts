import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';

const fakeRaw = { issues: [] };

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function jsonHeaders(token: string): Record<string, string> {
  return { 'x-knip-gui-token': token, 'content-type': 'application/json' };
}

async function makeProject(knipConfig: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knip-gui-ignores-'));
  tmpDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', type: 'module' }, null, 2));
  await writeFile(join(dir, 'knip.json'), JSON.stringify({ entry: ['src/index.ts'], ...knipConfig }, null, 2));
  return dir;
}

async function makeReadyServer(knipConfig: Record<string, unknown> = {}) {
  const dir = await makeProject(knipConfig);
  const server = createServer({ projectDir: dir, scan: async () => fakeRaw });
  const h = jsonHeaders(server.token);
  const scanRes = await server.app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
  expect(scanRes.status).toBe(200);
  return { ...server, dir, h };
}

describe('ignores routes require a token', () => {
  it('rejects every /api/ignores* route without a token', async () => {
    const { app } = await makeReadyServer();
    const routes: [string, string][] = [
      ['GET', '/api/ignores'],
      ['POST', '/api/ignores/remove/preview'],
      ['POST', '/api/ignores/remove/apply'],
    ];
    for (const [method, path] of routes) {
      const res = await app.request(path, { method, body: method === 'POST' ? '{}' : undefined });
      expect(res.status).toBe(401);
    }
  });
});

describe('GET /api/ignores', () => {
  it('lists root and workspace-scoped entries from knip.json', async () => {
    const { app, h } = await makeReadyServer({
      ignoreDependencies: ['left-pad'],
      workspaces: { 'packages/app': { ignore: ['src/orphan.ts'] } },
    });
    const res = await app.request('/api/ignores', { headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.configKind).toBe('knip.json');
    expect(body.configPath).toBe('knip.json');
    expect(body.entries).toEqual(
      expect.arrayContaining([
        { kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' },
        { kind: 'ignore', value: 'src/orphan.ts', workspace: 'packages/app' },
      ]),
    );
  });

  it('reports kind "none" with empty entries when there is no ignorable config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'knip-gui-ignores-'));
    tmpDirs.push(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 't' }));
    const { app, token } = createServer({ projectDir: dir, scan: async () => fakeRaw });
    const res = await app.request('/api/ignores', { headers: jsonHeaders(token) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [], configKind: 'none' });
  });

  it('does not require a ready report — works even before any scan', async () => {
    const dir = await makeProject({ ignoreDependencies: ['left-pad'] });
    const { app, token } = createServer({ projectDir: dir, scan: async () => fakeRaw });
    const res = await app.request('/api/ignores', { headers: jsonHeaders(token) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toEqual([{ kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' }]);
  });
});

describe('remove-ignores preview/apply', () => {
  it('preview returns a knip.json diff and withholds patches; apply removes the entry and rescans', async () => {
    const { app, h, dir } = await makeReadyServer({ ignoreDependencies: ['left-pad', 'chalk'] });

    const previewRes = await app.request('/api/ignores/remove/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entries: [{ kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' }] }),
    });
    expect(previewRes.status).toBe(200);
    const previewBody = await previewRes.json();
    expect(previewBody.patches).toBeUndefined();
    expect(previewBody.diffs).toHaveLength(1);
    expect(previewBody.diffs[0].filePath).toBe('knip.json');
    expect(previewBody.diffs[0].diff).toContain('-    "left-pad"');
    expect(previewBody.items).toEqual([{ issueId: 'ignoreDependencies:.:left-pad', ok: true }]);

    const applyRes = await app.request('/api/ignores/remove/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId: previewBody.planId }),
    });
    expect(applyRes.status).toBe(200);
    const applyBody = await applyRes.json();
    expect(applyBody.results).toEqual([{ filePath: 'knip.json', ok: true }]);
    expect(applyBody.failedItems).toEqual([]);
    expect(applyBody.rescanning).toBe(true);

    const knipJson = JSON.parse(await readFile(join(dir, 'knip.json'), 'utf8'));
    expect(knipJson.ignoreDependencies).toEqual(['chalk']);
  });

  it('404s apply for an unknown planId', async () => {
    const { app, h } = await makeReadyServer({ ignoreDependencies: ['left-pad'] });
    const res = await app.request('/api/ignores/remove/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('404s a second apply of the same planId (single-use)', async () => {
    const { app, h } = await makeReadyServer({ ignoreDependencies: ['left-pad'] });
    const previewRes = await app.request('/api/ignores/remove/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entries: [{ kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' }] }),
    });
    const { planId } = await previewRes.json();

    const firstApply = await app.request('/api/ignores/remove/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId }),
    });
    expect(firstApply.status).toBe(200);

    const secondApply = await app.request('/api/ignores/remove/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId }),
    });
    expect(secondApply.status).toBe(404);
  });

  it('preview reports ok:false with reason "not-found" for an entry no longer present', async () => {
    const { app, h } = await makeReadyServer({ ignoreDependencies: ['left-pad'] });
    const res = await app.request('/api/ignores/remove/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entries: [{ kind: 'ignoreDependencies', value: 'does-not-exist', workspace: '.' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.diffs).toEqual([]);
    expect(body.items).toEqual([
      { issueId: 'ignoreDependencies:.:does-not-exist', ok: false, reason: 'not-found' },
    ]);
  });

  it('409s apply when a scan already holds the latch, naming the blocking op', async () => {
    // Same reasoning as routes-fix.ts's apply routes: apply now takes the shared
    // latch itself, so it never reaches applyPatches while a scan is in flight.
    const { app, h, store } = await makeReadyServer({ ignoreDependencies: ['left-pad'] });
    const previewRes = await app.request('/api/ignores/remove/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entries: [{ kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' }] }),
    });
    const { planId } = await previewRes.json();

    // Simulates a scan already holding the shared latch — same tryBeginOp the
    // real /api/scan route calls.
    expect(store.tryBeginOp('scan')).toBe(true);
    const applyRes = await app.request('/api/ignores/remove/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId }),
    });
    expect(applyRes.status).toBe(409);
    expect(await applyRes.json()).toEqual({ error: 'scan in progress', op: 'scan' });
  });

  it('reports code-config/no-config reasons when there is no writable config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'knip-gui-ignores-'));
    tmpDirs.push(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 't' }));
    const { app, token } = createServer({ projectDir: dir, scan: async () => fakeRaw });
    const h = jsonHeaders(token);
    await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });

    const res = await app.request('/api/ignores/remove/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ entries: [{ kind: 'ignoreDependencies', value: 'left-pad', workspace: '.' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([{ issueId: 'ignoreDependencies:.:left-pad', ok: false, reason: 'no-config' }]);
  });
});
