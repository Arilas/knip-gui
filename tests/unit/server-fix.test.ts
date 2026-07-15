import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

// Local-only identity, never touches host/global git config — same pattern as
// tests/unit/git.test.ts.
async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.name', 'Test User']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'initial']);
}

const usedTsContent = `export function usedHelper(k: string): string {
  return k.toUpperCase();
}

export function unusedHelper(n: number): number {
  return n * 2;
}
`;

// Raw shape mirrors knip's real --reporter json output (see
// tests/fixtures/single-report.json): one entry per file, per-type arrays of
// { name, line?, col?, pos? }. `pos` is deliberately omitted here — the
// strip-export transform falls back to a top-level name lookup when `pos` is
// absent, so the fixture doesn't need to track exact byte offsets.
const fakeRaw = {
  issues: [
    { file: 'src/used.ts', exports: [{ name: 'unusedHelper' }] },
    { file: 'src/orphan.ts', files: [{ name: 'src/orphan.ts' }] },
  ],
};

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'knip-gui-server-fix-'));
  tmpDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', type: 'module' }, null, 2));
  await writeFile(join(dir, 'knip.json'), JSON.stringify({ entry: ['src/index.ts'], project: ['src/**/*.ts'] }, null, 2));
  await writeFile(join(dir, 'src/used.ts'), usedTsContent);
  await writeFile(join(dir, 'src/orphan.ts'), 'export const nobodyImportsMe = true;\n');
  await initRepo(dir);
  return dir;
}

function jsonHeaders(token: string): Record<string, string> {
  return { 'x-knip-gui-token': token, 'content-type': 'application/json' };
}

async function makeReadyServer() {
  const dir = await makeProject();
  const server = createServer({ projectDir: dir, scan: async () => fakeRaw });
  const h = jsonHeaders(server.token);
  const scanRes = await server.app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
  expect(scanRes.status).toBe(200);
  return { ...server, dir, h };
}

describe('new routes require a token', () => {
  it('rejects every fix/ignore/sweep/git route without a token', async () => {
    const { app } = await makeReadyServer();
    const routes: [string, string][] = [
      ['POST', '/api/fix/preview'],
      ['POST', '/api/fix/apply'],
      ['POST', '/api/ignore/preview'],
      ['POST', '/api/ignore/apply'],
      ['POST', '/api/sweep'],
      ['GET', '/api/sweep/capabilities'],
      ['GET', '/api/git/status'],
      ['POST', '/api/git/branch'],
      ['POST', '/api/git/commit'],
    ];
    for (const [method, path] of routes) {
      const res = await app.request(path, { method, body: method === 'POST' ? '{}' : undefined });
      expect(res.status).toBe(401);
    }
  });
});

describe('fix preview/apply', () => {
  it('409s preview when the report is not ready yet', async () => {
    const dir = await makeProject();
    const { app, token } = createServer({ projectDir: dir, scan: async () => fakeRaw });
    const res = await app.request('/api/fix/preview', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ issueIds: ['x'] }),
    });
    expect(res.status).toBe(409);
  });

  it('preview returns diffs+items and withholds patch content', async () => {
    const { app, h, store } = await makeReadyServer();
    const exportIssue = store.report!.issues.find((i) => i.type === 'exports')!;

    const res = await app.request('/api/fix/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ issueIds: [exportIssue.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.planId).toEqual(expect.any(String));
    expect(body.patches).toBeUndefined();
    expect(body.diffs).toHaveLength(1);
    expect(body.diffs[0].filePath).toBe('src/used.ts');
    expect(body.diffs[0].diff).toContain('unusedHelper');
    expect(body.items).toEqual([{ issueId: exportIssue.id, ok: true }]);
  });

  it('applies the plan, writes the file, and 404s a second apply of the same planId', async () => {
    const { app, h, store, dir } = await makeReadyServer();
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
    expect(applyBody.results).toEqual([{ filePath: 'src/used.ts', ok: true }]);
    expect(applyBody.failedItems).toEqual([]);
    expect(applyBody.rescanning).toBe(true);

    // strip-export (the default fix mode for an 'exports' issue) only removes the
    // `export ` keyword, mirroring knip --fix — the now-dead local declaration
    // stays behind, so assert on the export keyword's absence specifically.
    const content = await readFile(join(dir, 'src/used.ts'), 'utf8');
    expect(content).not.toContain('export function unusedHelper');
    expect(content).toContain('function unusedHelper');
    expect(content).toContain('export function usedHelper');

    const second = await app.request('/api/fix/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId }),
    });
    expect(second.status).toBe(404);
  });

  it('404s apply for an unknown planId', async () => {
    const { app, h } = await makeReadyServer();
    const res = await app.request('/api/fix/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('reports a per-file stale result when the file changed on disk after preview', async () => {
    const { app, h, store, dir } = await makeReadyServer();
    const exportIssue = store.report!.issues.find((i) => i.type === 'exports')!;

    const previewRes = await app.request('/api/fix/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ issueIds: [exportIssue.id] }),
    });
    const { planId } = await previewRes.json();

    await writeFile(join(dir, 'src/used.ts'), '// changed externally after preview\n');

    const applyRes = await app.request('/api/fix/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId }),
    });
    expect(applyRes.status).toBe(200);
    const body = await applyRes.json();
    expect(body.results).toEqual([{ filePath: 'src/used.ts', ok: false, reason: 'stale' }]);
  });

  it('409s apply when a scan already holds the latch, naming the blocking op', async () => {
    // Pre-fix, apply checked nothing before mutating files — a concurrent scan
    // reading the project and an apply rewriting it could race. Now apply itself
    // takes the shared latch, so it never even reaches applyPatches while a scan
    // is in flight (and never reaches the "rescan skipped" branch either — that
    // path is gone; see triggerBackgroundRescan).
    const { app, h, store } = await makeReadyServer();
    const exportIssue = store.report!.issues.find((i) => i.type === 'exports')!;

    const previewRes = await app.request('/api/fix/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ issueIds: [exportIssue.id] }),
    });
    const { planId } = await previewRes.json();

    // Simulates a scan already holding the shared latch — same tryBeginOp the
    // real /api/scan route calls.
    expect(store.tryBeginOp('scan')).toBe(true);
    const applyRes = await app.request('/api/fix/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId }),
    });
    expect(applyRes.status).toBe(409);
    expect(await applyRes.json()).toEqual({ error: 'scan in progress', op: 'scan' });
  });

  it('409s a concurrent apply while a sweep is stalled mid-flight, naming the blocking op', async () => {
    const dir = await makeProject();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const server = createServer({
      projectDir: dir,
      scan: async () => fakeRaw,
      sweep: async () => {
        await gate;
        return { ok: true };
      },
    });
    const h = jsonHeaders(server.token);
    await server.app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });

    const exportIssue = server.store.report!.issues.find((i) => i.type === 'exports')!;
    const previewRes = await server.app.request('/api/fix/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ issueIds: [exportIssue.id] }),
    });
    const { planId } = await previewRes.json();

    // Sweep's tryBeginOp('sweep') runs synchronously before its first await, so
    // the latch is already held by the time this line returns control to us —
    // same reasoning as the sweep-vs-sweep latch test below.
    const sweepReq = server.app.request('/api/sweep', { method: 'POST', headers: h, body: '{}' });
    const applyRes = await server.app.request('/api/fix/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId }),
    });
    expect(applyRes.status).toBe(409);
    expect(await applyRes.json()).toEqual({ error: 'sweep in progress', op: 'sweep' });

    release();
    await sweepReq;
  });
});

describe('ignore preview/apply', () => {
  it('409s preview when the report is not ready yet', async () => {
    const dir = await makeProject();
    const { app, token } = createServer({ projectDir: dir, scan: async () => fakeRaw });
    const res = await app.request('/api/ignore/preview', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ issueIds: ['x'] }),
    });
    expect(res.status).toBe(409);
  });

  it('preview returns a knip.json diff and withholds patches; apply writes knip.json', async () => {
    const { app, h, store, dir } = await makeReadyServer();
    const filesIssue = store.report!.issues.find((i) => i.type === 'files')!;

    const previewRes = await app.request('/api/ignore/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ issueIds: [filesIssue.id] }),
    });
    expect(previewRes.status).toBe(200);
    const previewBody = await previewRes.json();
    expect(previewBody.patches).toBeUndefined();
    expect(previewBody.diffs).toHaveLength(1);
    expect(previewBody.diffs[0].filePath).toBe('knip.json');
    expect(previewBody.items).toEqual([{ issueId: filesIssue.id, ok: true }]);

    const applyRes = await app.request('/api/ignore/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId: previewBody.planId }),
    });
    expect(applyRes.status).toBe(200);
    const applyBody = await applyRes.json();
    expect(applyBody.results).toEqual([{ filePath: 'knip.json', ok: true }]);
    expect(applyBody.rescanning).toBe(true);

    const knipJson = JSON.parse(await readFile(join(dir, 'knip.json'), 'utf8'));
    expect(knipJson.ignore).toContain('src/orphan.ts');
  });

  it('404s apply for an unknown planId', async () => {
    const { app, h } = await makeReadyServer();
    const res = await app.request('/api/ignore/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId: 'does-not-exist' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('sweep routes', () => {
  it('surfaces a sweep failure (500) when knip is unresolvable in the temp project', async () => {
    const { app, h } = await makeReadyServer();
    const res = await app.request('/api/sweep', { method: 'POST', headers: h, body: '{}' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('409s /api/sweep while a scan is stalled mid-flight, naming the blocking op', async () => {
    const dir = await makeProject();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const server = createServer({
      projectDir: dir,
      scan: async () => {
        await gate;
        return fakeRaw;
      },
    });
    const h = jsonHeaders(server.token);

    // /api/scan's tryBeginOp('scan') runs synchronously before its first await
    // (readJsonObject), so by the time this line returns control to us the latch
    // is already held — same reasoning as the sweep-vs-sweep latch test below.
    const scanReq = server.app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    const sweepRes = await server.app.request('/api/sweep', { method: 'POST', headers: h, body: '{}' });
    expect(sweepRes.status).toBe(409);
    expect(await sweepRes.json()).toEqual({ error: 'scan in progress', op: 'scan' });

    release();
    await scanReq;
  });

  it('409s a second concurrent sweep POST while the first is still stalling (synchronous latch)', async () => {
    const dir = await makeProject();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const server = createServer({
      projectDir: dir,
      scan: async () => fakeRaw,
      sweep: async () => {
        calls++;
        await gate;
        return { ok: true };
      },
    });
    const h = jsonHeaders(server.token);
    await server.app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });

    const first = server.app.request('/api/sweep', { method: 'POST', headers: h, body: '{}' });
    const second = server.app.request('/api/sweep', { method: 'POST', headers: h, body: '{}' });
    release();

    const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(calls).toBe(1);
  });

  it('capabilities probe reports all-false for a project with no resolvable knip', async () => {
    const { app, h } = await makeReadyServer();
    const res = await app.request('/api/sweep/capabilities', { headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ fix: false, fixType: false, allowRemoveFiles: false, workspace: false });
  });
});

describe('production mode threading', () => {
  it('applies production to the rescan after a fix apply, and keeps it on the resulting report', async () => {
    const dir = await makeProject();
    const rescanCalls: Array<{ production?: boolean }> = [];
    const server = createServer({
      projectDir: dir,
      production: true,
      scan: async (_projectDir, opts = {}) => {
        rescanCalls.push({ production: opts.production });
        return fakeRaw;
      },
    });
    const h = jsonHeaders(server.token);
    await server.app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });

    const exportIssue = server.store.report!.issues.find((i) => i.type === 'exports')!;
    const previewRes = await server.app.request('/api/fix/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ issueIds: [exportIssue.id] }),
    });
    const { planId } = await previewRes.json();
    const applyRes = await server.app.request('/api/fix/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId }),
    });
    expect(applyRes.status).toBe(200);
    expect((await applyRes.json()).rescanning).toBe(true);

    // The post-apply rescan is fire-and-forget (triggerBackgroundRescan) — poll
    // briefly for it to land rather than asserting immediately.
    for (let i = 0; i < 20 && rescanCalls.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rescanCalls.length).toBeGreaterThanOrEqual(2); // initial scan + post-apply rescan
    expect(rescanCalls.every((c) => c.production === true)).toBe(true);
    expect(server.store.report!.production).toBe(true);
  });
});

describe('git routes', () => {
  it('reports status for a clean repo', async () => {
    const { app, h } = await makeReadyServer();
    const res = await app.request('/api/git/status', { headers: h });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isRepo).toBe(true);
    expect(body.branch).toBe('main');
    expect(body.dirty).toBe(false);
  });

  it('creates a branch and reports it via status', async () => {
    const { app, h } = await makeReadyServer();
    const res = await app.request('/api/git/branch', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ name: 'feature/x' }),
    });
    expect(res.status).toBe(200);
    const status = await (await app.request('/api/git/status', { headers: h })).json();
    expect(status.branch).toBe('feature/x');
  });

  it('400s branch creation when name is missing', async () => {
    const { app, h } = await makeReadyServer();
    const res = await app.request('/api/git/branch', { method: 'POST', headers: h, body: '{}' });
    expect(res.status).toBe(400);
  });

  it('400s branch creation with the GitError detail when the branch already exists', async () => {
    const { app, h } = await makeReadyServer();
    await app.request('/api/git/branch', { method: 'POST', headers: h, body: JSON.stringify({ name: 'dup' }) });
    const res = await app.request('/api/git/branch', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ name: 'dup' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('commits listed paths and returns the sha', async () => {
    const { app, h, dir } = await makeReadyServer();
    await writeFile(join(dir, 'new.txt'), 'hi', 'utf8');
    const res = await app.request('/api/git/commit', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ message: 'add new.txt', paths: ['new.txt'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sha).toMatch(/^[0-9a-f]{40}$/);

    const { stdout } = await git(dir, ['rev-parse', 'HEAD']);
    expect(stdout.trim()).toBe(body.sha);
  });

  it('400s commit with an empty message', async () => {
    const { app, h, dir } = await makeReadyServer();
    await writeFile(join(dir, 'new2.txt'), 'hi', 'utf8');
    const res = await app.request('/api/git/commit', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ message: '   ', paths: ['new2.txt'] }),
    });
    expect(res.status).toBe(400);
  });

  it('400s commit with empty/missing/non-array paths and does NOT commit a stray pre-staged file', async () => {
    const { app, h, dir } = await makeReadyServer();
    // Stage an unrelated file directly in the repo — the failure mode this
    // guards against: `git add --` with no pathspec is a no-op, so a pathless
    // commit would silently sweep this already-staged file into a commit
    // under our message.
    await writeFile(join(dir, 'stray.txt'), 'staged but not ours', 'utf8');
    await git(dir, ['add', 'stray.txt']);
    const { stdout: headBefore } = await git(dir, ['rev-parse', 'HEAD']);

    for (const paths of [[], undefined, 'not-an-array']) {
      const res = await app.request('/api/git/commit', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ message: 'sneaky commit', paths }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('paths');
    }

    // No commit happened, and the stray file remains staged-but-uncommitted.
    const { stdout: headAfter } = await git(dir, ['rev-parse', 'HEAD']);
    expect(headAfter).toBe(headBefore);
    const { stdout: staged } = await git(dir, ['diff', '--cached', '--name-only']);
    expect(staged.split('\n').filter(Boolean)).toEqual(['stray.txt']);
  });

  it('400s commit and surfaces GitError stderr when there is nothing to commit', async () => {
    const { app, h } = await makeReadyServer();
    const res = await app.request('/api/git/commit', {
      method: 'POST',
      headers: h,
      // src/used.ts is already committed and unmodified: nothing gets staged.
      body: JSON.stringify({ message: 'noop', paths: ['src/used.ts'] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(`${body.error} ${body.stderr ?? ''}`).toContain('nothing to commit');
  });
});
