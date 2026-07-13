// Regression spec for the CodePane blank-screen crash (whole-branch review
// finding, Task 6 follow-up fix): CodeBlock's gutter-marker overlay rendered
// `lineIssues.get(line)!.map(...)` against `markers` state that can be one
// render stale relative to the `lineIssues` prop. When a rescan prunes an
// issue while the code pane is open on the SAME file, that render pass sees
// old (still-flagged) `markers` but a new `lineIssues` map that no longer has
// the entry -> `get()` returns undefined -> the `!` non-null assertion throws
// -> React unmounts the whole root (no error boundary existed) -> blank page.
//
// Reproduces the reviewer's exact repro shape but targets `src/used.ts`'s
// `Color.Blue` enumMember issue (line 11) rather than the `unusedHelper`
// export (line 5) smoke.spec.ts already consumes via its Fix flow — this
// keeps the spec independent of run order/state, same rationale as
// ignore.spec.ts targeting `left-pad` instead of smoke.spec.ts's issues (see
// that file's doc comment). File name sorts before both existing specs, so it
// runs first against the fresh fixture regardless.
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('code pane open on a file survives a rescan that prunes one of its issues', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('nav-code').click();
  await page.getByRole('button', { name: 'Expand src' }).click();

  // Open src/used.ts in the code pane (the file row's name button, not the
  // "Expand used.ts" toggle — see TreeNode.tsx's onOpenFile wiring).
  await page.getByTestId('tree-file-src/used.ts').getByRole('button', { name: 'used.ts', exact: true }).click();

  const badge = page.getByTestId('code-pane-badge-enumMembers-Blue');
  await expect(badge).toBeVisible();
  await badge.getByRole('checkbox').check();

  await expect(page.getByTestId('selection-count')).toHaveText('1 selected');

  await page.getByRole('button', { name: 'Ignore', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  // Ignoring an enumMember inserts an @public JSDoc tag directly into the
  // source file (see src/fix/compiler.ts's compileIgnorePlan enumMembers
  // case) rather than editing the knip config.
  const diff = page.getByTestId('diff-view-src/used.ts');
  await expect(diff).toBeVisible({ timeout: 10_000 });
  await expect(diff).toContainText('@public');

  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('result-status-src/used.ts')).toHaveText('ok', { timeout: 10_000 });

  // The code pane is still open BEHIND the modal (App.tsx keeps it mounted)
  // while the background rescan runs. Wait for the rescan to actually drop
  // the now-ignored issue's badge — this is the moment the old code crashed.
  await expect(badge).toHaveCount(0, { timeout: 30_000 });

  // App did NOT blank: the persistent chrome (sidebar footer's scan stamp,
  // sidebar nav) and the code pane's own content are all still there and
  // functioning.
  await expect(page.getByText(/^Scanned /)).toBeVisible();
  await expect(page.getByTestId('nav-code')).toBeVisible();
  await expect(page.locator('.code-pane-html')).toContainText('usedHelper');
  // The still-open unusedHelper export issue on the same file is unaffected
  // and its badge is still rendered — confirms the overlay re-synced with
  // the fresh report rather than the whole pane going empty/stale.
  await expect(page.getByTestId('code-pane-badge-exports-unusedHelper')).toBeVisible();

  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(dialog).toHaveCount(0);
});
