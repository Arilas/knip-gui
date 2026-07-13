// The selection "cart": a set of issue ids the user has checked in the tree /
// table views, plus per-issue fix-mode overrides. Zustand's vanilla store API
// (getState/setState) makes this directly unit-testable without rendering
// React (see tests/client/selection.test.ts).
import { create } from 'zustand';
import type { FixMode, Issue, IssueType } from '../../../src/core/types.js';

export interface SelectionState {
  selected: Set<string>;
  modeOverrides: Record<string, FixMode>;
  toggle: (ids: string[]) => void;
  clear: () => void;
  setMode: (id: string, mode: FixMode) => void;
  // Drops ids that no longer exist after a rescan (Plan 3 Task 5's apply flow
  // obligation: the cart prunes ids no longer present in the fresh report).
  pruneMissing: (presentIds: Iterable<string>) => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selected: new Set<string>(),
  modeOverrides: {},

  toggle: (ids) =>
    set((state) => {
      const next = new Set(state.selected);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return { selected: next };
    }),

  clear: () => set({ selected: new Set<string>(), modeOverrides: {} }),

  setMode: (id, mode) => set((state) => ({ modeOverrides: { ...state.modeOverrides, [id]: mode } })),

  pruneMissing: (presentIds) =>
    set((state) => {
      const keep = new Set(presentIds);
      const selected = new Set([...state.selected].filter((id) => keep.has(id)));
      const modeOverrides = Object.fromEntries(
        Object.entries(state.modeOverrides).filter(([id]) => keep.has(id)),
      );
      return { selected, modeOverrides };
    }),
}));

export function selectionCount(state: Pick<SelectionState, 'selected'>): number {
  return state.selected.size;
}

// "12 exports, 3 files" — sorted by descending count (ties broken
// alphabetically by type name) so the biggest buckets read first.
export function summaryByType(state: Pick<SelectionState, 'selected'>, issues: Issue[]): string {
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const counts = new Map<IssueType, number>();
  for (const id of state.selected) {
    const issue = issueById.get(id);
    if (!issue) continue;
    counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, n]) => `${n} ${type}`)
    .join(', ');
}
