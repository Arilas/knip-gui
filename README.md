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
| `--production` | off | Passes knip's own `--production` through to every scan (incl. rescans) — no test files, no devDependencies. Fixed for the life of the server; a sidebar "Production" badge shows next to the scan timestamp whenever it's on. |

### Security

The server binds to `127.0.0.1` only. Every API request requires a per-session
token embedded in the served page, and cross-origin requests are rejected — so
web pages you have open cannot drive the API. Requests whose `Host` header
isn't a loopback address are rejected outright, which closes the DNS-rebinding
path (a malicious page rebinding its own hostname to `127.0.0.1` to read the
token off the served shell and then read project files). Commits are scoped to
the exact paths knip-gui touched via literal pathspecs, so nothing else in your
working tree is ever swept into a commit.

## Status

v0.3: a shadcn-based UI (Radix primitives, Tailwind v4, warm-purple theme,
light/dark following your OS preference) — scan and browse (unified tree,
per-type facets, dependency tables, shiki code pane with issue markers,
auto-scroll to the first flagged line, a hint on likely test files knip
flagged as unused), bulk **Fix** (strip export / delete declaration / delete
file / remove dependency / remove enum+namespace member) and **Ignore** (knip
config entries, member-precise `@public` tags) through a dedicated **Review**
page — hash-guarded diff preview, one file's diff at a time, apply writes
exactly what you previewed; `knip --fix` sweep; a docked commit bar right
after applying, plus a standing "N uncommitted files" commit affordance in
the sidebar footer reachable any time (not just right after a fix) with a
checklist that pre-selects the files *this session* actually touched.
Monorepo workspaces supported, incl. a workspace-scoped rescan from the
sidebar switcher. Optional `--production` mode (see the flags table above).

### Pages

An icon sidebar (collapsible; your collapsed/expanded choice persists across
reloads) switches between:

| Page | What it's for |
| --- | --- |
| Dashboard | Stat tiles + a sortable, virtualized per-workspace table |
| Code | Unified issue tree with type filter chips, filter-aware selection, resizable split (drag to resize, collapse the pane — both persist across reloads) against a shiki code pane |
| Packages | Dependency/devDependency/peerDependency/binary issues, grouped per workspace |
| Ignored | Config-backed ignore entries (knip.json ignore arrays) with one-click removal |
| Activity | Session-only log of fixes/ignores/sweeps/commits (clears on reload — nothing here is persisted) |

Selecting issues from Code/Packages and choosing Fix or Ignore opens the
**Review** page: one file's diff at a time (no scroll wall), apply, then
either commit right there in the docked commit bar or Skip and commit later
via the sidebar's "N uncommitted files" button — either way the commit
checklist pre-checks exactly the files knip-gui itself just touched, leaving
anything else in your working tree unchecked (and untouched — commits are
scoped to only the checked paths).

Known rough edges and future candidates are tracked in
[GitHub Issues](https://github.com/Arilas/knip-gui/issues) — bug reports and
feature requests welcome.

## Development

This repo is developed with [pnpm](https://pnpm.io) (pinned via
`packageManager` in `package.json`); enable it once via corepack:

```bash
corepack enable
pnpm install
pnpm test          # vitest (unit + integration against fixture projects, and
                   # client-logic tests under a jsdom project) — 560+ tests
pnpm run typecheck  # server tsc + client tsc + tests/scripts tsc, no emit
pnpm run build      # emits dist/ (server) and dist/client/ (Vite SPA build);
                   # this is what `files: ["dist"]` publishes and what
                   # `npx knip-gui` serves
```

Only seven packages are runtime `dependencies` (`hono`, `@hono/node-server`,
`oxc-parser`, `magic-string`, `diff`, `jsonc-parser`, `open`) — the entire
React/Tailwind/shiki client toolchain is a `devDependency`, since the shipped
package serves a prebuilt, self-contained `dist/client/` bundle. So
`npx knip-gui` installs a small server, not a UI framework. `prepublishOnly`
runs the build so a stale `dist/` can't be published.

### End-to-end tests (Playwright)

```bash
pnpm exec playwright install chromium   # one-time, ~260MB download
pnpm run test:e2e                  # builds (if dist/client is missing), then
                                   # runs the e2e specs against a real
                                   # Chromium browser
```

`pnpm run test:e2e` drives the real built client + server (no mocking) against
a throwaway git-initialized copy of `tests/fixtures/single` (recreated fresh
on every run by `scripts/e2e-fixture.ts`, gitignored under `.tmp-tests/`):

- `tests/e2e/smoke.spec.ts` — tree facet, select an unused export + an unused
  file, fix through the Review page, wait for the rescan to clear them, commit.
- `tests/e2e/ignore.spec.ts` — dependencies table, select an unused
  dependency, ignore (writes a `knip.json` entry), wait for the rescan to
  clear it.
- `tests/e2e/filters.spec.ts` — disabling a filter chip gates what a file
  checkbox adds to the selection; re-enabling restores it; fix still applies.
- `tests/e2e/setup.spec.ts` — a broken knip config renders the setup screen
  and Re-run recovers; a stale session token swaps in the session-expired
  screen instead of a softlocked UI.
- `tests/e2e/codepane-crash.spec.ts` — the code pane on an open file survives
  a rescan that prunes one of its issues (with an explicit API-poll assertion
  that the rescan really is still in flight at that moment, so the spec fails
  loudly rather than passing vacuously if that timing ever changes).
- `tests/e2e/review.spec.ts` — the Review page itself: cancel from preview
  keeps the selection intact, a multi-file fix whose rail distinguishes a
  clean apply from a file edited on disk mid-flow, keyboard nav through the
  rail, Escape not dismissing the page, and the ignore flow through Review.
- `tests/e2e/commit-affordance.spec.ts` — apply a fix, Skip its commit bar,
  then commit later via the sidebar footer's "N uncommitted files" button;
  checks that an unrelated dirty file created outside the app stays unchecked.
- `tests/e2e/resizable.spec.ts` — drags the Code page's split handle and
  reloads to confirm the persisted panel size; same for collapsing the pane.
- `tests/e2e/dashboard.spec.ts` — intercepts `/api/report` with a synthetic
  60-workspace payload to pin table virtualization (bounded row count,
  sticky header, no page scroll) at a scale the shared fixture can't reach.
- `tests/e2e/workspace-switcher.spec.ts` and `tests/e2e/production-mode.spec.ts`
  each boot their own short-lived server against their own throwaway fixture
  copy (a monorepo shape, and a `--production`-flagged instance respectively)
  rather than joining the shared single-workspace server above — see either
  spec's own doc comment.

All specs but `dashboard.spec.ts`, `workspace-switcher.spec.ts`, and
`production-mode.spec.ts` mutate the same fixture copy and the same running
server (`playwright.config.ts`'s `webServer`), so they run serially
(`workers: 1`) rather than in parallel; the other three either only intercept
their own request or run an entirely separate server/fixture, so they're safe
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

### Gotcha: `--production` can undercount a Vite SPA's own dependencies

Verified by dogfooding this exact repo: booting `knip-gui --production` here
reports all 19 of `client/`'s runtime dependencies (`zustand`, `sonner`,
`cmdk`, `@tanstack/react-query`, …) as **unused**, while the normal-mode scan
correctly finds none of that (it instead reports the real, much smaller list
of unused exports/types under `client/src/`). `knip --production
--trace-file client/src/App.tsx` confirms why: `App.tsx` (and everything it
imports) simply isn't traversed at all in production mode on this project's
layout — vs. a full reachability trace from `main.tsx` in normal mode. This
looks like an interaction between knip's `--production` mode and its
Vite-plugin-based entry detection for an SPA client that isn't a real npm
workspace; knip-gui just threads `--production` straight through to knip, so
this isn't something knip-gui can paper over. If you run `--production`
against a similarly-shaped project (a bundler-driven client under a
non-workspace subdirectory) and get a suspiciously large "unused
dependencies" list instead of the usual finer-grained issues, this is
probably why — check with a plain `knip --production --trace-file <a client
file>` before trusting the result.

### Gotcha: `build:client` forces `NODE_ENV=production`

`pnpm run build:client` explicitly runs as `NODE_ENV=production vite build ...`
rather than relying on Vite's own default. `tests/integration/cli.test.ts`
shells out to `pnpm run build` (to get a real `dist/cli.js` for its
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
another spot that shells out to `pnpm run build`, keep this in mind.

Design docs live in `docs/superpowers/specs/`, implementation plans in
`docs/superpowers/plans/`.
