// Full fix-loop e2e smoke test against the real built client + server,
// driven by a real browser (Playwright), against a throwaway git-initialized
// copy of tests/fixtures/single (see scripts/e2e-fixture.ts + this repo's
// playwright.config.ts webServer command). Mutates that copy: selects the
// `unusedHelper` unused export (src/used.ts) and the `orphan.ts` unused file,
// fixes both through the Review page (Task 3, v0.3 — replaces the old
// ActionModal-driven flow this spec used to pin), waits for the background
// rescan to clear them from the tree, then commits. See playwright.config.ts's
// doc comment for why this and ignore.spec.ts are independent of each other
// (different target issues) but still run serially (workers: 1) against the
// one shared fixture/server.
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('select unused export + unused file, fix through the Review page, rescan clears them, commit', async ({
  page,
}) => {
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

  await expect(page.getByTestId('selbar-count')).toHaveText('2 selected');

  await page.getByTestId('selbar-fix').click();

  // Review page opened directly (no modal) — SelectionDock's Fix… hands off
  // to state/ui.ts's startReview, landing on the 'options' step.
  const reviewPage = page.getByTestId('review-page');
  await expect(reviewPage).toBeVisible();
  await expect(page.getByTestId('review-header')).toContainText('Fix 2 issues');

  // orphan.ts's only fix mode is delete-file, so the options step shows the
  // file-deletion confirm checkbox and blocks "Preview changes" until it's
  // checked.
  await page.getByLabel('I understand these files will be permanently deleted.').check();
  await page.getByTestId('review-preview').click();

  // Preview step: exactly 2 rail rows (src/used.ts strip-export, src/orphan.ts
  // delete), each showing ONE diff at a time in the main area (no more
  // ActionModal's stacked-diffs list — see FileRail.tsx's doc comment).
  const usedRow = page.getByTestId('review-rail-row-src/used.ts');
  const orphanRow = page.getByTestId('review-rail-row-src/orphan.ts');
  await expect(usedRow).toBeVisible({ timeout: 10_000 });
  await expect(orphanRow).toBeVisible();

  // orphan.ts sorts before used.ts, so it's the default-selected row; assert
  // its diff content (a whole-file deletion — renderDiff diffs against empty
  // content when patch.kind === 'delete', so its single line of content
  // shows up as a `-` removal line), then switch to used.ts's diff.
  await expect(page.getByTestId('diff-view-src/orphan.ts')).toContainText('-export const nobodyImportsMe');
  await usedRow.click();
  await expect(page.getByTestId('diff-view-src/used.ts')).toContainText('unusedHelper');

  await page.getByTestId('review-apply').click();

  // Applied step: both rows report ok (sr-only status text on each row).
  await expect(usedRow).toContainText('applied ok', { timeout: 10_000 });
  await expect(orphanRow).toContainText('applied ok');

  // Commit bar: prefilled message, commit, sha rendered.
  const messageBox = page.getByLabel('Commit message');
  await expect(messageBox).toHaveValue(/^chore\(knip\): remove/);
  await page.getByTestId('review-commit').click();

  const commitSha = page.getByTestId('review-commit-sha');
  await expect(commitSha).toBeVisible();
  await expect(commitSha).toContainText(/[0-9a-f]{7,40}/);

  // Escape never dismisses the Review page (it's a page, not a dialog) —
  // pin this before actually leaving via Done.
  await page.keyboard.press('Escape');
  await expect(reviewPage).toBeVisible();

  await page.getByTestId('review-done').click();
  await expect(reviewPage).toHaveCount(0);

  // Back on Code: wait for the background rescan to land. unusedHelper was
  // src/used.ts's ONLY code-type issue in this fixture, so once it's fixed
  // the whole FILE ROW disappears from the (issues-driven) tree — not just a
  // gutter badge inside an still-open pane — same as orphan.ts's row.
  await expect(page.getByTestId('tree-file-src/used.ts')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('tree-file-src/orphan.ts')).toHaveCount(0, { timeout: 30_000 });
});
