// Pure checklist/message logic for the sidebar commit affordance (Task 5,
// v0.3 papercuts): CommitDialog.tsx renders this, GitFooter.tsx opens it.
// Unlike the Review page's CommitBar (which only ever offers the files a
// fix/ignore JUST applied, docked right after applying them), this dialog is
// reachable from anywhere the footer shows — so it has to reconcile the
// FULL current dirty-file list against what this session's activity log
// (state/activity.ts) recorded as knip-gui-applied, rather than assuming
// everything dirty came from this app.
export interface ChecklistRow {
  path: string;
  /** Pre-checked iff `knipTouched` — see buildChecklist's doc comment. */
  checked: boolean;
  /** Whether `path` is in this session's activity-log appliedPaths(). */
  knipTouched: boolean;
}

/**
 * One row per dirty file, in the SAME order `dirtyFiles` was given (the
 * server's own git-status order — not re-sorted here). A row starts checked
 * iff its path is in `appliedPaths` (this session's knip-gui-applied files):
 * defaulting to "commit what knip-gui just touched" is the safe default,
 * since anything else dirty in the tree is, from this dialog's point of
 * view, an unrelated in-progress edit it has no business silently sweeping
 * into a commit. `appliedPaths` entries that AREN'T currently dirty (already
 * committed, or reverted) simply produce no row — there's nothing to commit.
 */
export function buildChecklist(dirtyFiles: string[], appliedPaths: ReadonlySet<string>): ChecklistRow[] {
  return dirtyFiles.map((path) => {
    const knipTouched = appliedPaths.has(path);
    return { path, checked: knipTouched, knipTouched };
  });
}

/** Plain fallback commit message — used whenever the checked set isn't purely knip-touched files. */
export const DEFAULT_COMMIT_MESSAGE = 'chore(knip): commit cleanup';

/**
 * The message textarea's default value, recomputed as the checklist changes
 * (until the user types into the textarea themselves — CommitDialog.tsx's
 * concern, not this function's). When every CHECKED row is knip-touched, the
 * message can honestly claim the commit is pure knip-gui cleanup, so it
 * reconciles with the actual count being committed rather than staying
 * generic; the moment even one checked file is unrelated (or nothing is
 * checked yet), it falls back to the plain default rather than overclaiming
 * what the commit contains.
 */
export function defaultCommitDialogMessage(rows: ChecklistRow[]): string {
  const checked = rows.filter((r) => r.checked);
  if (checked.length === 0 || !checked.every((r) => r.knipTouched)) return DEFAULT_COMMIT_MESSAGE;
  return `chore(knip): commit ${checked.length} file${checked.length === 1 ? '' : 's'}`;
}
