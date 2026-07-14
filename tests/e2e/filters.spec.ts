// Filter-aware selection e2e spec (Task 3, UX overhaul): pins the core
// invariant that disabling a Code page filter chip changes what a file/dir
// checkbox click ADDS to the cart, but never retroactively prunes anything
// already selected. Targets src/forms.ts (exports: listUnused/default/
// reexportSource, duplicates: dupeAlias, namespaceMembers: unusedFlag) — a
// file untouched by any other spec, so this is independent of run order
// (see codepane-crash.spec.ts's doc comment for the same rationale re:
// src/used.ts/left-pad).
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('disabling a filter chip gates what a file checkbox adds; the cart survives re-enabling; fix still applies', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  // The rebuilt tree auto-expands every directory for a project this small
  // (see lib/tree.ts's autoExpandDepth), so src/ is already open on load.
  await page.getByTestId('nav-code').click();

  const exportsChip = page.getByTestId('filter-chip-exports');
  await expect(exportsChip).toBeVisible();
  await expect(exportsChip).toHaveAttribute('aria-pressed', 'true');

  // Disable "Unused exports".
  await exportsChip.click();
  await expect(exportsChip).toHaveAttribute('aria-pressed', 'false');

  // Check the whole forms.ts file: with exports disabled, only its
  // duplicates (dupeAlias) and namespaceMembers (unusedFlag) issues are
  // actionable-and-enabled — its 3 export issues (listUnused/default/
  // reexportSource) must NOT be added.
  await page.getByTestId('tree-file-src/forms.ts').getByRole('checkbox').check();

  await expect(page.getByTestId('selbar-count')).toHaveText('2 selected');
  // Pluralized per-type text (Task 2, v0.3 — lib/pluralize.ts's
  // pluralizeType, not the old raw-IssueType "1 duplicates"/
  // "1 namespaceMembers" summary): singular counts read as "1 duplicate
  // export"/"1 namespace member". Neither contains the substring "exports"
  // (no trailing 's'), so the not.toContainText assertion below still holds.
  const selectionDock = page.getByTestId('selection-dock');
  await expect(selectionDock).toContainText('1 duplicate export');
  await expect(selectionDock).toContainText('1 namespace member');
  await expect(selectionDock).not.toContainText('exports');

  // Re-enable "Unused exports" — a pure filter-state change must never
  // retroactively add or remove anything from the cart.
  await exportsChip.click();
  await expect(exportsChip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('selbar-count')).toHaveText('2 selected');
  await expect(selectionDock).toContainText('1 duplicate export');
  await expect(selectionDock).toContainText('1 namespace member');
  await expect(selectionDock).not.toContainText('exports');

  // The apply flow still works end-to-end on the rebuilt tree/filters: fix
  // the 2 selected (filter-gated) issues.
  await page.getByTestId('selbar-fix').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByTestId('diff-view-src/forms.ts')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('result-status-src/forms.ts')).toHaveText('ok', { timeout: 10_000 });

  // Wait for the background rescan to land, then close out via the commit
  // panel's Skip (git repo is initialized in the fixture).
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(dialog).toHaveCount(0);
});
