// Session-local activity log (Task 5, Ignored + Activity pages): a plain
// client-side history of fix/ignore/sweep/commit/ignore-remove outcomes,
// entirely in-memory — cleared on a page reload, same as the rest of this
// app's zustand stores (there is no server-side persistence for this; the
// Activity page states that explicitly). Zustand's vanilla store API
// (getState/setState) makes this directly unit-testable without rendering
// React, same pattern as selection.ts/ui.ts.
import { create } from 'zustand';

export type ActivityKind = 'fix' | 'ignore' | 'sweep' | 'commit' | 'ignore-remove';

export interface ActivityEntry {
  id: number;
  kind: ActivityKind;
  summary: string;
  sha?: string;
  /**
   * File paths this entry actually touched (Task 5, v0.3 — added for the
   * sidebar commit affordance's checklist pre-checking). Optional so
   * existing call sites/entries stay valid without this: not every kind
   * necessarily has a meaningful file list, and older in-memory entries from
   * before this field existed (impossible in practice since this store is
   * session-only, but kept optional regardless — see appliedPaths()) simply
   * contribute nothing to it.
   */
  paths?: string[];
  at: string; // new Date().toISOString(), captured by the caller at log-call time
}

export type LogActivityInput = Omit<ActivityEntry, 'id'>;

// Caps how many entries the session log retains — old entries fall off the
// end once this is exceeded, rather than growing unboundedly across a long
// session. 200 per the task spec.
const MAX_ENTRIES = 200;

export interface ActivityState {
  entries: ActivityEntry[];
  log: (entry: LogActivityInput) => void;
  clear: () => void;
}

let nextId = 1;

export const useActivityStore = create<ActivityState>((set) => ({
  entries: [],

  log: (entry) =>
    set((state) => ({
      // Newest-first: the new entry goes at the front, not pushed to the
      // back — ActivityPage renders `entries` in store order directly rather
      // than reversing on every render.
      entries: [{ ...entry, id: nextId++ }, ...state.entries].slice(0, MAX_ENTRIES),
    })),

  clear: () => set({ entries: [] }),
}));

/**
 * The union of every `paths` entry logged this session (CommitDialog's
 * pre-check source, via lib/commit-dialog.ts's buildChecklist): a plain
 * function reading the vanilla store's current getState() rather than a
 * hook, since the only consumer (CommitDialog) only needs "what's been
 * applied so far" at the moment its checklist is (re)built, not a live
 * subscription that re-renders the dialog on every unrelated log() call
 * elsewhere in the app. Entries with no `paths` (or an empty one) simply
 * contribute nothing.
 */
export function appliedPaths(): Set<string> {
  const paths = new Set<string>();
  for (const entry of useActivityStore.getState().entries) {
    for (const p of entry.paths ?? []) paths.add(p);
  }
  return paths;
}
