// Pure projections of Report.issues into the Dashboard page (Task 2, UX
// overhaul): the stat-tile grid (typeTotals) and the sortable/searchable
// per-workspace breakdown table (workspaceRows/visibleColumns/sortRows/
// filterRows). No React, no store — unit-tested directly (see
// tests/client/dashboard.test.ts), same pattern as lib/facets.ts and
// lib/tree.ts.
import { ISSUE_TYPES, type Issue, type IssueType } from '../../../src/core/types.js';

export interface TypeTotal {
  type: IssueType;
  count: number;
}

// Every type's declaration index in ISSUE_TYPES, used as the tie-break for
// both typeTotals (equal counts) and visibleColumns (column ordering) so
// both stay in one consistent, stable order rather than an incidental one
// derived from object-key iteration or count magnitude alone.
const TYPE_ORDER: Partial<Record<IssueType, number>> = Object.fromEntries(ISSUE_TYPES.map((t, i) => [t, i]));

/** Total issue count per type across the whole (unscoped) issue list, non-zero only, sorted by count descending. */
export function typeTotals(issues: Issue[]): TypeTotal[] {
  const counts = new Map<IssueType, number>();
  for (const issue of issues) counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || TYPE_ORDER[a.type]! - TYPE_ORDER[b.type]!);
}

export interface WorkspaceRow {
  workspace: string;
  counts: Partial<Record<IssueType, number>>;
  total: number;
}

/** One row per workspace that has at least one issue — never fabricates a zero row for a workspace absent from `issues`. */
export function workspaceRows(issues: Issue[]): WorkspaceRow[] {
  const rows = new Map<string, WorkspaceRow>();
  for (const issue of issues) {
    let row = rows.get(issue.workspace);
    if (!row) {
      row = { workspace: issue.workspace, counts: {}, total: 0 };
      rows.set(issue.workspace, row);
    }
    row.counts[issue.type] = (row.counts[issue.type] ?? 0) + 1;
    row.total += 1;
  }
  return [...rows.values()];
}

/** Every type with a non-zero count in at least one row, in ISSUE_TYPES declaration order (stable across sorts/searches — the table's column set doesn't reshuffle as rows filter/re-sort). */
export function visibleColumns(rows: WorkspaceRow[]): IssueType[] {
  const present = new Set<IssueType>();
  for (const row of rows) {
    for (const type of Object.keys(row.counts) as IssueType[]) present.add(type);
  }
  return ISSUE_TYPES.filter((type) => present.has(type));
}

export type SortKey = 'workspace' | 'total' | IssueType;
export type SortDir = 'asc' | 'desc';

/** Returns a new, stably-sorted copy of `rows` — ties keep their original relative order (native Array#sort is stable), so re-sorting on an unchanged key never visibly reshuffles equal rows. */
export function sortRows(rows: WorkspaceRow[], key: SortKey, dir: SortDir): WorkspaceRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const valueOf = (row: WorkspaceRow): string | number => {
    if (key === 'workspace') return row.workspace;
    if (key === 'total') return row.total;
    return row.counts[key] ?? 0;
  };
  return [...rows].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (typeof av === 'string' || typeof bv === 'string') return sign * String(av).localeCompare(String(bv));
    return sign * (av - bv);
  });
}

/** Case-insensitive substring filter over each row's workspace name; an empty/whitespace-only query is a no-op. */
export function filterRows(rows: WorkspaceRow[], query: string): WorkspaceRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.workspace.toLowerCase().includes(needle));
}
