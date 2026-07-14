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
