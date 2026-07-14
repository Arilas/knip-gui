// Sortable table for facets with no per-symbol source position (dependency-
// shaped types: dependencies/devDependencies/optionalPeerDependencies merged
// for the 'dependencies' facet, plus unlisted/unresolved/binaries — see
// facets.ts's FILE_BEARING_TYPES doc comment for why these can't use
// TreeView). Header select-all respects disabled (unactionable) rows: it
// only ever selects/clears the actionable subset.
import { useMemo, useState } from 'react';
import type { Issue, IssueType } from '../../../src/core/types.js';
import { isFixable, isIgnorable } from '../lib/filters.js';
import { idsToToggleForNode, nodeSelectionState } from '../lib/tree.js';
import { TriStateCheckbox, unactionableReason } from './code/TreeNode.js';

export interface TableViewProps {
  issues: Issue[];
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
}

type SortKey = 'symbol' | 'filePath' | 'workspace';

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'filePath', label: 'File path' },
  { key: 'workspace', label: 'Workspace' },
];

function isActionable(issue: Issue): boolean {
  return isFixable(issue).ok || isIgnorable(issue).ok;
}

const TYPE_LABELS: Partial<Record<IssueType, string>> = {
  dependencies: 'dependency',
  devDependencies: 'dev dependency',
  optionalPeerDependencies: 'peer dependency',
  unlisted: 'unlisted',
  unresolved: 'unresolved',
  binaries: 'binary',
};

export function TableView({ issues, selected, onToggleIds }: TableViewProps) {
  const [sortKey, setSortKey] = useState<SortKey>('filePath');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const actionableIds = useMemo(() => issues.filter(isActionable).map((i) => i.id), [issues]);
  const headerState = nodeSelectionState({ actionableIds }, selected);

  const sorted = useMemo(() => {
    const copy = [...issues];
    copy.sort((a, b) => {
      const av = String(a[sortKey] ?? '');
      const bv = String(b[sortKey] ?? '');
      const cmp = av.localeCompare(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [issues, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  if (issues.length === 0) {
    return <p className="p-4 text-sm text-gray-500 dark:text-gray-400">No issues here.</p>;
  }

  return (
    <div className="flex-1 overflow-auto p-2">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="w-8 border-b border-gray-200 px-2 py-1 dark:border-gray-800">
              <TriStateCheckbox
                state={headerState}
                disabled={actionableIds.length === 0}
                title={actionableIds.length === 0 ? 'No fixable or ignorable issues here' : 'Select all'}
                ariaLabel="Select all issues"
                onChange={() => onToggleIds(idsToToggleForNode({ actionableIds }, selected))}
              />
            </th>
            <th className="border-b border-gray-200 px-2 py-1 text-left dark:border-gray-800">Type</th>
            {SORT_COLUMNS.map(({ key, label }) => (
              <th
                key={key}
                className="cursor-pointer select-none border-b border-gray-200 px-2 py-1 text-left dark:border-gray-800"
                onClick={() => toggleSort(key)}
                aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                {label}
                {sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((issue) => {
            const actionable = isActionable(issue);
            return (
              <tr
                key={issue.id}
                data-testid={`table-row-${issue.type}-${issue.symbol ?? issue.id}`}
                className="hover:bg-gray-50 dark:hover:bg-gray-900"
              >
                <td className="border-b border-gray-100 px-2 py-1 dark:border-gray-900">
                  <input
                    type="checkbox"
                    checked={selected.has(issue.id)}
                    disabled={!actionable}
                    title={actionable ? undefined : unactionableReason(issue)}
                    onChange={() => onToggleIds([issue.id])}
                    className="disabled:cursor-not-allowed"
                  />
                </td>
                <td className="border-b border-gray-100 px-2 py-1 dark:border-gray-900">
                  {TYPE_LABELS[issue.type] ?? issue.type}
                </td>
                <td className="border-b border-gray-100 px-2 py-1 dark:border-gray-900">{issue.symbol ?? '—'}</td>
                <td className="border-b border-gray-100 px-2 py-1 font-mono text-xs dark:border-gray-900">
                  {issue.filePath}
                </td>
                <td className="border-b border-gray-100 px-2 py-1 dark:border-gray-900">
                  {issue.workspace === '.' ? 'All workspaces' : issue.workspace}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
