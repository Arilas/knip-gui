# knip-gui

A local web GUI for [knip](https://knip.dev). Browse unused files, exports, types,
enum/namespace members, and dependencies in a file tree; select them; fix or ignore
them in bulk with a diff preview; commit the cleanup — all from your browser.

## Usage

Run in a project that has knip installed and configured:

```bash
npx knip-gui
```

The CLI resolves your project's own knip install, runs it with the JSON reporter,
and opens a browser at a local URL.

### Flags

| Flag | Default | Description |
| --- | --- | --- |
| `--port <n>` | random free port | Port to listen on (always binds `127.0.0.1`) |
| `--no-open` | — | Don't open the browser |
| `--dir <path>` | cwd | Project root to scan |

### Security

The server binds to `127.0.0.1` only. Every API request requires a per-session
token embedded in the served page, and cross-origin requests are rejected — so
web pages you have open cannot drive the API.

## Status

Under active development. Working: scan, normalized report API, file content API.
Coming: fix/ignore engines with diff preview, git integration, and the web UI.

## Development

```bash
npm install
npm test          # vitest (unit + integration against fixture projects, and
                   # client-logic tests under a jsdom project) — 341 tests
npm run typecheck  # server tsc + client tsc, no emit
npm run build      # emits dist/ (server) and dist/client/ (Vite SPA build);
                   # this is what `files: ["dist"]` publishes and what
                   # `npx knip-gui` serves
```

### End-to-end tests (Playwright)

```bash
npx playwright install chromium   # one-time, ~260MB download
npm run test:e2e                  # builds (if dist/client is missing), then
                                   # runs both e2e specs against a real
                                   # Chromium browser
```

`npm run test:e2e` drives the real built client + server (no mocking) through
two flows against a throwaway git-initialized copy of
`tests/fixtures/single` (recreated fresh on every run by
`scripts/e2e-fixture.ts`, gitignored under `.tmp-tests/`):

- `tests/e2e/smoke.spec.ts` — tree facet, select an unused export + an unused
  file, fix, wait for the rescan to clear them, commit.
- `tests/e2e/ignore.spec.ts` — dependencies table, select an unused
  dependency, ignore (writes a `knip.json` entry), wait for the rescan to
  clear it.

Both specs mutate the same fixture copy and the same running server
(`playwright.config.ts`'s `webServer`), so they run serially
(`workers: 1`) rather than in parallel — but they target unrelated issues
(an export/file vs. a dependency), so either can run first. Playwright specs
are intentionally excluded from the vitest run (`vitest.config.ts`) since
they need a live browser and a booted server, not a unit-test environment.

### Gotcha: `build:client` forces `NODE_ENV=production`

`npm run build:client` explicitly runs as `NODE_ENV=production vite build ...`
rather than relying on Vite's own default. `tests/integration/cli.test.ts`
shells out to `npm run build` (to get a real `dist/cli.js` for its
bin-symlink regression test), and Vitest sets `NODE_ENV=test` on itself —
which that child process inherits. Without the explicit override, the
inherited `NODE_ENV=test` caused `vite build` to ship react-dom's
*development* bundle (React StrictMode's double-invoked effects then raced
`ActionModal`'s `<dialog>` open/close plumbing: the discarded first effect's
cleanup called `dialog.close()`, whose `close` event fired asynchronously
*after* the second effect re-opened the dialog, closing a modal that should
have stayed open) — a genuinely broken production artifact that only
reproduced when a build was triggered from inside a process with
`NODE_ENV` already set to something other than `production`. If you add
another spot that shells out to `npm run build`, keep this in mind.

Design docs live in `docs/superpowers/specs/`, implementation plans in
`docs/superpowers/plans/`.
