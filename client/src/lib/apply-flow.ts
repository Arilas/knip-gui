// Pure state machine + join/summary helpers driving ActionModal's fix/ignore
// flow (Task 5). No React, no API calls — ActionModal.tsx dispatches events
// into applyFlowReducer from its mutation callbacks and renders each
// resulting state as one modal step (options -> preview -> applying ->
// results). Unit-tested directly in tests/client/apply-flow.test.ts; the
// modal's actual rendering is verified live (Plan 3's Global Constraints keep
// heavy rendering tests out of this vitest run).
import type { FixMode, Issue } from '../../../src/core/types.js';
import type { PlanItem } from '../../../src/fix/compiler.js';
import type { PatchResult } from '../../../src/fix/patch.js';

export interface DiffEntry {
  filePath: string;
  diff: string;
}

export type ApplyFlowState =
  | { status: 'idle' }
  | { status: 'previewing' }
  | { status: 'previewed'; planId: string; diffs: DiffEntry[]; items: PlanItem[] }
  | { status: 'applying'; planId: string; diffs: DiffEntry[]; items: PlanItem[] }
  | {
      status: 'applied';
      planId: string;
      diffs: DiffEntry[];
      items: PlanItem[];
      results: PatchResult[];
      failedItems: PlanItem[];
      rescanning: boolean;
    }
  | { status: 'failed'; error: string; previous: ApplyFlowState };

export type ApplyFlowEvent =
  | { type: 'preview:start' }
  | { type: 'preview:success'; planId: string; diffs: DiffEntry[]; items: PlanItem[] }
  | { type: 'preview:error'; error: string }
  | { type: 'apply:start' }
  | { type: 'apply:success'; results: PatchResult[]; failedItems: PlanItem[]; rescanning: boolean }
  | { type: 'apply:error'; error: string }
  | { type: 'reset' };

export const initialApplyFlowState: ApplyFlowState = { status: 'idle' };

/**
 * `idle -> previewing -> previewed -> applying -> applied`, with a `failed`
 * state reachable from `previewing` or `applying` that carries the state it
 * failed from (so a retry / "back" affordance has somewhere to return to).
 * Transitions that don't make sense for the current state (e.g. apply:start
 * while still idle) are no-ops returning the same state reference, rather
 * than throwing — ActionModal's mutation callbacks are the only caller and
 * are themselves gated by the UI (Apply is only clickable once previewed),
 * but a defensive no-op is cheap insurance against a stray double-dispatch.
 */
export function applyFlowReducer(state: ApplyFlowState, event: ApplyFlowEvent): ApplyFlowState {
  switch (event.type) {
    case 'reset':
      return { status: 'idle' };
    case 'preview:start':
      return { status: 'previewing' };
    case 'preview:error':
      return { status: 'failed', error: event.error, previous: state };
    case 'preview:success':
      return { status: 'previewed', planId: event.planId, diffs: event.diffs, items: event.items };
    case 'apply:start':
      if (state.status !== 'previewed') return state;
      return { status: 'applying', planId: state.planId, diffs: state.diffs, items: state.items };
    case 'apply:error':
      return { status: 'failed', error: event.error, previous: state };
    case 'apply:success':
      if (state.status !== 'applying') return state;
      return {
        status: 'applied',
        planId: state.planId,
        diffs: state.diffs,
        items: state.items,
        results: event.results,
        failedItems: event.failedItems,
        rescanning: event.rescanning,
      };
    default:
      return state;
  }
}

export type FileRowStatus = 'ok' | 'stale' | 'missing' | 'io-error' | 'compile-failed';

export interface FileResultRow {
  filePath: string;
  status: FileRowStatus;
  reason?: string;
}

/**
 * The client-side join obligation (Plan 3's carried-over obligations): apply
 * only returns `results` (per file, from applyPatches) and `failedItems`
 * (per issue, compile-time only — PlanItems whose transform failed before
 * ever producing a patch). This zips `previewDiffs` (the files that DID
 * produce a patch/diff) against `applyResults` by filePath for the
 * ok/stale/missing/io-error rows, then appends one 'compile-failed' row per
 * failed PlanItem — those never had a diff of their own, so their filePath is
 * recovered from `issues` (PlanItem itself only carries an issueId).
 */
export function joinResults(
  previewDiffs: DiffEntry[],
  applyResults: PatchResult[],
  planItems: PlanItem[],
  issues: Issue[],
): FileResultRow[] {
  const resultByFile = new Map(applyResults.map((r) => [r.filePath, r]));
  const diffRows: FileResultRow[] = previewDiffs.map(({ filePath }): FileResultRow => {
    const result = resultByFile.get(filePath);
    if (!result) return { filePath, status: 'missing', reason: 'no apply result received for this file' };
    if (result.ok) return { filePath, status: 'ok' };
    return { filePath, status: result.reason ?? 'io-error', reason: result.detail };
  });

  const issueById = new Map(issues.map((i) => [i.id, i]));
  const compileFailedRows: FileResultRow[] = planItems
    .filter((item) => !item.ok)
    .map((item) => ({
      filePath: issueById.get(item.issueId)?.filePath ?? 'unknown file',
      status: 'compile-failed' as const,
      reason: item.reason,
    }));

  return [...diffRows, ...compileFailedRows];
}

/** "chore(knip): remove 12 exports, 3 files" from selection.ts's summaryByType() output. */
export function defaultCommitMessage(summary: string): string {
  return `chore(knip): remove ${summary || 'unused code'}`;
}

/** The full changed-file list from a preview (before any apply-ok/failed distinction is known). */
export function commitPaths(previewDiffs: DiffEntry[]): string[] {
  return previewDiffs.map((d) => d.filePath);
}

/**
 * Files that will be DELETED by the current fix selection — i.e. selected
 * issues whose effective fix mode (a per-issue override, falling back to its
 * first available mode, mirroring compileFixPlan's own default) is
 * 'delete-file'. In practice only `files`-type issues carry that mode, but
 * this is driven by the resolved mode rather than issue.type so it stays
 * correct if that ever changes. Powers the options step's explicit
 * delete-confirmation list.
 */
export function filesToDelete(
  issues: Issue[],
  selectedIds: ReadonlySet<string> | Iterable<string>,
  modeOverrides: Record<string, FixMode>,
): string[] {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const paths = new Set<string>();
  for (const issue of issues) {
    if (!selected.has(issue.id)) continue;
    const mode = modeOverrides[issue.id] ?? issue.fixModes[0];
    if (mode === 'delete-file') paths.add(issue.filePath);
  }
  return [...paths].sort();
}

/** `chore/knip-cleanup-<today's ISO date>` — CommitPanel's prefilled branch name. */
export function defaultBranchName(date: Date = new Date()): string {
  return `chore/knip-cleanup-${date.toISOString().slice(0, 10)}`;
}

/**
 * Whether the options step's Next button must stay disabled pending the
 * file-deletion confirmation. Only fix mode can delete files (ignore mode
 * writes config entries / @public tags, never deletes), and the confirm
 * checkbox only RENDERS in fix mode — so gating on deletePaths alone would
 * leave Next permanently disabled, with no visible checkbox to satisfy it,
 * whenever an ignore selection happens to contain a files-type issue.
 */
export function optionsNextBlocked(
  mode: 'fix' | 'ignore',
  deletePaths: string[],
  confirmedDelete: boolean,
): boolean {
  return mode === 'fix' && deletePaths.length > 0 && !confirmedDelete;
}

const DEP_TYPES = new Set<Issue['type']>(['dependencies', 'devDependencies', 'optionalPeerDependencies']);

// The file a fixed issue's patch actually lands in. Dependency-shaped issues
// are patched into the owning workspace's package.json (mirrors
// compileFixPlan's own pkgPath computation in src/fix/compiler.ts), not
// `issue.filePath`; everything else is patched in place. Ignore-mode config
// edits (files/deps/binaries -> the knip config file) land somewhere this
// can't derive from the issue alone — appliedOkIssueIds handles that case
// via its all-patches-ok fallback.
function patchFileForIssue(issue: Issue): string {
  if (DEP_TYPES.has(issue.type)) {
    return issue.workspace === '.' ? 'package.json' : `${issue.workspace}/package.json`;
  }
  return issue.filePath;
}

/**
 * The issue ids that were ACTUALLY applied: compiled ok (their PlanItem is
 * ok) AND their patch file applied ok. The commit-message summary must be
 * computed from these, not the frozen selection summary — the frozen summary
 * overclaims whenever a file goes stale/missing between preview and apply
 * (the commit paths already correctly exclude such files; the message must
 * agree with them).
 *
 * An issue whose patch file isn't among the diffed files at all (an
 * ignore-mode config edit, whose patch lands in the knip config rather than
 * any file derivable from the issue) counts as applied only when every patch
 * row succeeded — when something failed we can't attribute it, so we
 * undercount rather than overclaim.
 */
export function appliedOkIssueIds(
  planItems: PlanItem[],
  rows: FileResultRow[],
  issues: Issue[],
): string[] {
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const patchRows = rows.filter((r) => r.status !== 'compile-failed');
  const patchFiles = new Set(patchRows.map((r) => r.filePath));
  const okFiles = new Set(patchRows.filter((r) => r.status === 'ok').map((r) => r.filePath));
  const allPatchesOk = patchRows.every((r) => r.status === 'ok');

  const ids: string[] = [];
  for (const item of planItems) {
    if (!item.ok) continue;
    const issue = issueById.get(item.issueId);
    if (!issue) continue;
    const file = patchFileForIssue(issue);
    const applied = patchFiles.has(file) ? okFiles.has(file) : allPatchesOk;
    if (applied) ids.push(item.issueId);
  }
  return ids;
}
