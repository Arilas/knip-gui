// ARIA tree keyboard navigation e2e coverage (Task K, #13): drives the real
// built client + server against a REAL knip scan, same self-hosted-server
// pattern as workspace-switcher.spec.ts/scope-chip.spec.ts/production-mode.
// spec.ts (own port, own throwaway fixture copy, own beforeAll/afterAll) —
// this spec's own test intentionally SELECTS an issue (via the Space key) to
// assert the checkbox/selection-dock contract, and picking an isolated
// server means that never risks racing the shared single-fixture webServer's
// specs (playwright.config.ts's, which several OTHER files mutate) or being
// mutated out from under it by them.
//
// Uses tests/fixtures/single (the same shape codepane-crash/filters/review/
// smoke/etc. use against the shared server) rather than the monorepo
// fixture: its single top-level `src/` directory holding 5 issue-bearing
// files gives a deterministic 2-level tree (root -> src/ -> 5 files, all
// auto-expanded — lib/tree.ts's autoExpandDepth returns 'all' well under its
// 200-file threshold) without any nested-directory ambiguity to account for.
// Flattened + sorted order is: src/ (dir), extra.ts, forms.ts, orphan.ts,
// shapes.ts, used.ts — verified directly against a real knip run on this
// fixture (same verification convention as workspace-switcher.spec.ts's own
// header comment).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// One above scope-chip.spec.ts's 4821 — entirely separate server/port from
// every other spec in this directory.
const PORT = 4822;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const fixtureSrc = fileURLToPath(new URL('../fixtures/single/', import.meta.url));
const workDir = fileURLToPath(new URL('../../.tmp-tests/tree-keyboard-fixture/', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

let server: ChildProcess | undefined;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: workDir, stdio: 'ignore' });
}

// Same self-healing rationale as workspace-switcher.spec.ts's own
// reapStrayServer (darwin/linux only — matches this repo's dev platforms).
function reapStrayServer(port: number): void {
  let pids: number[];
  try {
    pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

// The roving-tabindex contract (TreeView.tsx) puts real DOM focus on exactly
// one row at a time — reading document.activeElement's own data-testid is a
// direct pin of THAT (not just a data-active CSS hook that could drift from
// actual focus), matching the design brief's "assert via document
// .activeElement" instruction.
function activeRowTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

// A keyboard-driven move focuses its target row via a bounded
// requestAnimationFrame retry (TreeView.tsx's moveActive — virtualization
// means the row may not be mounted the instant scrollToIndex is called), so
// `document.activeElement` can lag a real keypress by a frame or two.
// page.keyboard.press() only awaits the synchronous dispatch, not those
// later rAF callbacks — expect.poll (not a bare assert right after press) is
// what actually waits for focus to land rather than racing it.
async function expectActiveRow(page: Page, testId: string): Promise<void> {
  await expect.poll(() => activeRowTestId(page)).toBe(testId);
}

test.beforeAll(async () => {
  reapStrayServer(PORT);
  await rm(workDir, { recursive: true, force: true });
  await cp(fixtureSrc, workDir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'knip-gui e2e']);
  git(['config', 'user.email', 'e2e@knip-gui.local']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'initial fixture import']);

  server = spawn('node', [cliPath, '--dir', workDir, '--no-open', '--port', String(PORT)], {
    stdio: 'ignore',
  });
  await waitForServer(`${BASE_URL}/`);
});

test.afterAll(async () => {
  server?.kill();
  await rm(workDir, { recursive: true, force: true });
});

test('ArrowDown/Right/Left traverse and (de)expand the tree; Enter opens a file; Space toggles its selection', async ({
  page,
}) => {
  await page.goto(BASE_URL);
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('nav-code').click();

  const treeContainer = page.locator('[role="tree"]');
  await expect(treeContainer).toBeVisible();

  const srcRow = page.getByTestId('tree-dir-src');
  const extraRow = page.getByTestId('tree-file-src/extra.ts');
  await expect(srcRow).toBeVisible();
  await expect(srcRow).toHaveAttribute('role', 'treeitem');
  await expect(srcRow).toHaveAttribute('aria-level', '1');

  // Click into the tree (brief: "Tab/click into the tree") — src/ starts
  // auto-expanded (autoExpandDepth policy), so this click's own toggle
  // side effect collapses it; that's convenient, not incidental: it lets the
  // very next ArrowRight below exercise the "expand a COLLAPSED dir" branch
  // rather than the "move to first child of an already-expanded dir" one.
  await srcRow.click();
  await expectActiveRow(page, 'tree-dir-src');
  await expect(srcRow).toHaveAttribute('tabindex', '0');
  await expect(srcRow).toHaveAttribute('aria-expanded', 'false');
  await expect(extraRow).toHaveCount(0);

  // ArrowRight expands a collapsed dir (focus stays put — only the dir's
  // expand state changes).
  await page.keyboard.press('ArrowRight');
  await expect(srcRow).toHaveAttribute('aria-expanded', 'true');
  await expect(extraRow).toBeVisible();
  await expect(extraRow).toHaveAttribute('tabindex', '-1'); // roving tabindex: only the active row is 0
  await expectActiveRow(page, 'tree-dir-src');

  // ArrowLeft collapses an expanded dir.
  await page.keyboard.press('ArrowLeft');
  await expect(srcRow).toHaveAttribute('aria-expanded', 'false');
  await expect(extraRow).toHaveCount(0);

  // Re-expand to reach the file rows for the rest of this test.
  await page.keyboard.press('ArrowRight');
  await expect(extraRow).toBeVisible();

  // ArrowDown moves the active row, one at a time: src/ -> extra.ts.
  await page.keyboard.press('ArrowDown');
  await expectActiveRow(page, 'tree-file-src/extra.ts');

  // extra.ts -> forms.ts -> orphan.ts -> shapes.ts (alphabetical order —
  // see this file's header comment).
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expectActiveRow(page, 'tree-file-src/shapes.ts');

  // Enter opens the active file — the EXACT same contract as a row click
  // (the `file` search param + the code pane rendering it), not just a
  // visual highlight.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/code\?.*shapes\.ts/);
  await expect(page.getByTestId('code-pane')).toContainText('src/shapes.ts');

  // Space toggles the active row's OWN selection checkbox — deliberately NOT
  // the same action as Enter (the pre-Task-K per-row handler treated both
  // identically; this is the behavior change the design brief calls for).
  // shapes.ts's only issue (the UnusedShape type) is fixable, so this adds
  // exactly one id to the cart.
  const shapesRow = page.getByTestId('tree-file-src/shapes.ts');
  await expect(page.getByTestId('selbar-count')).toHaveCount(0);
  await page.keyboard.press(' ');
  await expect(page.getByTestId('selbar-count')).toHaveText('1 selected');
  await expect(shapesRow.getByRole('checkbox')).toBeChecked();

  // Space again clears it back out — a pure toggle, not an accumulate-only
  // action, and Enter never fired again in between (still on shapes.ts).
  await page.keyboard.press(' ');
  await expect(page.getByTestId('selbar-count')).toHaveCount(0);
  await expect(shapesRow.getByRole('checkbox')).not.toBeChecked();
});
