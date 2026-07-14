// Full fix-loop e2e smoke test against the real built client + server,
// driven by a real browser (Playwright), against a throwaway git-initialized
// copy of tests/fixtures/single (see scripts/e2e-fixture.ts + this repo's
// playwright.config.ts webServer command). Mutates that copy: selects the
// `unusedHelper` unused export (src/used.ts) and the `orphan.ts` unused file,
// fixes both, waits for the background rescan to clear them from the tree,
// then commits. See playwright.config.ts's doc comment for why this and
// ignore.spec.ts are independent of each other (different target issues) but
// still run serially (workers: 1) against the one shared fixture/server.
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('select unused export + unused file, fix, rescan clears them, commit', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('knip-gui');

  // Report ready: TopBar only renders the "Scanned <time>" stamp once
  // report.scannedAt is set (i.e. the initial fire-and-forget scan finished).
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  // Switch to the Code page (sidebar nav, not the old facet rail). The
  // rebuilt tree auto-expands every directory when the project has few
  // files (see lib/tree.ts's autoExpandDepth — this fixture is well under
  // the 200-file threshold), so src/ is already open; no expand click needed.
  await page.getByTestId('nav-code').click();

  // The rebuilt tree no longer has per-issue child rows (a file row's whole
  // click opens the file instead of expanding it — see TreeNode.tsx's doc
  // comment) — select the specific unusedHelper export via the code pane's
  // gutter badge instead, then check the orphan.ts file row directly.
  await page.getByTestId('tree-file-src/used.ts').click();
  const exportBadge = page.getByTestId('code-pane-badge-exports-unusedHelper');
  await expect(exportBadge).toBeVisible();
  await exportBadge.getByRole('checkbox').check();

  await page.getByTestId('tree-file-src/orphan.ts').getByRole('checkbox').check();

  await expect(page.getByTestId('selection-count')).toHaveText('2 selected');

  await page.getByRole('button', { name: 'Fix…' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // orphan.ts's only fix mode is delete-file, so the options step shows the
  // file-deletion confirm checkbox and blocks Next until it's checked.
  await page.getByLabel('I understand these files will be permanently deleted.').check();
  await page.getByRole('button', { name: 'Next' }).click();

  // Preview step: exactly 2 diffs (src/used.ts strip-export, src/orphan.ts delete).
  await expect(page.locator('[data-testid^="diff-view-"]')).toHaveCount(2, { timeout: 10_000 });
  // Not just visible — the diff CONTENT must show the right change: the
  // used.ts diff touches the unusedHelper declaration, and the orphan.ts
  // diff is a whole-file deletion (renderDiff diffs against empty content
  // when patch.kind === 'delete' — see src/fix/diff.ts), so its single line
  // of content shows up as a `-` removal line.
  await expect(page.getByTestId('diff-view-src/used.ts')).toContainText('unusedHelper');
  await expect(page.getByTestId('diff-view-src/orphan.ts')).toContainText('-export const nobodyImportsMe');

  await page.getByRole('button', { name: 'Apply' }).click();

  // Results step: both files applied ok.
  await expect(page.getByTestId('result-status-src/used.ts')).toHaveText('ok', { timeout: 10_000 });
  await expect(page.getByTestId('result-status-src/orphan.ts')).toHaveText('ok');

  // Wait for the background rescan to land: the tree (still mounted behind
  // the open modal) drops both the unusedHelper issue row and the orphan.ts
  // file row entirely once the fresh report excludes them.
  await expect(page.getByTestId('tree-issue-exports-unusedHelper')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('tree-file-src/orphan.ts')).toHaveCount(0, { timeout: 30_000 });

  // Commit panel: prefilled message, commit, sha rendered.
  const messageBox = page.getByLabel('Commit message');
  await expect(messageBox).toHaveValue(/^chore\(knip\): remove/);
  await page.getByRole('button', { name: 'Commit', exact: true }).click();

  const commitSha = page.getByTestId('commit-sha');
  await expect(commitSha).toBeVisible();
  await expect(commitSha).toContainText(/[0-9a-f]{7,40}/);

  // Escape at the results step closes the modal (native <dialog> Escape ->
  // 'cancel' -> 'close', not blocked here since flow.status isn't 'applying'
  // — this was flagged untestable via the Browser pane in Task 5 since it
  // needs a real trusted key event, which Playwright can send).
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
