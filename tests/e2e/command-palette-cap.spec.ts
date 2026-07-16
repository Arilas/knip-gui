// CommandPalette Files-group cap pin (#38), mirroring dashboard.spec.ts's
// synthetic-intercept approach: with more distinct file paths than
// FILE_RESULTS_CAP (200), the palette must mount a bounded Files group,
// yet typing must still reach a path OUTSIDE the first 200 — proving the
// substring pre-limit scans the full path list, not the capped slice.
//
// Intercepts /api/report via page.route — nothing touches the shared
// fixture or the server, so (like dashboard.spec.ts and
// packages-virtualization.spec.ts) this spec is order-independent: it
// neither needs left-pad (consumed by ignore.spec.ts) nor mutates anything
// a later spec reads.
import { expect, test } from '@playwright/test';

const FILES = 300;
const pad = (i: number) => String(i).padStart(3, '0');

// Shape must match src/core/types.ts's Issue/Report and the /api/report
// envelope ({ status, report }) — same contract dashboard.spec.ts fabricates.
function syntheticReport() {
  const issues: unknown[] = [];
  for (let i = 0; i < FILES; i++) {
    issues.push({
      id: `exp-${pad(i)}`,
      type: 'exports',
      workspace: '.',
      filePath: `src/mod-${pad(i)}.ts`,
      symbol: `unused${i}`,
      fixable: true,
      fixModes: ['strip-export', 'delete-declaration'],
    });
  }
  return {
    status: 'ready',
    report: { issues, scannedAt: new Date().toISOString(), workspaces: ['.'] },
  };
}

test('palette caps mounted file items at 200 but still finds paths beyond the cap by typing', async ({ page }) => {
  await page.route('**/api/report', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticReport()) }),
  );

  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press('Meta+k');
  const paletteInput = page.getByPlaceholder('Search pages, files, workspaces, actions…');
  await expect(paletteInput).toBeVisible();

  // Empty query: the Files group holds the capped alphabetical slice.
  // Mounted-item budget = 200 files + 5 pages + 1 workspace entry ("All
  // workspaces" — the synthetic report has no other workspaces) + 1 action
  // (Re-run scan; no per-page filter items on /dashboard) = 207.
  const items = page.locator('[data-slot="command-item"]');
  await expect(page.getByText('src/mod-000.ts')).toBeVisible();
  expect(await items.count()).toBeLessThanOrEqual(207);

  // mod-299 sorts LAST — far outside the capped slice — but a query must
  // reach it: the pre-limit substring-scans all 300 paths.
  //
  // pressSequentially (not fill): fill() sets the input value in one shot,
  // and when the matching item was never mounted before (true here — none
  // of the first 200 alphabetical paths match "mod-299"), cmdk's
  // auto-select-first-item tracking doesn't follow a single synthetic
  // input event — the newly-mounted item renders but stays
  // data-selected="false" indefinitely, so a subsequent Enter is a no-op.
  // Real keystroke-by-keystroke typing (what pressSequentially simulates)
  // gives cmdk's internal effects a chance to re-run after each
  // intermediate render and the selection correctly lands on the sole
  // survivor. Verified against this exact scenario; command-palette.spec.ts's
  // fill()-then-Enter flow stays fine because that query's target file is
  // already mounted (below-cap fixture) when fill() fires.
  await paletteInput.pressSequentially('mod-299');
  await expect(page.getByText('src/mod-299.ts')).toBeVisible();
  expect(await items.count()).toBeLessThanOrEqual(207);

  // And Enter opens it — same open-file contract command-palette.spec.ts
  // pins for the below-cap path.
  await page.keyboard.press('Enter');
  await expect(paletteInput).toBeHidden();
  await expect(page).toHaveURL(/\/code\?.*mod-299\.ts/);
});
