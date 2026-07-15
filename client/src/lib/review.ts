// Pure rail-row model for the Review page (Task 3 will build the FileRail
// component and ReviewPage state machine on top of this; this task only
// needs the pure data shaping — no React, no API calls). Mirrors the
// ok/stale/missing/io-error/compile-failed vocabulary lib/apply-flow.ts's
// joinResults already established for ActionModal's results step, but
// dropped the `issues: Issue[]` lookup parameter joinResults needed to
// recover a compile-failed PlanItem's filePath (PlanItem itself only carries
// an issueId): buildFileRail's `items` here are pre-resolved to carry their
// own `filePath` (the caller — Task 3's ReviewPage — is expected to zip the
// real PlanItem[] against the issue list once, same lookup joinResults does
// internally, before calling this), which keeps this module's signature to
// exactly the three things the design brief specifies.
import type { ApplyFlowState } from './apply-flow.js';

export type RailStatus = 'pending' | 'ok' | 'stale' | 'missing' | 'io-error' | 'compile-failed';

export interface FileRailRow {
  filePath: string;
  status: RailStatus;
  reason?: string;
}

/** A previewed file change — just enough of DiffEntry (lib/apply-flow.ts) for rail purposes. */
export interface RailDiffEntry {
  filePath: string;
}

/**
 * A per-issue compile outcome, pre-resolved to its patch file (see this
 * module's doc comment above for why `filePath` lives here rather than on a
 * bare PlanItem). Only `ok: false` entries affect the rail — a `filePath`
 * with only ok:true items and no diff entry doesn't happen in practice (a
 * successful transform always produces a diff), but such an item is simply
 * ignored here rather than fabricating a row for it.
 */
export interface RailPlanItem {
  filePath: string;
  ok: boolean;
  reason?: string;
}

/** A per-file apply outcome — same shape as PatchResult (src/fix/patch.ts). */
export interface RailResult {
  filePath: string;
  ok: boolean;
  reason?: 'stale' | 'missing' | 'io-error';
  detail?: string;
}

/**
 * Builds the Review page's left-rail rows: one per file touched by the plan
 * (every diffed file, plus any compile-failed item's file that never made it
 * to a diff — e.g. a transform that failed before producing a patch), sorted
 * by filePath.
 *
 * Status precedence per file, per the design brief:
 *  1. `compile-failed` — if ANY item for this filePath has `ok: false`, that
 *     wins outright, even if `results` separately reports the same file
 *     applied ok (a file can carry multiple issues; one failing to compile
 *     means the file's overall outcome must flag it, regardless of what
 *     happened to its other, successfully-compiled issues). Reasons from
 *     multiple failed items for the same file are joined with '; '.
 *  2. Otherwise, when `results` has landed (apply happened): the matching
 *     PatchResult's ok/stale/missing/io-error, `detail` as the row's reason.
 *     A diffed file with no matching result at all is `missing` (mirrors
 *     joinResults' same fallback) — apply ran but this file's outcome never
 *     came back.
 *  3. Otherwise (no `results` argument yet — still at the preview step):
 *     `pending`.
 */
export function buildFileRail(diffs: RailDiffEntry[], items: RailPlanItem[], results?: RailResult[]): FileRailRow[] {
  const filePaths = new Set<string>();
  for (const d of diffs) filePaths.add(d.filePath);

  // Only ok:false items contribute a filePath of their own (per this
  // function's doc comment: a successful transform always produces a diff,
  // so an ok:true item's file is already covered by the `diffs` loop above).
  // This matters beyond tidiness: for a dependency-shaped issue, the
  // caller's pre-resolved `filePath` is the ISSUE's own filePath (its
  // package.json), which is NOT where a fix (workspace package.json) or
  // ignore (knip config file) patch actually lands — including an ok:true
  // item's filePath here would fabricate a bogus extra row for that
  // never-diffed, never-resultable file that a caller's "pick the first row"
  // UI logic (ReviewPage.tsx) could get stuck showing instead of the real
  // diffed file. ok:false items don't have this problem: their filePath is
  // only ever used to surface a compile failure that never made it to a
  // diff, which is exactly what's needed regardless of whether the
  // filePath is fully accurate for a dependency-shaped issue.
  const failedReasonsByFile = new Map<string, string[]>();
  for (const item of items) {
    if (item.ok) continue;
    filePaths.add(item.filePath);
    const reasons = failedReasonsByFile.get(item.filePath) ?? [];
    if (item.reason) reasons.push(item.reason);
    failedReasonsByFile.set(item.filePath, reasons);
  }

  const resultByFile = results ? new Map(results.map((r) => [r.filePath, r])) : undefined;

  const rows: FileRailRow[] = [...filePaths].map((filePath) => {
    const failedReasons = failedReasonsByFile.get(filePath);
    if (failedReasons) {
      const reason = failedReasons.length > 0 ? failedReasons.join('; ') : undefined;
      return reason ? { filePath, status: 'compile-failed', reason } : { filePath, status: 'compile-failed' };
    }

    if (!resultByFile) return { filePath, status: 'pending' };

    const result = resultByFile.get(filePath);
    if (!result) return { filePath, status: 'missing', reason: 'no apply result received for this file' };
    if (result.ok) return { filePath, status: 'ok' };
    return result.detail ? { filePath, status: result.reason ?? 'io-error', reason: result.detail } : { filePath, status: result.reason ?? 'io-error' };
  });

  return rows.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/**
 * The Review page's 'options' step (Task 3) shows an affected-file list
 * derived client-side from the selection, before any plan has been compiled
 * (no diffs/items/results exist yet) — just the deduped, sorted set of
 * `filePath`s among the selected issues. This deliberately doesn't account
 * for dependency-shaped issues actually patching into a workspace's
 * package.json rather than `issue.filePath` (see apply-flow.ts's
 * patchFileForIssue) — that reconciliation only matters once a real plan
 * comes back, which is exactly when the 'preview' step's buildFileRail call
 * (fed the plan's real diffs) supersedes this list.
 */
export function affectedFilePaths(issues: { filePath: string }[]): string[] {
  return [...new Set(issues.map((i) => i.filePath))].sort();
}

/**
 * Inputs to `shouldRestoreOpenFile` (#6): deliberately a narrower, flatter
 * shape than "whatever ReviewPage has lying around" — `returnTo`/
 * `returnOpenFile` come straight off the frozen `ReviewRequest`
 * (state/ui.ts), `applied` collapses ReviewPage's five-state `flow.status`
 * down to the one distinction that matters here (did an apply actually run,
 * as opposed to Cancel from idle/previewing/failed), and `deletedOkPaths` is
 * pre-computed by the caller rather than re-derived from issues/selection
 * here — this module stays free of PlanItem/PatchResult/Issue shapes, and the
 * caller is the one with access to plan-vs-live staleness concerns (see
 * ReviewPage.tsx's own comment on why it sources deletedOkPaths from frozen
 * plan/apply data, not the live selection store).
 */
export interface ShouldRestoreOpenFileArgs {
  /** The page Cancel/Done navigates back to — restoring only ever makes sense returning to Code, the one page with a file pane. */
  returnTo: string;
  /** What was open before the review started (state/ui.ts's ReviewRequest.returnOpenFile) — undefined means nothing was. */
  returnOpenFile?: string;
  /** Whether an apply actually completed (flow.status === 'applied') — false for Cancel from idle/previewing/failed, where nothing could have been deleted yet. */
  applied: boolean;
  /** Paths that were both slated for deletion AND applied ok — see filesToDelete/joinResults (lib/apply-flow.ts). Only meaningful when `applied` is true; ignored otherwise. */
  deletedOkPaths: string[];
}

/**
 * Whether ReviewPage's Cancel/Skip/Done should hand `returnOpenFile` back to
 * `navigate` (restoring the Code page's file pane) or leave it out (letting
 * `navigate`'s default clear it — see state/ui.ts's doc comment). Three ways
 * to say no:
 *  1. Not returning to Code at all — a file pane is Code-page-only state
 *     (state/ui.ts's `navigate` doc comment), so restoring it while landing
 *     on another page would be meaningless.
 *  2. Nothing was open before the review started (`returnOpenFile` unset).
 *  3. The file was genuinely deleted by what just ran: an apply completed
 *     AND the file is in `deletedOkPaths`. Gated on `applied` first and not
 *     merely `deletedOkPaths.includes(...)` on its own, since a caller could
 *     otherwise (harmlessly, but incorrectly) compute deletedOkPaths ahead of
 *     an apply that hasn't happened yet — e.g. an ignore-mode plan never
 *     deletes anything (compileIgnorePlan, src/fix/compiler.ts, has no
 *     delete-file branch), so an 'ignore' review can always restore even
 *     though issue.fixModes (a fix-mode concept) might coincidentally still
 *     say 'delete-file' for a files-type issue — ReviewPage.tsx accounts for
 *     that by only ever populating deletedOkPaths for 'fix' reviews, but this
 *     function doesn't need to know why the caller's list is empty, only
 *     that it is.
 */
export function shouldRestoreOpenFile({
  returnTo,
  returnOpenFile,
  applied,
  deletedOkPaths,
}: ShouldRestoreOpenFileArgs): boolean {
  if (returnTo !== 'code') return false;
  if (!returnOpenFile) return false;
  if (applied && deletedOkPaths.includes(returnOpenFile)) return false;
  return true;
}

/**
 * (#9) The Review page freezes `frozenCount`/`summary` at startReview time,
 * but the LIVE selection (`selectedIssues`, derived from the selection store
 * filtered against the current `issues`) can be pruned to nothing before the
 * user ever clicks "Preview changes" — an external edit + rescan invalidates
 * every selected issue, and App.tsx's pruneMissing effect drops the
 * now-dangling selection entries out from under this page. Left unhandled,
 * the 'options' step (ReviewHeader) renders with a frozen non-zero count
 * badge but nothing to actually preview: a dead end with no explanation.
 *
 * Gated on `flowStatus === 'idle'` specifically (not "selectedCount === 0"
 * alone) so this can ONLY fire on the pre-preview step: once a plan has
 * compiled (previewing/previewed/applying/applied/failed), the plan's own
 * frozen diffs/items are what the rest of the page renders from, and the
 * live selection emptying out from under an in-flight or completed plan is
 * expected (see ReviewPage.tsx's planIssuesRef/planModeOverridesRef doc
 * comments) — flipping to this empty state mid-flow would yank the plan
 * result out from under the user for no reason.
 *
 * `frozenCount > 0` excludes the (currently unreachable, but cheap to guard)
 * case of a review started with nothing selected in the first place — that's
 * not "gone stale", there was never anything to preview.
 */
export function isAllStale(flowStatus: ApplyFlowState['status'], selectedCount: number, frozenCount: number): boolean {
  return flowStatus === 'idle' && selectedCount === 0 && frozenCount > 0;
}
