// Setup-screen e2e (Task 6, UX overhaul): boots its OWN `dist/cli.js` process
// against a throwaway, deliberately-broken copy of tests/fixtures/single,
// rather than reusing playwright.config.ts's shared webServer/fixture (which
// smoke/ignore/filters/dashboard/codepane-crash specs all mutate in a known-
// good state — see e.g. ignore.spec.ts's doc comment on why specs stay
// independent of each other). A broken-config server needs a life of its own:
// no existing spec spins one up, and adding a second entry to the shared
// webServer config risks two `(test -d dist/client || npm run build)` guards
// racing each other. Spawning `dist/cli.js` directly sidesteps that — by the
// time ANY spec file's tests run, Playwright has already waited for the
// shared webServer's port to come up, which only happens after that same
// `npm run build` has finished, so dist/cli.js is guaranteed to exist here
// too, and this spec's server just points it at a different --dir/--port.
//
// The fixture is intentionally NOT missing knip.json: verified manually
// (`node node_modules/knip/bin/knip.js --reporter json` against a copy of
// tests/fixtures/single with knip.json deleted) that knip's own default
// entry/project discovery still matches this fixture's src/index.ts fine
// with no config at all — exit 0, well under runScan's exitCode >= 2 failure
// threshold (src/core/knip-runner.ts only rejects a scan at exitCode >= 2;
// exitCode 1 just means "ran fine, found issues"). So a MISSING config
// doesn't reproduce the "knip couldn't scan this project" state the setup
// screen exists for. Corrupting the config's JSON does: knip's own config
// loader fails fast with exit code 2 (confirmed the same way) — the same
// >= 2 failure class (KnipError w/ code:'knip-failed', a numeric exitCode)
// that the real-world "knip exited with 7" bug report hit, whatever knip's
// own fatal error actually was in that case.
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureSrc = fileURLToPath(new URL('../fixtures/single/', import.meta.url));
const tmpTestsDir = fileURLToPath(new URL('../../.tmp-tests/', import.meta.url));

let workDir: string;
// stdio ['ignore','pipe','pipe'] → stdin null, stdout/stderr readable.
let child: ChildProcessByStdio<null, Readable, Readable>;
let baseURL: string;

test.beforeAll(async () => {
  mkdirSync(tmpTestsDir, { recursive: true });
  workDir = mkdtempSync(`${tmpTestsDir}e2e-setup-fixture-`);
  cpSync(fixtureSrc, workDir, { recursive: true });
  writeFileSync(`${workDir}/knip.json`, '{ not valid json');

  child = spawn(process.execPath, ['dist/cli.js', '--dir', workDir, '--no-open', '--port', '0'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  baseURL = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for URL; output so far: ${out}`)), 20_000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = out.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cli exited before printing a URL (code=${code}); output: ${out}`));
    });
  });
});

test.afterAll(async () => {
  child.kill();
  rmSync(workDir, { recursive: true, force: true });
});

test('broken knip config renders the setup screen; fixing it and Re-run recovers to the dashboard', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });

  await page.goto(baseURL);

  const setupScreen = page.getByTestId('setup-screen');
  await expect(setupScreen).toBeVisible({ timeout: 30_000 });
  await expect(setupScreen).toContainText("knip couldn't scan this project");

  // The stderr block shows knip's real config-load error verbatim, and the
  // starter knip.json snippet is always offered as a fix.
  const stderrBlock = page.getByTestId('setup-stderr');
  await expect(stderrBlock).toBeVisible();
  await expect(stderrBlock).toContainText(/knip\.json/);
  await expect(page.getByTestId('setup-snippet')).toContainText('"entry"');

  // Copy buttons write to the clipboard (permission granted above) and
  // confirm via a sonner toast.
  await page.getByTestId('setup-copy-stderr').click();
  await expect(page.getByText('Error output copied to clipboard')).toBeVisible();
  const copiedStderr = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedStderr).toContain('knip.json');

  await page.getByTestId('setup-copy-snippet').click();
  await expect(page.getByText('knip.json snippet copied to clipboard')).toBeVisible();
  const copiedSnippet = await page.evaluate(() => navigator.clipboard.readText());
  expect(copiedSnippet).toContain('"entry"');

  // Docs link points at knip's real configuration reference.
  await expect(page.getByRole('link', { name: /Configuration docs/ })).toHaveAttribute(
    'href',
    'https://knip.dev/overview/configuration',
  );

  // Sidebar stays usable while stuck on the setup screen: Activity (not
  // report-dependent) renders its own normal page instead of SetupScreen.
  await page.getByTestId('nav-activity').click();
  await expect(page.getByText('Nothing yet this session')).toBeVisible();
  await expect(setupScreen).toHaveCount(0);
  await page.getByTestId('nav-dashboard').click();
  await expect(setupScreen).toBeVisible();

  // Fix the config on disk, then Re-run from the setup screen itself.
  writeFileSync(`${workDir}/knip.json`, '{ "entry": ["src/index.ts"], "project": ["src/**/*.ts"] }');
  await page.getByTestId('setup-rerun').click();

  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(setupScreen).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true, level: 2 })).toBeVisible();
});

// Session-expiry pin (Task 6 review fix, reproduced live 3x): real scenario —
// the CLI restarts, an old tab stays open holding the previous token, so every
// API call from it 401s. Before the fix, clicking Re-run softlocked the button
// (scanMutation.isPending stuck: the 401'd report REFETCH that Re-run's
// onSettled invalidation awaits gets retried by react-query behind a
// focus-gated pause that can never win — see App.tsx's QueryClient retry
// comment for the full chain) with no toast and no recovery short of a manual
// reload the user had no reason to know they needed. Now any 401 swaps the
// whole app for an explicit session-expired notice. Runs after the recovery
// test above (serial), so the server is healthy and the dashboard reachable;
// the stale token is simulated by overwriting the meta tag the same way a
// restarted server would invalidate it (api.ts reads the tag on every call).
test('stale token: Re-run swaps the app for the session-expired screen instead of softlocking', async ({
  page,
}) => {
  await page.goto(baseURL);
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

  await page.evaluate(() => {
    document
      .querySelector('meta[name="knip-gui-token"]')!
      .setAttribute('content', 'stale-token-from-before-the-cli-restarted');
  });

  await page.getByTestId('rerun-button').click();

  const expired = page.getByTestId('session-expired');
  await expect(expired).toBeVisible();
  await expect(expired).toContainText('Session expired');
  await expect(expired).toContainText('knip-gui was restarted');
  await expect(expired.getByRole('button', { name: 'Reload' })).toBeVisible();

  // The ENTIRE app is replaced — no sidebar, and in particular no Re-run
  // button left behind stuck in its spinning "Scanning…" state.
  await expect(page.getByTestId('rerun-button')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-trigger')).toHaveCount(0);

  // Reload recovers: the server re-serves the shell with the real token.
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('session-expired')).toHaveCount(0);
});
