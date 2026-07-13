import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';

const monorepo = new URL('../fixtures/monorepo/', import.meta.url).pathname;

function jsonHeaders(token: string): Record<string, string> {
  return { 'x-knip-gui-token': token, 'content-type': 'application/json' };
}

describe('report scope', () => {
  it('records the requested workspace as report.scope', async () => {
    const calls: (string | undefined)[] = [];
    const scan = async (_dir: string, opts: { workspace?: string } = {}) => {
      calls.push(opts.workspace);
      return { issues: [] };
    };
    const { app, token } = createServer({ projectDir: monorepo, scan });
    const h = jsonHeaders(token);

    const res = await app.request('/api/scan', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ workspace: 'packages/lib' }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['packages/lib']);

    const rep = await (await app.request('/api/report', { headers: h })).json();
    expect(rep.report.scope).toBe('packages/lib');
  });

  it('leaves scope undefined (full project) when no workspace is requested', async () => {
    const scan = async () => ({ issues: [] });
    const { app, token } = createServer({ projectDir: monorepo, scan });
    const h = jsonHeaders(token);

    await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    const rep = await (await app.request('/api/report', { headers: h })).json();
    expect(rep.report.scope).toBeUndefined();
  });
});

describe('scope reuse on rescan', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function makeProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'knip-gui-scope-'));
    tmpDirs.push(dir);
    await mkdir(join(dir, 'packages/lib/src'), { recursive: true });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 't', version: '1.0.0', type: 'module', workspaces: ['packages/*'] }, null, 2),
    );
    await writeFile(join(dir, 'packages/lib/package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }, null, 2));
    await writeFile(
      join(dir, 'packages/lib/src/index.ts'),
      `export function usedHelper(k: string): string {\n  return k.toUpperCase();\n}\n\nexport function unusedHelper(n: number): number {\n  return n * 2;\n}\n`,
    );
    return dir;
  }

  it('reuses the last scan workspace on the fire-and-forget rescan after a fix apply', async () => {
    const calls: (string | undefined)[] = [];
    const dir = await makeProject();
    const scan = async (_projectDir: string, opts: { workspace?: string } = {}) => {
      calls.push(opts.workspace);
      return { issues: [{ file: 'packages/lib/src/index.ts', exports: [{ name: 'unusedHelper' }] }] };
    };
    const { app, token, store } = createServer({ projectDir: dir, scan });
    const h = jsonHeaders(token);

    await app.request('/api/scan', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ workspace: 'packages/lib' }),
    });
    expect(calls).toEqual(['packages/lib']);

    const exportIssue = store.report!.issues.find((i) => i.type === 'exports')!;
    const previewRes = await app.request('/api/fix/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ issueIds: [exportIssue.id] }),
    });
    const { planId } = await previewRes.json();

    const applyRes = await app.request('/api/fix/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId }),
    });
    expect(applyRes.status).toBe(200);
    const applyBody = await applyRes.json();
    expect(applyBody.rescanning).toBe(true);

    // Fire-and-forget rescan: wait for the store to settle back to 'ready'.
    for (let i = 0; i < 50 && store.status === 'scanning'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(calls).toEqual(['packages/lib', 'packages/lib']);
    expect(store.report?.scope).toBe('packages/lib');
  });
});
