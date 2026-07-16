# Client-Interaction Batch Implementation Plan (#35, #38)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the Code page's two per-interaction hot spots at 10k issues (#35) — every search keystroke synchronously rerunning filter→buildTree→expansion-policy→flatten (and Packages' filter→group→sort), and every mounted tree row paying O(subtree) `nodeSelectionState` + `scopedActionableIds` calls on every render (so an arrow-key press re-renders ~40 rows, root rows costing O(total issues) each) — plus #38's four smaller confirmed costs: the command palette mounting a `CommandItem` per distinct file path (3–6k at scale), ReviewPage's unmemoized `joinedRows` breaking the `okPaths` → `deletedOkPaths` memo chain every 2s during post-apply rescans, `rollupActionableIdsByType`'s O(n²) per-child array re-spreads, and AppSidebar's two O(n) filters per render.

**Architecture:** A new pure `buildSelectionSummaries(tree, selected, enabledTypes)` in `lib/tree.ts` does ONE post-order walk producing `Map<path, { state: 'none'|'some'|'all'; disabled: boolean }>` — TreeView memoizes it and passes each row two primitives, TreeNodeRow stops calling `nodeSelectionState`/`scopedActionableIds` entirely and gets `React.memo`'d behind identity-stable handlers (`toggleDir`/`expandAll` `useCallback`'d in TreeView, `onOpenFile` `useCallback`'d in CodePage). Search on both pages goes through `useDeferredValue`: the controlled input echoes keystrokes urgently, the filter/build memos consume the deferred value, and each page's `filtered` list derives from its chip-count pass (one substring scan, not two). The palette's Files group becomes a `useCommandState`-driven component that, only above a 200-path cap, pre-limits mounted items by a full-list substring match; below the cap it renders byte-identical DOM to today. ReviewPage's `joinedRows` gets `useMemo([flow])`, the rollup gets an append-into-fresh-accumulator loop, AppSidebar's counts become one memoized pass.

**Tech Stack:** TypeScript, React 19 (`useDeferredValue`, `memo`, `useCallback`), zustand (identity-stable actions), cmdk 1.1.1 (`useCommandState`), @tanstack/react-virtual (untouched), vitest (pure helpers only — this repo has NO jsdom component tests), Playwright e2e, pnpm 10.

## Global Constraints

- **Package manager: pnpm 10** (pnpm 11 is forbidden with Node 20). All commands run through pnpm: `pnpm test`, `pnpm test <file>`, `pnpm run typecheck`, `pnpm run test:e2e`.
- **Every existing unit AND e2e test passes unchanged.** The specific gates for this batch: `tests/e2e/tree-keyboard.spec.ts` (roving tabindex, `document.activeElement` focus-follow, Enter/Space contracts, the End+Home generation-guard race), `tests/e2e/scope-chip.spec.ts:161-167` (tree-search fill → "No files match that filter." → clear — this is the e2e pin that the deferred search still settles correctly), `tests/e2e/command-palette.spec.ts` (fill `src/forms.ts` → Enter opens it — pins the below-cap palette path), `tests/e2e/filters.spec.ts`, `tests/e2e/context-preview.spec.ts` + `tests/e2e/ignore.spec.ts` (Packages table), `tests/e2e/review.spec.ts` (ReviewPage), `tests/e2e/dashboard.spec.ts:154-174`. No assertion in any existing spec is edited.
- **e2e runs are always the FULL suite (`pnpm run test:e2e`), never a filtered subset.** The suite has a documented order dependency: ignore.spec.ts permanently consumes the fixture's only unused dependency (left-pad), so context-preview.spec.ts must run before it — guaranteed only by alphabetical file discovery under `workers: 1` / `fullyParallel: false`. A subset run skips that contract and can fail spuriously.
- **Run `pnpm run typecheck` before every commit** (all three tsconfigs).
- **Keyboard/focus machinery is behavior-frozen.** TreeView/TreeNode carry the ARIA-tree pattern (roving tabindex, rAF focus chains with the generation guard, container-level `treeKeyAction` dispatch, TriStateCheckbox's key-swallowing) — recently reviewed and pinned by tree-keyboard.spec.ts. This plan changes WHO computes tri-state and WHEN rows re-render; it must not change any keyboard/focus semantics. The memo-boundary stability contract is spelled out in Task 2 and must be kept as comments in the code.
- **All existing testids keep working:** `tree-search`, `tree-dir-*`, `tree-file-*`, `packages-search`, `packages-row-*`, `scope-chip*`, `selbar-count`.
- Non-goals (do not touch): `TriStateCheckbox`, `treeKeyAction`/`moveActive`/`registerRowRef` logic, the seed-delta/expand-store machinery (ui.ts), TanStack Virtual config on either page, `ui/command.tsx`, `nodeSelectionState`/`scopedActionableIds`/`idsToToggleForNode` signatures (PackagesPage's header checkbox and `toggleNodeSelection` still use them), the selection store.
- This plan is executed on a feature branch, task by task, one commit per task step where marked.

---

## Task 1: #35(b) pure half — `buildSelectionSummaries` (TDD)

One post-order walk over a built tree computing every node's tri-state AND disabled flag, replacing the per-row `nodeSelectionState` + `scopedActionableIds` pair (each O(subtree)) with a map lookup.

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/lib/tree.ts`
- Test (modify): `/Volumes/Dev/Projects/krona/knip-gui/tests/client/tree.test.ts`

**Interface** (pure, React-free, same file as the helpers it subsumes):

```ts
export interface SelectionSummary {
  state: 'none' | 'some' | 'all';
  /** True when the node has zero enabled-type actionable ids — its checkbox renders disabled. */
  disabled: boolean;
}

export function buildSelectionSummaries(
  tree: DirNode,
  selectedIds: ReadonlySet<string>,
  enabledTypes?: ReadonlySet<IssueType>,
): Map<string, SelectionSummary>;
```

Keyed by `node.path`: file and dir paths can never collide in one tree — a filesystem path can't be both a file and a directory in the same scan — so no `kind:` prefix is needed. The synthetic root (path `''`) gets an entry too; it's never rendered, harmless.

### Steps

- [ ] **Write the failing tests.** In `tests/client/tree.test.ts`, extend the tree.js import (lines 3–14) with `buildSelectionSummaries` and `scopedActionableIds`:

  ```ts
  import {
    autoExpandDepth,
    buildSelectionSummaries,
    buildTree,
    collectActionableIds,
    collectFileIssues,
    collectIds,
    countFiles,
    filterByScope,
    idsToToggleForNode,
    nodeSelectionState,
    scopedActionableIds,
    treeKeyAction,
  } from '../../client/src/lib/tree.js';
  ```

  Append after the `nodeSelectionState` describe block:

  ```ts
  describe('buildSelectionSummaries (#35: one post-order walk replacing per-row nodeSelectionState/scopedActionableIds)', () => {
    const a = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'a', fixable: true, fixModes: ['strip-export'] });
    const b = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'b', fixable: true, fixModes: ['strip-export'] });
    const c = issue({ type: 'files', filePath: 'src/orphan.ts', fixable: true, fixModes: ['delete-file'] });
    const unfixable = issue({ type: 'nsExports', filePath: 'lib/dead.ts', symbol: 'ns', fixable: false, fixModes: [] });

    it('computes none/some/all per file and rolls up through dirs', () => {
      const tree = buildTree([a, b, c]);
      const some = buildSelectionSummaries(tree, new Set([a.id]));
      expect(some.get('src/used.ts')).toEqual({ state: 'some', disabled: false });
      expect(some.get('src/orphan.ts')).toEqual({ state: 'none', disabled: false });
      expect(some.get('src')).toEqual({ state: 'some', disabled: false });

      const all = buildSelectionSummaries(tree, new Set([a.id, b.id, c.id]));
      expect(all.get('src/used.ts')).toEqual({ state: 'all', disabled: false });
      expect(all.get('src')).toEqual({ state: 'all', disabled: false });

      expect(buildSelectionSummaries(tree, new Set()).get('src')).toEqual({ state: 'none', disabled: false });
    });

    it('marks zero-actionable nodes disabled, and never counts an unfixable id as selected', () => {
      const tree = buildTree([a, unfixable]);
      const summaries = buildSelectionSummaries(tree, new Set([unfixable.id]));
      expect(summaries.get('lib/dead.ts')).toEqual({ state: 'none', disabled: true });
      expect(summaries.get('lib')).toEqual({ state: 'none', disabled: true });
      expect(summaries.get('src/used.ts')).toEqual({ state: 'none', disabled: false });
    });

    it('scopes to enabledTypes exactly like nodeSelectionState (a disabled-type id never counts, even selected)', () => {
      const exp = issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'e', fixable: true, fixModes: ['strip-export'] });
      const enumM = issue({ type: 'enumMembers', filePath: 'src/used.ts', symbol: 'm', fixable: true, fixModes: ['remove-member'] });
      const tree = buildTree([exp, enumM]);
      const enabled = new Set<IssueType>(['enumMembers']);
      expect(buildSelectionSummaries(tree, new Set([exp.id, enumM.id]), enabled).get('src/used.ts')).toEqual({
        state: 'all',
        disabled: false,
      });
      expect(buildSelectionSummaries(tree, new Set([exp.id]), enabled).get('src/used.ts')).toEqual({
        state: 'none',
        disabled: false,
      });
      // Every actionable issue at the node is of a DISABLED type -> the
      // checkbox disables (mirrors scopedActionableIds().length === 0).
      expect(buildSelectionSummaries(tree, new Set(), new Set<IssueType>(['files'])).get('src/used.ts')).toEqual({
        state: 'none',
        disabled: true,
      });
    });

    it('agrees with nodeSelectionState + scopedActionableIds on EVERY node (the exact per-row calls it replaces)', () => {
      const t = issue({ type: 'types', filePath: 'src/deep/nested/shapes.ts', symbol: 'T', fixable: true, fixModes: ['strip-export'] });
      const tree = buildTree([a, b, c, unfixable, t]);
      const cases: [ReadonlySet<string>, ReadonlySet<IssueType> | undefined][] = [
        [new Set(), undefined],
        [new Set([a.id, c.id]), undefined],
        [new Set([a.id, b.id]), new Set<IssueType>(['exports'])],
        [new Set([a.id, t.id]), new Set<IssueType>(['files', 'types'])],
      ];
      for (const [selectedIds, enabled] of cases) {
        const summaries = buildSelectionSummaries(tree, selectedIds, enabled);
        const check = (node: TreeNode): void => {
          expect(summaries.get(node.path)).toEqual({
            state: nodeSelectionState(node, selectedIds, enabled),
            disabled: scopedActionableIds(node, enabled).length === 0,
          });
          if (node.kind === 'dir') node.children.forEach(check);
        };
        tree.children.forEach(check);
      }
    });
  });
  ```

- [ ] Run `pnpm test tests/client/tree.test.ts` — expected: FAIL (`buildSelectionSummaries` unresolved).

- [ ] **Implement.** In `client/src/lib/tree.ts`, append after `nodeSelectionState` (ends line 326):

  ```ts
  export interface SelectionSummary {
    state: 'none' | 'some' | 'all';
    /** True when the node has zero enabled-type actionable ids — its checkbox renders disabled. */
    disabled: boolean;
  }

  /**
   * Every node's tri-state + disabled flag in ONE post-order walk (#35):
   * TreeNode.tsx used to call nodeSelectionState + scopedActionableIds per
   * rendered row — each O(subtree), so a root-level dir row cost O(total
   * issues) on every render of every mounted row. This walk computes the
   * identical answers for the whole tree in O(total issues) once, for
   * TreeView to memoize and hand each row as two primitives.
   *
   * Semantics are exactly nodeSelectionState's (only fixable-or-ignorable ids
   * count; enabledTypes restricts to enabled-type ids; zero actionable ids
   * reads 'none') and `disabled` is exactly `scopedActionableIds(node,
   * enabledTypes).length === 0` — pinned node-for-node by the equivalence
   * test in tests/client/tree.test.ts. Dir counts are SUMS of child results,
   * never a re-scan of the dir's own rolled-up id arrays — that per-node
   * re-scan is the O(subtree) cost this exists to remove.
   *
   * Keyed by node.path: a filesystem path can never be both a file and a dir
   * within one scan, so paths are unique across both kinds. The synthetic
   * root ('') gets an entry; it's never rendered as a row.
   */
  export function buildSelectionSummaries(
    tree: DirNode,
    selectedIds: ReadonlySet<string>,
    enabledTypes?: ReadonlySet<IssueType>,
  ): Map<string, SelectionSummary> {
    const summaries = new Map<string, SelectionSummary>();
    function walk(node: TreeNode): { total: number; selectedCount: number } {
      let total = 0;
      let selectedCount = 0;
      if (node.kind === 'file') {
        for (const [type, ids] of Object.entries(node.actionableIdsByType) as [IssueType, string[]][]) {
          if (enabledTypes && !enabledTypes.has(type)) continue;
          total += ids.length;
          for (const id of ids) if (selectedIds.has(id)) selectedCount += 1;
        }
      } else {
        for (const child of node.children) {
          const result = walk(child);
          total += result.total;
          selectedCount += result.selectedCount;
        }
      }
      const state: SelectionSummary['state'] =
        total === 0 || selectedCount === 0 ? 'none' : selectedCount === total ? 'all' : 'some';
      summaries.set(node.path, { state, disabled: total === 0 });
      return { total, selectedCount };
    }
    walk(tree);
    return summaries;
  }
  ```

  (When `enabledTypes` is omitted, iterating `actionableIdsByType` still covers exactly `actionableIds` — `finalizeFile` builds the by-type map from the same `actionableIssues` list, so the union over all types IS the full actionable set.)

- [ ] Run `pnpm test tests/client/tree.test.ts` — expected: PASS.
- [ ] Run `pnpm test` and `pnpm run typecheck` — expected: green/clean.
- [ ] Commit: `perf: buildSelectionSummaries — one post-order walk for tree tri-state + disabled (#35)`

---

## Task 2: #35(b) component half — O(1) rows, stable handlers, `React.memo(TreeNodeRow)`

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/code/TreeView.tsx`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/code/TreeNode.tsx`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/pages/CodePage.tsx`

**Keyboard-machinery risk analysis (read before editing — the memo boundary must not break focus-follow):**

The roving-tabindex contract (tree-keyboard.spec.ts) depends on: (1) exactly one row having `tabIndex 0`/`data-active`; (2) `moveActive`'s rAF chain finding the target row's DOM node in `rowRefs`; (3) `treeKeyAction` dispatch reading the CURRENT `rows`/`selected` at keypress time. Memoizing `TreeNodeRow` is safe for all three **iff every prop is either a primitive or identity-stable**, because:
- A memo-skipped row keeps its mounted DOM node AND its `rowRefs` registration — `registerRowRef` (already `useCallback([])`) is only re-invoked when a row actually re-renders, and the rAF focus chain reads the map, which memoization never empties.
- An `activeIndex` change flips the `active` prop on exactly two rows — precisely the rows whose `tabIndex`/`data-active` must change. They re-render; everything else skips. Focus-follow is unchanged.
- The container-level `handleTreeKeyDown` is NOT a row prop — Enter/Space/arrows semantics can't be affected by the row memo at all.
- The `index` prop changes whenever expansion above a row shifts the flattened indices — that row re-renders and its ref-callback closure re-registers under the new index, exactly as today (the closure identity changes, so React calls old(null)/new(el)).

Props that MUST stay identity-stable (and where stability comes from — keep this list as the memo's doc comment): `row` (TreeView's `rows` useMemo), `registerRowRef` (useCallback `[]`), `onActivate` (React's `setActiveIndex`, stable by contract), `selected`/`enabledTypes` (store-owned references, change only on real selection/chip changes), `onToggleExpand` (Task 2's useCallback'd `toggleDir`), `onToggleIds`/`onAddFileFiltered` (zustand actions threaded through CodePage, stable), `onOpenFile` (Task 2's useCallback in CodePage). `selectionState`/`checkboxDisabled`/`active` are primitives.

**Accepted non-goal:** a selection toggle still re-renders every mounted row (the `selected` set's identity changes, and ancestor states legitimately change anyway) — but each row is now O(1), so ~40 O(1) renders. The wins #35 names — arrow keys, search keystrokes (with Task 3's deferral), poll landings with unchanged data — all skip.

### Steps

- [ ] **TreeView: import + summaries memo.** In `client/src/components/code/TreeView.tsx`, add `buildSelectionSummaries` to the tree.js import (lines 48–57):

  ```ts
  import {
    autoExpandDepth,
    buildSelectionSummaries,
    buildTree,
    countFiles,
    filterByScope,
    toggleNodeSelection,
    treeKeyAction,
    type DirNode,
    type FlatRow,
  } from '../../lib/tree.js';
  ```

  After the `rows` useMemo (lines 240–244), add:

  ```ts
  // One post-order walk for every row's tri-state + disabled flag (#35):
  // recomputed only when the tree, the selection cart, or the enabled chips
  // actually change — never per row, never per arrow-key render. Each row
  // gets two primitives out of this map (see the render loop below), which
  // is what lets React.memo(TreeNodeRow) skip rows whose state didn't move.
  const selectionSummaries = useMemo(
    () => buildSelectionSummaries(tree, selected, enabledTypes),
    [tree, selected, enabledTypes],
  );
  ```

- [ ] **TreeView: `useCallback` the handlers.** Replace `toggleDir` and `expandAll` (lines 313–328), keeping the existing comments and adding the stability note (`collapseAll` is toolbar-only, not a row prop — leave it as is):

  ```ts
  // toggleDir merges into whatever's already expanded — if the store hasn't
  // been seeded yet (theoretically possible: the seeding effect above hasn't
  // committed, though in practice it always has by the time a row is
  // interactive), seed it first from the same policy default the render
  // already used, so the toggle merges against what the user is actually
  // looking at rather than an empty store set. initExpandedDirs/
  // storeToggleDir are both synchronous zustand `set` calls, so the store
  // reflects the seed before storeToggleDir reads it.
  // useCallback (#35): passed to every memo'd TreeNodeRow as onToggleExpand —
  // a fresh closure per render would defeat the row memo wholesale.
  const toggleDir = useCallback(
    (path: string) => {
      if (!expandedDirsInitialized) initExpandedDirs(policyExpandedDirs);
      storeToggleDir(path);
    },
    [expandedDirsInitialized, initExpandedDirs, policyExpandedDirs, storeToggleDir],
  );

  const expandAll = useCallback(() => {
    storeExpandAll(allDirPaths(tree));
  }, [storeExpandAll, tree]);
  ```

  (`handleTreeKeyDown`'s `toggleDir(action.path)` call and the toolbar's `onClick={expandAll}` need no edits — same names.)

- [ ] **TreeView: pass the two primitives per row.** In the virtualized render loop (lines 454–483), look the summary up and thread it through:

  ```tsx
  {virtualizer.getVirtualItems().map((virtualRow) => {
    const row = rows[virtualRow.index]!;
    // Fallback can only fire if a row's path somehow isn't in the walk's map
    // (it always is — both are built from the same `tree`); 'none'+disabled
    // is the safe render for an impossible state.
    const summary = selectionSummaries.get(row.node.path) ?? { state: 'none' as const, disabled: true };
    return (
      <div
        key={rowKey(row)}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: virtualRow.size,
          transform: `translateY(${virtualRow.start}px)`,
        }}
      >
        <TreeNodeRow
          row={row}
          index={virtualRow.index}
          active={virtualRow.index === safeActiveIndex}
          registerRowRef={registerRowRef}
          onActivate={setActiveIndex}
          selected={selected}
          enabledTypes={enabledTypes}
          selectionState={summary.state}
          checkboxDisabled={summary.disabled}
          onToggleExpand={toggleDir}
          onToggleIds={onToggleIds}
          onAddFileFiltered={onAddFileFiltered}
          onOpenFile={onOpenFile}
        />
      </div>
    );
  })}
  ```

- [ ] **TreeNode: take the primitives, drop the per-row O(subtree) calls, memoize.** In `client/src/components/code/TreeNode.tsx`:
  1. Imports: add `memo` to the react import (line 11) and remove the two now-unused helpers from the tree.js import (lines 16–23):

     ```ts
     import { memo, useEffect, useRef } from 'react';
     ```

     ```ts
     import {
       toggleNodeSelection,
       type DirNode,
       type FileNode,
       type FlatRow,
     } from '../../lib/tree.js';
     ```

  2. Add to `TreeNodeRowProps` (after `enabledTypes`, line 44):

     ```ts
     /**
      * This row's tri-state, from TreeView's single buildSelectionSummaries
      * walk (#35) — replaces the per-row nodeSelectionState call (O(subtree)
      * per row; O(total issues) for a root-level dir row).
      */
     selectionState: 'none' | 'some' | 'all';
     /** True when the row has zero enabled-type actionable ids (same walk) — replaces the per-row scopedActionableIds().length === 0 check. */
     checkboxDisabled: boolean;
     ```

  3. Wrap the component in `memo`, destructure the new props, and delete the four per-row helper calls. Replace the `export function TreeNodeRow(…)` declaration (line 266) with (body edits shown; everything not mentioned stays byte-identical):

     ```tsx
     // React.memo boundary (#35): with every prop a primitive or an
     // identity-stable reference, an arrow-key press (activeIndex change)
     // re-renders exactly the two rows whose `active` flipped instead of all
     // ~40 mounted rows, and a poll that changes nothing re-renders none.
     // Stability contract, per prop — breaking ANY of these silently defeats
     // the memo (and re-introduces per-keystroke full-window renders):
     //   row              TreeView's `rows` useMemo (changes on tree/expansion)
     //   registerRowRef   useCallback([]) in TreeView
     //   onActivate       React setState dispatcher (stable by contract)
     //   selected         selection-store set (changes on real toggles only —
     //                    a toggle re-rendering the mounted window is accepted;
     //                    ancestor tri-states legitimately change then anyway)
     //   enabledTypes     ui-store chip set (changes on chip toggles only)
     //   onToggleExpand   TreeView's useCallback'd toggleDir
     //   onToggleIds / onAddFileFiltered   zustand actions (stable)
     //   onOpenFile       CodePage's useCallback'd onOpenFile
     // Focus-follow (tree-keyboard.spec.ts) is unaffected: a memo-skipped row
     // keeps its mounted DOM node and its rowRefs registration; the rows that
     // DO re-render are exactly the ones whose tabIndex/data-active must
     // change, and moveActive's rAF chain reads rowRefs, which memoization
     // never empties.
     export const TreeNodeRow = memo(function TreeNodeRow({
       row,
       index,
       active,
       registerRowRef,
       onActivate,
       selected,
       enabledTypes,
       selectionState,
       checkboxDisabled,
       onToggleExpand,
       onToggleIds,
       onAddFileFiltered,
       onOpenFile,
     }: TreeNodeRowProps) {
     ```

     In the dir branch, delete lines 311–312:

     ```ts
     const state = nodeSelectionState(node, selected, enabledTypes);
     const disabled = scopedActionableIds(node, enabledTypes).length === 0;
     ```

     and change its `TriStateCheckbox` usage to:

     ```tsx
     <TriStateCheckbox
       state={selectionState}
       disabled={checkboxDisabled}
       ariaLabel={`Select all issues in ${node.path}/`}
       title={checkboxDisabled ? 'No fixable or ignorable issues in this directory' : undefined}
       onChange={() => handleCheckboxChange(node)}
     />
     ```

     In the file branch, delete the same two lines (367–368) and change its checkbox to:

     ```tsx
     <TriStateCheckbox
       state={selectionState}
       disabled={checkboxDisabled}
       ariaLabel={`Select issues in ${node.path}`}
       title={checkboxDisabled ? 'No fixable or ignorable issues in this file' : undefined}
       onChange={() => handleCheckboxChange(node)}
     />
     ```

     Close the component with `});` (it's a `memo(...)` call now). `handleCheckboxChange`/`toggleNodeSelection` stay exactly as they are — the click-time toggle still computes its own state from the live `selected`/`enabledTypes` (once per click, O(subtree), fine).

- [ ] **CodePage: stable `onOpenFile`.** In `client/src/components/pages/CodePage.tsx`, extend the react import (line 18):

  ```ts
  import { useCallback, useMemo, useState } from 'react';
  ```

  Replace the `function onOpenFile(path: string) { … }` declaration (lines 93–101) with:

  ```ts
  // useCallback (#35): threaded through TreeView into every memo'd
  // TreeNodeRow (and TreeView's own Enter-key handler) — a fresh closure per
  // CodePage render would defeat the row memo. All three deps are stable:
  // bumpOpenFileNonce is a zustand action, navigate is TanStack Router's
  // stable navigate function, codePanelRef is a ref object.
  const onOpenFile = useCallback(
    (path: string) => {
      // Bump the nonce on EVERY explicit open, even re-clicking the already-open
      // row: the router won't re-render on a navigation to an identical URL, so
      // the nonce (a store write) is what re-fires CodePane's scroll/pulse. `ws`
      // rides along via retainSearchParams; other search params are untouched.
      bumpOpenFileNonce();
      navigate({ to: '/code', search: (prev) => ({ ...prev, file: path }) });
      codePanelRef.current?.expand();
    },
    [bumpOpenFileNonce, navigate, codePanelRef],
  );
  ```

  (It moves from a hoisted function declaration to a `const` — it's only referenced in JSX below its new position, so no TDZ issue. `closeFile`/`toggleCodePanel` are not row props; leave them.)

- [ ] Run `pnpm test` — expected: green (Task 1's equivalence test now pins what the rows render).
- [ ] Run `pnpm run typecheck` — expected: clean (in particular: no remaining `nodeSelectionState`/`scopedActionableIds` references in TreeNode.tsx — `grep -n "nodeSelectionState\|scopedActionableIds" client/src/components/code/TreeNode.tsx` must show zero hits; PackagesPage's own uses are untouched).
- [ ] Run `pnpm run test:e2e` — expected: FULL suite green. tree-keyboard.spec.ts is the hard gate: every flow (click-to-activate, ArrowRight/Left expand-collapse with focus staying put, ArrowDown traversal, Enter-opens, Space-toggles-selection twice, the End+Home generation race) must pass unchanged.
- [ ] **Manual verification** (render counts aren't unit/e2e-observable): run the dev app against a large project (or any project with a few hundred issues), open Code, enable React DevTools "Highlight updates when components render": (1) holding ArrowDown repaints only the two rows whose active state changed per step, not the window; (2) toggling one file checkbox updates its own row plus its ancestors' tri-states correctly; (3) checkbox disabled states match pre-change behavior (compare a dir with only unfixable issues); (4) `/`-focus, Enter-to-open, Space-to-select all still work by hand.
- [ ] Commit: `perf: O(1) tri-state per tree row via selection-summary map; memoized TreeNodeRow behind stable handlers (#35)`

---

## Task 3: #35(a) — deferred search on both pages, one shared filter pass

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/code/TreeView.tsx`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/pages/PackagesPage.tsx`

`useDeferredValue(search)` feeds the filter/build memos; the controlled inputs keep echoing keystrokes urgently. The issue's optional "derive chip counts from one shared pass" **is included** — it falls out naturally as "derive `filtered` FROM the chip-count list" (one substring scan instead of two), sound on both pages:
- **TreeView:** `scopedIssues` ⊆ CodePage's `codeIssues`, which is already `filterIssues(issues, ALL_CODE_TYPES, '')` — so `chipScopeIssues`'s `ALL_CODE_TYPES` gate never excludes anything, and `chipScopeIssues.filter(enabledTypes.has)` is provably identical (same elements, same order) to the old `filterIssues(scopedIssues, enabledTypes, search)` for ANY `enabledTypes`.
- **PackagesPage:** identical iff `packagesFilters ⊆ PACKAGE_TYPES`, which holds by construction: it defaults to the full set (state/ui.ts:179) and its only writers are `togglePackagesFilter` (called from FilterChips with `types={PACKAGE_TYPES}` and CommandPalette with `PACKAGE_TYPES`) and Dashboard's `setPackagesFilters([type])` (Dashboard.tsx:143,170 — only package-shaped types route to `/packages`). Document this invariant at the derivation site.

No behavior change beyond render scheduling — the existing e2e pins (`scope-chip.spec.ts:161-167` fills `tree-search` and asserts the empty state, then clears it; `filters.spec.ts` drives chips; `dashboard.spec.ts:161/174` asserts `tree-search` value) are the gates and pass unchanged because Playwright's auto-waiting assertions absorb the deferred settle.

### Steps

- [ ] **TreeView.** Add `useDeferredValue` to the react import (line 42):

  ```ts
  import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
  ```

  Replace the two filter memos (lines 170–176, the `chipScopeIssues`/`filtered` block) with:

  ```ts
  // Deferred search (#35): the controlled Input echoes each keystroke
  // urgently (it renders from `search` directly, below), while the whole
  // rebuild pipeline — filter -> buildTree -> expansion policy -> flatten ->
  // selection summaries — consumes the DEFERRED value, so React commits the
  // echoed keystroke first and rebuilds the tree in a separate,
  // interruptible render. The seed-delta machinery is untouched: it reads
  // scopedIssues, which never depended on search (by design — see the top
  // doc comment).
  const deferredSearch = useDeferredValue(search);

  // FilterChips' own live counts intentionally use the FULL type set (only
  // search/scope-scoped) so a chip shows "how many exist" even while it's off
  // — the tree itself, below, uses the real `enabledTypes`. `filtered` is
  // DERIVED from chipScopeIssues rather than a second filterIssues pass
  // (#35's shared pass): every issue here already passed the ALL_CODE_TYPES
  // gate (CodePage pre-filters `issues` to code types, and scope only
  // narrows) and the substring match — the expensive part — so narrowing to
  // the enabled chips is a cheap Set check, and both lists are guaranteed to
  // reflect the SAME search snapshot.
  const chipScopeIssues = useMemo(
    () => filterIssues(scopedIssues, ALL_CODE_TYPES, deferredSearch),
    [scopedIssues, deferredSearch],
  );
  const filtered = useMemo(() => chipScopeIssues.filter((i) => enabledTypes.has(i.type)), [chipScopeIssues, enabledTypes]);
  ```

  Everything else stays: the Input's `value={search}` and the empty-state text's `search ? … : …` remain on the URGENT value (the input must echo instantly; the empty-state wording can lag the row list by one deferred render when clearing a no-match search — a frame-level artifact, accepted).

- [ ] **PackagesPage.** Add `useDeferredValue` to the react import (line 13):

  ```ts
  import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
  ```

  Replace the filter memos (lines 169–173, the `chipScopeIssues`/`filtered`/`groups` block) with:

  ```ts
  // Deferred search (#35), same shape as TreeView's: the input echoes
  // urgently, the refilter/regroup/resort pipeline consumes the deferred
  // value in an interruptible render.
  const deferredSearch = useDeferredValue(search);

  // FilterChips' own live counts intentionally use the FULL package type set
  // (only search-scoped) so a chip shows "how many exist" even while it's
  // off — same pattern as TreeView.tsx's chipScopeIssues for the Code page.
  // `filtered` derives from chipScopeIssues (one substring pass, #35's
  // shared pass) — sound because packagesFilters ⊆ PACKAGE_TYPES by
  // construction: it defaults to the full set (state/ui.ts) and its only
  // writers pass PACKAGE_TYPES members (FilterChips/CommandPalette's
  // togglePackagesFilter, Dashboard's setPackagesFilters([type]) on
  // package-routed cells).
  const chipScopeIssues = useMemo(
    () => filterIssues(issues, ALL_PACKAGE_TYPES, deferredSearch),
    [issues, deferredSearch],
  );
  const filtered = useMemo(
    () => chipScopeIssues.filter((i) => packagesFilters.has(i.type)),
    [chipScopeIssues, packagesFilters],
  );
  const groups = useMemo(() => groupByWorkspace(filtered), [filtered]);
  ```

- [ ] Run `pnpm test` and `pnpm run typecheck` — expected: green/clean.
- [ ] Run `pnpm run test:e2e` — expected: FULL suite green (scope-chip.spec.ts's search fill/clear and filters.spec.ts's chip counts are the specific gates).
- [ ] **Manual verification:** against a large project, type quickly into the Code tree search and the Packages search — the input must never drop or lag keystrokes while the tree/table settles a beat later; clearing the search restores the full view; chip counts match the searched subset.
- [ ] Commit: `perf: defer Code/Packages search into the filter memos; derive filtered from the chip-count pass (#35)`

---

## Task 4: #38 grab-bag — palette file cap, ReviewPage joinedRows memo, rollup append, sidebar counts

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/lib/tree.ts`
- Test (modify): `/Volumes/Dev/Projects/krona/knip-gui/tests/client/tree.test.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/CommandPalette.tsx`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/pages/ReviewPage.tsx`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/app-shell/AppSidebar.tsx`

**Palette decision (issue offered three options — cap / ≥2-char gate / `shouldFilter={false}` + pre-limit):** chosen — **a 200-item cap that only engages above 200 distinct paths, with a full-list substring pre-limit driven by cmdk's own search state (`useCommandState`, cmdk 1.1.1 exports it)**. Rationale: (a) below the cap the mounted DOM is byte-identical to today, so small projects (and command-palette.spec.ts's 6-file fixture, which types `src/forms.ts` into cmdk's default filter) keep the exact current UX including browse-all-files-on-empty-query; (b) `shouldFilter={false}` is a whole-`Command` switch, not per-group — it would force reimplementing matching/ranking for Pages/Workspaces/Actions too, strictly more churn; (c) a ≥2-char gate is unnecessary once the cap bounds mounting — the substring pre-scan is O(paths) string work (microseconds at 6k paths) even for 1-char queries, and the gate would make files undiscoverable-by-browsing on big projects for no additional bound. Trade-off accepted and documented in code: above the cap, file matching is substring (over the FULL list), not cmdk's subsequence fuzzy — cmdk still ranks the pre-limited survivors (a substring match always scores > 0 under command-score, so the pre-limit never fights the ranker).

### Steps

- [ ] **Rollup: write the failing aliasing test.** The behavior (grouped ids) is already pinned by `tree.test.ts`'s "groups actionableIds by type on both FileNode and DirNode"; the new risk an append-based implementation introduces is ALIASING a child's own array as the accumulator and then mutating it. Pin that. Append inside the `buildTree` describe block:

  ```ts
  it('rollup byType arrays are fresh per dir, never aliased to a child node\'s own arrays (#38 append-based rollup)', () => {
    const a = issue({ type: 'exports', filePath: 'src/a.ts', symbol: 'x', fixable: true, fixModes: ['strip-export'] });
    const tree = buildTree([a]);
    const src = findChild(tree, 'src') as DirNode;
    const file = src.children[0] as FileNode;
    // Same contents…
    expect(src.actionableIdsByType.exports).toEqual(file.actionableIdsByType.exports);
    expect(tree.actionableIdsByType.exports).toEqual(file.actionableIdsByType.exports);
    // …but distinct arrays at every level: mutating a dir's rollup (or the
    // root's) must never corrupt a child's own actionableIdsByType.
    expect(src.actionableIdsByType.exports).not.toBe(file.actionableIdsByType.exports);
    expect(tree.actionableIdsByType.exports).not.toBe(src.actionableIdsByType.exports);
  });
  ```

  Run `pnpm test tests/client/tree.test.ts` — expected: PASS already against the spread-based implementation (it copies). This test exists to stay green across the rewrite and catch the tempting single-child-alias shortcut; TDD here pins the invariant, not a new behavior.

- [ ] **Rollup: rewrite as append-into-fresh-accumulator.** In `client/src/lib/tree.ts`, replace `rollupActionableIdsByType` (lines 122–130) with:

  ```ts
  function rollupActionableIdsByType(children: TreeNode[]): Partial<Record<IssueType, string[]>> {
    const byType: Partial<Record<IssueType, string[]>> = {};
    for (const child of children) {
      for (const [type, ids] of Object.entries(child.actionableIdsByType) as [IssueType, string[]][]) {
        // Append into one accumulator per type (#38) instead of re-spreading
        // the accumulated array for every child — the old
        // `[...(byType[type] ?? []), ...ids]` re-copied everything gathered so
        // far on EACH child, O(children²) across a wide dir (~5M element
        // copies for a 1k-file directory). An element loop rather than
        // `push(...ids)` sidesteps engines' argument-count limits when a
        // child dir rolls up tens of thousands of ids. The accumulator always
        // starts as a FRESH array — never a child's own array — so mutating
        // it here can't corrupt a child node (pinned by tree.test.ts's
        // no-aliasing test).
        const acc = (byType[type] ??= []);
        for (const id of ids) acc.push(id);
      }
    }
    return byType;
  }
  ```

  Run `pnpm test tests/client/tree.test.ts` — expected: PASS (grouping tests + the aliasing pin, unchanged).

- [ ] **CommandPalette: capped, search-aware Files group.** In `client/src/components/CommandPalette.tsx`:
  1. Add the cmdk import below the react import (line 17):

     ```ts
     import { useMemo } from 'react';
     import { useCommandState } from 'cmdk';
     ```

  2. Replace the inline Files block (lines 135–144):

     ```tsx
     {filePaths.length > 0 && (
       <CommandGroup heading="Files">
         {filePaths.map((path) => (
           <CommandItem key={path} value={path} onSelect={() => openFile(path)}>
             <FileCode2 className="size-4" />
             <span className="truncate">{path}</span>
           </CommandItem>
         ))}
       </CommandGroup>
     )}
     ```

     with:

     ```tsx
     <FilesGroup filePaths={filePaths} onOpenFile={openFile} />
     ```

  3. Add below the `CommandPalette` component (same file):

     ```tsx
     // Mounted-item cap for the Files group (#38): cmdk mounts a live
     // CommandItem per rendered child and re-scores every one per keystroke —
     // fine for pages/workspaces/actions (a handful), but 3–6k distinct file
     // paths made ⌘K-open and each keystroke pay hundreds of ms. Below the
     // cap nothing changes: every path mounts and cmdk's own fuzzy filter
     // ranks them exactly as before (command-palette.spec.ts's small-fixture
     // flow is byte-identical). Above it, a substring pre-limit over the FULL
     // path list picks at most FILE_RESULTS_CAP items to mount — searching
     // the whole list, not the capped slice, so a path outside the first 200
     // is still reachable by typing — and cmdk then ranks those survivors (a
     // substring match always scores positive under cmdk's command-score, so
     // the pre-limit never hides an item the ranker would keep). Trade-off,
     // accepted: above the cap, file matching is substring rather than
     // cmdk's subsequence-fuzzy ('sfr' no longer hits src/forms.ts) — the
     // alternative, shouldFilter={false}, is a whole-Command switch that
     // would force hand-rolling matching for every OTHER group too.
     const FILE_RESULTS_CAP = 200;

     function FilesGroup({ filePaths, onOpenFile }: { filePaths: string[]; onOpenFile: (path: string) => void }) {
       // cmdk's live search text — this component renders inside
       // CommandDialog's <Command> wrapper (ui/command.tsx), which is the
       // context useCommandState needs. Subscribing here (rather than
       // controlling CommandInput from CommandPalette) keeps the input
       // uncontrolled, so its fresh-on-reopen behavior is untouched.
       const search = useCommandState((state) => state.search);
       const visiblePaths = useMemo(() => {
         if (filePaths.length <= FILE_RESULTS_CAP) return filePaths;
         const needle = search.trim().toLowerCase();
         if (!needle) return filePaths.slice(0, FILE_RESULTS_CAP);
         const out: string[] = [];
         for (const path of filePaths) {
           if (path.toLowerCase().includes(needle)) {
             out.push(path);
             if (out.length === FILE_RESULTS_CAP) break;
           }
         }
         return out;
       }, [filePaths, search]);

       if (visiblePaths.length === 0) return null;
       return (
         <CommandGroup heading="Files">
           {visiblePaths.map((path) => (
             <CommandItem key={path} value={path} onSelect={() => onOpenFile(path)}>
               <FileCode2 className="size-4" />
               <span className="truncate">{path}</span>
             </CommandItem>
           ))}
         </CommandGroup>
       );
     }
     ```

- [ ] **ReviewPage: memoize `joinedRows`.** In `client/src/components/pages/ReviewPage.tsx`, replace line 289:

  ```ts
  const joinedRows = flow.status === 'applied' ? joinResults(flow.diffs, flow.results, flow.items) : [];
  ```

  with:

  ```ts
  // Memoized on [flow] (#38): joinResults is O(plan), and worse, the old
  // inline call minted a fresh array identity EVERY render — breaking the
  // okPaths -> deletedOkPaths memo chain below it, so the whole chain rerun
  // on each render the post-apply background rescan triggers (every 2s while
  // the applied step is on screen). `flow` only changes identity through
  // dispatch, so this now recomputes exactly on real flow transitions.
  const joinedRows = useMemo(
    () => (flow.status === 'applied' ? joinResults(flow.diffs, flow.results, flow.items) : []),
    [flow],
  );
  ```

  (`useMemo` is already imported on line 20. The downstream `okPaths` (line 290) and `commitSummary`/`deletedOkPaths` memos need no edits — they now actually get stable inputs.)

- [ ] **AppSidebar: one memoized counting pass.** In `client/src/components/app-shell/AppSidebar.tsx`, change the react import (line 9):

  ```ts
  import { useMemo, type ComponentType } from 'react';
  ```

  Replace the two filters (lines 53–54):

  ```ts
  const codeCount = issues.filter((i) => CODE_TYPE_SET.has(i.type)).length;
  const packagesCount = issues.filter((i) => PACKAGE_TYPE_SET.has(i.type)).length;
  ```

  with:

  ```ts
  // One memoized pass (#38) instead of two O(n) filters re-run on every
  // render — this component re-renders on every route change
  // (useRouterState), every activity write, and every report poll.
  // CODE_TYPES and PACKAGE_TYPES are disjoint (lib/filters.ts), so else-if
  // counts each issue at most once.
  const { codeCount, packagesCount } = useMemo(() => {
    let code = 0;
    let packages = 0;
    for (const item of issues) {
      if (CODE_TYPE_SET.has(item.type)) code += 1;
      else if (PACKAGE_TYPE_SET.has(item.type)) packages += 1;
    }
    return { codeCount: code, packagesCount: packages };
  }, [issues]);
  ```

- [ ] Run `pnpm test` — expected: green.
- [ ] Run `pnpm run typecheck` — expected: clean (in particular the removed inline Files JSX leaves no unused imports — `FileCode2` is still used by `FilesGroup`).
- [ ] Run `pnpm run test:e2e` — expected: FULL suite green. Specific gates: `command-palette.spec.ts` (below-cap Files flow: fill `src/forms.ts` → Enter opens it; ⌘K toggle), `review.spec.ts` (applied step + CommitBar paths — `joinedRows` consumers), `smoke.spec.ts` (sidebar counts render).
- [ ] **Manual verification:** (1) small project — ⌘K with an empty query still lists every file; (2) large project (or Task 5's synthetic intercept run locally) — ⌘K opens instantly, Elements panel shows ≤200 file `command-item`s, and typing a path that sorts beyond the 200th still surfaces it; (3) run a fix through Review to 'applied' and watch a poll tick — React DevTools shows CommitBar not re-rendering from a fresh `paths` identity.
- [ ] Commit: `perf: palette file-list cap, ReviewPage joinedRows memo, append-based rollup, memoized sidebar counts (#38)`

---

## Task 5 (optional, recommended): e2e pin — palette file cap at scale

**Files**
- Create: `/Volumes/Dev/Projects/krona/knip-gui/tests/e2e/command-palette-cap.spec.ts`

**Justification / scope decision:** The prompt asked whether the tri-state work makes a scale e2e cheap. **The tri-state/deferral/memo work itself gets no new e2e** — it is behavior-preserving by construction (Task 1's node-for-node equivalence test is the strongest pin possible; render counts and deferral timing are not observable from Playwright without flaky timing assertions, and a big-tree row-count spec would pin TanStack Virtual's windowing, which predates this batch and is untouched). But Task 4's palette cap IS new user-visible behavior that **no existing spec can see** (it only engages above 200 distinct paths; the fixture has ~6), and `packages-virtualization.spec.ts` / `dashboard.spec.ts`'s synthetic `page.route('**/api/report')` intercept makes pinning it nearly free — including the one subtle contract worth pinning: the pre-filter searches the FULL path list, not the capped slice (the trap a naive slice-then-filter falls into).

### Steps

- [ ] **Write the spec.** Create `tests/e2e/command-palette-cap.spec.ts` with exactly:

  ```ts
  // CommandPalette Files-group cap pin (#38), mirroring dashboard.spec.ts's
  // synthetic-intercept approach: with more distinct file paths than
  // FILE_RESULTS_CAP (200), the palette must mount a bounded Files group,
  // yet typing must still reach a path OUTSIDE the first 200 — proving the
  // substring pre-limit scans the full path list, not the capped slice.
  //
  // Intercepts /api/report via page.route — nothing touches the shared
  // fixture or the server, so (like dashboard.spec.ts and
  // packages-virtualization.spec.ts) this spec is order-independent: it
  // neither needs left-pad (consumed by ignore.spec.ts) nor mutates anything
  // a later spec reads.
  import { expect, test } from '@playwright/test';

  const FILES = 300;
  const pad = (i: number) => String(i).padStart(3, '0');

  // Shape must match src/core/types.ts's Issue/Report and the /api/report
  // envelope ({ status, report }) — same contract dashboard.spec.ts fabricates.
  function syntheticReport() {
    const issues: unknown[] = [];
    for (let i = 0; i < FILES; i++) {
      issues.push({
        id: `exp-${pad(i)}`,
        type: 'exports',
        workspace: '.',
        filePath: `src/mod-${pad(i)}.ts`,
        symbol: `unused${i}`,
        fixable: true,
        fixModes: ['strip-export', 'delete-declaration'],
      });
    }
    return {
      status: 'ready',
      report: { issues, scannedAt: new Date().toISOString(), workspaces: ['.'] },
    };
  }

  test('palette caps mounted file items at 200 but still finds paths beyond the cap by typing', async ({ page }) => {
    await page.route('**/api/report', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticReport()) }),
    );

    await page.goto('/');
    await expect(page.getByText(/^Scanned /)).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press('Meta+k');
    const paletteInput = page.getByPlaceholder('Search pages, files, workspaces, actions…');
    await expect(paletteInput).toBeVisible();

    // Empty query: the Files group holds the capped alphabetical slice.
    // Mounted-item budget = 200 files + 5 pages + 1 workspace entry ("All
    // workspaces" — the synthetic report has no other workspaces) + 1 action
    // (Re-run scan; no per-page filter items on /dashboard) = 207.
    const items = page.locator('[data-slot="command-item"]');
    await expect(page.getByText('src/mod-000.ts')).toBeVisible();
    expect(await items.count()).toBeLessThanOrEqual(207);

    // mod-299 sorts LAST — far outside the capped slice — but a query must
    // reach it: the pre-limit substring-scans all 300 paths.
    await paletteInput.fill('mod-299');
    await expect(page.getByText('src/mod-299.ts')).toBeVisible();
    expect(await items.count()).toBeLessThanOrEqual(207);

    // And Enter opens it — same open-file contract command-palette.spec.ts
    // pins for the below-cap path.
    await page.keyboard.press('Enter');
    await expect(paletteInput).toBeHidden();
    await expect(page).toHaveURL(/\/code\?.*mod-299\.ts/);
  });
  ```

- [ ] Run `pnpm run test:e2e` — expected: FULL suite green including the new spec (it fails against pre-Task-4 code: 300 mounted file items > 207).
- [ ] Run `pnpm run typecheck` — expected: clean (tsconfig.tests.json covers tests/e2e).
- [ ] Commit: `test: e2e pin for the command-palette file cap at scale (#38)`

---

## Post-implementation verification (before finishing the branch)

- [ ] `pnpm test` — full unit suite green (including the new `buildSelectionSummaries` block and the rollup aliasing pin).
- [ ] `pnpm run typecheck` — clean across all three tsconfigs.
- [ ] `pnpm run build` — compiles.
- [ ] `pnpm run test:e2e` — full suite green in ONE run (order contract intact; tree-keyboard.spec.ts and scope-chip.spec.ts are this batch's hard gates).
- [ ] `grep -n "nodeSelectionState\|scopedActionableIds" client/src/components/code/TreeNode.tsx` — zero hits; `grep -rn "nodeSelectionState" client/src/components/pages/PackagesPage.tsx` — still present (untouched).
- [ ] `grep -c "filterIssues" client/src/components/code/TreeView.tsx` — exactly 1 call site (the shared pass) plus the import line.
- [ ] Manual smoke per Task 2/3/4's manual-verification steps against one large project in a single session: arrow-key row repaints, responsive typing on both searches, capped palette, single-row checkbox repaint semantics on Packages (pre-existing, must not have regressed).

## Out of scope (explicit follow-ups, do not do here)

- Making selection toggles skip unaffected mounted tree rows (would require rows to read the selection store directly or a per-row selected-boolean protocol like PackagesPage's — the `selected` prop identity change re-rendering ~40 O(1) rows is accepted; #35 names arrow keys/keystrokes/polls, which all skip now).
- Debouncing (as opposed to deferring) either search input, or virtualizing FilterChips.
- Any change to `nodeSelectionState`/`scopedActionableIds` themselves — still the click-time and Packages-header implementations.
- A "Type to see more files…" affordance in the palette when the cap truncates an over-200 result set (cmdk hides empty groups; a forceMount hint row is UI surface #38 didn't ask for).

## Behavioral notes pinned by this plan (for reviewers)

- Tree checkbox tri-states and disabled flags are computed by ONE memoized walk in TreeView; TreeNodeRow renders them from props. Node-for-node equivalence with the old per-row calls is unit-pinned.
- Arrow-key presses now re-render exactly the two rows whose `active` changed (memo + stable handlers). Focus-follow, roving tabindex, Enter/Space semantics, and the rAF generation guard are untouched — tree-keyboard.spec.ts passes unchanged.
- Both search inputs echo keystrokes urgently; results settle in a deferred render. Clearing a no-match Code search can show the "No issues match the current filters." wording for one frame before rows repopulate — accepted frame-level artifact.
- `filtered` on both pages derives from the chip-count list (one substring pass). Equivalence arguments are documented inline (CodePage pre-filters to code types; `packagesFilters ⊆ PACKAGE_TYPES` by writer audit).
- Palette Files group: byte-identical below 200 distinct paths; above it, substring (not fuzzy) matching over the full list, capped at 200 mounted items.
- ReviewPage's applied-step memo chain (`joinedRows` → `okPaths` → `deletedOkPaths`/`commitSummary`) is now stable across post-apply rescan polls; recomputes only on flow dispatches.
