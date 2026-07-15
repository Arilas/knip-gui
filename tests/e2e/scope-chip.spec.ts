// Exercises the Code page's workspace path-scope chip + promote flow
// (Task W, #29): the fix for the bug report's exact complaint — a Dashboard
// workspace-table click used to stuff a path prefix into the free-text
// search box, indistinguishable from the sidebar's REAL scoped-rescan
// switcher and unable to be typed into afterward. Now a workspace click sets
// a removable chip (state/ui.ts's `codeScope`) that composes with the search
// box instead of occupying it, plus a one-click "Scan only this workspace"
// promote that hands off to the real switcher flow.
//
// Runs its own short-lived server against a throwaway copy of
// tests/fixtures/monorepo — same rationale and conventions as
// workspace-switcher.spec.ts (a REAL Dashboard workspace table needs a
// REAL multi-workspace report; the shared webServer in playwright.config.ts
// is deliberately single-workspace). Verified against a real `knip` run on
// this fixture (see workspace-switcher.spec.ts's own header comment): a
// full-project scan flags exactly one issue, packages/lib/extra.ts (a fully
// orphaned file, fixable via delete-file). packages/app owns none of the
// SHARED fixture's issues — Dashboard's workspace table only ever lists
// workspaces that own at least one issue (lib/dashboard.ts's workspaceRows
// groups purely off `issues`), so a second orphaned file is written into
// THIS spec's own private throwaway copy only (never the shared source
// tests/fixtures/monorepo other specs rely on) to give packages/app a row
// and a visible "chip narrows the tree to a different workspace" case.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// One above production-mode.spec.ts's 4820 — entirely separate server/port
// from every other spec in this directory.
const PORT = 4821;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const fixtureSrc = fileURLToPath(new URL('../fixtures/monorepo/', import.meta.url));
const workDir = fileURLToPath(new URL('../../.tmp-tests/scope-chip-fixture/', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let server: ChildProcess | undefined;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: workDir, stdio: 'ignore' });
}

// Same self-healing rationale as workspace-switcher.spec.ts's reapStrayServer.
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
  // Gives packages/app its own real, fixable issue (mirrors extra.ts's shape
  // exactly) — see this file's header comment for why this is written here
  // rather than into the shared fixture source.
  await writeFile(path.join(workDir, 'packages/app/orphan.ts'), 'export const appOrphan = true;\n');
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

test('dashboard workspace click sets a scope chip (not the search box); X restores the full tree', async ({
  page,
}) => {
  await page.goto(BASE_URL);
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  // Root redirects to /dashboard.
  await expect(page.getByTestId('workspace-row-packages/app')).toBeVisible();

  // packages/app owns its own single issue (orphan.ts, written into this
  // spec's private fixture copy — see header comment) — scoping to it must
  // hide packages/lib's issue, a clean, visible narrowing.
  await page.getByTestId('workspace-open-packages/app').click();

  await expect(page).toHaveURL(/\/code(\?|$)/);
  const chip = page.getByTestId('scope-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('packages/app');

  // The #29 bug this fixes: the search box must stay genuinely empty (and
  // thus typeable), never pre-filled with the workspace path.
  await expect(page.getByTestId('tree-search')).toHaveValue('');

  // Scoped to packages/app: its own file shows, packages/lib's does not.
  await expect(page.getByTestId('tree-file-packages/app/orphan.ts')).toBeVisible();
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toHaveCount(0);

  // Clearing the chip restores the full (unscoped) tree.
  await page.getByTestId('scope-chip-clear').click();
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(page.getByTestId('tree-file-packages/lib/extra.ts')).toBeVisible();
  await expect(page.getByTestId('tree-file-packages/app/orphan.ts')).toBeVisible();

  // No rescan ever happened — this was purely a client-side view filter.
  await expect(page.getByTestId('workspace-switcher')).toHaveAttribute('title', 'All workspaces');
});

test('typing in the search box filters WITHIN the chip scope; promote prompts for a selection, rescans directly without one', async ({
  page,
}) => {
  await page.goto(BASE_URL);
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('workspace-row-packages/lib')).toBeVisible();

  // Scope to packages/lib this time — it owns the fixture's one issue, so
  // there's a file to search for and select.
  await page.getByTestId('workspace-open-packages/lib').click();
  const chip = page.getByTestId('scope-chip');
  await expect(chip).toContainText('packages/lib');
  await expect(page.getByTestId('tree-search')).toHaveValue('');
  const file = page.getByTestId('tree-file-packages/lib/extra.ts');
  await expect(file).toBeVisible();

  // Search composes WITH the chip rather than replacing it: a non-matching
  // term hides the file while the chip (and its scope) stays put...
  const search = page.getByTestId('tree-search');
  await search.fill('does-not-match-anything');
  await expect(file).toHaveCount(0);
  await expect(chip).toContainText('packages/lib');

  // ...and clearing the search brings it back, still within the same scope.
  await search.fill('');
  await expect(file).toBeVisible();

  // Select the file (checkbox) so the promote-with-a-selection path has
  // something to warn about discarding.
  await page.getByLabel('Select issues in packages/lib/extra.ts').click();

  const promote = page.getByTestId('scope-chip-promote');
  await expect(promote).toBeVisible();
  await promote.click();

  // A non-empty selection routes through the shared discard-selection
  // confirm (WorkspaceSwitchConfirmDialog) rather than switching immediately.
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByText(/switching workspaces re-scans/i)).toBeVisible();

  // Cancel ("Keep selection"): no scan happened, the chip and selection both
  // survive untouched.
  await page.getByRole('button', { name: 'Keep selection' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(chip).toBeVisible();
  await expect(page.getByTestId('workspace-switcher')).toHaveAttribute('title', 'All workspaces');

  // Clear the selection, then promote again — with nothing to discard, this
  // time it rescans directly with no confirm step.
  await page.getByLabel('Select issues in packages/lib/extra.ts').click();
  await promote.click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  await expect(page.getByTestId('rerun-button')).toBeDisabled();
  await expect(page.getByTestId('rerun-button')).toBeEnabled({ timeout: 15_000 });

  // A successful promote clears the chip — the real, rescanned scope
  // supersedes the client-side view filter it stood in for — and the
  // sidebar switcher picks up the new scope, closing the loop the #29 bug
  // report asked for (a workspace click DOES eventually drive the switcher).
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);
  await expect(page.getByTestId('workspace-switcher')).toHaveAttribute('title', 'packages/lib');
  await expect(page).toHaveURL(/[?&]ws=packages(%2F|\/)lib/);

  // Leave the shared server back on All workspaces, matching the courtesy
  // reset in workspace-switcher.spec.ts.
  const switcher = page.getByTestId('workspace-switcher');
  await switcher.click();
  await page.getByTestId('workspace-option-.').click();
  await expect(page.getByTestId('rerun-button')).toBeEnabled({ timeout: 15_000 });
  await expect(switcher).toHaveAttribute('title', 'All workspaces');
});
