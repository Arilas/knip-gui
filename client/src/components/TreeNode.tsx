// Row renderers for TreeView's flattened, virtualized list: one component
// per row kind (dir / file / issue), sharing the same tri-state checkbox
// look. Kept separate from TreeView.tsx so the virtualization/expand-state
// plumbing there stays readable.
import { useEffect, useRef } from 'react';
import type { Issue, IssueType } from '../../../src/core/types.js';
import { isFixable, isIgnorable } from '../lib/facets.js';
import { idsToToggleForNode, nodeSelectionState, type DirNode, type FileNode } from '../lib/tree.js';

export type FlatRow =
  | { kind: 'dir'; node: DirNode; depth: number; expanded: boolean }
  | { kind: 'file'; node: FileNode; depth: number; expanded: boolean; expandable: boolean }
  | { kind: 'issue'; issue: Issue; filePath: string; depth: number };

export interface TreeNodeRowProps {
  row: FlatRow;
  selected: ReadonlySet<string>;
  onToggleExpand: (path: string) => void;
  onToggleIds: (ids: string[]) => void;
  onOpenFile: (path: string) => void;
}

// Compact per-type pill labels — the badges are small, so these are
// abbreviations of facets.ts's FACETS labels rather than the full text.
// Exported for CodePane's gutter-marker badges (Task 4), which want the same
// abbreviations rather than a second, possibly-drifting copy.
export const TYPE_BADGE_LABELS: Record<IssueType, string> = {
  files: 'files',
  exports: 'export',
  nsExports: 'ns export',
  types: 'type',
  nsTypes: 'ns type',
  enumMembers: 'enum member',
  namespaceMembers: 'ns member',
  duplicates: 'duplicate',
  dependencies: 'dependency',
  devDependencies: 'dev dependency',
  optionalPeerDependencies: 'peer dependency',
  unlisted: 'unlisted',
  unresolved: 'unresolved',
  binaries: 'binary',
  catalog: 'catalog',
  cycles: 'cycle',
};

function CountBadges({
  counts,
  excludeFiles,
}: {
  counts: Partial<Record<IssueType, number>>;
  excludeFiles?: boolean;
}) {
  const entries = (Object.entries(counts) as [IssueType, number][]).filter(
    ([type, n]) => n > 0 && !(excludeFiles && type === 'files'),
  );
  if (entries.length === 0) return null;
  // Rows are fixed-height (virtualized — see TreeView's estimateSize), so
  // badges must never wrap onto a second line: that would spill outside the
  // row's box and visually overlap the next virtualized row. Clip
  // overflowing badges instead of wrapping; the full set is still visible
  // by widening the window or opening the file.
  return (
    <span className="flex min-w-0 shrink flex-nowrap items-center gap-1 overflow-hidden">
      {entries.map(([type, n]) => (
        <span
          key={type}
          className="shrink-0 whitespace-nowrap rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] leading-none text-gray-700 dark:bg-gray-700 dark:text-gray-200"
        >
          {n} {TYPE_BADGE_LABELS[type]}
          {n === 1 ? '' : 's'}
        </span>
      ))}
    </span>
  );
}

function UnusedFileBadge() {
  return (
    <span className="shrink-0 whitespace-nowrap rounded-full bg-amber-200 px-1.5 py-0.5 text-[10px] leading-none text-amber-900 dark:bg-amber-800 dark:text-amber-100">
      unused file
    </span>
  );
}

export function TriStateCheckbox({
  state,
  disabled,
  title,
  onChange,
}: {
  state: 'none' | 'some' | 'all';
  disabled: boolean;
  title?: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      disabled={disabled}
      title={title}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className="shrink-0 disabled:cursor-not-allowed"
    />
  );
}

// Only present when both isFixable and isIgnorable say no — the disabled
// checkbox's tooltip explains why. Exported for TableView's per-row tooltip.
export function unactionableReason(issue: Issue): string {
  const fix = isFixable(issue);
  const ignore = isIgnorable(issue);
  return [fix.reason, ignore.reason].filter(Boolean).join(' / ');
}

const ROW_BASE =
  'flex items-center gap-2 overflow-hidden px-2 py-1 text-sm hover:bg-gray-50 dark:hover:bg-gray-900';

export function TreeNodeRow({ row, selected, onToggleExpand, onToggleIds, onOpenFile }: TreeNodeRowProps) {
  const indent = 8 + row.depth * 16;

  if (row.kind === 'dir') {
    const { node } = row;
    const state = nodeSelectionState(node, selected);
    const disabled = node.actionableIds.length === 0;
    return (
      <div className={ROW_BASE} style={{ paddingLeft: indent }}>
        <button
          type="button"
          aria-label={row.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          onClick={() => onToggleExpand(node.path)}
          className="w-4 shrink-0 text-gray-500 dark:text-gray-400"
        >
          {row.expanded ? '▾' : '▸'}
        </button>
        <TriStateCheckbox
          state={state}
          disabled={disabled}
          title={disabled ? 'No fixable or ignorable issues in this directory' : undefined}
          onChange={() => onToggleIds(idsFor(node, selected))}
        />
        <button
          type="button"
          onClick={() => onToggleExpand(node.path)}
          className="min-w-0 shrink truncate font-medium text-gray-800 dark:text-gray-200"
        >
          {node.name}/
        </button>
        <CountBadges counts={node.counts} />
      </div>
    );
  }

  if (row.kind === 'file') {
    const { node } = row;
    const state = nodeSelectionState(node, selected);
    const disabled = node.actionableIds.length === 0;
    return (
      <div className={ROW_BASE} style={{ paddingLeft: indent }}>
        {row.expandable ? (
          <button
            type="button"
            aria-label={row.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={() => onToggleExpand(node.path)}
            className="w-4 shrink-0 text-gray-500 dark:text-gray-400"
          >
            {row.expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <TriStateCheckbox
          state={state}
          disabled={disabled}
          title={disabled ? 'No fixable or ignorable issues in this file' : undefined}
          onChange={() => onToggleIds(idsFor(node, selected))}
        />
        <button
          type="button"
          onClick={() => onOpenFile(node.path)}
          className="min-w-0 shrink truncate text-blue-700 hover:underline dark:text-blue-400"
          title={node.path}
        >
          {node.name}
        </button>
        {(node.counts.files ?? 0) > 0 && <UnusedFileBadge />}
        <CountBadges counts={node.counts} excludeFiles />
      </div>
    );
  }

  // issue row
  const { issue } = row;
  const fix = isFixable(issue);
  const ignore = isIgnorable(issue);
  const actionable = fix.ok || ignore.ok;
  return (
    <div className={ROW_BASE} style={{ paddingLeft: indent }}>
      <span className="w-4 shrink-0" />
      <input
        type="checkbox"
        checked={selected.has(issue.id)}
        disabled={!actionable}
        title={actionable ? undefined : unactionableReason(issue)}
        onChange={() => onToggleIds([issue.id])}
        className="shrink-0 disabled:cursor-not-allowed"
      />
      <span className="min-w-0 shrink truncate text-gray-700 dark:text-gray-300">{issue.symbol ?? '(unnamed)'}</span>
      {issue.line !== undefined && (
        <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-500">:{issue.line}</span>
      )}
      <span className="shrink-0 rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] leading-none text-gray-700 dark:bg-gray-700 dark:text-gray-200">
        {TYPE_BADGE_LABELS[issue.type]}
      </span>
    </div>
  );
}

function idsFor(node: DirNode | FileNode, selected: ReadonlySet<string>): string[] {
  return idsToToggleForNode(node, selected);
}
