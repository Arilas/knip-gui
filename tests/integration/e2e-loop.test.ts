import { execFile } from 'node:child_process';
import { cp, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { runScan } from '../../src/core/knip-runner.js';
import type { Issue } from '../../src/core/types.js';
import { createServer } from '../../src/server/index.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd });
}

// Lives under the repo's own gitignored .tmp-tests/ (not the OS tmpdir) so the
// copied fixture can still resolve knip via the repo's node_modules walk-up —
// same precedent as tests/integration/sweep.test.ts and
// tests/integration/ignore-roundtrip.test.ts.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../fixtures/single/', import.meta.url));
const workDir = join(repoRoot, '.tmp-tests', `e2e-${randomBytes(6).toString('hex')}`);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function pollReport(
  // Hono's app.request returns Response | Promise<Response>; await handles both.
  app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response },
  headers: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ status: string; report?: { issues: Issue[] } }> {
  const start = Date.now();
  for (;;) {
    const rep = await (await app.request('/api/report', { headers })).json();
    if (rep.status === 'ready' || rep.status === 'error') return rep;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for rescan (status=${rep.status})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('end-to-end fix loop against real knip', () => {
  it('scans, previews + applies a fix plan across 3 issue kinds, rescans, and commits exactly those paths', async () => {
    await cp(fixtureDir, workDir, { recursive: true });
    await git(workDir, ['init', '-b', 'main']);
    await git(workDir, ['config', 'user.name', 'Test User']);
    await git(workDir, ['config', 'user.email', 'test@example.com']);
    await git(workDir, ['config', 'commit.gpgsign', 'false']);
    await git(workDir, ['add', '-A']);
    await git(workDir, ['commit', '-m', 'initial fixture import']);

    const { app, token } = createServer({ projectDir: workDir, scan: runScan });
    const h = { 'x-knip-gui-token': token, 'content-type': 'application/json' };

    const scanRes = await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    expect(scanRes.status).toBe(200);

    const report1 = await (await app.request('/api/report', { headers: h })).json();
    expect(report1.status).toBe('ready');
    const issues: Issue[] = report1.report.issues;

    const exportIssue = issues.find((i) => i.type === 'exports' && i.symbol === 'unusedHelper');
    const fileIssue = issues.find((i) => i.type === 'files' && i.filePath === 'src/orphan.ts');
    const depIssue = issues.find(
      (i) =>
        (i.type === 'dependencies' || i.type === 'devDependencies' || i.type === 'optionalPeerDependencies') &&
        i.symbol === 'left-pad',
    );
    expect(exportIssue, 'expected an unusedHelper exports issue in the scan').toBeTruthy();
    expect(fileIssue, 'expected a src/orphan.ts files issue in the scan').toBeTruthy();
    expect(depIssue, 'expected a left-pad dependency issue in the scan').toBeTruthy();

    const issueIds = [exportIssue!.id, fileIssue!.id, depIssue!.id];

    const previewRes = await app.request('/api/fix/preview', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ issueIds }),
    });
    expect(previewRes.status).toBe(200);
    const previewBody = await previewRes.json();
    expect(previewBody.patches).toBeUndefined();
    expect(previewBody.diffs).toHaveLength(3);
    const diffPaths: string[] = previewBody.diffs.map((d: { filePath: string }) => d.filePath).sort();
    expect(diffPaths).toEqual(['package.json', 'src/orphan.ts', 'src/used.ts']);

    const applyRes = await app.request('/api/fix/apply', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ planId: previewBody.planId }),
    });
    expect(applyRes.status).toBe(200);
    const applyBody = await applyRes.json();
    expect(applyBody.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(applyBody.failedItems).toEqual([]);
    expect(applyBody.rescanning).toBe(true);

    const report2 = await pollReport(app, h);
    expect(report2.status).toBe('ready');
    const idsAfter = new Set(report2.report!.issues.map((i) => i.id));
    for (const id of issueIds) expect(idsAfter.has(id)).toBe(false);

    // Full tsc check on the mutated copy is not required (only unused code was
    // removed, so imports stay valid) — assert usedHelper is still exported
    // instead, pinning that the strip-export transform touched only the
    // targeted symbol.
    const usedContent = await readFile(join(workDir, 'src/used.ts'), 'utf8');
    expect(usedContent).toContain('export function usedHelper');
    // strip-export (the default fix mode for an 'exports' issue) only removes the
    // `export ` keyword, mirroring knip --fix — the dead local declaration is
    // still textually present, so assert the export keyword specifically is gone.
    expect(usedContent).not.toContain('export function unusedHelper');

    const commitRes = await app.request('/api/git/commit', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ message: 'chore: apply knip-gui fixes', paths: diffPaths }),
    });
    expect(commitRes.status).toBe(200);
    const commitBody = await commitRes.json();
    expect(commitBody.sha).toMatch(/^[0-9a-f]{40}$/);

    const { stdout: headSha } = await git(workDir, ['rev-parse', 'HEAD']);
    expect(headSha.trim()).toBe(commitBody.sha);

    const { stdout } = await git(workDir, ['log', '--name-only', '--pretty=format:', '-1']);
    const committedPaths = stdout.split('\n').filter(Boolean).sort();
    expect(committedPaths).toEqual(['package.json', 'src/orphan.ts', 'src/used.ts']);
  }, 60_000);
});
