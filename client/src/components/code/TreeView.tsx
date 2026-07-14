// Virtualized tree view for the Code page (Task 3 rebuild, UX overhaul):
// applies the search + type-enable filter (lib/filters.ts's filterIssues,
// combining both in one pass) before calling buildTree, so "chips filter the
// tree" is just "build a smaller tree" rather than a separate pass — every
// downstream count/badge/row naturally reflects only enabled types. Flattens
// the buildTree() output into a plain dir/file row list driven by expand-
// state, and hands that list to TanStack Virtual so only the visible rows
// are ever mounted.
//
// Expand-state lift (Task 2, v0.3): expandedDirs now lives in the ui store
// (state/ui.ts) rather than local useState, so it survives this component
// unmounting on a Code -> Packages -> Code round trip. The auto-expand-on-
// first-load POLICY (lib/tree.ts's autoExpandDepth) still runs here, though
// — it needs the built tree, which is page-local — via `policyExpandedDirs`
// (recomputed on every tree change, cheap) as the render-time fallback
// whenever the store hasn't been seeded yet (`expandedDirsInitialized ===
// false`), plus an effect that performs the ONE-TIME seed write into the
// store once mounted. Using the computed fallback for the actual render
// (rather than waiting for the effect to fire) avoids a first-paint flash of
// an unexpanded tree; the effect no-ops forever once seeded, which is
// exactly what keeps "Collapse all" from being silently undone on the next
// render (see ui.ts's doc comment for the full rationale).
import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronsDownUp, ChevronsUpDown, PanelRightClose, PanelRightOpen, Search } from 'lucide-react';
import type { Issue, IssueType } from '../../../../src/core/types.js';
import { CODE_TYPES, filterIssues } from '../../lib/filters.js';
import { autoExpandDepth, buildTree, countFiles, type DirNode } from '../../lib/tree.js';
import { useUiStore } from '../../state/ui.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { FilterChips } from './FilterChips.js';
import { TreeNodeRow, type FlatRow } from './TreeNode.js';

export interface TreeViewProps {
  /** Every code-eligible issue in scope (workspace/search is applied here, not by the caller). */
  issues: Issue[];
  enabledTypes: ReadonlySet<IssueType>;
  onToggleFilter: (type: IssueType) => void;
  search: string;
  onSearchChange: (value: string) => void;
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
  onAddFileFiltered: (fileIssues: Issue[], enabled: ReadonlySet<IssueType>) => void;
  onOpenFile: (path: string) => void;
  /**
   * Whether the code pane (the OTHER split panel) is currently collapsed —
   * its own toggle button lives here, in the tree toolbar, rather than
   * inside that panel: a control rendered inside a 0px-wide panel would
   * disappear along with it, leaving no way to re-expand.
   */
  paneCollapsed: boolean;
  onTogglePane: () => void;
}

const ALL_CODE_TYPES = new Set(CODE_TYPES);

function flatten(node: DirNode, depth: number, expandedDirs: ReadonlySet<string>, out: FlatRow[]): void {
  for (const child of node.children) {
    if (child.kind === 'dir') {
      const expanded = expandedDirs.has(child.path);
      out.push({ kind: 'dir', node: child, depth, expanded });
      if (expanded) flatten(child, depth + 1, expandedDirs, out);
    } else {
      out.push({ kind: 'file', node: child, depth });
    }
  }
}

function allDirPaths(node: DirNode, out: Set<string> = new Set()): Set<string> {
  for (const child of node.children) {
    if (child.kind === 'dir') {
      out.add(child.path);
      allDirPaths(child, out);
    }
  }
  return out;
}

function topDirPaths(node: DirNode): Set<string> {
  const out = new Set<string>();
  for (const child of node.children) {
    if (child.kind === 'dir') out.add(child.path);
  }
  return out;
}

function rowKey(row: FlatRow): string {
  return `${row.kind}:${row.node.path}`;
}

export function TreeView({
  issues,
  enabledTypes,
  onToggleFilter,
  search,
  onSearchChange,
  selected,
  onToggleIds,
  onAddFileFiltered,
  onOpenFile,
  paneCollapsed,
  onTogglePane,
}: TreeViewProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // FilterChips' own live counts intentionally use the FULL type set (only
  // search-scoped) so a chip shows "how many exist" even while it's off —
  // the tree itself, below, uses the real `enabledTypes`.
  const chipScopeIssues = useMemo(() => filterIssues(issues, ALL_CODE_TYPES, search), [issues, search]);
  const filtered = useMemo(() => filterIssues(issues, enabledTypes, search), [issues, enabledTypes, search]);
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  // Lifted expand state (ui store) — see this file's top doc comment and
  // ui.ts's doc comment for the full seed-once-and-never-reseed rationale.
  const storeExpandedDirs = useUiStore((s) => s.expandedDirs);
  const expandedDirsInitialized = useUiStore((s) => s.expandedDirsInitialized);
  const initExpandedDirs = useUiStore((s) => s.initExpandedDirs);
  const storeToggleDir = useUiStore((s) => s.toggleDir);
  const storeExpandAll = useUiStore((s) => s.expandAll);
  const storeCollapseAll = useUiStore((s) => s.collapseAll);

  const policyExpandedDirs = useMemo(() => {
    const policy = autoExpandDepth(tree, countFiles(tree));
    return policy === 'all' ? allDirPaths(tree) : topDirPaths(tree);
  }, [tree]);

  // Render-time value: the real store set once seeded, otherwise the policy
  // default computed above — this is what avoids a first-paint flash while
  // the seeding effect (below) hasn't run yet.
  const expandedDirs = expandedDirsInitialized ? storeExpandedDirs : policyExpandedDirs;

  // One-time seed: writes the policy default into the store the first time
  // this tree mounts (or, if a rescan somehow lands before the first mount's
  // effect fires, the first time the tree itself changes) — a permanent
  // no-op after that (initExpandedDirs itself guards on
  // expandedDirsInitialized), so it never overwrites a later Collapse
  // all/Expand all/manual toggle, and expansion set by an earlier Code page
  // visit survives navigating away and back.
  useEffect(() => {
    if (!expandedDirsInitialized) initExpandedDirs(policyExpandedDirs);
  }, [expandedDirsInitialized, initExpandedDirs, policyExpandedDirs]);

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flatten(tree, 0, expandedDirs, out);
    return out;
  }, [tree, expandedDirs]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  // toggleDir merges into whatever's already expanded — if the store hasn't
  // been seeded yet (theoretically possible: the seeding effect above hasn't
  // committed, though in practice it always has by the time a row is
  // interactive), seed it first from the same policy default the render
  // already used, so the toggle merges against what the user is actually
  // looking at rather than an empty store set. initExpandedDirs/
  // storeToggleDir are both synchronous zustand `set` calls, so the store
  // reflects the seed before storeToggleDir reads it.
  function toggleDir(path: string) {
    if (!expandedDirsInitialized) initExpandedDirs(policyExpandedDirs);
    storeToggleDir(path);
  }

  function expandAll() {
    storeExpandAll(allDirPaths(tree));
  }

  function collapseAll() {
    storeCollapseAll();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Filter by path or symbol…"
              aria-label="Filter tree by path or symbol"
              className="pl-7"
              data-testid="tree-search"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Expand all directories"
            onClick={expandAll}
          >
            <ChevronsUpDown className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Collapse all directories"
            onClick={collapseAll}
          >
            <ChevronsDownUp className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={paneCollapsed ? 'Expand code panel' : 'Collapse code panel'}
            onClick={onTogglePane}
          >
            {paneCollapsed ? <PanelRightOpen className="size-4" /> : <PanelRightClose className="size-4" />}
          </Button>
        </div>
        <FilterChips issues={chipScopeIssues} enabled={enabledTypes} onToggle={onToggleFilter} />
      </div>

      {rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          {search ? 'No files match that filter.' : 'No issues match the current filters.'}
        </p>
      ) : (
        <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]!;
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
                    selected={selected}
                    enabledTypes={enabledTypes}
                    onToggleExpand={toggleDir}
                    onToggleIds={onToggleIds}
                    onAddFileFiltered={onAddFileFiltered}
                    onOpenFile={onOpenFile}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
