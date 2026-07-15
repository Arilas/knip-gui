// The Review page (Task 3, v0.3 — replaces ActionModal + CommitPanel, both
// deleted this task): a single page with three steps driven by
// apply-flow.ts's existing reducer (reused untouched) rather than a modal —
// 'idle' renders as the pre-preview 'options' step (fix-mode radios/delete-
// confirm/ignore explanation, in ReviewHeader), 'previewing'/'previewed'/
// 'applying' render as the 'preview' step (FileRail + a single file's
// DiffView in the main area — deliberately ONE diff at a time, not
// ActionModal's old stacked list, so a big selection never becomes a giant
// scroll wall), and 'applied' is the 'applied' step (rail statuses + a docked
// CommitBar). Only reachable via SelectionDock's startReview() call
// (state/ui.ts) — App.tsx redirects away if 'review' is the active page with
// no pending request (direct nav/reload edge case).
//
// Cancel/Done never gets blocked by Escape-to-dismiss (there's no dialog
// here to dismiss) — the page persists across preview/apply until the user
// explicitly leaves via Cancel, CommitBar's Skip, or CommitBar's Done, per
// the design brief. The one exception mirrors ActionModal's old guard:
// Cancel does nothing while `applying` (a patch write in flight shouldn't be
// abandoned mid-request).
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { FixMode, Issue } from '../../api.js';
import { apiErrorMessage, deleteFixPlan } from '../../api.js';
import {
  appliedOkIssueIds,
  applyFlowReducer,
  buildApplyActivityEntry,
  defaultCommitMessage,
  filesToDelete,
  initialApplyFlowState,
  joinResults,
} from '../../lib/apply-flow.js';
import { pluralizeWord } from '../../lib/pluralize.js';
import {
  affectedFilePaths,
  buildFileRail,
  isAllStale,
  shouldRestoreOpenFile,
  type RailPlanItem,
  type RailResult,
} from '../../lib/review.js';
import { useActivityStore } from '../../state/activity.js';
import {
  useBusy,
  useFixApplyMutation,
  useFixPreviewMutation,
  useGitStatus,
  useIgnoreApplyMutation,
  useIgnorePreviewMutation,
  useReport,
  useScanMutation,
} from '../../state/queries.js';
import { summaryByType, useSelectionStore } from '../../state/selection.js';
import { useUiStore, type ReviewRequest } from '../../state/ui.js';
import { DiffView } from '../flows/DiffView.js';
import { CommitBar } from '../review/CommitBar.js';
import { FileRail } from '../review/FileRail.js';
import { ReviewHeader } from '../review/ReviewHeader.js';
import { Button } from '../ui/button.js';

export interface ReviewPageProps {
  issues: Issue[];
  review: ReviewRequest;
}

function issueLabel(issueId: string, issues: Issue[]): string {
  const issue = issues.find((i) => i.id === issueId);
  if (!issue) return issueId;
  return issue.symbol ? `${issue.filePath}: ${issue.symbol}` : issue.filePath;
}

export function ReviewPage({ issues, review }: ReviewPageProps) {
  const selected = useSelectionStore((s) => s.selected);
  const modeOverrides = useSelectionStore((s) => s.modeOverrides);
  const setModeOverride = useSelectionStore((s) => s.setMode);

  const navigate = useUiStore((s) => s.navigate);
  const clearReview = useUiStore((s) => s.clearReview);

  const [flow, dispatch] = useReducer(applyFlowReducer, initialApplyFlowState);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const fixPreview = useFixPreviewMutation();
  const fixApply = useFixApplyMutation();
  const ignorePreview = useIgnorePreviewMutation();
  const ignoreApply = useIgnoreApplyMutation();
  const gitStatusQuery = useGitStatus();
  const reportQuery = useReport();
  const scanMutation = useScanMutation();
  const busy = useBusy();
  const log = useActivityStore((s) => s.log);

  // Frozen the moment "Preview changes" is clicked (mirrors ActionModal's old
  // planIssuesRef): issueId -> filePath/label lookups for the preview/applied
  // steps must stay stable even if `issues` changes underneath this page from
  // the post-apply background rescan while the applied step is still up.
  const planIssuesRef = useRef<Issue[]>(issues);
  // Frozen alongside planIssuesRef at "Preview changes" time (#6 review):
  // the mode overrides the plan was actually compiled with. The live
  // selection-store value is NOT stable during the applied step — App.tsx's
  // pruneMissing effect prunes overrides for issue ids the post-apply
  // background rescan made vanish — so deletedOkPaths below must read this
  // snapshot, not the live store, to keep agreeing with the plan that ran.
  const planModeOverridesRef = useRef<Record<string, FixMode>>(modeOverrides);

  const selectedIssues = useMemo(() => issues.filter((i) => selected.has(i.id)), [issues, selected]);
  const affectedFiles = useMemo(() => affectedFilePaths(selectedIssues), [selectedIssues]);
  const exportTypeIssues = useMemo(
    () => selectedIssues.filter((i) => i.type === 'exports' || i.type === 'types'),
    [selectedIssues],
  );
  const currentExportTypeMode: FixMode =
    exportTypeIssues.length > 0
      ? modeOverrides[exportTypeIssues[0]!.id] ?? exportTypeIssues[0]!.fixModes[0] ?? 'strip-export'
      : 'strip-export';
  const deletePaths = useMemo(
    () => filesToDelete(issues, selected, modeOverrides),
    [issues, selected, modeOverrides],
  );

  // (#9) See lib/review.ts's isAllStale doc comment: true only at the
  // pre-preview 'options' step, when the live selection a rescan pruned to
  // nothing has left the frozen header's count with nothing left to act on.
  // Computed once per render and reused by both the early-return guard below
  // (belt-and-suspenders against any other path trying to drive a preview
  // off an empty selection) and the render branch further down.
  const allStale = isAllStale(flow.status, selectedIssues.length, review.frozenCount);

  async function handlePreview() {
    if (allStale) return;
    planIssuesRef.current = issues;
    planModeOverridesRef.current = modeOverrides;
    const issueIds = [...selected];
    dispatch({ type: 'preview:start' });
    try {
      if (review.kind === 'fix') {
        const overrides = Object.fromEntries(Object.entries(modeOverrides).filter(([id]) => selected.has(id)));
        const result = await fixPreview.mutateAsync({ issueIds, modeOverrides: overrides });
        dispatch({ type: 'preview:success', planId: result.planId, diffs: result.diffs, items: result.items });
      } else {
        const result = await ignorePreview.mutateAsync(issueIds);
        dispatch({ type: 'preview:success', planId: result.planId, diffs: result.diffs, items: result.items });
      }
    } catch (e) {
      const message = apiErrorMessage(e);
      dispatch({ type: 'preview:error', error: message });
      toast.error(message);
    }
  }

  async function handleApply() {
    if (flow.status !== 'previewed') return;
    dispatch({ type: 'apply:start' });
    try {
      const applyMutation = review.kind === 'fix' ? fixApply : ignoreApply;
      const result = await applyMutation.mutateAsync(flow.planId);
      dispatch({
        type: 'apply:success',
        results: result.results,
        failedItems: result.failedItems,
        rescanning: result.rescanning,
      });
      // (#7) Log right here, in the mutateAsync continuation, rather than in
      // a post-render effect keyed on flow.status === 'applied': this code
      // keeps running even if the user has already navigated away and
      // unmounted the page during the 'applying' window (React doesn't
      // cancel in-flight promises), whereas an effect on an unmounted
      // component simply never fires again — silently dropping the entry
      // CommitDialog's "changed by knip-gui" check depends on. flow.diffs/
      // flow.items are still the frozen 'previewed' values checked above (this
      // function never reassigns `flow`); planIssuesRef.current is the issue
      // list the plan was compiled from, per its own doc comment above.
      const entry = buildApplyActivityEntry(
        flow.diffs,
        flow.items,
        result.results,
        planIssuesRef.current,
        review.kind,
        review.summary,
        new Date().toISOString(),
      );
      if (entry) log(entry);
    } catch (e) {
      const message = apiErrorMessage(e);
      dispatch({ type: 'apply:error', error: message });
      toast.error(message);
    }
  }

  // (#2, client half) A 'previewed' plan is compiled server-side but never
  // consumed — planStore.take() only runs inside /api/fix/apply and
  // /api/ignore/apply (routes-fix.ts) — so leaving the page at this step
  // (handleCancel via handleLeave, or ReviewHeader's Back->reset) leaks it
  // until PlanStore's own TTL/LRU eviction reclaims it. Fire-and-forget: a
  // failed DELETE must never block navigation or surface an error — the TTL
  // is the backstop, this call is purely an optimization.
  // Also fires on 'failed' when the failure came from an apply attempt
  // (flow.previous.status === 'applying', which carries the same planId the
  // plan was previewed with) — an apply can fail BEFORE planStore.take() ever
  // runs (the busy-latch 409 in routes-fix.ts checks tryBeginOp('fix-apply')/
  // ('ignore-apply') before take()), which leaves the plan sitting in
  // PlanStore exactly like an abandoned 'previewed' page would. Releasing
  // unconditionally on this branch is still safe for failures that happened
  // AFTER take() (the 404 "unknown or already-applied plan" branch, or any
  // later error) — take() already removed the plan there, so the DELETE is
  // a benign no-op (PlanStore.delete on a missing id just returns
  // `{ deleted: false }`). 'failed' after a *preview* failure
  // (flow.previous.status === 'previewing') is excluded: compileFixPlan/
  // compileIgnorePlan never got far enough to produce a plan, so there's
  // nothing to release.
  function releasePlanIfPreviewed() {
    if (flow.status === 'previewed') deleteFixPlan(flow.planId).catch(() => {});
    else if (flow.status === 'failed' && flow.previous.status === 'applying') {
      deleteFixPlan(flow.previous.planId).catch(() => {});
    }
  }

  function handleLeave() {
    releasePlanIfPreviewed();
    clearReview();
    // #6: restore whatever file was open on the Code page before this review
    // started, unless the fix/ignore run just deleted it out from under us —
    // see lib/review.ts's shouldRestoreOpenFile and deletedOkPaths above for
    // the full "why". `navigate` itself always clears openFile when opts (or
    // opts.openFile) is omitted (state/ui.ts), so passing `undefined` here
    // reproduces the pre-#6 behavior exactly.
    const restore = shouldRestoreOpenFile({
      returnTo: review.returnTo,
      returnOpenFile: review.returnOpenFile,
      applied: flow.status === 'applied',
      deletedOkPaths,
    });
    navigate(review.returnTo, restore ? { openFile: review.returnOpenFile } : undefined);
  }

  function handleCancel() {
    if (flow.status === 'applying') return;
    handleLeave();
  }

  // --- rail rows per step (lib/review.ts's buildFileRail, Task 2) ---
  const zippedItems: RailPlanItem[] = useMemo(() => {
    if (flow.status === 'idle' || flow.status === 'previewing' || flow.status === 'failed') return [];
    const issueById = new Map(planIssuesRef.current.map((i) => [i.id, i]));
    return flow.items.map((item) => ({
      filePath: issueById.get(item.issueId)?.filePath ?? 'unknown file',
      ok: item.ok,
      reason: item.reason,
    }));
  }, [flow]);

  const railRows = useMemo(() => {
    // Pre-compile: a "pending" row per affected file derived client-side from
    // the selection — there's no plan yet, so nothing else to show.
    if (flow.status === 'idle' || flow.status === 'previewing' || flow.status === 'failed') {
      return buildFileRail(
        affectedFiles.map((filePath) => ({ filePath })),
        [],
      );
    }
    const results: RailResult[] | undefined = flow.status === 'applied' ? flow.results : undefined;
    return buildFileRail(flow.diffs, zippedItems, results);
  }, [flow, affectedFiles, zippedItems]);

  // Keep the main area's selected file valid as the rail's rows change (a
  // fresh compile, or the transition into 'applied') — defaults to the first
  // row so the main area is never blank once rows exist.
  useEffect(() => {
    if (selectedFilePath && railRows.some((r) => r.filePath === selectedFilePath)) return;
    setSelectedFilePath(railRows[0]?.filePath ?? null);
    // Only re-run when the ROWS change, not on every selectedFilePath write
    // this same effect makes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railRows]);

  const compileFailedLabels = useMemo(() => {
    if (flow.status !== 'previewed') return [];
    return flow.items.filter((i) => !i.ok).map((i) => `${issueLabel(i.issueId, planIssuesRef.current)} — ${i.reason}`);
  }, [flow]);

  // --- applied-step reconciliation (apply-flow.ts's joinResults/
  // appliedOkIssueIds, reused untouched — see that module's doc comments).
  // DISPLAY only (CommitBar's paths/summary props) — the activity-log write
  // itself happens in handleApply via buildApplyActivityEntry, not here; see
  // that call's comment for why logging moved out of render/effect scope. ---
  const joinedRows =
    flow.status === 'applied' ? joinResults(flow.diffs, flow.results, flow.items, planIssuesRef.current) : [];
  const okPaths = useMemo(() => joinedRows.filter((r) => r.status === 'ok').map((r) => r.filePath), [joinedRows]);

  // Deletion signal for handleLeave's shouldRestoreOpenFile call (#6): every
  // input is FROZEN at "Preview changes" time — planIssuesRef.current (the
  // issue list the plan was compiled from), planModeOverridesRef.current
  // (the overrides it was compiled with), and flow.items' issueIds (the
  // exact PlanItem set that was applied) — never the live `issues`/
  // `selected`/`modeOverrides` this page also has in scope. All three live
  // values can legitimately drift out from under an already-applied plan
  // while the applied/commit step is still on screen: the post-apply
  // background rescan changes `issues`, App.tsx's pruneMissing effect then
  // prunes both `selected` AND `modeOverrides` entries for the ids that
  // rescan made vanish — so a live read would make this computation agree
  // with what's on screen right now instead of with what the apply that just
  // ran actually did. Only computed for 'fix' reviews: filesToDelete's
  // delete-file signal comes from an issue's fixModes, which is meaningless
  // for an 'ignore' review (compileIgnorePlan, src/fix/compiler.ts, never
  // deletes a file) — a files-type issue's fixModes[0] can still be
  // 'delete-file' even when this review is an ignore, which would otherwise
  // falsely flag its file as deleted and block the restore that ignore
  // should always allow.
  const deletedOkPaths = useMemo(() => {
    if (review.kind !== 'fix' || flow.status !== 'applied') return [];
    const appliedIds = new Set(flow.items.map((item) => item.issueId));
    const deleted = new Set(filesToDelete(planIssuesRef.current, appliedIds, planModeOverridesRef.current));
    return okPaths.filter((path) => deleted.has(path));
  }, [review.kind, flow, okPaths]);
  const commitSummary = useMemo(() => {
    if (flow.status !== 'applied') return review.summary;
    const okIds = appliedOkIssueIds(flow.items, joinedRows, planIssuesRef.current);
    return summaryByType({ selected: new Set(okIds) }, planIssuesRef.current) || review.summary;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, review.summary]);

  const selectedRow = railRows.find((r) => r.filePath === selectedFilePath);
  const selectedDiff =
    flow.status === 'previewed' || flow.status === 'applying' || flow.status === 'applied'
      ? flow.diffs.find((d) => d.filePath === selectedFilePath)
      : undefined;

  function renderMain() {
    if (flow.status === 'idle' || flow.status === 'previewing' || flow.status === 'failed') {
      return (
        <p className="p-4 text-center text-sm text-muted-foreground">
          Compile the plan ("Preview changes") to see file diffs here.
        </p>
      );
    }
    if (railRows.length === 0) {
      return <p className="p-4 text-sm text-muted-foreground">No file changes to preview.</p>;
    }
    if (selectedDiff) {
      return <DiffView key={selectedDiff.filePath} diff={selectedDiff} />;
    }
    if (selectedRow?.status === 'compile-failed') {
      return (
        <p className="p-4 text-sm text-destructive">
          Could not be compiled{selectedRow.reason ? `: ${selectedRow.reason}` : ''}.
        </p>
      );
    }
    return <p className="p-4 text-sm text-muted-foreground">Select a file to see its diff.</p>;
  }

  const isRepo = gitStatusQuery.data?.isRepo ?? false;
  const rescanning = flow.status === 'applied' && reportQuery.data?.status === 'scanning';

  // (#9) Dedicated dead-end screen instead of the normal header+rail+main
  // body: an 'options' step whose frozen count badge has nothing left behind
  // it to preview is worse than no screen at all — it looks actionable
  // (radios, a Preview button) but Preview can never produce anything. No
  // GitFooter Re-run affordance is reachable from here to fix it either
  // (that button is disabled for the whole time page === 'review' — see its
  // own comment), so this state needs its own Rescan.
  //
  // Ordering: handleLeave() runs BEFORE scanMutation.mutate() rather than
  // after/concurrently. clearReview()+navigate() are synchronous zustand
  // writes that only take effect on React's next render, so this handler
  // still finishes running (and fires the mutation) before this component
  // unmounts — but conceptually the mutation is now "launched from the Code
  // page", which lines up with where the user actually lands. This is safe
  // either way since useScanMutation is queryClient-bound, not tied to this
  // component's lifetime (react-query doesn't cancel in-flight mutations on
  // unmount) — the ordering is a documentation choice, not a correctness one.
  if (allStale) {
    return (
      <div
        data-testid="review-all-stale"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
      >
        <p className="max-w-md text-sm text-muted-foreground">
          All {pluralizeWord(review.frozenCount, 'selected issue', 'selected issues')}{' '}
          {review.frozenCount === 1 ? 'is' : 'are'} stale — the code changed since the scan. Rescan and reselect.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            data-testid="review-all-stale-rescan"
            disabled={busy}
            onClick={() => {
              handleLeave();
              scanMutation.mutate(reportQuery.data?.report?.scope);
            }}
          >
            Rescan
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleLeave}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="review-page" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <ReviewHeader
        kind={review.kind}
        frozenCount={review.frozenCount}
        summary={review.summary}
        flow={flow}
        affectedFiles={affectedFiles}
        exportTypeIssues={exportTypeIssues}
        currentExportTypeMode={currentExportTypeMode}
        onSetExportTypeMode={(mode) => {
          for (const issue of exportTypeIssues) setModeOverride(issue.id, mode);
        }}
        deletePaths={deletePaths}
        confirmDelete={confirmDelete}
        onConfirmDeleteChange={setConfirmDelete}
        compileFailedLabels={compileFailedLabels}
        onPreview={handlePreview}
        onApply={handleApply}
        onReset={() => {
          releasePlanIfPreviewed();
          dispatch({ type: 'reset' });
        }}
        onCancel={handleCancel}
      />

      {rescanning && (
        <p className="shrink-0 border-b border-border px-4 py-1 text-xs text-muted-foreground">Rescanning…</p>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-border">
          <FileRail rows={railRows} selectedFilePath={selectedFilePath} onSelect={setSelectedFilePath} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{renderMain()}</div>
      </div>

      {flow.status === 'applied' &&
        (isRepo ? (
          <CommitBar
            paths={okPaths}
            defaultMessage={defaultCommitMessage(commitSummary, review.kind)}
            onLeave={handleLeave}
          />
        ) : (
          <div className="flex shrink-0 justify-end border-t border-border p-3">
            <Button type="button" onClick={handleLeave} data-testid="review-done">
              Done
            </Button>
          </div>
        ))}
    </div>
  );
}
