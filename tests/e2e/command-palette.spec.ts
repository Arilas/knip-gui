// Command palette + bare shortcuts e2e (Task P, #25): drives the real built
// client + server against the shared single-workspace fixture (same harness
// as routing.spec.ts/filters.spec.ts) — none of these flows mutate a fixture
// file, so this spec is independent of run order.
//
// Targets src/forms.ts for the "open a file via the palette" flow — untouched
// by any earlier-sorting spec (codepane-crash.spec.ts is the only one that
// sorts before this file, and it only touches src/used.ts) and by any
// later-sorting one before it runs (filters.spec.ts reads forms.ts's issues
// afterward but never before this spec has already run) — same "pick a file
// nobody else has gotten to yet" convention codepane-crash.spec.ts's own doc
// comment describes.
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('⌘K opens the palette (and toggles it closed again); typing a filename and pressing Enter opens it on the Code page', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  const paletteInput = page.getByPlaceholder('Search pages, files, workspaces, actions…');

  // Toggle: open, then close again with the same combo — proves it's a
  // toggle, not just an "open" binding.
  await page.keyboard.press('Meta+k');
  await expect(paletteInput).toBeVisible();
  await page.keyboard.press('Meta+k');
  await expect(paletteInput).toBeHidden();

  // Re-open, type a filename, Enter opens it — same open-file contract as a
  // tree-row click (the `file` search param + the code pane header).
  await page.keyboard.press('Meta+k');
  await expect(paletteInput).toBeVisible();
  await paletteInput.fill('src/forms.ts');
  await page.keyboard.press('Enter');

  await expect(paletteInput).toBeHidden();
  await expect(page).toHaveURL(/\/code\?.*forms\.ts/);
  await expect(page.getByTestId('code-pane')).toContainText('src/forms.ts');
});

test('"2" switches to the Code page from elsewhere', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.keyboard.press('2');
  await expect(page).toHaveURL(/\/code$/);
});

test('"/" focuses the Code page tree filter input, navigating there first if elsewhere', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.keyboard.press('/');
  await expect(page).toHaveURL(/\/code$/);
  await expect(page.getByTestId('tree-search')).toBeFocused();
});

test('"r" triggers a rescan (same gate as the sidebar Re-run button)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  // Dashboard has no auto-focused input, so the keydown lands outside any
  // typing context.
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.keyboard.press('r');

  // react-query flips a mutation's isPending synchronously on `.mutate()`,
  // before the request even resolves (same assertion pattern as
  // workspace-switcher.spec.ts's scoped-rescan check) — disabled then
  // re-enabled proves a real rescan ran, not just a no-op keypress.
  const rerunButton = page.getByTestId('rerun-button');
  await expect(rerunButton).toBeDisabled();
  await expect(rerunButton).toBeEnabled({ timeout: 15_000 });
});
