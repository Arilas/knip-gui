import { defineConfig, devices } from '@playwright/test';

const PORT = 4818;
const FIXTURE_DIR = '.tmp-tests/e2e-fixture';

// Chromium-only smoke coverage of the real, built client against the real
// server (see tests/e2e/*.spec.ts) — everything else (pure logic, store
// behavior) is covered by the vitest client project instead.
export default defineConfig({
  testDir: './tests/e2e',
  // Both specs mutate the SAME fixture copy that the single webServer
  // instance serves (there's no per-test isolation at the fixture/server
  // level — recreating it per test would mean juggling multiple servers/
  // ports for no benefit here). They're independent of each other's target
  // issues (unusedHelper/orphan.ts vs. the left-pad dependency), so they can
  // run in either order — but NOT concurrently, since they'd otherwise race
  // on the same report/rescan state. `workers: 1` + `fullyParallel: false`
  // serializes them; see scripts/e2e-fixture.ts's doc comment for why the
  // fixture itself is still recreated fresh on every whole-suite run.
  fullyParallel: false,
  workers: 1,
  // One retry in CI only — a real browser driving a real subprocess (knip
  // scans, fs writes) occasionally hits a one-off timing hiccup that isn't a
  // real regression; local runs stay retries: 0 so a genuine bug fails fast.
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  // Generous default per-assertion timeout: the app does real work behind
  // some of these renders (a real knip scan/rescan, real fs writes for
  // apply), and CI/dev-machine load can push a first paint or a state
  // update past the library default (5s) even though nothing is actually
  // stuck — bumping the floor here is cheaper than sprinkling `{ timeout }`
  // on every assertion. Assertions waiting on a real rescan still specify
  // their own longer timeout explicitly (see the specs).
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Fixture prep + conditional build are chained into this command with
    // `&&` (rather than done in `globalSetup`) precisely because Playwright
    // starts this process before `globalSetup` would run — see
    // scripts/e2e-fixture.ts's doc comment for the full explanation. `test -d
    // dist/client` skips the build when a previous `npm run build` already
    // produced it, since a from-scratch build (server tsc + vite) is the slow
    // part of this command.
    command:
      'npm run e2e:fixture && ' +
      '(test -d dist/client || npm run build) && ' +
      `node dist/cli.js --dir ${FIXTURE_DIR} --no-open --port ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
