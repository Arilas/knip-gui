# Scope Chip + Tree Keyboard Nav + Row Preview + pnpm Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GitHub issues #29 (workspace path-scope chip + promote — user-chosen design), #13 (ARIA tree keyboard navigation), #24 (Packages row-click context preview), then #28 (migrate npm → pnpm), in that order, one commit per issue (extra review-fix commits allowed).

**Architecture:** #29 splits the Code page's conflated "search box carries a workspace path" into two first-class pieces of ui.ts state (`codeScope` chip + free-text `codeSearch`), with a promote action reusing `useWorkspaceSwitch`. #13 adds the WAI-ARIA tree pattern to the existing flattened/virtualized TreeView (roving tabindex). #24 reuses CodePane inside a new PackagesPage split panel (the dependency issues already carry `filePath`/`line` into package.json; unresolved imports carry the import site). #28 swaps the package manager last, as its own verification gate (CI is the real test).

**Tech Stack:** React 19 + zustand + TanStack Router/Virtual, shadcn primitives, Hono untouched, pnpm (corepack) + GitHub Actions.

**User decisions (2026-07-15):** #29 = chip + promote action; #28 = pnpm; batch includes #13 + #24; #28 runs last.

## Global Constraints

- Commits: `feat: … (#29)`, `feat: … (#13)`, `feat: … (#24)`, `build: migrate to pnpm (#28)`. No auto-close keywords.
- `npm test` (later `pnpm test`) + typecheck green after every task; full e2e after each UI task.
- **Lockfile discipline until Task N lands:** if any task needs a new dependency, regenerate package-lock.json FROM SCRATCH (rm -rf node_modules package-lock.json && npm install) and validate `npm ci --dry-run` — the @emnapi npm bug bites otherwise.
- Comments dense "why, not what"; zustand state stays unit-testable without React.
- No new knip findings (`npx knip` clean-diff vs main for touched code).

---

### Task W: Workspace path-scope chip + promote (#29)

**Files:**
- Modify: `client/src/state/ui.ts` (add `codeScope?: string` + `setCodeScope`; doc comment contrasting scope-chip vs codeSearch vs real scan scope)
- Modify: `client/src/components/pages/Dashboard.tsx` (workspace cell/row click → `setCodeScope(ws)` instead of stuffing `codeSearch`; keep type-filter semantics; `searchPrefixFor` logic moves to where the chip filters)
- Modify: `client/src/components/pages/CodePage.tsx` (+ `TreeView.tsx`/`lib/tree.ts` as needed): chip row rendered when `codeScope` set — label = workspace, X clears, "Scan only this workspace" promote button; tree shows only files under the scope prefix (root workspace '.' never produces a chip), search input filters WITHIN the scoped set
- Modify: `client/src/components/app-shell/WorkspaceSwitcher.tsx` or reuse `useWorkspaceSwitch` for the promote (must include the discard-selection confirm; render the shared WorkspaceSwitchConfirmDialog)
- Test: ui-store unit tests (setCodeScope/clear semantics; scope+search compose), tree filter unit tests in `tests/client/tree.test.ts`, new e2e `tests/e2e/scope-chip.spec.ts`

**Interfaces:**
- Produces: `codeScope` in ui.ts (path-prefix view filter, session-only — deliberately NOT in the URL, same as filters/search; document that choice).
- Promote: calls `useWorkspaceSwitch().select(ws)`; ON SUCCESSFUL switch the chip clears (a real scope makes the view filter redundant). Promote button hidden/disabled when `report.scope === ws` already.
- Prefix semantics: scope 'packages/app' matches `filePath === 'packages/app'` prefix boundary (`filePath.startsWith(scope + '/')` — no false match on 'packages/app-2'); reuse/adapt Dashboard's existing `searchPrefixFor` boundary logic.

Steps:
- [ ] TDD ui-store + tree-filter tests → implement state + filtering.
- [ ] Chip UI (match FilterChips visual language; data-testid="scope-chip", "scope-chip-clear", "scope-chip-promote").
- [ ] Dashboard click rewiring; confirm no other `codeSearch` writer regressed (grep).
- [ ] e2e: dashboard workspace click → /code with chip + EMPTY search input; typing filters within scope; X restores full tree; promote (no selection) → scoped rescan, switcher label updates, chip gone; promote with selection → confirm dialog first.
- [ ] Full suite + typecheck + e2e; commit `feat: first-class workspace scope chip on the Code page with scan-promote (#29)`.

Verification (orchestrator, browser): the user's exact complaint path — Dashboard table click → chip (not search-box path), type to search within scope, promote → switcher picks it up.

---

### Task K: Tree keyboard navigation, ARIA tree pattern (#13)

**Files:**
- Modify: `client/src/components/code/TreeView.tsx`, `client/src/components/code/TreeNode.tsx` (roles/tabindex/handlers), possibly `client/src/lib/code-tree-focus.ts` (the `/`-shortcut focus registry — `/` should focus the FILTER input as today; from the filter, ArrowDown moves focus into the tree's active row)
- Test: pure key-handler helper (e.g. `treeKeyAction(key, ctx)` in lib/tree.ts) unit-tested; new e2e `tests/e2e/tree-keyboard.spec.ts`

**Interfaces (the ARIA tree contract):**
- Container `role="tree"` + `aria-label`; rows `role="treeitem"`, `aria-level`, `aria-setsize`, `aria-posinset`, dirs `aria-expanded`.
- Roving tabindex over the EXISTING flattened row list (visible rows only): tabIndex 0 on the active row, -1 elsewhere; activeIndex is component state; virtualization must `scrollToIndex` when keynav moves to an off-screen row.
- Keys: ArrowDown/ArrowUp ±1; ArrowRight = expand collapsed dir else move to first child; ArrowLeft = collapse expanded dir else move to parent; Home/End = first/last; Enter = open file (same contract as click: file search param + nonce bump) / toggle dir; Space = toggle the row's selection checkbox where present. No typeahead (out of scope — note in code).
- Existing mouse behavior, checkbox clicks, and the #25 `/`-focus flow unchanged.

Steps:
- [ ] TDD the pure key-action helper (all keys, boundary rows, dir-vs-file, parent lookup).
- [ ] Wire roles + roving tabindex + scrollToIndex; keep the virtualizer's overscan behavior intact.
- [ ] e2e: focus tree → arrows traverse (active row visibly changes), Right expands, Left collapses/jumps to parent, Enter on a file opens it (URL check), Space toggles selection count.
- [ ] Full suite + typecheck + e2e; commit `feat: ARIA tree keyboard navigation for the Code file tree (#13)`.

---

### Task Q: Packages row-click context preview (#24)

**Files:**
- Modify: `client/src/components/pages/PackagesPage.tsx` — table becomes a resizable split (same primitives as CodePage's `ui/resizable.tsx`, own persistence key): left = existing table, right = context panel, collapsed until a row is clicked
- Reuse: `client/src/components/code/CodePane.tsx` as the panel body — dependency-type issues already carry `filePath` (the workspace's package.json) + `line` (knip 6 position); unresolved imports carry the importing file + import-site line. Pass that single issue in `issues=[issue]` so CodePane's existing gutter badge + auto-scroll-to-line + pulse do the work.
- Small header above the pane: issue type + symbol + filePath, a close button, and (dependency rows only) an "other mentions in this file" count/list computed client-side from the fetched content (plain string scan for the dep name; skip if content unavailable/413).
- Test: pure helper for the mentions scan (unit) + new e2e `tests/e2e/packages-preview.spec.ts` (fixture has an unused dependency `left-pad` — click its row → panel shows package.json scrolled to the left-pad line with the badge).

Notes: row click must not fight the row's existing checkbox/selection affordances (click on checkbox = select, click elsewhere on row = preview; keep row hover cursor + aria-pressed or data-state on the active row). CodePane needs `openFileNonce`-like scroll key — reuse the prop with a local counter, do NOT touch the ui-store nonce (that belongs to the Code page).

Steps:
- [ ] TDD mentions helper → implement panel + split + row wiring.
- [ ] e2e; full suite + typecheck; commit `feat: Packages row-click context preview (#24)`.

Verification (orchestrator, browser): click dependency row → package.json at the right line; click unresolved-import row (fixture has one? if not, dependency-only is acceptable per fixture reality — note it); esc/close collapses panel.

---

### Task N: Migrate to pnpm (#28) — LAST, own gate

**Files:**
- Modify: `package.json` (`packageManager: "pnpm@<latest stable>"`; scripts stay `npm`-agnostic — audit for literal `npm run` self-references and switch to the manager-neutral form or `pnpm run`), delete `package-lock.json`, create `pnpm-lock.yaml`
- Modify: `.github/workflows/ci.yml` — pnpm/action-setup + setup-node `cache: 'pnpm'`, `pnpm install --frozen-lockfile`, `pnpm run …` on the Node 20/22 matrix
- Modify: `playwright.config.ts` webServer command + `scripts/e2e-fixture.ts` if they shell out to npm; README dev instructions section
- Check: `.gitignore` (pnpm store paths not needed), knip config (knip auto-detects pnpm), publish flow (`prepublishOnly` runs under pnpm; the published artifact is manager-agnostic — verify `pnpm publish --dry-run` output lists the same `files`)

Constraints:
- corepack pin, no global-install assumptions in CI.
- pnpm's strict hoisting may surface phantom deps (imports of undeclared transitive packages) — typecheck/tests/build/e2e catch them; fix by promoting to direct deps, listing each in the report.
- Node 20/22 CI matrix must pass; that's part of DONE (push happens at orchestrator level — implementer verifies everything local: install from clean clone dir, test, typecheck, build, full e2e, publish dry-run).

Steps:
- [ ] Fresh `pnpm install` → lockfile; fix any phantom deps; local full verification (unit, typecheck, build, e2e, `pnpm publish --dry-run`).
- [ ] CI workflow + README + config updates.
- [ ] Commit `build: migrate to pnpm (#28)`.

Verification (orchestrator): after merge+push, WATCH the CI run on both Node versions before closing #28.

---

## Final verification (orchestrator)

- [ ] Full suite + typecheck + build + e2e under pnpm.
- [ ] Browser pass: #29 chip flow end-to-end (the user's exact complaint), #13 keyboard traversal, #24 row preview.
- [ ] Merge to main, push, WATCH CI (pnpm now), close #29/#13/#24/#28 with verification comments; file/append follow-ups.
