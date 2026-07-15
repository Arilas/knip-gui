// Router integration e2e (Task R, #14): the active page and the open Code file
// live in the URL now, so a reload/deep-link/bookmark restores exactly where
// the user was, and browser Back/Forward move between pages. Drives the real
// built client + server (same harness as the other specs).
//
// Navigation-only: this spec never applies a fix/ignore and never commits, so
// it mutates nothing and is independent of run order. It opens src/used.ts,
// which is present in the shared fixture whenever this spec runs (its
// unusedHelper export is smoke.spec's target, fixed later in the serial run —
// same "target another spec's issue that hasn't happened yet" convention the
// other specs use).
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('page + open file live in the URL; reload and Back/Forward restore them', async ({ page }) => {
  await page.goto('/');
  // `/` redirects to /dashboard (the router's index + not-found both land here).
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  // Sidebar nav writes the pathname (a plain <Link>).
  await page.getByTestId('nav-code').click();
  await expect(page).toHaveURL(/\/code$/);

  // Opening a file writes the `file` search param.
  await page.getByTestId('tree-file-src/used.ts').click();
  await expect(page).toHaveURL(/\/code\?.*used\.ts/);
  // The code pane header reflects the open file.
  await expect(page.getByTestId('code-pane')).toContainText('src/used.ts');

  // Reload restores page + open file straight from the URL — NOT a fresh
  // Dashboard (the pre-router behavior this whole task replaces).
  await page.reload();
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/code\?.*used\.ts/);
  await expect(page.getByTestId('code-pane')).toContainText('src/used.ts');

  // Back: the open file drops (previous history entry was /code with no file)
  // and Code still renders.
  await page.goBack();
  await expect(page).toHaveURL(/\/code$/);
  await expect(page.getByTestId('code-tree')).toBeVisible();

  // Back again lands on Dashboard; Forward returns to Code — real history, not
  // a single in-place swap.
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/code$/);
});

test('direct-loading /review with no pending review redirects to /code', async ({ page }) => {
  // A reload/deep-link of /review with nothing selected has no request to
  // render — the route's beforeLoad guard (replaces App.tsx's old effect)
  // bounces it to /code.
  await page.goto('/review');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/code$/);
  await expect(page.getByTestId('review-page')).toHaveCount(0);
});
