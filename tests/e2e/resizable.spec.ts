// Exercises the Code page's resizable split (client/src/components/pages/
// CodePage.tsx) end to end: drag the tree/pane handle, reload, and confirm
// the dragged size survived, plus that collapsing the pane survives a
// reload too.
//
// Persistence key: react-resizable-panels v4's `useDefaultLayout({ id:
// 'knip-code-split' })` (CodePage.tsx's own doc comment already flags that
// this installed version dropped the older `autoSaveId` string-prop API some
// docs describe). Reading the library source
// (node_modules/react-resizable-panels/dist/react-resizable-panels.js's `he`/
// `sn` helpers) confirms the actual localStorage key is
// `react-resizable-panels:knip-code-split` (no `panelIds` were passed to the
// hook here, so the key has no extra `:code-tree,code-pane` suffix) and the
// stored value is a plain `{ [panelId]: sizePercent }` JSON object, debounced
// 100ms after the last drag.
//
// Panel collapse: `ResizablePanel`/`Panel` render `data-testid={id}` (their
// own `id` prop) — see react-resizable-panels.js — so `code-tree`/`code-pane`
// are queryable directly, no extra testid plumbing needed in CodePage.tsx.
import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'react-resizable-panels:knip-code-split';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-code').click();
});

test('dragging the Code split handle persists panel sizes across a reload', async ({ page }) => {
  const tree = page.getByTestId('code-tree');
  const handle = page.locator('[data-slot="resizable-handle"]');
  await expect(tree).toBeVisible();
  await expect(handle).toBeVisible();

  const beforeBox = (await tree.boundingBox())!;
  const handleBox = (await handle.boundingBox())!;
  const handleY = handleBox.y + handleBox.height / 2;

  // Drag the handle left by 150px — shrinks the tree panel, grows the code
  // pane. Both panels have `minSize={20}` (percent); at this project's
  // default 1280px-wide viewport a 150px shrink from the tree's ~35% default
  // stays comfortably inside that floor.
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleY);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 - 150, handleY, { steps: 10 });
  await page.mouse.up();

  const afterDragBox = (await tree.boundingBox())!;
  expect(afterDragBox.width).toBeLessThan(beforeBox.width - 100);

  // The library's storage write is debounced — wait for it to actually land
  // before reloading, or the reload races the write and reads back the
  // PRE-drag layout, silently passing this spec for the wrong reason.
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .not.toBeNull();

  await page.reload();
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  // Post Task R (#14) the page lives in the URL, so a reload of /code lands
  // back on Code directly; the nav click is now a harmless no-op re-nav to the
  // current route, kept only so this spec doesn't assume the reload URL.
  await page.getByTestId('nav-code').click();

  const afterReloadBox = (await page.getByTestId('code-tree').boundingBox())!;
  // Persisted width should match the post-drag width, not the original —
  // small tolerance for sub-pixel layout rounding.
  expect(Math.abs(afterReloadBox.width - afterDragBox.width)).toBeLessThan(5);
});

test('collapsing the code pane persists across a reload', async ({ page }) => {
  const pane = page.getByTestId('code-pane');
  await expect(pane).toBeVisible();
  expect((await pane.boundingBox())!.width).toBeGreaterThan(0);

  await page.getByLabel('Collapse code panel').click();
  await expect(page.getByLabel('Expand code panel')).toBeVisible();
  await expect.poll(async () => (await pane.boundingBox())?.width ?? -1).toBe(0);

  // Confirmed live (not merely assumed): CodePage.tsx's own doc comment says
  // the pane-collapse toggle has no dedicated persisted flag — collapsing
  // just drives the SAME layout write down to size 0 for `code-pane`, and
  // `onResize` re-derives `paneCollapsed` from that persisted 0 on the next
  // mount. Assert the actual mechanism rather than an assumed one: the
  // localStorage entry really does carry a literal 0 for this panel.
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY))
    .toContain('"code-pane":0');

  await page.reload();
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-code').click();

  // What's actually true survives the reload: the pane stays 0-width and its
  // toggle button still reads "Expand" — there is no separate "collapsed"
  // concept in the store to assert on beyond this (see comment above).
  await expect.poll(async () => (await page.getByTestId('code-pane').boundingBox())?.width ?? -1).toBe(0);
  await expect(page.getByLabel('Expand code panel')).toBeVisible();
});
