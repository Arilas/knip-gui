// Virtualized tree view for the Code page (Task 3 rebuild, UX overhaul):
// applies the search + type-enable filter (lib/filters.ts's filterIssues,
// combining both in one pass) before calling buildTree, so "chips filter the
// tree" is just "build a smaller tree" rather than a separate pass — every
// downstream count/badge/row naturally reflects only enabled types. Flattens
// the buildTree() output into a plain dir/file row list driven by local
// expand-state, and hands that list to TanStack Virtual so only the visible
// rows are ever mounted.
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronsDownUp, ChevronsUpDown, PanelRightClose, PanelRightOpen, Search } from 'lucide-react';
import type { Issue, IssueType } from '../../../../src/core/types.js';
import { CODE_TYPES, filterIssues } from '../../lib/filters.js';
import { autoExpandDepth, buildTree, countFiles, type DirNode } from '../../lib/tree.js';
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

  // Manually-toggled expand state; null means "not touched yet, use the
  // auto-expand policy" (see lib/tree.ts's autoExpandDepth). Once the user
  // (or expand/collapse-all) sets it, later search/filter changes reuse
  // whatever's already in the set — dir paths that still exist keep their
  // state, newly-revealed ones default to collapsed. This intentionally
  // avoids resetting the user's manual expand/collapse choices on every
  // keystroke/chip toggle.
  const [manualExpandedDirs, setManualExpandedDirs] = useState<Set<string> | null>(null);
  const expandedDirs = useMemo(() => {
    if (manualExpandedDirs !== null) return manualExpandedDirs;
    const policy = autoExpandDepth(tree, countFiles(tree));
    return policy === 'all' ? allDirPaths(tree) : topDirPaths(tree);
  }, [manualExpandedDirs, tree]);

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

  function toggleDir(path: string) {
    setManualExpandedDirs((prev) => {
      const next = new Set(prev ?? expandedDirs);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function expandAll() {
    setManualExpandedDirs(allDirPaths(tree));
  }

  function collapseAll() {
    setManualExpandedDirs(new Set());
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
