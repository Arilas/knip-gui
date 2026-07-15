// Packages row-click context preview e2e spec (Task Q, #24): click the
// left-pad dependency row -> the resizable right-hand panel opens showing
// package.json with left-pad's declaration line highlighted via CodePane's
// own gutter badge (reused, not reimplemented) -> the close button collapses
// the panel back to 0-width -> re-clicking the same row reopens it.
//
// Filename deliberately does NOT start with "packages-preview" (the shape
// this task's own brief suggested) — it has to sort ALPHABETICALLY BEFORE
// ignore.spec.ts. ignore.spec.ts's own test permanently removes left-pad
// from the shared fixture's issue set (adds an ignoreDependencies entry to
// knip.json, then waits for the post-apply rescan to confirm the row is
// gone) — left-pad is the ONLY dependency-shaped issue the fixture produces
// (tests/fixtures/single/package.json declares just the one
// `{ "dependencies": { "left-pad": "1.3.0" } }`). Any spec that needs
// left-pad to still be flagged unused must run strictly before that
// mutation lands. Given playwright.config.ts's single shared webServer/
// fixture (`fullyParallel: false`, `workers: 1`), file execution order is
// the fs-glob's alphabetical order — confirmed directly via
// `npx playwright test --list` — and codepane-crash.spec.ts's own doc
// comment already documents and relies on this exact same mechanism to run
// ahead of smoke/filters/ignore/review.
//
// The fixture has no unresolved-import issue (package.json declares only a
// `dependencies` entry — see tests/fixtures/single/package.json and
// knip.json), so this spec covers the dependency-kind case only, per the
// task brief's own fallback note for that scenario.
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('clicking the left-pad row opens the preview panel at its line; close collapses it; re-click reopens', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('nav-packages').click();

  // Match on the symbol suffix, not the exact IssueType, same convention
  // ignore.spec.ts uses — which dependency bucket knip files left-pad under
  // is an implementation detail this spec doesn't need to assume.
  const row = page.locator('[data-testid^="packages-row-"][data-testid$="-left-pad"]');
  await expect(row).toBeVisible();

  const preview = page.getByTestId('packages-preview');
  // Fully collapsed until a row is clicked (own persistence key
  // 'knip-packages-split', a fresh — so unpersisted — browser context here).
  expect((await preview.boundingBox())?.width ?? 0).toBe(0);

  await row.click();

  await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  // Active-row indicator (data-state powers ui/table.tsx's own
  // data-[state=selected]:bg-muted styling; aria-selected mirrors it for
  // assistive tech).
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(row).toHaveAttribute('data-state', 'selected');

  await expect(preview).toContainText('left-pad');
  await expect(preview).toContainText('package.json');

  // CodePane's gutter badge for the synthesized line — knip's own
  // dependency-shaped JSON carries no line/col/pos at all (confirmed via
  // `knip --reporter json` against this fixture: bare `{"name":"left-pad"}`),
  // so PackagesPage locates the declaration line itself (lib/mentions.ts's
  // findDeclarationLine) and hands CodePane a patched issue — this is the
  // SAME badge/testid convention CodePane renders on the Code page.
  const badge = preview.locator('[data-testid^="code-pane-badge-"][data-testid$="-left-pad"]');
  await expect(badge).toBeVisible();

  // The flagged line gets CodePane's own highlight-tint + scroll target —
  // pins the actual auto-scroll/highlight DOM effect, not just the badge.
  await expect(preview.locator('.code-pane-flagged-line-bg')).toBeVisible();

  // "Other mentions" line (dependency-kind rows only): left-pad appears
  // exactly once in package.json (its own dependencies entry), so "other"
  // mentions — beyond the one CodePane's badge already points at — is 0.
  await expect(preview.getByTestId('packages-preview-mentions')).toContainText('No other mentions');

  // Close button collapses the panel back to 0 width and clears the
  // active-row indicator.
  await page.getByTestId('packages-preview-close').click();
  await expect.poll(async () => (await preview.boundingBox())?.width ?? -1).toBe(0);
  await expect(row).toHaveAttribute('aria-selected', 'false');

  // Re-clicking the SAME row reopens it — the local scroll-nonce bump
  // (deliberately not the ui-store's Code-page openFileNonce) re-fires
  // CodePane's auto-scroll/pulse even though nothing else about the issue
  // changed.
  await row.click();
  await expect.poll(async () => (await preview.boundingBox())?.width ?? 0).toBeGreaterThan(0);
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(preview).toContainText('left-pad');
  await expect(badge).toBeVisible();
});
