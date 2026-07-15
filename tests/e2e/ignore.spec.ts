// Ignore-loop e2e smoke test: dependencies facet table -> select the
// `left-pad` unused dependency -> Ignore -> preview shows a knip.json diff ->
// apply -> rescan drops the row. Runs against the SAME fixture/server as
// smoke.spec.ts (see playwright.config.ts's doc comment) but targets an
// unrelated issue (a dependency, not an export/file), so it's independent of
// whatever state smoke.spec.ts left behind.
//
// ORDER DEPENDENCY (reciprocal of context-preview.spec.ts's header): this
// spec permanently consumes the fixture's ONLY unused dependency (left-pad),
// so context-preview.spec.ts — which needs that row to click — must run
// FIRST. The suite runs workers:1 with alphabetical file discovery, and
// 'context-preview' sorts before 'ignore'; renaming either file, or adding
// an alphabetically-earlier spec that mutates the fixture, breaks that spec,
// not this one.
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('select left-pad dependency, ignore, preview shows knip.json diff, rescan clears it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  // Packages nav (sidebar) — dependency-shaped issues, including left-pad,
  // render in a per-workspace grouped table there (see PackagesPage.tsx).
  await page.getByTestId('nav-packages').click();

  // The exact IssueType (dependencies/devDependencies/optionalPeerDependencies)
  // is an implementation detail of how knip classifies it — match on the
  // symbol suffix rather than assuming which one.
  const row = page.locator('[data-testid^="packages-row-"][data-testid$="-left-pad"]');
  await expect(row).toBeVisible();

  // Keyboard accessibility pin (Task 4 review finding, still true post-
  // Task Q's resizable-split preview panel): the row must be reachable and
  // operable without a mouse — focusable (tabindex=0, exposed as a button)
  // and Enter must open the preview panel (CodePane, Task Q/#24). Playwright
  // key events are trusted, unlike the Browser pane's synthetic dispatch.
  // Runs BEFORE the ignore flow below, since that flow removes this row
  // entirely (and this spec runs before any later packages spec would —
  // file order).
  await expect(row).toHaveAttribute('role', 'button');
  await expect(row).toHaveAttribute('tabindex', '0');
  await row.press('Enter');
  const preview = page.getByTestId('packages-preview');
  // toBeVisible BEFORE toContainText (task Q review, MINOR 4): textContent
  // assertions pass against a zero-width element — exactly the sliver-bug
  // class the resize('35%') fix in PackagesPage exists for — so visibility
  // (nonzero box) must be pinned in its own right, not implied.
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('left-pad');
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await preview.boundingBox())?.width ?? -1)
    .toBe(0);

  await row.getByRole('checkbox').check();

  await expect(page.getByTestId('selbar-count')).toHaveText('1 selected');

  await page.getByTestId('selbar-ignore').click();

  // Review page opened directly (no modal — Task 3, v0.3 replaces the old
  // ActionModal this spec used to drive).
  const reviewPage = page.getByTestId('review-page');
  await expect(reviewPage).toBeVisible();
  await expect(page.getByTestId('review-header')).toContainText('Ignore 1 issue');

  await page.getByTestId('review-preview').click();

  // Preview: the ignore compiler writes an ignoreDependencies entry into the
  // fixture's knip.json (findKnipConfig prefers a dedicated knip.json over
  // package.json#knip when one exists — see src/ignore/config-writer.ts).
  // Assert the diff CONTENT, not just visibility: the added lines must be
  // the ignoreDependencies entry naming left-pad.
  const knipRow = page.getByTestId('review-rail-row-knip.json');
  await expect(knipRow).toBeVisible({ timeout: 10_000 });
  const knipJsonDiff = page.getByTestId('diff-view-knip.json');
  await expect(knipJsonDiff).toBeVisible();
  await expect(knipJsonDiff).toContainText('ignoreDependencies');
  await expect(knipJsonDiff).toContainText('left-pad');

  await page.getByTestId('review-apply').click();

  await expect(knipRow).toContainText('applied ok', { timeout: 10_000 });

  // Wait for the background rescan: left-pad's row disappears once the fresh
  // report no longer reports it as unused. The Packages page is unmounted
  // while the Review page is up, so this check happens after leaving.
  await page.getByTestId('review-skip').click();
  await expect(reviewPage).toHaveCount(0);
  await expect(row).toHaveCount(0, { timeout: 30_000 });
});
