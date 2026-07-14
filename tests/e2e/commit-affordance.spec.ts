// Sidebar commit-affordance e2e coverage (Task 5, v0.3 papercuts): the
// footer's "N uncommitted" button + CommitDialog, reachable from anywhere in
// the app — not just the Review page's post-apply CommitBar, which this spec
// deliberately SKIPS to prove the footer affordance can pick up the applied
// file later on its own.
//
// Targets tests/fixtures/single's src/extra.ts (exports: unusedExtra) — a
// file no other spec touches (added specifically for this spec; see
// src/extra.ts's own doc-free two-function shape and index.ts's `usedExtra`
// import). Runs against the SAME shared fixture/server as
// codepane-crash/filters/ignore/review/smoke specs (playwright.config.ts's
// single webServer) but is independent of run order since its target issue
// isn't claimed by any of them.
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const fixtureDir = path.join(process.cwd(), '.tmp-tests/e2e-fixture');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: fixtureDir, encoding: 'utf8' });
}

test('apply a fix, skip the commit bar, then commit later via the sidebar footer affordance', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-code').click();

  // Fix src/extra.ts's unusedExtra export through the Review page, same as
  // review.spec.ts's flow, but this time SKIP the commit bar entirely —
  // that's the whole point of this spec (the footer must pick this file up
  // as still-uncommitted afterward).
  await page.getByTestId('tree-file-src/extra.ts').click();
  const badge = page.getByTestId('code-pane-badge-exports-unusedExtra');
  await expect(badge).toBeVisible();
  await badge.getByRole('checkbox').check();
  await expect(page.getByTestId('selbar-count')).toHaveText('1 selected');

  await page.getByTestId('selbar-fix').click();
  await expect(page.getByTestId('review-page')).toBeVisible();
  await expect(page.getByTestId('review-header')).toContainText('Fix 1 issue');

  await page.getByTestId('review-preview').click();
  await expect(page.getByTestId('diff-view-src/extra.ts')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('review-apply').click();
  await expect(page.getByTestId('review-rail-row-src/extra.ts')).toContainText('applied ok', { timeout: 10_000 });

  const commitBar = page.getByTestId('review-commit-bar');
  await expect(commitBar).toBeVisible();
  await page.getByTestId('review-skip').click();
  await expect(page.getByTestId('review-page')).toHaveCount(0);

  // Back on Code (review.returnTo) — confirm explicitly, then create an
  // unrelated dirty file on disk BEFORE opening the dialog, mimicking
  // something already in progress in the working tree that knip-gui never
  // touched.
  await expect(page.getByTestId('tree-file-src/extra.ts')).toBeVisible();
  await writeFile(path.join(fixtureDir, 'UNRELATED.md'), 'not touched by knip-gui\n');

  // The footer button already reflects extra.ts as dirty (CommitBar's own
  // mount mid-apply refetched gitStatus, and GitFooter shares that same
  // query cache) — the UNRELATED.md write above isn't reflected yet, but
  // that's fine here: CommitDialog.tsx's open-effect explicitly re-fetches
  // gitStatus itself before building the checklist below, precisely so the
  // dialog never shows a stale dirty-file list.
  const commitButton = page.getByTestId('git-commit-button');
  await expect(commitButton).toContainText('uncommitted file', { timeout: 10_000 });

  // Keyboard access (design brief): Tab to the footer button, Enter opens
  // the dialog — not just a mouse click.
  await commitButton.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByTestId('commit-dialog');
  await expect(dialog).toBeVisible();

  // The applied file is pre-checked...
  const appliedRow = page.getByTestId('commit-dialog-row-src/extra.ts');
  await expect(appliedRow).toBeVisible();
  await expect(appliedRow.getByRole('checkbox')).toBeChecked();
  await expect(appliedRow).not.toContainText('not changed by knip-gui');

  // ...the unrelated file created via fs is NOT, and carries the hint.
  const unrelatedRow = page.getByTestId('commit-dialog-row-UNRELATED.md');
  await expect(unrelatedRow).toBeVisible();
  await expect(unrelatedRow.getByRole('checkbox')).not.toBeChecked();
  await expect(unrelatedRow).toContainText('not changed by knip-gui');

  // The message defaults to the reconciled "N file(s)" form since only the
  // knip-touched row is checked (lib/commit-dialog.ts's
  // defaultCommitDialogMessage).
  await expect(page.getByTestId('commit-dialog-message')).toHaveValue('chore(knip): commit 1 file');

  await page.getByTestId('commit-dialog-commit').click();
  const shaBox = page.getByTestId('commit-dialog-sha');
  await expect(shaBox).toBeVisible({ timeout: 10_000 });
  const shaText = (await shaBox.textContent()) ?? '';

  await page.getByTestId('commit-dialog-done').click();
  await expect(dialog).toHaveCount(0);

  // Reopen the dialog: the just-committed file must be gone from the dirty
  // checklist, while the unrelated file is still there — ground truth (from
  // the app's own point of view, not just git directly, see below) that the
  // affordance's view of the working tree is live, not stale. This doesn't
  // assert an exact total dirty-FILE count via the footer label, since this
  // spec runs in the same shared fixture as several others (playwright.config
  // .ts's single webServer) and some of them (e.g. codepane-crash.spec.ts)
  // deliberately leave their own applied fix uncommitted — asserting a global
  // count here would make this spec's outcome depend on run order.
  await commitButton.click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('commit-dialog-row-src/extra.ts')).toHaveCount(0);
  await expect(page.getByTestId('commit-dialog-row-UNRELATED.md')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Ground truth via git itself: exactly src/extra.ts was committed, and
  // UNRELATED.md remains untracked/uncommitted.
  const committedFiles = git(['show', '--stat=200', '--format=', 'HEAD']).trim();
  expect(committedFiles).toContain('src/extra.ts');
  expect(committedFiles).not.toContain('UNRELATED.md');
  expect(shaText).toContain(git(['rev-parse', '--short', 'HEAD']).trim());

  const statusAfter = git(['status', '--porcelain']);
  expect(statusAfter).toContain('UNRELATED.md');
  expect(statusAfter).not.toContain('src/extra.ts');

  // Clean up the unrelated file so later spec files (if any run after this
  // one) see a working tree whose only dirt is whatever THEY create.
  execFileSync('git', ['clean', '-f', 'UNRELATED.md'], { cwd: fixtureDir });
});
