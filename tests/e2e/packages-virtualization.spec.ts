// PackagesPage virtualization pin (#31), mirroring dashboard.spec.ts's
// synthetic-intercept approach: one giant per-workspace dependency group
// must window its rows (threshold-gated spacer <tr>s per group against the
// shared packages-scroll scrollport), keep its sticky group header pinned
// while scrolling, and keep select-all working against the full data set
// with only the bounded window in the DOM.
//
// Intercepts /api/report via page.route — nothing touches the shared
// fixture or the server, so (like dashboard.spec.ts) this spec is
// order-independent: it neither needs left-pad (consumed by ignore.spec.ts)
// nor mutates anything a later spec reads. Alphabetically it runs after
// ignore.spec.ts, which is fine for the same reason.
//
// A jsdom component test was considered and rejected for the same reason as
// dashboard.spec.ts's header documents: virtualization depends on real
// layout (clientHeight/scrollTop), which jsdom doesn't do.
import { expect, test } from '@playwright/test';

const BIG = 300;
const pad = (i: number) => String(i).padStart(3, '0');

// Shape must match src/core/types.ts's Issue/Report and the /api/report
// envelope ({ status, report }) — same contract dashboard.spec.ts fabricates.
function syntheticPackagesReport() {
  const issues: unknown[] = [];
  for (let i = 0; i < BIG; i++) {
    issues.push({
      id: `dep-${pad(i)}`,
      type: 'dependencies',
      workspace: 'packages/big',
      filePath: 'packages/big/package.json',
      symbol: `dep-${pad(i)}`,
      fixable: true,
      fixModes: ['remove-dependency'],
    });
  }
  // A second, tiny group pins that below-threshold groups still render in
  // full alongside a virtualized sibling. groupByWorkspace sorts
  // workspaces alphabetically ('.' first), so 'packages/big' renders
  // before 'packages/small'.
  for (let i = 0; i < 3; i++) {
    issues.push({
      id: `small-${i}`,
      type: 'devDependencies',
      workspace: 'packages/small',
      filePath: 'packages/small/package.json',
      symbol: `tiny-${i}`,
      fixable: true,
      fixModes: ['remove-dependency'],
    });
  }
  return {
    status: 'ready',
    report: {
      issues,
      scannedAt: new Date().toISOString(),
      workspaces: ['.', 'packages/big', 'packages/small'],
    },
  };
}

test('300-dep group virtualizes: bounded rows, sticky group header, select-all over the full set', async ({
  page,
}) => {
  await page.route('**/api/report', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticPackagesReport()) }),
  );

  await page.goto('/');
  await page.getByTestId('nav-packages').click();

  const scroller = page.getByTestId('packages-scroll');
  await expect(scroller).toBeVisible();
  await expect(page.getByTestId('workspace-group-packages/big')).toBeVisible();
  // Default sort is symbol asc, and the zero-padded symbols sort
  // numerically under localeCompare — dep-000 is the first row.
  await expect(page.getByTestId('packages-row-dependencies-dep-000')).toBeVisible();

  // The virtualization pin: 303 issue rows in the data, a bounded window
  // in the DOM (visible rows + 2×overscan(6) + spacer <tr>s + the small
  // group's 3 rows — ~40 at the default 720px viewport; 60 is the honest
  // upper bound, 300+ is the broken-case value this must never be).
  const renderedRows = scroller.locator('tbody tr');
  expect(await renderedRows.count()).toBeLessThan(60);

  // Sticky group header: capture the big group's label position, scroll
  // deep into the group, and require the label pinned at the same y.
  const bigLabel = page.getByTestId('packages-group-label-packages/big');
  const before = await bigLabel.boundingBox();
  expect(before).not.toBeNull();

  await scroller.evaluate((el) => {
    el.scrollTop = 3600; // ≈ 100 rows deep (36px/row), well past overscan
  });
  // Windowing proof, not just paint: a deep row entered the DOM...
  await expect(page.getByTestId('packages-row-dependencies-dep-100')).toBeVisible();
  // ...the first row left it entirely...
  await expect(page.getByTestId('packages-row-dependencies-dep-000')).toHaveCount(0);
  // ...and the DOM stayed bounded.
  expect(await renderedRows.count()).toBeLessThan(60);
  // Guard against a false pass where the div silently wasn't scrollable.
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // Sticky: still visible, same y as before the scroll.
  await expect(bigLabel).toBeVisible();
  const after = await bigLabel.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);

  // Select-all runs over the group's FULL id set (actionableIds is data-
  // derived, not DOM-derived), while the DOM keeps only the window; the
  // memoized rows mean this toggle re-renders the window, not 300 rows.
  await page.getByLabel('Select all issues in packages/big').check();
  await expect(page.getByTestId('selbar-count')).toHaveText('300 selected');
  expect(await renderedRows.count()).toBeLessThan(60);

  // A single rendered row's checkbox flips just that row out of the set.
  await page.getByTestId('packages-row-dependencies-dep-100').getByRole('checkbox').uncheck();
  await expect(page.getByTestId('selbar-count')).toHaveText('299 selected');

  // The below-threshold sibling group renders all of its rows at the
  // bottom, untouched by the big group's windowing.
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByTestId('packages-row-devDependencies-tiny-0')).toBeVisible();
  await expect(page.getByTestId('packages-row-devDependencies-tiny-2')).toBeVisible();
  await expect(page.getByTestId('packages-row-dependencies-dep-299')).toBeVisible();
});
