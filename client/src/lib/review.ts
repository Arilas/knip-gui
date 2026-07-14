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
  for (const i of items) filePaths.add(i.filePath);

  const failedReasonsByFile = new Map<string, string[]>();
  for (const item of items) {
    if (item.ok) continue;
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
