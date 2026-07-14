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
import { apiErrorMessage } from '../../api.js';
import {
  appliedOkIssueIds,
  applyFlowReducer,
  defaultCommitMessage,
  filesToDelete,
  initialApplyFlowState,
  joinResults,
} from '../../lib/apply-flow.js';
import { affectedFilePaths, buildFileRail, type RailPlanItem, type RailResult } from '../../lib/review.js';
import { useActivityStore } from '../../state/activity.js';
import {
  useFixApplyMutation,
  useFixPreviewMutation,
  useGitStatus,
  useIgnoreApplyMutation,
  useIgnorePreviewMutation,
  useReport,
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
  const log = useActivityStore((s) => s.log);

  // Frozen the moment "Preview changes" is clicked (mirrors ActionModal's old
  // planIssuesRef): issueId -> filePath/label lookups for the preview/applied
  // steps must stay stable even if `issues` changes underneath this page from
  // the post-apply background rescan while the applied step is still up.
  const planIssuesRef = useRef<Issue[]>(issues);

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

  async function handlePreview() {
    planIssuesRef.current = issues;
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
    } catch (e) {
      const message = apiErrorMessage(e);
      dispatch({ type: 'apply:error', error: message });
      toast.error(message);
    }
  }

  function handleLeave() {
    clearReview();
    navigate(review.returnTo);
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
  // appliedOkIssueIds, reused untouched — see that module's doc comments) ---
  const joinedRows =
    flow.status === 'applied' ? joinResults(flow.diffs, flow.results, flow.items, planIssuesRef.current) : [];
  const okPaths = useMemo(() => joinedRows.filter((r) => r.status === 'ok').map((r) => r.filePath), [joinedRows]);
  const commitSummary = useMemo(() => {
    if (flow.status !== 'applied') return review.summary;
    const okIds = appliedOkIssueIds(flow.items, joinedRows, planIssuesRef.current);
    return summaryByType({ selected: new Set(okIds) }, planIssuesRef.current) || review.summary;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, review.summary]);

  // Activity logging (fix/ignore — commit logging lives in CommitBar): once
  // per successful apply, mirroring ActionModal.ResultsStep's ref-guarded
  // effect. Nothing is logged when every row failed (okPaths empty).
  const loggedRef = useRef(false);
  useEffect(() => {
    if (flow.status !== 'applied' || loggedRef.current || okPaths.length === 0) return;
    loggedRef.current = true;
    log({ kind: review.kind, summary: commitSummary, at: new Date().toISOString() });
    // Runs once per successful apply; commitSummary/okPaths/log/review are
    // read at that moment, not re-triggered on their own later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.status]);

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
        onReset={() => dispatch({ type: 'reset' })}
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
