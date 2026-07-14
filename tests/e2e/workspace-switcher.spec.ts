// Exercises the sidebar workspace-switcher combobox
// (client/src/components/app-shell/WorkspaceSwitcher.tsx) against a REAL
// monorepo-shaped project — a throwaway copy of tests/fixtures/monorepo,
// scanned by a real knip subprocess (not a mocked `scan` fn, unlike
// tests/unit/server-scope.test.ts, which only pins the plumbing).
//
// This spec runs its OWN short-lived server on its own port/fixture copy
// rather than joining the shared single-fixture webServer that
// playwright.config.ts boots for every other spec in this directory: that
// shared setup is deliberately single-workspace (see its own doc comment),
// and retrofitting a second project shape into one shared server/fixture
// would coalesce two unrelated concerns. Same pattern already used for
// manual browser verification in prior task reports (a scratch `dist/cli.js
// --dir <copy> --port <n>` instance), just automated here.
//
// Verified directly against a real `knip` run on this fixture before writing
// assertions (see task report): a full-project scan flags exactly ONE
// issue — packages/lib/extra.ts, a fully orphaned file. packages/app's and
// packages/lib's own index.ts exports are each declared as that package's
// package.json `main`, so knip treats them as public API entry points, not
// unused exports. Scoping to packages/app (which owns none of the fixture's
// issues) is therefore a real, visible narrowing: the tree goes from
// one file to none. Scoping to packages/lib keeps the one issue.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// One above playwright.config.ts's shared PORT (4818) — this spec's server
// is entirely separate from that shared instance.
const PORT = 4819;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const fixtureSrc = fileURLToPath(new URL('../fixtures/monorepo/', import.meta.url));
const workDir = fileURLToPath(new URL('../../.tmp-tests/workspace-switcher-fixture/', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let server: ChildProcess | undefined;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: workDir, stdio: 'ignore' });
}

// Same self-healing rationale as scripts/e2e-fixture.ts's reapStrayServers:
// an abnormally-terminated previous run of THIS spec (Ctrl-C, a crashed
// harness) can leave its `node dist/cli.js` child bound to PORT, and this
// spec's own server.kill() below never runs to free it. darwin/linux only
// (lsof) — matches this repo's dev platforms.
function reapStrayServer(port: number): void {
  let pids: number[];
  try {
    pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return; // no listener on the port (or no lsof) — nothing to reap
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

test.beforeAll(async () => {
  reapStrayServer(PORT);
  await rm(workDir, { recursive: true, force: true });
  await cp(fixtureSrc, workDir, { recursive: true });
  // Git-initialized for parity with every other throwaway fixture copy in
  // this repo (scripts/e2e-fixture.ts does the same) — not strictly required
  // for a scan (src/git/git.ts's gitStatus degrades to `isRepo: false`
  // gracefully), but keeps the sidebar's git chrome in its normal state
  // rather than an untested edge case.
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'knip-gui e2e']);
  git(['config', 'user.email', 'e2e@knip-gui.local']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial fixture import']);

  server = spawn('node', [cliPath, '--dir', workDir, '--no-open', '--port', String(PORT)], {
    stdio: 'ignore',
  });
  await waitForServer(`${BASE_URL}/`);
});

test.afterAll(async () => {
  server?.kill();
  await rm(workDir, { recursive: true, force: true });
});

test('workspace switcher scopes the scan and narrows both the report and the tree', async ({ page }) => {
  await page.goto(BASE_URL);
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('nav-code').click();
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toBeVisible();

  const switcher = page.getByTestId('workspace-switcher');
  await expect(switcher).toHaveAttribute('title', 'All workspaces');

  async function readReport(): Promise<{ report: { scope?: string; issues: unknown[] } }> {
    const token = await page.evaluate(
      () => document.querySelector('meta[name="knip-gui-token"]')?.getAttribute('content'),
    );
    const res = await page.request.get(`${BASE_URL}/api/report`, {
      headers: { 'x-knip-gui-token': token! },
    });
    return res.json();
  }

  // Narrow to packages/app — owns none of the fixture's issues.
  await switcher.click();
  await page.getByPlaceholder('Search workspaces…').fill('app');
  await page.getByTestId('workspace-option-packages/app').click();

  // A scoped rescan really was triggered (react-query's mutation flips this
  // synchronously on click, before the request even resolves) — not just a
  // no-op selection of the entry already showing.
  await expect(page.getByTestId('rerun-button')).toBeDisabled();
  await expect(page.getByTestId('rerun-button')).toBeEnabled({ timeout: 15_000 });
  await expect(switcher).toHaveAttribute('title', 'packages/app');

  // Tree narrowed to nothing: the fixture's one real issue lives in
  // packages/lib, outside this scope.
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toHaveCount(0);

  const scopedToApp = await readReport();
  expect(scopedToApp.report.scope).toBe('packages/app');
  expect(scopedToApp.report.issues).toEqual([]);

  // Narrow to packages/lib instead — the issue (and its tree row) reappear.
  await switcher.click();
  await page.getByPlaceholder('Search workspaces…').fill('lib');
  await page.getByTestId('workspace-option-packages/lib').click();
  await expect(page.getByTestId('rerun-button')).toBeEnabled({ timeout: 15_000 });
  await expect(switcher).toHaveAttribute('title', 'packages/lib');
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toBeVisible();

  const scopedToLib = await readReport();
  expect(scopedToLib.report.scope).toBe('packages/lib');
  expect(scopedToLib.report.issues).toHaveLength(1);

  // Back to All workspaces — full report + tree restored.
  await switcher.click();
  await page.getByTestId('workspace-option-.').click();
  await expect(page.getByTestId('rerun-button')).toBeEnabled({ timeout: 15_000 });
  await expect(switcher).toHaveAttribute('title', 'All workspaces');
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toBeVisible();

  const scopedToAll = await readReport();
  expect(scopedToAll.report.scope).toBeUndefined();
});
