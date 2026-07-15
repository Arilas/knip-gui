// Dashboard virtualization + bounded-shell regression pin (Task 2 review
// finding): with a >50-workspace report, the workspace table must actually
// virtualize — which only happens when the scroll container has a real,
// viewport-bounded height. Before the fix, the app shell's wrapper only had
// min-h-svh (a floor, not a cap), so the PAGE scrolled, the table's
// overflow-auto div had clientHeight === scrollHeight, TanStack Virtual saw
// one giant viewport, and ALL rows rendered with the sticky header scrolling
// away.
//
// The real /api/report from the shared single fixture can't exercise this
// (1 workspace), so this spec intercepts /api/report with a synthetic
// 60-workspace payload via page.route — nothing touches the fixture or the
// server, so this spec is safe to run in any order with the others (which is
// also why it must NOT use the real report: they mutate it).
//
// A jsdom component test was considered and rejected: virtualization depends
// on real layout (clientHeight/scrollHeight), which jsdom doesn't do — it
// would render 0-height containers and assert nothing honest.
import { expect, test } from '@playwright/test';

// Shape must match src/core/types.ts's Issue/Report and the /api/report
// response envelope ({ status, report }).
function syntheticReport(workspaceCount: number) {
  const workspaces: string[] = ['.'];
  const issues: unknown[] = [];
  for (let i = 0; i < workspaceCount; i++) {
    const ws = `packages/ws-${String(i).padStart(2, '0')}`;
    workspaces.push(ws);
    issues.push(
      {
        id: `exp-${i}`,
        type: 'exports',
        workspace: ws,
        filePath: `${ws}/index.ts`,
        symbol: `unused${i}`,
        fixable: true,
        fixModes: ['strip-export', 'delete-declaration'],
      },
      {
        id: `file-${i}`,
        type: 'files',
        workspace: ws,
        filePath: `${ws}/orphan.ts`,
        fixable: true,
        fixModes: ['delete-file'],
      },
      // A package-shaped (Packages-routed) issue too, so cell-click tests can
      // exercise the packages side of Dashboard.tsx's onCellClick alongside
      // the code side above.
      {
        id: `dep-${i}`,
        type: 'dependencies',
        workspace: ws,
        filePath: `${ws}/package.json`,
        symbol: `left-pad-${i}`,
        fixable: true,
        fixModes: ['remove-dependency'],
      },
    );
  }
  return {
    status: 'ready',
    report: { issues, scannedAt: new Date().toISOString(), workspaces },
  };
}

test('60-workspace table virtualizes: bounded row count, pinned header, no page scroll', async ({ page }) => {
  await page.route('**/api/report', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticReport(60)) }),
  );

  await page.goto('/');
  // Dashboard is the default page; wait for the synthetic rows to land.
  const scroller = page.getByTestId('workspace-table-scroll');
  await expect(scroller).toBeVisible();
  await expect(page.getByTestId('workspace-row-packages/ws-00')).toBeVisible();

  // The virtualization pin: 60 rows in the data, far fewer in the DOM.
  // (Rendered count = visible window + 2×overscan(6) + up to 2 spacer <tr>s —
  // ~25 at the default 720px viewport; 30 is the honest upper bound the
  // review asked for, and 60 is the broken-case value this must never be.)
  const renderedRows = scroller.locator('tbody tr');
  expect(await renderedRows.count()).toBeLessThan(30);

  // The table's scroll div is the ONLY scrolling element: the page itself
  // must not have grown past the viewport (that was the bug — min-h-svh let
  // the shell stretch and the page scrolled instead of the table).
  const overflows = await page.evaluate(() => ({
    page: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    scrollY: window.scrollY,
  }));
  expect(overflows.page).toBe(0);
  expect(overflows.scrollY).toBe(0);

  // Header position before scrolling — sticky means it must not move.
  const headerButton = page.getByTestId('sort-workspace');
  const before = await headerButton.boundingBox();
  expect(before).not.toBeNull();

  // Scroll the table container itself.
  await scroller.evaluate((el) => {
    el.scrollTop = 1200;
  });
  // A deep row scrolled into the rendered window proves the virtualizer
  // re-windowed (1200px / 36px-per-row ≈ row 33).
  await expect(page.getByTestId('workspace-row-packages/ws-35')).toBeVisible();
  // ...and the early rows left the DOM entirely (windowing, not just paint).
  await expect(page.getByTestId('workspace-row-packages/ws-00')).toHaveCount(0);
  // Still bounded after scrolling.
  expect(await renderedRows.count()).toBeLessThan(30);

  // Sticky header: still visible and pinned at the same y.
  await expect(headerButton).toBeVisible();
  const after = await headerButton.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);

  // The container really did scroll (guards against a false pass where
  // scrollTop silently stayed 0 because the div wasn't a scroll container).
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

// Cell-scoping pin (review finding, updated for Task W #29): Dashboard.tsx's
// onCellClick used to pass `search: '<ws>/'` to navigate() for EVERY cell
// type, including packages-routed ones — but PackagesPage keeps its own
// local search state and never reads the ui store's codeSearch, so a
// packages-cell click both opened Packages unscoped AND silently pre-filled
// the Code page's tree search for whenever it was next visited. Fixed by
// only forwarding the scope when routing to 'code' (Dashboard.tsx) and by
// PackagesPage simply never reading codeScope, so this stays pinned even if
// a future caller repeats the mistake.
//
// #29 itself then replaced the "stuffed into codeSearch" mechanism with a
// first-class scope CHIP (state/ui.ts's `codeScope`) — a workspace click no
// longer touches the free-text search box at all, so this test now also pins
// that the tree search stays genuinely empty (typeable) after a code-routed
// cell click, with the workspace surfaced as a chip instead. See
// scope-chip.spec.ts for the chip's own dedicated coverage (compose with
// search, clear, promote).
test('workspace cell click scopes Code via the chip (not the search box); a packages cell click never touches Code scope', async ({
  page,
}) => {
  await page.route('**/api/report', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticReport(3)) }),
  );

  await page.goto('/');
  await expect(page.getByTestId('workspace-row-packages/ws-01')).toBeVisible();

  // Packages cell first, on a clean codeScope (the undefined default) —
  // clicking it must land on Packages and must NOT populate codeScope for
  // later.
  await page.getByTestId('cell-packages/ws-01-dependencies').locator('button').click();
  await expect(page.getByTestId('packages-search')).toBeVisible();
  await expect(page.getByTestId('workspace-group-packages/ws-01')).toBeVisible();

  // Hop to Code via the sidebar (a plain nav click — opts.search omitted —
  // so this alone wouldn't prove anything either way); no chip and an empty
  // tree search, proving the packages-cell click never wrote codeScope.
  await page.getByTestId('nav-code').click();
  await expect(page.getByTestId('tree-search')).toHaveValue('');
  await expect(page.getByTestId('scope-chip')).toHaveCount(0);

  // Back to the dashboard for the file-type (Code-routed) cell click.
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('cell-packages/ws-01-exports').locator('button').click();

  // Landed on Code, scoped to just the 'exports' type...
  await expect(page.getByTestId('filter-chip-exports')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('filter-chip-files')).toHaveAttribute('aria-pressed', 'false');
  // ...the workspace shows up as a chip, not text in the search box...
  await expect(page.getByTestId('scope-chip')).toContainText('packages/ws-01');
  // ...and the search box stays empty and typeable — the #29 bug this fixes.
  await expect(page.getByTestId('tree-search')).toHaveValue('');
});
