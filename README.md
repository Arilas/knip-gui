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

v0.2: a shadcn-based UI (Radix primitives, Tailwind v4, warm-purple theme,
light/dark following your OS preference) over the v0.1 engine — scan and
browse (unified tree, per-type facets, dependency tables, shiki code pane
with issue markers), bulk **Fix** (strip export / delete declaration /
delete file / remove dependency / remove enum+namespace member) and
**Ignore** (knip config entries, member-precise `@public` tags) with
hash-guarded diff preview — apply writes exactly what you previewed;
`knip --fix` sweep; git commit panel with optional branch creation.
Monorepo workspaces supported.

### Pages

An icon sidebar (collapsible; your collapsed/expanded choice persists across
reloads) switches between:

| Page | What it's for |
| --- | --- |
| Dashboard | Stat tiles + a sortable, virtualized per-workspace table |
| Code | Unified issue tree with type filter chips, filter-aware selection, resizable split against a shiki code pane |
| Packages | Dependency/devDependency/peerDependency/binary issues, grouped per workspace |
| Ignored | Config-backed ignore entries (knip.json ignore arrays) with one-click removal |
| Activity | Session-only log of fixes/ignores/sweeps/commits (clears on reload — nothing here is persisted) |

See [docs/backlog.md](docs/backlog.md) for known rough edges and v0.3 candidates.

## Development

```bash
npm install
npm test          # vitest (unit + integration against fixture projects, and
                   # client-logic tests under a jsdom project) — 450+ tests
npm run typecheck  # server tsc + client tsc, no emit
npm run build      # emits dist/ (server) and dist/client/ (Vite SPA build);
                   # this is what `files: ["dist"]` publishes and what
                   # `npx knip-gui` serves
```

### End-to-end tests (Playwright)

```bash
npx playwright install chromium   # one-time, ~260MB download
npm run test:e2e                  # builds (if dist/client is missing), then
                                   # runs the e2e specs against a real
                                   # Chromium browser
```

`npm run test:e2e` drives the real built client + server (no mocking) against
a throwaway git-initialized copy of `tests/fixtures/single` (recreated fresh
on every run by `scripts/e2e-fixture.ts`, gitignored under `.tmp-tests/`):

- `tests/e2e/smoke.spec.ts` — tree facet, select an unused export + an unused
  file, fix, wait for the rescan to clear them, commit.
- `tests/e2e/ignore.spec.ts` — dependencies table, select an unused
  dependency, ignore (writes a `knip.json` entry), wait for the rescan to
  clear it.
- `tests/e2e/filters.spec.ts` — disabling a filter chip gates what a file
  checkbox adds to the selection; re-enabling restores it; fix still applies.
- `tests/e2e/setup.spec.ts` — a broken knip config renders the setup screen
  and Re-run recovers; a stale session token swaps in the session-expired
  screen instead of a softlocked UI.
- `tests/e2e/codepane-crash.spec.ts` — the code pane on an open file survives
  a rescan that prunes one of its issues.
- `tests/e2e/dashboard.spec.ts` — intercepts `/api/report` with a synthetic
  60-workspace payload to pin table virtualization (bounded row count,
  sticky header, no page scroll) at a scale the shared fixture can't reach.

All specs but `dashboard.spec.ts` mutate the same fixture copy and the same
running server (`playwright.config.ts`'s `webServer`), so they run serially
(`workers: 1`) rather than in parallel; `dashboard.spec.ts` only intercepts
its own request and touches neither the fixture nor the server, so it's safe
in any order. Playwright specs are intentionally excluded from the vitest
run (`vitest.config.ts`) since they need a live browser and a booted server,
not a unit-test environment.

### Dogfooding: this repo's own `knip.json`

The root `knip.json` scopes knip to this repo's real entry points
(`src/index.ts`, `src/cli.ts`, `client/src/main.tsx`, `scripts/*.ts`) and
ignores `tests/fixtures/**` (fixture projects that are intentionally full of
"dead" code for knip-gui's own tests to exercise). Without it, knip's default
heuristics flag fixture files as real issues and drown out anything
meaningful. It's what makes `node dist/cli.js --dir .` — i.e. running
knip-gui against itself — actually useful for finding real cleanup
opportunities in this codebase.

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
