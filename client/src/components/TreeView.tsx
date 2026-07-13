// Virtualized tree view for the file-bearing facets (tree, files, exports,
// types, enumMembers, namespaceMembers, duplicates — see App.tsx's facet
// switching). Flattens the buildTree() output into a plain row list driven
// by local expand-state, and hands that list to TanStack Virtual so only
// the visible rows are ever mounted.
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Issue } from '../../../src/core/types.js';
import { buildTree, type DirNode, type FileNode } from '../lib/tree.js';
import { TreeNodeRow, type FlatRow } from './TreeNode.js';

export interface TreeViewProps {
  issues: Issue[];
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
  onOpenFile: (path: string) => void;
}

function matches(node: FileNode, needle: string): boolean {
  if (node.path.toLowerCase().includes(needle)) return true;
  return node.fileIssues.some((i) => i.symbol?.toLowerCase().includes(needle));
}

// Substring filter over path/symbol: keeps a directory if it (or any
// descendant file's path/symbol) matches, so matching a deep file doesn't
// hide its ancestor rows.
function filterIssues(issues: Issue[], needle: string): Issue[] {
  if (!needle) return issues;
  const lower = needle.toLowerCase();
  return issues.filter(
    (i) => i.filePath.toLowerCase().includes(lower) || i.symbol?.toLowerCase().includes(lower),
  );
}

function flatten(
  node: DirNode,
  depth: number,
  expandedDirs: ReadonlySet<string>,
  expandedFiles: ReadonlySet<string>,
  out: FlatRow[],
): void {
  for (const child of node.children) {
    if (child.kind === 'dir') {
      const expanded = expandedDirs.has(child.path);
      out.push({ kind: 'dir', node: child, depth, expanded });
      if (expanded) flatten(child, depth + 1, expandedDirs, expandedFiles, out);
    } else {
      const lineIssues = child.fileIssues.filter((i) => i.line !== undefined);
      const expandable = lineIssues.length > 0;
      const expanded = expandable && expandedFiles.has(child.path);
      out.push({ kind: 'file', node: child, depth, expanded, expandable });
      if (expanded) {
        for (const issue of lineIssues) {
          out.push({ kind: 'issue', issue, filePath: child.path, depth: depth + 1 });
        }
      }
    }
  }
}

function rowKey(row: FlatRow): string {
  if (row.kind === 'issue') return `issue:${row.issue.id}`;
  return `${row.kind}:${row.node.path}`;
}

export function TreeView({ issues, selected, onToggleIds, onOpenFile }: TreeViewProps) {
  const [filterText, setFilterText] = useState('');
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(new Set());
  const parentRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterIssues(issues, filterText.trim()), [issues, filterText]);
  const tree = useMemo(() => buildTree(filtered), [filtered]);

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    flatten(tree, 0, expandedDirs, expandedFiles, out);
    return out;
  }, [tree, expandedDirs, expandedFiles]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 12,
  });

  function toggleDir(path: string) {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleFile(path: string) {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function onToggleExpand(path: string) {
    const row = rows.find((r) => r.kind !== 'issue' && r.node.path === path);
    if (row?.kind === 'dir') toggleDir(path);
    else if (row?.kind === 'file') toggleFile(path);
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
        <input
          type="search"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter by path or symbol…"
          aria-label="Filter tree by path or symbol"
          className="w-64 rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Showing only files/directories with issues — matches knip's flat report, not the whole project tree.
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="p-4 text-sm text-gray-500 dark:text-gray-400">
          {filterText ? 'No files match that filter.' : 'No issues here.'}
        </p>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-auto">
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
                    onToggleExpand={onToggleExpand}
                    onToggleIds={onToggleIds}
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
