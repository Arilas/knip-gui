// Regression spec for the CodePane blank-screen crash (whole-branch review
// finding, Task 6 follow-up fix): CodeBlock's gutter-marker overlay rendered
// `lineIssues.get(line)!.map(...)` against `markers` state that can be one
// render stale relative to the `lineIssues` prop. When a rescan prunes an
// issue while the code pane is open on the SAME file, that render pass sees
// old (still-flagged) `markers` but a new `lineIssues` map that no longer has
// the entry -> `get()` returns undefined -> the `!` non-null assertion throws
// -> React unmounts the whole root (no error boundary existed) -> blank page.
//
// Task 3 (v0.3) note: the ignore/apply step that used to run in a modal
// FLOATING OVER the still-mounted code pane now runs on the separate Review
// page (Code unmounts entirely while Review is up — see App.tsx's page
// switch). The hazardous transition this spec pins — the SAME mounted
// CodePane instance living through a rescan that removes one of its flagged
// lines — still happens, just after returning from Review: `ui.openFile`
// is page-scoped (state/ui.ts's `navigate` doc comment) and is cleared by the
// navigation back to Code, so the file is reopened (a fresh CodePane mount)
// and left mounted while the apply's background rescan (already in flight)
// lands and prunes the now-ignored issue.
//
// Targets src/used.ts's Color.Blue enumMember issue (line 11) rather than the
// unusedHelper export smoke.spec.ts consumes via its Fix flow — keeps this
// spec independent of run order/state, same rationale as ignore.spec.ts
// targeting left-pad instead of smoke.spec.ts's issues. File name sorts
// before smoke.spec.ts/filters.spec.ts/ignore.spec.ts/review.spec.ts, so it
// runs first against the fresh fixture regardless.
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('code pane reopened after an ignore survives the rescan that prunes its issue', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  // The rebuilt tree auto-expands every directory for a project this small
  // (see lib/tree.ts's autoExpandDepth), so src/ is already open on load.
  await page.getByTestId('nav-code').click();

  // Open src/used.ts in the code pane — a file row's whole click opens it
  // (no separate expand toggle on file rows in the rebuilt tree; see
  // components/code/TreeNode.tsx's doc comment).
  await page.getByTestId('tree-file-src/used.ts').click();

  const badge = page.getByTestId('code-pane-badge-enumMembers-Blue');
  await expect(badge).toBeVisible();
  await badge.getByRole('checkbox').check();

  await expect(page.getByTestId('selbar-count')).toHaveText('1 selected');

  await page.getByTestId('selbar-ignore').click();
  await expect(page.getByTestId('review-page')).toBeVisible();
  await expect(page.getByTestId('review-header')).toContainText('Ignore 1 issue');

  await page.getByTestId('review-preview').click();

  // Ignoring an enumMember inserts an @public JSDoc tag directly into the
  // source file (see src/fix/compiler.ts's compileIgnorePlan enumMembers
  // case) rather than editing the knip config.
  const diff = page.getByTestId('diff-view-src/used.ts');
  await expect(diff).toBeVisible({ timeout: 10_000 });
  await expect(diff).toContainText('@public');

  await page.getByTestId('review-apply').click();
  await expect(page.getByTestId('review-rail-row-src/used.ts')).toContainText('applied ok', { timeout: 10_000 });

  await page.getByTestId('review-skip').click();
  await expect(page.getByTestId('review-page')).toHaveCount(0);

  // Structural pin, not a vacuous wall-clock race: this spec only actually
  // exercises the crash if the background rescan triggered by the apply
  // (src/server/routes-fix.ts's triggerBackgroundRescan, fire-and-forget) is
  // STILL in flight at the moment src/used.ts remounts below. Assert that
  // precondition directly via an API poll (bypassing the client's own 2s
  // /api/report polling interval, which would be too coarse to catch a
  // narrow window) using the session token embedded in the page — if a
  // future change ever makes the rescan finish before this point, THIS
  // assertion is what fails loudly, rather than the badge-count check below
  // silently passing because there was nothing left to race.
  const token = await page.evaluate(
    () => document.querySelector('meta[name="knip-gui-token"]')?.getAttribute('content'),
  );
  const statusRes = await page.request.get('/api/report', { headers: { 'x-knip-gui-token': token! } });
  expect((await statusRes.json()).status, 'rescan should still be in flight here — see comment above').toBe(
    'scanning',
  );

  // Back on Code — ui.openFile is page-scoped and was cleared by the
  // navigation back, so reopen src/used.ts explicitly (a fresh CodePane
  // mount, left mounted from here on). The apply's background rescan is
  // confirmed still in flight above; wait for it to land and actually drop
  // the now-ignored issue's badge — this is the moment the old code crashed.
  await page.getByTestId('tree-file-src/used.ts').click();
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
});
