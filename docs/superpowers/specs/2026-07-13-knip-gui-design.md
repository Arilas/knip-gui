# knip-gui — Design

**Date:** 2026-07-13
**Status:** Approved for planning

## Errata / approved deviations

- **No SSE for scan progress** (Plan 1): `POST /api/scan` is a single awaited request.
  Knip emits no incremental progress, so SSE bought nothing.
- **`classMembers` does not exist in knip 6** (discovered against knip 6.26.0 ground
  truth): knip's real issue-type universe is files, dependencies, devDependencies,
  optionalPeerDependencies, unlisted, binaries, unresolved, exports, nsExports,
  types, nsTypes, enumMembers, namespaceMembers, duplicates, catalog, cycles. Every
  mention of class members below should be read as enum/namespace members. Member
  entries carry a `namespace` field naming the parent. Supported knip floor is v6;
  older majors work but issue types they emit that knip 6 doesn't are ignored.

## Summary

`knip-gui` is an npm package run via `npx knip-gui` in a project root. It runs the
project's own [knip](https://knip.dev) install, serves a local web UI that presents
knip's findings in a browsable, selectable form (file tree, per-issue-type views,
shiki-highlighted code), and lets the user bulk-fix or bulk-ignore selected issues,
review the resulting diff, apply it to disk, and optionally commit via git.
Monorepos are first-class: results are workspace-aware and every action can be
scoped to one workspace or the whole project.

## Goals

- Make triaging knip output dramatically faster than reading CLI text.
- Cherry-pick granularity: fix *these three exports and that file*, not just whole categories.
- Both halves of triage: **Fix** (change code) and **Ignore** (mark intentional, write knip config).
- Preview every change as a diff before it touches disk.
- One-click commit with a sensible prefilled message; optional branch creation.

## Non-goals (v1)

- Editing code beyond knip-driven fixes (no general editor).
- Trash/recycle-bin for deleted files (git is the undo).
- PR creation, watch mode, git-blame age indicators, export-usage heatmaps (parked for v2).
- Editing `knip.ts` (code-form config) — UI shows a paste-ready snippet instead.

## Architecture

One published package with two build outputs:

- **CLI/server** (`bin/knip-gui`, Node ≥ 20): Hono + `@hono/node-server`.
- **SPA**: React + Vite, prebuilt into `dist/client`, served statically.

Startup sequence:

1. Resolve the **project's local knip** (via `require.resolve` from cwd). Never bundle
   our own knip — results must match the project's version and config. Missing knip →
   friendly setup screen with install instructions.
2. Spawn `knip --reporter json` (child process, cwd = project root).
3. Start server on `127.0.0.1` at a random free port; open the browser
   (`--port`, `--no-open`, `--dir` flags).

### API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/scan` | (Re-)run knip; optional `workspace` scope; SSE progress events |
| `GET /api/report` | Latest normalized report |
| `GET /api/file?path=` | File content for the code pane |
| `POST /api/fix/preview` | Selection + options → fix plan with concrete text patches + diffs |
| `POST /api/fix/apply` | Apply a previously previewed plan (by plan id) |
| `POST /api/ignore` | Selection → knip config edits / `@public` tag insertions (same preview/apply shape) |
| `GET /api/git/status` | Branch, dirty state |
| `POST /api/git/branch` | Create + switch to branch |
| `POST /api/git/commit` | Stage only tool-touched files, commit with given message |

### Security

A localhost server that deletes files and commits is a CSRF target for any web page
the user has open. Mitigations, all cheap:

- Bind `127.0.0.1` only.
- Per-session random token embedded in the served HTML; required header on every API call.
- `Origin` header checked against the server's own origin.

## Data model

Server normalizes knip's per-file JSON into a flat `Issue[]`:

```ts
type Issue = {
  id: string;            // stable hash of (workspace, filePath, type, symbol)
  type: 'files' | 'exports' | 'types' | 'enumMembers' | 'classMembers'
      | 'duplicates' | 'dependencies' | 'devDependencies'
      | 'optionalPeerDependencies' | 'unlisted' | 'unresolved' | 'binaries';
  workspace: string;     // workspace dir, '.' for single-package repos
  filePath: string;      // repo-relative
  symbol?: string;
  parentSymbol?: string; // enum/class name for member issues
  line?: number; col?: number; pos?: number;
  fixable: boolean;
  fixModes: FixMode[];   // e.g. ['strip-export', 'delete-declaration']
};
```

Stable `id`s let selections survive re-scans and let the UI tick off resolved issues
after apply. Every view (tree, tables, dashboard) is a client-side projection of this
one array; facets are filters, not separate data sources.

## Fix engine (hybrid)

A selection compiles into a **fix plan** before anything touches disk. The plan
compiler picks the execution path per plan segment:

### Path 1 — delegate to `knip --fix`

Used when a segment covers an entire issue type within a workspace (or project-wide),
e.g. "all unused dependencies in `packages/web`":

```
knip --fix --fix-type dependencies --workspace packages/web
```

Upstream `--fix` supports: exports, re-exports, exported types, default exports,
enum and namespace members, dependencies/devDependencies, catalog entries, and file
deletion behind `--allow-remove-files`. Zero behavioral drift from knip.

If the installed knip version doesn't support a needed flag combination (probed once
per session via `knip --help`), the plan compiler silently routes that segment to
Path 2 — delegation is an optimization, never a requirement.

### Path 2 — own fixer (cherry-picks + class members)

Class members are not covered by upstream `--fix`; everything else lands here only
when the selection is partial.

- **Parsing:** `oxc-parser` (fast, span-accurate TS/TSX AST). No type information
  needed — knip already did the analysis; we only need precise node boundaries.
- **Editing:** `magic-string` text edits computed from AST spans; anchored at knip's
  reported `pos`/`line`/`col`, then validated against the located node's name.
- **Transforms:**
  - Unused file → `fs.rm`.
  - Unused export/type, mode `strip-export` (default) → remove the `export` keyword,
    or the binding from an `export { a, b }` list (removing the whole statement when
    the list empties), or the `export default` prefix / re-export entry. Mirrors
    upstream semantics.
  - Unused export/type, mode `delete-declaration` → remove the entire declaration
    including attached JSDoc/leading comments. No usage analysis in v1: the diff
    preview is the safety net, and a follow-up scan catches newly-dead code.
  - Enum/class member → remove the member node (+ trailing comma/comment range).
  - Duplicate export → remove the duplicate binding.
  - Dependencies → remove the key from the owning workspace's `package.json`,
    preserving indentation and key order.

### Preview == apply, guaranteed

`fix/preview` computes concrete text patches and returns them with rendered diffs and
a `planId`; `fix/apply` writes **those exact patches** — never a recomputation. Every
touched file is content-hashed at preview time; a hash mismatch at apply time marks
the plan stale and forces re-preview. Apply is per-item fault-tolerant: one failed
patch reports and skips, the rest proceed. After apply, knip re-runs automatically
(toggleable) and resolved issues clear from the views.

## Ignore engine

"Ignore" = "knip, stop reporting this — it's intentional." Same preview/apply shape
as fixes.

- Files → append to `ignore` patterns; dependencies → `ignoreDependencies`;
  binaries → `ignoreBinaries`. Written to `knip.json` / `knip.jsonc` /
  `package.json#knip` (whichever the project uses), preserving formatting; workspace-
  scoped entries go under the right `workspaces` key.
- Exports / types / members → insert `/** @public */` JSDoc above the declaration
  (knip's native mechanism for intentional exports).
- `knip.ts` config → not edited; UI shows the exact snippet to paste.

## UX

Layout: **A + B hybrid** — IDE-style tree + code pane for file-shaped facets, flat
triage tables for dependency-shaped facets. Shared chrome:

- **Top bar:** project name · workspace picker (`All workspaces ▾` / one) · Re-run
  button with last-scan timestamp · git branch + dirty indicator.
- **Left rail (facets):** Overview · Unified tree · Files · Exports · Types ·
  Members · Duplicates · Dependencies · Unlisted · Unresolved · Binaries, each with
  a count badge (respecting the active workspace filter).
- **Overview:** counts per issue type × workspace; quick actions ("Fix all unused
  deps in web") that pre-fill the selection and open the fix modal.
- **Tree views** (unified, files, exports, types, members, duplicates): virtualized
  file tree, folder badges roll up counts, checkboxes at folder/file/issue level,
  filter box, "only issues" toggle. Clicking a file opens the **code pane**: shiki-
  highlighted source, issue lines flagged with gutter markers + inline badges, each
  with its own checkbox.
- **Table views** (dependencies, unlisted, unresolved, binaries): flat sortable table
  per workspace with select-all; row click opens a small preview (package.json
  context or the unresolved import site).
- **Selection cart:** global across facets and workspaces (zustand). Sticky bottom
  bar: grouped summary ("12 exports, 3 files, 2 deps") · `Ignore` · `Fix…` · `Clear`.
- **Fix modal:** per-type options (strip export vs delete declaration; file-deletion
  confirm list) → diff preview (shiki-rendered) → Apply with per-item results →
  **commit panel**: optional "create branch first" (prefilled
  `chore/knip-cleanup-<date>`), message prefilled from template
  `chore(knip): <auto summary>` and fully editable, stages only tool-touched files.
  Dirty working tree → warning, never a block.
- Light/dark theme via shiki dual themes + CSS variables.

## Error handling

- Knip missing → setup screen with install command.
- Knip exit code 1 (issues found) is success; exit code 2 → stderr surfaced in UI.
- Stale plan (file changed between preview and apply) → per-file stale marker,
  re-preview required.
- Own-fixer anchor mismatch (node at `pos` doesn't match symbol name) → item fails
  safely, reported in results, nothing written for that item.
- Git op failures → stderr shown verbatim; no retries, no partial cleanup.

## Testing

- **Unit:** every oxc/magic-string transform against fixture snippets — snapshot the
  before/after (export lists, default exports, re-exports, JSDoc-attached
  declarations, enum/class members, trailing commas).
- **Integration:** fixture repos (single-package + pnpm monorepo) — scan → select →
  apply → re-scan asserts the issues are gone and `tsc --noEmit` still passes.
  Ignore path: apply ignores → re-scan asserts items no longer reported.
- **API:** Hono endpoint tests (token/origin enforcement included).
- **E2E:** one Playwright smoke — boot on fixture, expand tree, select, preview,
  apply, verify UI clears.

## v2 parking lot

Trash-instead-of-delete · PR creation via `gh` · watch mode · git-blame age of dead
code · export-usage heatmap · unused property detection if knip ships it.
