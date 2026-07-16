# Client-Perf Batch Implementation Plan (#31, #34)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the client's three worst large-input costs: PackagesPage rendering every dependency issue as a live DOM row with its own Radix Tooltip (#31 — 30–50k nodes on a 5k-issue monorepo), CodePane/DiffView putting multi-MB strings inside react-query keys that TanStack `JSON.stringify`s on every render plus an unmemoized `plainCodeHtml` that rewrites the whole `innerHTML` per checkbox toggle (#34 items 1–2), and shiki synchronously tokenizing arbitrarily large files on the main thread (#34 item 3, scoped to a size cap — no worker in this batch).

**Architecture:** PackagesPage adopts Dashboard's threshold-gated spacer-`<tr>` virtualization **per workspace group** (not flattened into one list — see Task 3's decision note): each `WorkspaceTable` gets its own `useVirtualizer` windowing against the one shared `packages-scroll` scrollport via `scrollMargin`, its header (workspace label folded into the `<thead>`) goes `position: sticky`, and rows become a `memo`'d `PackageIssueRow` keyed on `selected.has(issue.id)` booleans with a `title` attribute instead of the per-row Radix Tooltip. CodePane's highlight query keys on `[filePath, lang, fileQuery.dataUpdatedAt]` (the fetch's own timestamp — changes exactly when content can have changed), DiffView's on `[planId, filePath]` (a plan's diffs are immutable once compiled; both call sites have `planId` in scope), `plainCodeHtml` gets a `useMemo`, and a new pure `isTooLargeToHighlight` helper in `lib/highlighter.ts` gates shiki behind a ~200k-char cap, falling back to the existing plain-`<pre>` + `highlightNote` banner path.

**Tech Stack:** TypeScript, React 19, @tanstack/react-query, @tanstack/react-virtual 3.14.x (already a dependency — Dashboard uses it), shadcn table primitives, vitest (pure helpers only — this repo has NO jsdom component tests), Playwright e2e, pnpm 10.

## Global Constraints

- **Package manager: pnpm 10** (pnpm 11 is forbidden with Node 20). All commands run through pnpm: `pnpm test`, `pnpm test <file>`, `pnpm run typecheck`, `pnpm run test:e2e`.
- **Every existing unit AND e2e test passes unchanged.** The e2e suite is the REAL gate for #31: `tests/e2e/ignore.spec.ts` and `tests/e2e/context-preview.spec.ts` both drive the Packages table (row click, Enter-to-open, checkbox, preview panel, Escape) against the real fixture, and `tests/e2e/dashboard.spec.ts:155` asserts the `workspace-group-packages/ws-01` section testid after a packages cell click. No assertion in any existing spec is edited.
- **e2e runs are always the FULL suite (`pnpm run test:e2e`), never a filtered subset.** The suite has a documented order dependency: ignore.spec.ts permanently consumes the fixture's only unused dependency (left-pad), so context-preview.spec.ts must run before it — guaranteed only by alphabetical file discovery under `workers: 1` / `fullyParallel: false` (both spec headers document this reciprocally). A subset run skips that contract and can fail spuriously.
- **Run `pnpm run typecheck` before every commit** (all three tsconfigs).
- **React 19 idioms:** `ref` is a regular prop (shadcn's `TableBody` forwards `React.ComponentProps<'tbody'>`, so `<TableBody ref=…>` just works — no forwardRef); `memo`/`useCallback` where a memo boundary needs identity-stable props.
- **Copy Dashboard's virtualization pattern, don't invent one:** threshold-gated (`> 50`), spacer `<tr>`s (never `position: absolute` rows — they fall out of table layout), `overscan: 6`, explicit `height: ROW_HEIGHT` on virtualized rows, sticky `<thead>` enabled by neutralizing shadcn's `data-slot="table-container"` wrapper from the scroller (`[&_[data-slot=table-container]]:overflow-visible`) — see `client/src/components/pages/Dashboard.tsx:182-200` and `:265-333`.
- **All existing testids keep working:** `packages-scroll`, `workspace-group-*`, `packages-row-*`, `packages-sort-*`, `packages-preview*`, `code-pane-badge-*`, `diff-view-*`.
- Non-goals (do not touch): web-worker shiki, line-virtualized code view, server file cap, `PlanStore`/wire shapes, PackagesPage's preview-panel/Escape/persistence logic (recently pinned by context-preview.spec.ts).
- This plan is executed on a feature branch, task by task, one commit per task.

---

## Task 1: #34 items 1+2 — cheap query keys (CodePane + DiffView) and memoized plainCodeHtml

Tiny, pure wins. No DOM/UX change of any kind.

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/code/CodePane.tsx`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/flows/DiffView.tsx`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/pages/ReviewPage.tsx`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/flows/RemoveIgnoreDialog.tsx`

No unit test can pin these (no jsdom component tests in this repo; `tests/client/*` covers pure helpers only). Verification = typecheck + full unit suite + the e2e specs that render both components (`codepane-crash.spec.ts`, `smoke.spec.ts`, `ignore.spec.ts` asserts `diff-view-knip.json` contents, `review.spec.ts`), which run in Task 3/4's full-suite gates and in post-verification.

### Steps

- [ ] **CodePane: key the highlight query on `dataUpdatedAt`, not content.** In `client/src/components/code/CodePane.tsx`, add `useMemo` to the react import (line 15):

  ```ts
  import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
  ```

  Replace the `highlightQuery` block (lines 291–301) with:

  ```ts
  const highlightQuery = useQuery({
    // Keyed on the fetch's own timestamp, NOT the content string (#34 item 1):
    // TanStack computes queryHash via JSON.stringify(queryKey) on EVERY
    // render, and CodePane re-renders on every gutter-checkbox toggle,
    // selection change, and poll landing — a 2MB content string in the key
    // made each of those pay an O(2MB) stringify. `fileQuery.dataUpdatedAt`
    // is bumped by react-query on every successful file fetch, so it changes
    // exactly when `content` can have changed; `content` itself is read via
    // closure in queryFn, which is safe under that invariant.
    queryKey: ['highlight', filePath, lang, fileQuery.dataUpdatedAt] as const,
    queryFn: async () => {
      if (!filePath || !lang || content === undefined) {
        throw new Error('highlight query ran without a file path/language/content');
      }
      return highlightToHtml(content, filePath);
    },
    enabled: filePath !== null && lang !== undefined && content !== undefined,
    retry: false,
  });
  ```

- [ ] **CodePane: memoize `plainCodeHtml`.** Directly below the `highlightQuery` block (still ABOVE the `if (filePath === null)` early return — Rules of Hooks), add:

  ```ts
  // Memoized plain-<pre> fallback (#34 item 2): plainCodeHtml over a 2MB file
  // is O(content) string work, and its result's IDENTITY matters — the old
  // inline call in render returned a fresh string each time, so React rewrote
  // the container's entire innerHTML (dangerouslySetInnerHTML diffs by string
  // identity) and re-fired CodeBlock's marker-measuring layout effect on
  // every checkbox toggle. undefined until content lands.
  const plainHtml = useMemo(() => (content === undefined ? undefined : plainCodeHtml(content)), [content]);
  ```

  Then in the html-selection block (lines 367–375 pre-edit), replace both `html = plainCodeHtml(content);` calls (the `lang === undefined` branch and the `highlightQuery.error` branch) with `html = plainHtml;`. (`content` is defined past the error/loading returns, so `plainHtml` is too; `html`'s type stays `string | undefined` and the existing `html === undefined` render guard is unchanged.)

- [ ] **DiffView: key on planId + filePath instead of the full diff string.** In `client/src/components/flows/DiffView.tsx`, the query key at lines 26–31 currently embeds `diff.diff` (the entire unified diff). `DiffEntry` (`client/src/lib/apply-flow.ts:16-19`) is just `{ filePath, diff }` — no cheap id on it — but BOTH render sites have the plan id in scope, so thread it in as a required prop:

  ```ts
  export interface DiffViewProps {
    diff: DiffEntry;
    /**
     * Id of the compiled plan this diff belongs to (#34 item 1, DiffView
     * variant): the highlight query used to key on the FULL diff string,
     * paying a JSON.stringify of it on every render of the preview step. A
     * plan's diffs are immutable once compiled — every re-preview mints a
     * fresh planId (src/fix/plan.ts's newPlanId) — so planId+filePath
     * identifies the diff text exactly.
     */
    planId: string;
    defaultOpen?: boolean;
  }

  export function DiffView({ diff, planId, defaultOpen = true }: DiffViewProps) {
    const [open, setOpen] = useState(defaultOpen);

    const highlightQuery = useQuery({
      queryKey: ['diff-highlight', planId, diff.filePath],
      queryFn: () => highlightDiff(diff.diff),
      enabled: open,
      retry: false,
    });
  ```

  (Rest of the component unchanged.)

- [ ] **Update DiffView's two call sites.**
  1. `client/src/components/pages/ReviewPage.tsx` (~line 325): the `selectedDiff` computation narrows `flow` but TS can't carry that narrowing into `renderMain`, so hoist the narrowed flow. Replace:

     ```ts
     const selectedDiff =
       flow.status === 'previewed' || flow.status === 'applying' || flow.status === 'applied'
         ? flow.diffs.find((d) => d.filePath === selectedFilePath)
         : undefined;
     ```

     with:

     ```ts
     const previewedFlow =
       flow.status === 'previewed' || flow.status === 'applying' || flow.status === 'applied' ? flow : undefined;
     const selectedDiff = previewedFlow?.diffs.find((d) => d.filePath === selectedFilePath);
     ```

     and in `renderMain` (~line 341) replace:

     ```tsx
     if (selectedDiff) {
       return <DiffView key={selectedDiff.filePath} diff={selectedDiff} />;
     }
     ```

     with:

     ```tsx
     if (selectedDiff && previewedFlow) {
       return <DiffView key={selectedDiff.filePath} diff={selectedDiff} planId={previewedFlow.planId} />;
     }
     ```

     (All three narrowed statuses carry `planId` — see `ApplyFlowState` in `client/src/lib/apply-flow.ts:21-34`.)
  2. `client/src/components/flows/RemoveIgnoreDialog.tsx` (~line 157, inside the `flow.status === 'previewed'` branch, whose state carries `planId`):

     ```tsx
     <DiffView key={d.filePath} diff={d} planId={flow.planId} />
     ```

- [ ] Run `pnpm test` — expected: entire unit suite green (nothing here is unit-covered; this catches accidental import breakage).
- [ ] Run `pnpm run typecheck` — expected: clean (in particular, the ReviewPage narrowing change and the new required `planId` prop compile at both call sites and nowhere else — `grep -rn "<DiffView" client/src` must show exactly the two updated sites).
- [ ] Commit: `perf: cheap highlight query keys (file dataUpdatedAt, diff planId) + memoized plainCodeHtml (#34)`

---

## Task 2: #34 item 3 (scoped) — client-side highlight cap with plain-text notice

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/lib/highlighter.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/code/CodePane.tsx`
- Test (modify): `/Volumes/Dev/Projects/krona/knip-gui/tests/client/highlighter.test.ts`

**Interfaces** (produced in `lib/highlighter.ts` — pure, so unit-testable in the existing pure-helper test file):

```ts
export const HIGHLIGHT_MAX_CHARS = 200_000;
export function isTooLargeToHighlight(content: string): boolean;
```

### Steps

- [ ] **Write the failing test.** Append to `tests/client/highlighter.test.ts` (import `HIGHLIGHT_MAX_CHARS, isTooLargeToHighlight` from the existing `'../../client/src/lib/highlighter.js'` import line):

  ```ts
  describe('isTooLargeToHighlight (client-side highlight cap, #34)', () => {
    it('small content is highlightable', () => {
      expect(isTooLargeToHighlight('const a = 1;')).toBe(false);
    });

    it('content exactly at the cap is still highlightable (cap is exclusive)', () => {
      expect(isTooLargeToHighlight('x'.repeat(HIGHLIGHT_MAX_CHARS))).toBe(false);
    });

    it('content one char over the cap is not', () => {
      expect(isTooLargeToHighlight('x'.repeat(HIGHLIGHT_MAX_CHARS + 1))).toBe(true);
    });
  });
  ```

- [ ] Run `pnpm test tests/client/highlighter.test.ts` — expected: FAIL (unresolved exports).

- [ ] **Implement the helper.** Append to `client/src/lib/highlighter.ts` (after `highlightDiff`, line 124):

  ```ts
  /**
   * Client-side highlight cap (#34 item 3): shiki tokenizes synchronously on
   * the main thread, so a 2MB/50k-line file is a multi-second freeze followed
   * by ~500k tokenized-span DOM nodes. Files over this size skip shiki and
   * render CodePane's existing plain-<pre> path with a notice instead.
   * Measured in UTF-16 code units (`content.length`, O(1)) rather than true
   * bytes — the ~200KB cap is a ballpark, not a contract, and an exact byte
   * count would cost an O(n) encode pass per check. Moving shiki to a Web
   * Worker so large files can be highlighted without blocking is the
   * follow-up (out of scope for this batch — see the plan's out-of-scope
   * section).
   */
  export const HIGHLIGHT_MAX_CHARS = 200_000;

  /** Pure: true when `content` is too large to shiki-highlight on the main thread. */
  export function isTooLargeToHighlight(content: string): boolean {
    return content.length > HIGHLIGHT_MAX_CHARS;
  }
  ```

- [ ] **Wire it into CodePane.** In `client/src/components/code/CodePane.tsx`:
  1. Extend the highlighter import (line 20):

     ```ts
     import { highlightToHtml, isTooLargeToHighlight, issueLines, langForPath } from '../../lib/highlighter.js';
     ```

  2. Directly below `const lang = …` (line 289), add:

     ```ts
     // #34 item 3 (scoped to a cap — no web worker in this batch): over-cap
     // files reuse the plain-<pre> + highlightNote path that non-highlightable
     // extensions already take, so no new UI surface is invented.
     const tooLargeToHighlight = content !== undefined && isTooLargeToHighlight(content);
     ```

  3. Gate the highlight query off entirely for over-cap files — change its `enabled` line to:

     ```ts
     enabled: filePath !== null && lang !== undefined && content !== undefined && !tooLargeToHighlight,
     ```

  4. In the html-selection block, insert the cap branch between the `lang === undefined` branch and the `highlightQuery.data` branch (final shape, post-Task-1):

     ```ts
     let html: string | undefined;
     let highlightNote: string | undefined;
     if (lang === undefined) {
       html = plainHtml;
       highlightNote = 'No syntax highlighting available for this file type.';
     } else if (tooLargeToHighlight) {
       html = plainHtml;
       highlightNote = 'Syntax highlighting is skipped for large files — showing plain text.';
     } else if (highlightQuery.data) {
       html = highlightQuery.data;
     } else if (highlightQuery.error) {
       html = plainHtml;
       highlightNote = 'Syntax highlighting failed — showing plain text.';
     }
     ```

     (The subtle notice is the existing `highlightNote` banner — the muted one-liner CodePane already renders for the other two plain-text cases. The branch must come BEFORE `highlightQuery.data`: the disabled query never produces data for over-cap content, and the explicit order keeps that invariant local instead of relying on it.)

- [ ] Run `pnpm test tests/client/highlighter.test.ts` — expected: PASS.
- [ ] Run `pnpm test` — expected: entire suite green.
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] **Manual verification** (unit tests can't render CodePane): `pnpm run e2e:fixture` to stand up the fixture app (or any dev run against a scratch project), drop a >200k-char `.ts` file into the scanned project (e.g. `node -e "require('fs').writeFileSync('big.ts', 'export const x = 1;\n'.repeat(15000))"` — ~300KB), make knip flag it (it's unimported, so it lands under files), open it on the Code page: expect instant plain-text render with the "Syntax highlighting is skipped for large files" banner and NO multi-second freeze; a small file still highlights. Delete the scratch file afterwards.
- [ ] Commit: `feat: skip client-side syntax highlighting above 200k chars with a notice (#34)`

---

## Task 3: #31 — virtualize PackagesPage, title tooltips, memoized rows

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/pages/PackagesPage.tsx` (only file)

**Decision — per-group virtualization, not flatten-into-one-list.** The current UX (`PackagesPage.tsx:206-224`) is one `<section>` per workspace, each with its own bordered `<Table>`, its own tri-state select-all, and its own (shared-state) sort header, all inside one shared scroller (`packages-scroll`). Per-group virtualization keeps that entire structure — sections, testids (`workspace-group-*`, `packages-sort-*`), per-group select-all semantics, and the below-threshold rendering path byte-identical for small groups (the e2e fixture's single 1-row group never virtualizes, so `context-preview.spec.ts`/`ignore.spec.ts` exercise unchanged DOM) — and needs only a `scrollMargin` per group to window against the shared scrollport. Flattening would mean one merged table with interleaved group-header rows, collapsing the per-group select-all/sort headers into new UI, and sticky headers would then require a `rangeExtractor` that force-renders off-window header rows plus split spacer math (non-contiguous rendered indices break the single-padTop spacer trick). That is strictly more structural churn for the same DOM bound. Sticky group headers ARE feasible in the per-group shape — CSS-only: a sticky `<thead>` pins while its own table intersects the scroller top and is pushed out by the next table (its containing block), exactly the multi-section sticky-header pattern — so we get them essentially free, and better than the flatten variant's JS-driven equivalent.

**What changes inside the file**
1. Per-group threshold-gated spacer-`<tr>` virtualization (Dashboard's pattern + `scrollMargin` for the shared scroller).
2. Sticky group header: the workspace label moves from the loose `<h3>` into a first full-width row of the (now sticky) `<thead>`, so ONE sticky block carries label + select-all + sort buttons. Two required CSS unlocks, both with Dashboard precedent: the scroller neutralizes shadcn's `data-slot="table-container"` overflow wrapper, and the per-group border wrapper drops `overflow-hidden` (an overflow other than `visible` would make the WRAPPER the sticky scrollport, and since it grows with the table the header would never pin — the cost is ≤6px of un-clipped row-hover corner, cosmetic).
3. Per-row Radix `<Tooltip>` (`:361-366`) → `title` attribute (it only ever showed `typeLabel`).
4. Rows extracted into `memo`'d `PackageIssueRow` keyed on `selected.has(issue.id)`/`activeIssueId === issue.id` booleans; `openPreview` gets `useCallback` so the memo isn't defeated by a fresh closure each render (`toggle` from zustand is already identity-stable).

### Steps

- [ ] **Imports and constants.** Replace line 13 with:

  ```ts
  import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
  ```

  Add below the existing imports (with the other library imports):

  ```ts
  import { useVirtualizer } from '@tanstack/react-virtual';
  ```

  DELETE line 31 (`import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';`) — the row Tooltip was its only use in this file.

  Below `const ALL_PACKAGE_TYPES…` (line 37), add:

  ```ts
  // Same threshold/row-height/overscan as Dashboard.tsx's workspace table —
  // one virtualization dialect in this app, not two. 36px is the measured
  // shadcn row height (p-2 cells + text line box + border), the same value
  // dashboard.spec.ts's scroll math empirically pins.
  const ROW_HEIGHT = 36;
  const VIRTUALIZE_THRESHOLD = 50;
  ```

- [ ] **PackagesPage body: stable `openPreview`, scroller ref.** Wrap `openPreview` (lines 82–101) in `useCallback`, keeping its entire existing comment verbatim:

  ```ts
  const openPreview = useCallback(
    (issue: Issue) => {
      setPreviewIssue(issue);
      setPreviewNonce((n) => n + 1);
      const panel = previewPanelRef.current;
      if (!panel || !panel.isCollapsed()) return;
      // [existing resize('35%') comment, verbatim]
      panel.resize('35%');
    },
    // Identity-stable on purpose: PackageIssueRow is memo'd on this handler —
    // a fresh closure per render (every search keystroke) would defeat the
    // memo for every rendered row. Setters and the panel ref never change.
    [previewPanelRef],
  );
  ```

  (`closePreview` and the Escape effect stay exactly as they are — the effect's dep comment already documents why `closePreview` is deliberately not stabilized.)

  Add a scroller ref next to the other refs:

  ```ts
  // The ONE scrollport all workspace groups window against — each
  // WorkspaceTable's virtualizer gets this element plus its own scrollMargin.
  const scrollerRef = useRef<HTMLDivElement>(null);
  ```

  Change the scroll container div (line 206) to attach the ref and neutralize shadcn's table wrapper (same arbitrary variant and rationale as Dashboard.tsx:277-281 — the `data-slot="table-container"` overflow-x-auto wrapper would otherwise become each sticky header's nearest scrollport and it grows with its table, so headers would never pin):

  ```tsx
  <div
    ref={scrollerRef}
    className="min-h-0 flex-1 overflow-auto [&_[data-slot=table-container]]:overflow-visible"
    data-testid="packages-scroll"
  >
  ```

  And pass the ref through in the group loop:

  ```tsx
  <WorkspaceTable
    key={group.workspace}
    group={group}
    selected={selected}
    onToggleIds={toggle}
    sortKey={sortKey}
    sortDir={sortDir}
    onSort={toggleSort}
    sortIndicator={sortIndicator}
    activeIssueId={previewIssue?.id}
    onRowClick={openPreview}
    scrollerRef={scrollerRef}
  />
  ```

- [ ] **Rewrite `WorkspaceTable`** (lines 262–378) as (complete):

  ```tsx
  function WorkspaceTable({
    group,
    selected,
    onToggleIds,
    sortKey,
    sortDir,
    onSort,
    sortIndicator,
    activeIssueId,
    onRowClick,
    scrollerRef,
  }: {
    group: WorkspaceGroup;
    selected: ReadonlySet<string>;
    onToggleIds: (ids: string[]) => void;
    sortKey: SortKey;
    sortDir: SortDir;
    onSort: (key: SortKey) => void;
    sortIndicator: (key: SortKey) => string;
    activeIssueId: string | undefined;
    onRowClick: (issue: Issue) => void;
    scrollerRef: RefObject<HTMLDivElement | null>;
  }) {
    const actionableIds = useMemo(() => group.issues.filter(isActionable).map((i) => i.id), [group.issues]);
    const headerState = nodeSelectionState({ actionableIds }, selected);
    const sortedIssues = useMemo(() => sortIssues(group.issues, sortKey, sortDir), [group.issues, sortKey, sortDir]);
    const label = group.workspace === '.' ? '(root)' : group.workspace;

    // Threshold-gated spacer-<tr> virtualization, Dashboard.tsx's pattern
    // (#31) applied PER GROUP against the one shared packages-scroll
    // scrollport. Small groups (the common case, and the whole e2e fixture)
    // take the render-everything path and produce the same DOM as before.
    const tbodyRef = useRef<HTMLTableSectionElement>(null);
    const shouldVirtualize = sortedIssues.length > VIRTUALIZE_THRESHOLD;

    // Where this group's tbody starts inside the scroller's content —
    // react-virtual's `scrollMargin` for lists that don't start at their
    // scrollport's top. rect-difference + scrollTop is scroll-invariant. The
    // ResizeObserver on the scroller's content column re-measures when
    // EARLIER groups change height (a filter/search shrinking a preceding
    // table would otherwise leave this one windowing against a stale
    // offset); the identity-guarded setState keeps the effect loop-free.
    // Only window SELECTION depends on this — row positions come from the
    // spacer rows' natural flow — so overscan(6) absorbs small measurement
    // error by construction.
    const [scrollMargin, setScrollMargin] = useState(0);
    useLayoutEffect(() => {
      if (!shouldVirtualize) return;
      const tbody = tbodyRef.current;
      const scroller = scrollerRef.current;
      if (!tbody || !scroller) return;
      const measure = () => {
        const next = Math.round(
          tbody.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop,
        );
        setScrollMargin((prev) => (prev === next ? prev : next));
      };
      measure();
      // jsdom (vitest) has no ResizeObserver; skip so tests don't crash —
      // same guard as CodePane's CodeBlock.
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(scroller.firstElementChild ?? scroller);
      return () => observer.disconnect();
    }, [shouldVirtualize, scrollerRef]);

    const virtualizer = useVirtualizer({
      count: sortedIssues.length,
      getScrollElement: () => scrollerRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 6,
      scrollMargin,
    });
    // Spacer <tr>s above/below the window, not absolutely-positioned rows —
    // same rationale as Dashboard.tsx: absolute positioning pulls a <tr> out
    // of table layout and its cells stop aligning with the header columns.
    // With scrollMargin set, react-virtual folds it into every item's
    // start/end (items live in the SCROLLER's coordinate space), so the
    // spacer heights subtract it back out to get list-local pixels.
    const virtualItems = virtualizer.getVirtualItems();
    const renderedIndices = shouldVirtualize ? virtualItems.map((v) => v.index) : sortedIssues.map((_, index) => index);
    const padTop = shouldVirtualize && virtualItems.length > 0 ? virtualItems[0]!.start - scrollMargin : 0;
    const padBottom =
      shouldVirtualize && virtualItems.length > 0
        ? virtualizer.getTotalSize() - (virtualItems[virtualItems.length - 1]!.end - scrollMargin)
        : 0;

    const colCount = SORT_COLUMNS.length + 1; // +1 for the checkbox column

    return (
      <section data-testid={`workspace-group-${group.workspace}`}>
        {/* No overflow-hidden on this wrapper (it used to have it purely to
            round the table's corners): any non-visible overflow would make
            THIS div the sticky thead's containing scrollport, and since it
            grows with the table the header would never pin. The ≤6px of
            row-hover background that can now poke past the rounded corner is
            cosmetic. */}
        <div className="rounded-md border border-border">
          <Table>
            {/* Sticky group header (#31): pins against packages-scroll while
                this group's table intersects the top, then gets pushed out by
                the next group's header (sticky is bounded by its own table).
                The workspace label lives in the thead's first row now —
                previously a loose <h3> above the table — so label, select-all
                and sort buttons pin as one block. */}
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead
                  colSpan={colCount}
                  className="h-8 text-xs font-medium text-muted-foreground"
                  data-testid={`packages-group-label-${group.workspace}`}
                >
                  {label}
                </TableHead>
              </TableRow>
              <TableRow>
                <TableHead className="w-8">
                  <TriStateCheckbox
                    state={headerState}
                    disabled={actionableIds.length === 0}
                    title={actionableIds.length === 0 ? 'No fixable or ignorable issues here' : 'Select all'}
                    ariaLabel={`Select all issues in ${label}`}
                    onChange={() => onToggleIds(idsToToggleForNode({ actionableIds }, selected))}
                  />
                </TableHead>
                {SORT_COLUMNS.map(({ key, label: colLabel }) => (
                  <TableHead key={key}>
                    <button
                      type="button"
                      className="flex items-center gap-1 font-medium"
                      onClick={() => onSort(key)}
                      data-testid={`packages-sort-${key}`}
                      aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                    >
                      {colLabel} {sortIndicator(key)}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody ref={tbodyRef}>
              {padTop > 0 && (
                <tr aria-hidden style={{ height: padTop }}>
                  <td colSpan={colCount} />
                </tr>
              )}
              {renderedIndices.map((index) => {
                const issue = sortedIssues[index]!;
                return (
                  <PackageIssueRow
                    key={issue.id}
                    issue={issue}
                    isSelected={selected.has(issue.id)}
                    isActive={issue.id === activeIssueId}
                    onToggleIds={onToggleIds}
                    onRowClick={onRowClick}
                    height={shouldVirtualize ? ROW_HEIGHT : undefined}
                  />
                );
              })}
              {padBottom > 0 && (
                <tr aria-hidden style={{ height: padBottom }}>
                  <td colSpan={colCount} />
                </tr>
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    );
  }
  ```

- [ ] **Add `PackageIssueRow`** below `WorkspaceTable` (complete):

  ```tsx
  // Memoized per-row component (#31), keyed on `isSelected`/`isActive`
  // BOOLEANS rather than the `selected` set itself: a checkbox toggle swaps
  // the set's identity but flips `selected.has(id)` for exactly one id, so
  // with memo exactly one row re-renders instead of all of them. This only
  // holds because every handler prop is identity-stable (zustand's `toggle`
  // action, PackagesPage's useCallback'd openPreview) and `issue` objects
  // come straight from the report array (filter/sort re-wrap the arrays, not
  // the elements). The old per-row Radix <Tooltip> — a live component
  // instance per row, ~5k of them on a big monorepo — is a plain `title`
  // attribute now; it only ever showed typeLabel text.
  const PackageIssueRow = memo(function PackageIssueRow({
    issue,
    isSelected,
    isActive,
    onToggleIds,
    onRowClick,
    height,
  }: {
    issue: Issue;
    isSelected: boolean;
    isActive: boolean;
    onToggleIds: (ids: string[]) => void;
    onRowClick: (issue: Issue) => void;
    /** Set (to ROW_HEIGHT) only when the parent group is virtualized, so the spacer math matches reality. */
    height: number | undefined;
  }) {
    const actionable = isActionable(issue);
    return (
      // Keyboard-operable row, same pattern as TreeNode.tsx's TreeNodeRow:
      // role="button" + tabIndex=0 + Enter/Space both open the preview panel,
      // so keyboard-only users can reach it (a bare onClick on a <tr> is
      // mouse-only). The checkbox cell swallows click AND keydown (Space
      // bubbles as keydown) below, so checking a box never also opens the
      // panel. `data-state="selected"` piggybacks on ui/table.tsx's own
      // `data-[state=selected]:bg-muted` TableRow styling — no new CSS needed
      // for the active-row highlight; `aria-selected` alongside it for the
      // same signal to assistive tech.
      <TableRow
        role="button"
        tabIndex={0}
        aria-label={`View ${issue.filePath.split('/').pop() ?? 'package.json'} for ${issue.symbol ?? issue.filePath}`}
        aria-selected={isActive}
        data-state={isActive ? 'selected' : undefined}
        data-testid={`packages-row-${issue.type}-${issue.symbol ?? issue.id}`}
        className="cursor-pointer outline-none focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
        style={height !== undefined ? { height } : undefined}
        onClick={() => onRowClick(issue)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onRowClick(issue);
          }
        }}
      >
        <TableCell onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected}
            disabled={!actionable}
            title={actionable ? undefined : unactionableReason(issue)}
            onChange={() => onToggleIds([issue.id])}
            className="disabled:cursor-not-allowed"
          />
        </TableCell>
        <TableCell>
          <span title={typeLabel(issue.type)}>{TYPE_BADGE_LABELS[issue.type]}</span>
        </TableCell>
        <TableCell className="font-medium">{issue.symbol ?? '—'}</TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">{issue.filePath}</TableCell>
      </TableRow>
    );
  });
  ```

  (The old `<h3 className="mb-1.5 …">{label}</h3>` is deleted along with the rest of the old `WorkspaceTable` body — no test or component references it; `dashboard.spec.ts:155` and the two packages specs target the `<section>` testid and row testids, both preserved.)

- [ ] **Library-semantics check** (one grep, before trusting the spacer math): confirm in `node_modules/@tanstack/virtual-core/dist/esm/index.js` that measurement `start` values incorporate `options.scrollMargin` (v3.14's `getMeasurements` seeds the first item at `paddingStart + scrollMargin`). If the installed build did NOT fold it in, drop the two `- scrollMargin` compensations in `padTop`/`padBottom`. Task 4's e2e pin catches a mistake here regardless (rows would misalign or over-render).
- [ ] Run `pnpm test` — expected: green (PackagesPage has no unit tests; `tree.test.ts`/`filters.test.ts` cover the helpers this still calls, unchanged).
- [ ] Run `pnpm run typecheck` — expected: clean (also proves the removed Tooltip import had no other consumer in the file).
- [ ] Run `pnpm run test:e2e` — expected: FULL suite green. The specific gates: `context-preview.spec.ts` (row click/badge/mentions/reload-collapse against the 1-row — non-virtualized — fixture group), `ignore.spec.ts` (Enter-to-open, Escape, checkbox, ignore flow), `dashboard.spec.ts` (`workspace-group-packages/ws-01` after a packages cell click), `filters.spec.ts`, `smoke.spec.ts`.
- [ ] **Manual verification** (unit tests can't pin visuals): run the app against a large monorepo (or temporarily bump a scratch project's package.json with ~100 unused deps), open Packages: (1) scrolling a big group keeps its label+sort header pinned, and the next group's header pushes it out; (2) hovering a Type cell shows the native `title` tooltip; (3) with React DevTools' "highlight updates", toggling one checkbox repaints one row, not the table; (4) Elements panel shows a bounded `<tr>` count while scrolling.
- [ ] Commit: `perf: virtualize PackagesPage tables (spacer rows, sticky group headers), title tooltips, memoized rows (#31)`

---

## Task 4: e2e pin — PackagesPage virtualization at scale

**Files**
- Create: `/Volumes/Dev/Projects/krona/knip-gui/tests/e2e/packages-virtualization.spec.ts`

Copies `dashboard.spec.ts`'s approach wholesale: intercept `/api/report` with a synthetic payload (shape: `{ status: 'ready', report: { issues, scannedAt, workspaces } }`, issues matching `src/core/types.ts`'s `Issue` — `dashboard.spec.ts:23-65` is the fabrication template), so nothing touches the shared fixture and the spec is order-safe. The filename sorts after `ignore.spec.ts` alphabetically, which is harmless for exactly that reason (it needs no left-pad and mutates nothing).

### Steps

- [ ] **Write the spec** (fails against pre-Task-3 code — 303 rendered rows — and passes after it). Create `tests/e2e/packages-virtualization.spec.ts` with exactly:

  ```ts
  // PackagesPage virtualization pin (#31), mirroring dashboard.spec.ts's
  // synthetic-intercept approach: one giant per-workspace dependency group
  // must window its rows (threshold-gated spacer <tr>s per group against the
  // shared packages-scroll scrollport), keep its sticky group header pinned
  // while scrolling, and keep select-all working against the full data set
  // with only the bounded window in the DOM.
  //
  // Intercepts /api/report via page.route — nothing touches the shared
  // fixture or the server, so (like dashboard.spec.ts) this spec is
  // order-independent: it neither needs left-pad (consumed by ignore.spec.ts)
  // nor mutates anything a later spec reads. Alphabetically it runs after
  // ignore.spec.ts, which is fine for the same reason.
  //
  // A jsdom component test was considered and rejected for the same reason as
  // dashboard.spec.ts's header documents: virtualization depends on real
  // layout (clientHeight/scrollTop), which jsdom doesn't do.
  import { expect, test } from '@playwright/test';

  const BIG = 300;
  const pad = (i: number) => String(i).padStart(3, '0');

  // Shape must match src/core/types.ts's Issue/Report and the /api/report
  // envelope ({ status, report }) — same contract dashboard.spec.ts fabricates.
  function syntheticPackagesReport() {
    const issues: unknown[] = [];
    for (let i = 0; i < BIG; i++) {
      issues.push({
        id: `dep-${pad(i)}`,
        type: 'dependencies',
        workspace: 'packages/big',
        filePath: 'packages/big/package.json',
        symbol: `dep-${pad(i)}`,
        fixable: true,
        fixModes: ['remove-dependency'],
      });
    }
    // A second, tiny group pins that below-threshold groups still render in
    // full alongside a virtualized sibling. groupByWorkspace sorts
    // workspaces alphabetically ('.' first), so 'packages/big' renders
    // before 'packages/small'.
    for (let i = 0; i < 3; i++) {
      issues.push({
        id: `small-${i}`,
        type: 'devDependencies',
        workspace: 'packages/small',
        filePath: 'packages/small/package.json',
        symbol: `tiny-${i}`,
        fixable: true,
        fixModes: ['remove-dependency'],
      });
    }
    return {
      status: 'ready',
      report: {
        issues,
        scannedAt: new Date().toISOString(),
        workspaces: ['.', 'packages/big', 'packages/small'],
      },
    };
  }

  test('300-dep group virtualizes: bounded rows, sticky group header, select-all over the full set', async ({
    page,
  }) => {
    await page.route('**/api/report', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(syntheticPackagesReport()) }),
    );

    await page.goto('/');
    await page.getByTestId('nav-packages').click();

    const scroller = page.getByTestId('packages-scroll');
    await expect(scroller).toBeVisible();
    await expect(page.getByTestId('workspace-group-packages/big')).toBeVisible();
    // Default sort is symbol asc, and the zero-padded symbols sort
    // numerically under localeCompare — dep-000 is the first row.
    await expect(page.getByTestId('packages-row-dependencies-dep-000')).toBeVisible();

    // The virtualization pin: 303 issue rows in the data, a bounded window
    // in the DOM (visible rows + 2×overscan(6) + spacer <tr>s + the small
    // group's 3 rows — ~40 at the default 720px viewport; 60 is the honest
    // upper bound, 300+ is the broken-case value this must never be).
    const renderedRows = scroller.locator('tbody tr');
    expect(await renderedRows.count()).toBeLessThan(60);

    // Sticky group header: capture the big group's label position, scroll
    // deep into the group, and require the label pinned at the same y.
    const bigLabel = page.getByTestId('packages-group-label-packages/big');
    const before = await bigLabel.boundingBox();
    expect(before).not.toBeNull();

    await scroller.evaluate((el) => {
      el.scrollTop = 3600; // ≈ 100 rows deep (36px/row), well past overscan
    });
    // Windowing proof, not just paint: a deep row entered the DOM...
    await expect(page.getByTestId('packages-row-dependencies-dep-100')).toBeVisible();
    // ...the first row left it entirely...
    await expect(page.getByTestId('packages-row-dependencies-dep-000')).toHaveCount(0);
    // ...and the DOM stayed bounded.
    expect(await renderedRows.count()).toBeLessThan(60);
    // Guard against a false pass where the div silently wasn't scrollable.
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // Sticky: still visible, same y as before the scroll.
    await expect(bigLabel).toBeVisible();
    const after = await bigLabel.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);

    // Select-all runs over the group's FULL id set (actionableIds is data-
    // derived, not DOM-derived), while the DOM keeps only the window; the
    // memoized rows mean this toggle re-renders the window, not 300 rows.
    await page.getByLabel('Select all issues in packages/big').check();
    await expect(page.getByTestId('selbar-count')).toHaveText('300 selected');
    expect(await renderedRows.count()).toBeLessThan(60);

    // A single rendered row's checkbox flips just that row out of the set.
    await page.getByTestId('packages-row-dependencies-dep-100').getByRole('checkbox').uncheck();
    await expect(page.getByTestId('selbar-count')).toHaveText('299 selected');

    // The below-threshold sibling group renders all of its rows at the
    // bottom, untouched by the big group's windowing.
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByTestId('packages-row-devDependencies-tiny-0')).toBeVisible();
    await expect(page.getByTestId('packages-row-devDependencies-tiny-2')).toBeVisible();
    await expect(page.getByTestId('packages-row-dependencies-dep-299')).toBeVisible();
  });
  ```

- [ ] Run `pnpm run test:e2e` — expected: FULL suite green, including the new spec. (If the sticky-y assertion flakes by a fraction of a pixel on the first run, loosen only that tolerance to `<2` — the row-count and windowing assertions are the hard pins and stay as written.)
- [ ] Run `pnpm run typecheck` — expected: clean (tsconfig.tests.json covers tests/e2e).
- [ ] Commit: `test: e2e pin for PackagesPage virtualization at scale (#31)`

---

## Post-implementation verification (before finishing the branch)

- [ ] `pnpm test` — full unit suite green.
- [ ] `pnpm run typecheck` — clean across all three tsconfigs.
- [ ] `pnpm run build` — compiles.
- [ ] `pnpm run test:e2e` — full suite green in one run (order contract intact: context-preview before ignore, new spec after ignore).
- [ ] `grep -rn "<Tooltip" client/src/components/pages/PackagesPage.tsx` — no hits; `grep -rn "queryKey" client/src/components/code/CodePane.tsx client/src/components/flows/DiffView.tsx` — no content/diff strings in any key.
- [ ] Manual smoke: Task 2's large-file check and Task 3's big-monorepo check (sticky headers, native tooltip, single-row repaint on toggle).

## Out of scope (explicit follow-ups, do not do here)

- **Web-worker shiki** (#34 item 3's full fix): move tokenization off the main thread so files over the cap can still be highlighted. The cap + notice added here is the stopgap; the worker (and the `HIGHLIGHT_MAX_CHARS` doc comment pointing at it) is the follow-up issue's job.
- **Line-virtualized code view** (#34 item 3's "longer-term"): CodeBlock's `querySelectorAll('.line')` measuring pass still walks every rendered line per resize tick; capped files bound the damage for now.
- Memoizing `WorkspaceTable` itself / debouncing the Packages search input — the row memo plus virtualization already bounds per-keystroke work to the rendered windows.
- A size cap for DiffView (plan diffs are compiler-bounded and small in practice).

## Behavioral notes pinned by this plan (for reviewers)

- The Packages workspace label moved from a loose `<h3>` above each table into the first (sticky) `<thead>` row — same text, new placement; nothing in the test suites referenced the `<h3>`. New testid: `packages-group-label-<workspace>`.
- The per-group border wrapper lost `overflow-hidden` (sticky-containment requirement); row-hover background may now overlap the 6px rounded corner. Cosmetic, accepted.
- Type-column tooltips are native `title` tooltips now (hover delay is the OS's, not Radix's).
- CodePane recomputes the highlight when a refetch returns byte-identical content (`dataUpdatedAt` still bumps). That's the documented trade in #34 — a rare O(file) recompute versus an O(file) stringify on every render.
- Below-threshold groups (≤50 issues) render the exact same row DOM as before Task 3 — the fixture-backed e2e specs exercise that path unchanged.
