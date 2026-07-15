// Packages page (Task 4, UX overhaul; resizable split Task Q, #24): every
// dependency-shaped issue (PACKAGE_TYPES — dependencies/devDependencies/
// optionalPeerDependencies/binaries) grouped into one sortable shadcn Table
// per workspace (lib/filters.ts's groupByWorkspace), with a FilterChips
// toolbar + search above. Row click opens a resizable right-hand context
// panel (same react-resizable-panels split primitives as CodePage.tsx, own
// persistence key `knip-packages-split`) that REUSES CodePane — the
// dependency's workspace package.json, badge, and auto-scroll/pulse all come
// free from CodePane's existing single-issue rendering. This replaces the
// previous Sheet-based detail view (see git history) since a persistent
// split, not a modal overlay, is what lets the table stay usable (selection,
// search, filters) while a row's context is open.
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import { X } from 'lucide-react';
import type { Issue } from '../../../../src/core/types.js';
import { filterIssues, groupByWorkspace, isActionable, PACKAGE_TYPES, typeLabel, type WorkspaceGroup } from '../../lib/filters.js';
import { countMentions, findDeclarationLine, PACKAGE_JSON_SECTIONS } from '../../lib/mentions.js';
import { idsToToggleForNode, nodeSelectionState } from '../../lib/tree.js';
import { useFile } from '../../state/queries.js';
import { useSelectionStore } from '../../state/selection.js';
import { useUiStore } from '../../state/ui.js';
import { SelectionDock } from '../SelectionDock.js';
import { CodePane } from '../code/CodePane.js';
import { FilterChips } from '../code/FilterChips.js';
import { TriStateCheckbox, TYPE_BADGE_LABELS, unactionableReason } from '../code/TreeNode.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';

export interface PackagesPageProps {
  issues: Issue[];
}

const ALL_PACKAGE_TYPES = new Set(PACKAGE_TYPES);

type SortKey = 'type' | 'symbol' | 'filePath';
type SortDir = 'asc' | 'desc';

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'type', label: 'Type' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'filePath', label: 'File' },
];

function sortValue(issue: Issue, key: SortKey): string {
  if (key === 'type') return typeLabel(issue.type);
  if (key === 'symbol') return issue.symbol ?? '';
  return issue.filePath;
}

// Stable sort (native Array#sort) so re-sorting on an unchanged key never
// visibly reshuffles ties — same rationale as lib/dashboard.ts's sortRows.
function sortIssues(issues: Issue[], key: SortKey, dir: SortDir): Issue[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...issues].sort((a, b) => sign * sortValue(a, key).localeCompare(sortValue(b, key)));
}

export function PackagesPage({ issues }: PackagesPageProps) {
  const packagesFilters = useUiStore((s) => s.packagesFilters);
  const togglePackagesFilter = useUiStore((s) => s.togglePackagesFilter);
  const selected = useSelectionStore((s) => s.selected);
  const toggle = useSelectionStore((s) => s.toggle);

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Preview panel state: which issue is shown, plus a LOCAL scroll-nonce
  // (deliberately NOT the ui-store's openFileNonce, which belongs to the Code
  // page's own file-open flow — see CodePane's doc comment on that prop).
  // Bumped on every row click, including a re-click on the already-open row,
  // so CodePane's scrollKey (`${filePath}#${nonce}`) changes and its
  // auto-scroll/pulse effect re-fires even though filePath didn't change.
  const [previewIssue, setPreviewIssue] = useState<Issue | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const previewPanelRef = usePanelRef();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: 'knip-packages-split' });

  function openPreview(issue: Issue) {
    setPreviewIssue(issue);
    setPreviewNonce((n) => n + 1);
    const panel = previewPanelRef.current;
    if (!panel || !panel.isCollapsed()) return;
    // `resize('35%')`, NOT `expand()` — observed live (production build,
    // real e2e fixture): expand() on a panel sitting at its collapsedSize
    // with no remembered prior size — exactly the state the mount-collapse
    // effect below guarantees before the first open — takes its
    // fallback-to-minSize path, and bare-number sizes are uniformly PIXELS
    // in this library (react-resizable-panels.d.ts documents this for
    // minSize/defaultSize alike), so `minSize={20}` produced a useless
    // ~20px sliver. CodePage's split never hits that path because its
    // panels mount at a nonzero defaultSize, so expand() there always has a
    // real size to restore. An explicit percentage STRING is unambiguous
    // per PanelImperativeHandle.resize's contract. Guarded on isCollapsed:
    // a re-click while the panel is already open only bumps the nonce and
    // must not stomp a width the user has dragged to.
    panel.resize('35%');
  }

  function closePreview() {
    setPreviewIssue(null);
    previewPanelRef.current?.collapse();
  }

  // Collapsed-by-default must survive PERSISTED layouts, not just the
  // first-ever mount: useDefaultLayout persists every layout commit —
  // including openPreview's programmatic resize('35%') — so after a preview
  // has ever been opened, the next mount would rehydrate the right panel at
  // ~35% while `previewIssue` (plain React state, never persisted) is still
  // null: an empty pane with no header or close button. Force-collapse on
  // mount instead; `previewIssue` is definitionally null at mount, so this
  // needs no condition. collapse() is a no-op when the panel is already
  // collapsed (PanelImperativeHandle contract), i.e. the genuinely-fresh
  // first mount. Drag-resize persistence for an OPEN panel is unaffected
  // within a session — this only runs on mount. Pinned by
  // tests/e2e/context-preview.spec.ts's reload step.
  // useLayoutEffect, not useEffect: collapse must land before the browser
  // paints the hydrated layout, or a persisted-open remount flashes the
  // empty pane for a frame.
  useLayoutEffect(() => {
    previewPanelRef.current?.collapse();
    // previewPanelRef is a stable ref object — mount-only on purpose.
  }, []);

  // Escape closes the preview panel, same as it dismisses any other Radix
  // overlay in this app (Sheet/Dialog/Popover) even though the panel itself
  // is a plain resizable Panel, not a Radix primitive with that behavior
  // built in. Scoped to a window listener only while a preview is actually
  // open (not mounted otherwise). The defaultPrevented check is what keeps
  // this from double-acting with a Radix overlay ABOVE the preview (the ⌘K
  // command palette is reachable from every page): Radix's DismissableLayer
  // preventDefault()s the Escape it consumes, so a palette-dismissing Escape
  // must not also collapse the preview underneath it.
  useEffect(() => {
    if (!previewIssue) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') closePreview();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // `closePreview` is deliberately omitted from the dep array: it's a
    // plain function of stable refs/setters (previewPanelRef, setPreviewIssue),
    // re-created every render but never itself a reason to re-subscribe —
    // `previewIssue` (open vs. closed) is the only real trigger here.
  }, [previewIssue]);

  // FilterChips' own live counts intentionally use the FULL package type set
  // (only search-scoped) so a chip shows "how many exist" even while it's
  // off — same pattern as TreeView.tsx's chipScopeIssues for the Code page.
  const chipScopeIssues = useMemo(() => filterIssues(issues, ALL_PACKAGE_TYPES, search), [issues, search]);
  const filtered = useMemo(() => filterIssues(issues, packagesFilters, search), [issues, packagesFilters, search]);
  const groups = useMemo(() => groupByWorkspace(filtered), [filtered]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function sortIndicator(key: SortKey): string {
    if (key !== sortKey) return '';
    return sortDir === 'asc' ? '↑' : '↓';
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel id="packages-table" minSize={40} className="flex min-h-0 flex-col">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Packages</h2>
              <Input
                type="search"
                placeholder="Filter by name or path…"
                aria-label="Filter packages by name or path"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="max-w-64"
                data-testid="packages-search"
              />
            </div>

            <div className="mb-3">
              <FilterChips issues={chipScopeIssues} enabled={packagesFilters} onToggle={togglePackagesFilter} types={PACKAGE_TYPES} />
            </div>

            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {issues.some((i) => ALL_PACKAGE_TYPES.has(i.type))
                  ? 'No package issues match the current filters.'
                  : 'No package issues found — knip is happy.'}
              </p>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto" data-testid="packages-scroll">
                <div className="flex flex-col gap-6 pb-2">
                  {groups.map((group) => (
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
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Fully collapsed (0-width) until a row is clicked: `defaultSize={0}`
            covers the first-ever mount (no persisted layout yet), and the
            mount-collapse effect above covers every LATER mount, where
            useDefaultLayout would otherwise rehydrate a persisted open width
            with no previewIssue to fill it. Drag-resizing an open panel
            still persists within the session, same as CodePage's split. */}
        <ResizablePanel
          id="packages-preview"
          defaultSize={0}
          minSize={20}
          collapsible
          collapsedSize={0}
          panelRef={previewPanelRef}
          className="flex min-h-0 flex-col"
        >
          {previewIssue && (
            <PackagePreviewPanel
              issue={previewIssue}
              nonce={previewNonce}
              selected={selected}
              onToggleIds={toggle}
              onClose={closePreview}
            />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>

      <SelectionDock issues={issues} />
    </div>
  );
}

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
}) {
  const actionableIds = useMemo(() => group.issues.filter(isActionable).map((i) => i.id), [group.issues]);
  const headerState = nodeSelectionState({ actionableIds }, selected);
  const sortedIssues = useMemo(() => sortIssues(group.issues, sortKey, sortDir), [group.issues, sortKey, sortDir]);
  const label = group.workspace === '.' ? '(root)' : group.workspace;

  return (
    <section data-testid={`workspace-group-${group.workspace}`}>
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</h3>
      <div className="overflow-hidden rounded-md border border-border">
        <Table>
          <TableHeader>
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
          <TableBody>
            {sortedIssues.map((issue) => {
              const actionable = isActionable(issue);
              return (
                // Keyboard-operable row, same pattern as TreeNode.tsx's
                // TreeNodeRow: role="button" + tabIndex=0 + Enter/Space both
                // open the preview panel, so keyboard-only users can reach it
                // (a bare onClick on a <tr> is mouse-only). The checkbox cell
                // swallows click AND keydown (Space bubbles as keydown)
                // below, so checking a box never also opens the panel.
                // `data-state="selected"` piggybacks on ui/table.tsx's own
                // `data-[state=selected]:bg-muted` TableRow styling — no new
                // CSS needed for the active-row highlight; `aria-selected`
                // alongside it for the same signal to assistive tech.
                <TableRow
                  key={issue.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`View ${issue.filePath.split('/').pop() ?? 'package.json'} for ${issue.symbol ?? issue.filePath}`}
                  aria-selected={issue.id === activeIssueId}
                  data-state={issue.id === activeIssueId ? 'selected' : undefined}
                  data-testid={`packages-row-${issue.type}-${issue.symbol ?? issue.id}`}
                  className="cursor-pointer outline-none focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
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
                      checked={selected.has(issue.id)}
                      disabled={!actionable}
                      title={actionable ? undefined : unactionableReason(issue)}
                      onChange={() => onToggleIds([issue.id])}
                      className="disabled:cursor-not-allowed"
                    />
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{TYPE_BADGE_LABELS[issue.type]}</span>
                      </TooltipTrigger>
                      <TooltipContent>{typeLabel(issue.type)}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="font-medium">{issue.symbol ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{issue.filePath}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// The preview panel's body: a small header (type + symbol + filePath, close
// button) above a REUSED CodePane showing just this one issue. CodePane
// already owns the workspace package.json fetch, syntax highlight, gutter
// badge, and auto-scroll/pulse-to-line for a single-issue `issues` array —
// duplicating any of that here (as the old Sheet-based PackageDetailContent
// used to) would just be a second, drifting copy of the same logic.
function PackagePreviewPanel({
  issue,
  nonce,
  selected,
  onToggleIds,
  onClose,
}: {
  issue: Issue;
  nonce: number;
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
  onClose: () => void;
}) {
  // Own fetch (not just CodePane's internal one) so the declaration line can
  // be located BEFORE handing the issue to CodePane — see the `line` comment
  // below. Same query key as CodePane's own `useFile(filePath)` call
  // (state/queries.ts's fileQueryKey), so react-query dedupes this to a
  // cache hit riding on whichever of the two fetches lands first, never a
  // second network request.
  const fileQuery = useFile(issue.filePath);
  const content = fileQuery.data?.content;

  // Dependency-shaped issues (every type PackagesPage shows) carry NO line/
  // col/pos from knip — confirmed by running `knip --reporter json` directly
  // against tests/fixtures/single: the dependencies entry is bare
  // `{"name":"left-pad"}`, no position field (matches normalize.ts's
  // symbolsFor doc comment, despite this task's own brief assuming a `line`
  // was already present). Without a `line`, CodePane's gutter-marker auto-
  // scroll/pulse — entirely keyed off `issue.line` (lib/highlighter.ts's
  // issueLines) — never fires, and CodePane falls back to its line-less
  // whole-file banner alone. Locating the declaration line here (a tested
  // pure helper — lib/mentions.ts's findDeclarationLine, scoped via
  // PACKAGE_JSON_SECTIONS to the issue type's OWN package.json section so a
  // name listed in both dependencies and devDependencies highlights the
  // right one; binaries pass undefined = whole-file scan) and handing
  // CodePane a CLONE of the issue with that `line` filled in is what lets
  // CodePane's existing badge/auto-scroll/pulse machinery do the rest for
  // free — undefined when the name can't be found (or content hasn't loaded
  // yet) leaves the issue unchanged, so CodePane's own whole-file-banner
  // fallback still applies rather than crashing.
  const line =
    content !== undefined && issue.symbol
      ? findDeclarationLine(content, issue.symbol, PACKAGE_JSON_SECTIONS[issue.type])
      : undefined;
  const codePaneIssue = line === undefined ? issue : { ...issue, line };

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            {typeLabel(issue.type)}
            {issue.symbol && <span className="font-medium text-foreground"> · {issue.symbol}</span>}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={issue.filePath}>
            {issue.filePath}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close preview panel"
          data-testid="packages-preview-close"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      {/* Every issue type PackagesPage ever passes in here is one of
          PACKAGE_TYPES (dependencies/devDependencies/optionalPeerDependencies/
          binaries) — this page never shows anything else — but the check is
          spelled out rather than assumed, since it's the actual gate the
          brief specifies ("dependency-kind rows only") and keeps this
          correct if a non-dependency issue type is ever routed through this
          same panel component in the future. */}
      {ALL_PACKAGE_TYPES.has(issue.type) && <MentionsLine content={content} name={issue.symbol} />}
      <CodePane
        filePath={issue.filePath}
        issues={[codePaneIssue]}
        selected={selected}
        onToggleIds={onToggleIds}
        openFileNonce={nonce}
      />
    </>
  );
}

// "Other mentions" line: how many times this dependency's name appears
// elsewhere in the same file, beyond the one occurrence CodePane's badge now
// points at (via the synthesized `line` above). Takes already-fetched
// `content` rather than fetching again — PackagePreviewPanel already has it
// (needed for findDeclarationLine), so this stays a pure render given props,
// no query of its own. Silently renders nothing while loading or on a fetch
// failure (413/404/etc.) — an "other mentions" caption for content that
// isn't actually on screen would be confusing, and CodePane's own error/
// loading states already explain why.
function MentionsLine({ content, name }: { content: string | undefined; name: string | undefined }) {
  if (content === undefined || !name) return null;

  // -1: CodePane's badge already accounts for exactly one occurrence (the
  // flagged declaration line), so "other" mentions excludes it. Clamped at 0
  // rather than trusting the subtraction blindly — if the declaration itself
  // doesn't match countMentions' exact-token rule for some reason (e.g. knip
  // ever emits a dependency name that ISN'T literally quoted verbatim in the
  // file, such as a case-normalized match), this must not surface a
  // misleading negative count.
  const other = Math.max(0, countMentions(content, name) - 1);
  return (
    <p
      className="shrink-0 border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="packages-preview-mentions"
    >
      {other === 0
        ? `No other mentions of "${name}" in this file.`
        : `${other} other mention${other === 1 ? '' : 's'} of "${name}" in this file.`}
    </p>
  );
}
