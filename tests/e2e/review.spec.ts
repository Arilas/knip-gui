// Review page e2e coverage (Task 3, v0.3 — ActionModal's replacement).
// Targets tests/fixtures/single's src/forms.ts (listUnused/defaultUnused
// exports) and src/shapes.ts (UnusedShape type) — the only issues in the
// shared fixture no OTHER spec's target (see each spec's own "independent of
// run order" doc comment): src/used.ts's unusedHelper/Color.Blue are
// smoke.spec's/codepane-crash.spec's, src/orphan.ts is smoke.spec's,
// src/forms.ts's dupeAlias/unusedFlag are filters.spec's, and left-pad is
// ignore.spec's. Given the fixture only has 4 spare issues across 2 files,
// this file's "multi-file" test does double duty for the design brief's
// "rail shows ok" and "stale-file path" bullets in one plan (one file
// touched only by this app, one edited on disk mid-flow) rather than two
// fully separate multi-file plans — there simply aren't enough untouched
// fixture files left for two independent ones. The cancel test never applies
// anything (fixPreview doesn't write to disk), so its target issue is still
// present for the next test to re-select and actually fix — each `test()`
// below starts with its own `page.goto('/')`, which resets all client-side
// state (the selection cart included, being memory-only), so nothing is
// assumed to carry over except the fixture's own on-disk/report state.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('cancel from the preview step returns to Code with the selection intact', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-code').click();

  await page.getByTestId('tree-file-src/forms.ts').click();
  const badge = page.getByTestId('code-pane-badge-exports-listUnused');
  await expect(badge).toBeVisible();
  await badge.getByRole('checkbox').check();
  await expect(page.getByTestId('selbar-count')).toHaveText('1 selected');

  await page.getByTestId('selbar-fix').click();
  await expect(page.getByTestId('review-page')).toBeVisible();
  await expect(page.getByTestId('review-header')).toContainText('Fix 1 issue');

  await page.getByTestId('review-preview').click();
  await expect(page.getByTestId('diff-view-src/forms.ts')).toBeVisible({ timeout: 10_000 });

  // Cancel while previewed (not applying) — must leave immediately, no
  // Escape/outside-click gating like the old modal had (there's no dialog
  // here to gate in the first place).
  await page.getByTestId('review-cancel').click();
  await expect(page.getByTestId('review-page')).toHaveCount(0);

  // Back on Code, and the selection cart is untouched — nothing was ever
  // applied, so the same issue is still selected AND still selectable next.
  await expect(page.getByTestId('tree-file-src/forms.ts')).toBeVisible();
  await expect(page.getByTestId('selbar-count')).toHaveText('1 selected');
});

test('multi-file fix: rail distinguishes ok from a file edited on disk mid-flow; keyboard nav through the rail; Escape does not dismiss the page', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-code').click();

  // Client-side state (the selection cart included) is memory-only and does
  // NOT survive the fresh `page.goto('/')` reload above — only the fixture's
  // on-disk/server-side state carries over between tests in this file. The
  // previous test only previewed+cancelled (fixPreview never writes to
  // disk), so forms.ts's listUnused export is still an unfixed issue here;
  // re-select it from scratch, plus a second file's issue — src/shapes.ts's
  // UnusedShape type.
  await page.getByTestId('tree-file-src/forms.ts').click();
  const formsBadge = page.getByTestId('code-pane-badge-exports-listUnused');
  await expect(formsBadge).toBeVisible();
  await formsBadge.getByRole('checkbox').check();
  await expect(page.getByTestId('selbar-count')).toHaveText('1 selected');

  await page.getByTestId('tree-file-src/shapes.ts').click();
  const shapeBadge = page.getByTestId('code-pane-badge-types-UnusedShape');
  await expect(shapeBadge).toBeVisible();
  await shapeBadge.getByRole('checkbox').check();
  await expect(page.getByTestId('selbar-count')).toHaveText('2 selected');

  await page.getByTestId('selbar-fix').click();
  await expect(page.getByTestId('review-header')).toContainText('Fix 2 issues');

  await page.getByTestId('review-preview').click();
  const formsRow = page.getByTestId('review-rail-row-src/forms.ts');
  const shapesRow = page.getByTestId('review-rail-row-src/shapes.ts');
  await expect(formsRow).toBeVisible({ timeout: 10_000 });
  await expect(shapesRow).toBeVisible();

  // Keyboard nav (brief: "tab through rail"): a focused rail row responds to
  // both Enter and Space, switching which file's diff the main area shows —
  // never just mouse-clickable.
  await formsRow.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('diff-view-src/forms.ts')).toBeVisible();
  await shapesRow.focus();
  await page.keyboard.press(' ');
  await expect(page.getByTestId('diff-view-src/shapes.ts')).toBeVisible();

  // Escape must never dismiss the Review page — it's a page, not a dialog.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('review-page')).toBeVisible();
  await expect(page.getByTestId('review-apply')).toBeVisible();

  // Edit shapes.ts on disk — same working copy the server just hashed at
  // preview time — so its patch is stale by the time Apply runs, while
  // forms.ts (untouched) still applies cleanly.
  const shapesPath = path.join(process.cwd(), '.tmp-tests/e2e-fixture/src/shapes.ts');
  const original = await readFile(shapesPath, 'utf8');
  await writeFile(shapesPath, `${original}\n// stale-edit marker (review.spec.ts)\n`);

  await page.getByTestId('review-apply').click();
  await expect(formsRow).toContainText('applied ok', { timeout: 10_000 });
  await expect(shapesRow).toContainText('stale');

  // The commit bar's paths exclude the stale file — only forms.ts staged.
  const commitBar = page.getByTestId('review-commit-bar');
  await expect(commitBar).toBeVisible();
  await expect(commitBar).toContainText('1 file: src/forms.ts');
  await expect(commitBar).not.toContainText('shapes.ts');

  await page.getByTestId('review-skip').click();
  await expect(page.getByTestId('review-page')).toHaveCount(0);
});

test('ignore flow through the review page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-code').click();

  await page.getByTestId('tree-file-src/forms.ts').click();
  // src/forms.ts's default export (defaultUnused) — knip reports a default
  // export's symbol as the literal string 'default' (not the declared
  // function name). NOT reexportSource: a re-export has no local
  // declaration to attach an @public JSDoc tag to, so ignoring it is a
  // genuine (correctly-surfaced) compile failure, not a valid ignore target.
  const badge = page.getByTestId('code-pane-badge-exports-default');
  await expect(badge).toBeVisible();
  await badge.getByRole('checkbox').check();
  await expect(page.getByTestId('selbar-count')).toHaveText('1 selected');

  await page.getByTestId('selbar-ignore').click();
  await expect(page.getByTestId('review-header')).toContainText('Ignore 1 issue');

  await page.getByTestId('review-preview').click();
  const diff = page.getByTestId('diff-view-src/forms.ts');
  await expect(diff).toBeVisible({ timeout: 10_000 });
  // Ignoring an exports-type issue inserts an @public JSDoc tag directly in
  // the source file (compileIgnorePlan's exports/types case), not a config edit.
  await expect(diff).toContainText('@public');

  await page.getByTestId('review-apply').click();
  await expect(page.getByTestId('review-rail-row-src/forms.ts')).toContainText('applied ok', { timeout: 10_000 });

  await page.getByTestId('review-skip').click();
  await expect(page.getByTestId('review-page')).toHaveCount(0);
  await expect(page.getByTestId('tree-file-src/forms.ts')).toBeVisible();
});
