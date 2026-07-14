// Ignore-loop e2e smoke test: dependencies facet table -> select the
// `left-pad` unused dependency -> Ignore -> preview shows a knip.json diff ->
// apply -> rescan drops the row. Runs against the SAME fixture/server as
// smoke.spec.ts (see playwright.config.ts's doc comment) but targets an
// unrelated issue (a dependency, not an export/file), so it's independent of
// whatever state smoke.spec.ts left behind.
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

  // Keyboard accessibility pin (Task 4 review finding): the row must be
  // reachable and operable without a mouse — focusable (tabindex=0, exposed
  // as a button) and Enter must open the detail Sheet. Playwright key events
  // are trusted, unlike the Browser pane's synthetic dispatch. Runs BEFORE
  // the ignore flow below, since that flow removes this row entirely (and
  // this spec runs before any later packages spec would — file order).
  await expect(row).toHaveAttribute('role', 'button');
  await expect(row).toHaveAttribute('tabindex', '0');
  await row.press('Enter');
  const sheet = page.getByTestId('package-detail-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('left-pad');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  await row.getByRole('checkbox').check();

  await expect(page.getByTestId('selection-count')).toHaveText('1 selected');

  await page.getByRole('button', { name: 'Ignore', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await page.getByRole('button', { name: 'Next' }).click();

  // Preview: the ignore compiler writes an ignoreDependencies entry into the
  // fixture's knip.json (findKnipConfig prefers a dedicated knip.json over
  // package.json#knip when one exists — see src/ignore/config-writer.ts).
  // Assert the diff CONTENT, not just visibility: the added lines must be
  // the ignoreDependencies entry naming left-pad.
  const knipJsonDiff = page.getByTestId('diff-view-knip.json');
  await expect(knipJsonDiff).toBeVisible({ timeout: 10_000 });
  await expect(knipJsonDiff).toContainText('ignoreDependencies');
  await expect(knipJsonDiff).toContainText('left-pad');

  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByTestId('result-status-knip.json')).toHaveText('ok', { timeout: 10_000 });

  // Wait for the background rescan: left-pad's row disappears once the fresh
  // report no longer reports it as unused (rendered behind the still-open
  // modal, same as smoke.spec.ts's tree assertions).
  await expect(row).toHaveCount(0, { timeout: 30_000 });

  // Close out via the commit panel's Skip (git repo is initialized, so
  // CommitPanel — not a plain Done button — renders here); committing isn't
  // this spec's concern.
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(dialog).toHaveCount(0);
});
