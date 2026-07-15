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
import { expect, test, type Page } from '@playwright/test';

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

// Reads /api/report directly — the client's 2s poll now hits the slimmer
// /api/status instead, so this reads the full report on its own using the
// session token embedded in the served page — same pattern as
// codepane-crash.spec.ts. Module-level so both tests below share it.
async function readReport(page: Page): Promise<{ report: { scope?: string; issues: unknown[] } }> {
  const token = await page.evaluate(
    () => document.querySelector('meta[name="knip-gui-token"]')?.getAttribute('content'),
  );
  const res = await page.request.get(`${BASE_URL}/api/report`, {
    headers: { 'x-knip-gui-token': token! },
  });
  return res.json();
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
  git(['config', 'commit.gpgsign', 'false']);
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

  // The scope is mirrored into the URL (#14) so a reload/bookmark restores it.
  await expect(page).toHaveURL(/[?&]ws=packages(%2F|\/)app/);

  // Tree narrowed to nothing: the fixture's one real issue lives in
  // packages/lib, outside this scope.
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toHaveCount(0);

  const scopedToApp = await readReport(page);
  expect(scopedToApp.report.scope).toBe('packages/app');
  expect(scopedToApp.report.issues).toEqual([]);

  // Narrow to packages/lib instead — the issue (and its tree row) reappear.
  await switcher.click();
  await page.getByPlaceholder('Search workspaces…').fill('lib');
  await page.getByTestId('workspace-option-packages/lib').click();
  await expect(page.getByTestId('rerun-button')).toBeEnabled({ timeout: 15_000 });
  await expect(switcher).toHaveAttribute('title', 'packages/lib');
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toBeVisible();

  const scopedToLib = await readReport(page);
  expect(scopedToLib.report.scope).toBe('packages/lib');
  expect(scopedToLib.report.issues).toHaveLength(1);
  await expect(page).toHaveURL(/[?&]ws=packages(%2F|\/)lib/);

  // Reload with a scoped URL (#14): the `ws` param survives the reload and the
  // UI still shows the scoped workspace. NOTE this does NOT exercise the boot
  // RESCAN branch — the server persists the scoped report across the reload,
  // so URL and report scope already agree and the boot effect latches without
  // scanning. What this pins: the param is retained, and the switcher/tree
  // read the scope from the (persisted) report rather than snapping back to
  // All. The rescan branch is exercised by the deep-load test below.
  await page.reload();
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/[?&]ws=packages(%2F|\/)lib/);
  await expect(switcher).toHaveAttribute('title', 'packages/lib', { timeout: 15_000 });
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toBeVisible();
  expect((await readReport(page)).report.scope).toBe('packages/lib');

  // Back to All workspaces — full report + tree restored.
  await switcher.click();
  await page.getByTestId('workspace-option-.').click();
  await expect(page.getByTestId('rerun-button')).toBeEnabled({ timeout: 15_000 });
  await expect(switcher).toHaveAttribute('title', 'All workspaces');
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toBeVisible();
  // All/'.' removes the param entirely rather than serializing `ws=.`.
  await expect(page).toHaveURL(/^(?!.*[?&]ws=).*$/);

  const scopedToAll = await readReport(page);
  expect(scopedToAll.report.scope).toBeUndefined();
});

test('deep-loading a URL whose ws differs from the server scope triggers the boot rescan to that workspace (#14)', async ({
  page,
}) => {
  const switcher = page.getByTestId('workspace-switcher');

  // Precondition: pin the server scope to packages/app via the UI so the
  // deep-load below carries a GENUINELY different ws. The previous test
  // happens to end on All workspaces (also a mismatch), but setting the scope
  // explicitly keeps this test honest even if that test's ending changes.
  await page.goto(BASE_URL);
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await switcher.click();
  // The combobox's own cmdk input, NOT getByPlaceholder: this test starts on
  // /dashboard, whose workspace-table search shares the same placeholder text.
  await page.locator('[data-slot="command-input"]').fill('app');
  await page.getByTestId('workspace-option-packages/app').click();
  await expect(page.getByTestId('rerun-button')).toBeEnabled({ timeout: 15_000 });
  await expect(switcher).toHaveAttribute('title', 'packages/app');
  expect((await readReport(page)).report.scope).toBe('packages/app');

  // Fresh page load carrying ws=packages/lib: the URL disagrees with the
  // server's packages/app report, so the root layout's one-shot boot effect
  // (router.tsx) must fire a scoped rescan to packages/lib — the branch the
  // reload assertion in the previous test can't reach (there, URL and
  // persisted scope already agree). The switcher label flipping to the URL's
  // workspace is the user-visible proof the rescan ran and landed.
  await page.goto(`${BASE_URL}/code?ws=${encodeURIComponent('packages/lib')}`);
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(switcher).toHaveAttribute('title', 'packages/lib', { timeout: 30_000 });

  // The URL kept the ws it was loaded with — the boot-rescan gate
  // (bootRescanRef, router.tsx) keeps the reconcile effect from stripping it
  // while the boot scan is still landing.
  await expect(page).toHaveURL(/[?&]ws=packages(%2F|\/)lib/);

  // The report really was rescanned to the URL's scope, and the scoped issue
  // (packages/lib's one orphaned file) is in the tree.
  expect((await readReport(page)).report.scope).toBe('packages/lib');
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toBeVisible();

  // Leave the shared server back on All workspaces so any future test in this
  // file starts from the default scope, same courtesy as the previous test.
  await switcher.click();
  await page.getByTestId('workspace-option-.').click();
  await expect(page.getByTestId('rerun-button')).toBeEnabled({ timeout: 15_000 });
  await expect(switcher).toHaveAttribute('title', 'All workspaces');
});
