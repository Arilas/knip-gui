// Fix/ignore modal (Task 5): options -> preview -> applying -> results(+
// optional commit), driven by apply-flow.ts's pure reducer. Rendered as a
// native <dialog> via showModal() — this gets keyboard-Escape and
// page-inertness (nothing behind the modal is clickable) for free; the
// 'cancel' handler below blocks Escape specifically while applying, and the
// backdrop-click handler blocks a stray dismiss-click for the same reason
// (the "must not lose state on accidental backdrop click during applying"
// requirement).
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { FixMode, Issue } from '../../../src/core/types.js';
import { apiErrorMessage } from '../api.js';
import {
  appliedOkIssueIds,
  applyFlowReducer,
  defaultCommitMessage,
  filesToDelete,
  initialApplyFlowState,
  joinResults,
  optionsNextBlocked,
} from '../lib/apply-flow.js';
import { useActivityStore } from '../state/activity.js';
import {
  useFixApplyMutation,
  useFixPreviewMutation,
  useGitStatus,
  useIgnoreApplyMutation,
  useIgnorePreviewMutation,
  useReport,
} from '../state/queries.js';
import { summaryByType, useSelectionStore } from '../state/selection.js';
import { CommitPanel } from './CommitPanel.js';
import { DiffView } from './DiffView.js';
import { useToast } from './Toast.js';

export interface ActionModalProps {
  mode: 'fix' | 'ignore';
  issues: Issue[];
  onClose: () => void;
}

const EXPORT_TYPE_MODES: { value: FixMode; label: string; hint: string }[] = [
  {
    value: 'strip-export',
    label: 'Stop exporting it',
    hint: 'Removes the export keyword only — the declaration stays in the file.',
  },
  {
    value: 'delete-declaration',
    label: 'Delete the declaration',
    hint: 'Removes the whole export/type declaration.',
  },
];

function issueLabel(issueId: string, issues: Issue[]): string {
  const issue = issues.find((i) => i.id === issueId);
  if (!issue) return issueId;
  return issue.symbol ? `${issue.filePath}: ${issue.symbol}` : issue.filePath;
}

export function ActionModal({ mode, issues, onClose }: ActionModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selected = useSelectionStore((s) => s.selected);
  const modeOverrides = useSelectionStore((s) => s.modeOverrides);
  const setModeOverride = useSelectionStore((s) => s.setMode);

  const [flow, dispatch] = useReducer(applyFlowReducer, initialApplyFlowState);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { push } = useToast();

  const fixPreview = useFixPreviewMutation();
  const fixApply = useFixApplyMutation();
  const ignorePreview = useIgnorePreviewMutation();
  const ignoreApply = useIgnoreApplyMutation();
  const gitStatusQuery = useGitStatus();
  const reportQuery = useReport();

  // Frozen the moment "Next" is clicked, so later lookups (joinResults'
  // issueId -> filePath resolution, the commit message summary) stay stable
  // even if `issues` changes underneath the modal from the background rescan
  // fix/ignore apply triggers (App.tsx re-renders with the fresh report while
  // this modal is still open showing results).
  const planIssuesRef = useRef<Issue[]>(issues);
  const summaryRef = useRef('');

  const selectedIssues = useMemo(() => issues.filter((i) => selected.has(i.id)), [issues, selected]);
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

  // --- native <dialog> plumbing ---
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
    // Mount/unmount only — ActionModal itself is conditionally mounted by App.tsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    function handleCancel(e: Event) {
      if (flow.status === 'applying') e.preventDefault();
    }
    function handleClose() {
      onClose();
    }
    dialog.addEventListener('cancel', handleCancel);
    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
      dialog.removeEventListener('close', handleClose);
    };
  }, [flow.status, onClose]);

  function requestClose() {
    dialogRef.current?.close();
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current && flow.status !== 'applying') {
      requestClose();
    }
  }

  // --- step handlers ---
  async function handleNext() {
    planIssuesRef.current = issues;
    summaryRef.current = summaryByType({ selected }, issues);
    const issueIds = [...selected];
    dispatch({ type: 'preview:start' });
    try {
      if (mode === 'fix') {
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
      push('error', message);
    }
  }

  async function handleApply() {
    if (flow.status !== 'previewed') return;
    dispatch({ type: 'apply:start' });
    try {
      const applyMutation = mode === 'fix' ? fixApply : ignoreApply;
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
      push('error', message);
    }
  }

  const title = mode === 'fix' ? `Fix ${selected.size} issue${selected.size === 1 ? '' : 's'}` : `Ignore ${selected.size} issue${selected.size === 1 ? '' : 's'}`;

  return (
    <dialog
      ref={dialogRef}
      onClick={handleBackdropClick}
      onCancel={(e) => {
        if (flow.status === 'applying') e.preventDefault();
      }}
      className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white p-0 text-gray-900 shadow-xl backdrop:bg-black/40 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100"
    >
      <div className="flex max-h-[85vh] flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            disabled={flow.status === 'applying'}
            onClick={requestClose}
            className="text-gray-500 hover:text-gray-800 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:text-gray-100"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {flow.status === 'idle' && (
            <div className="flex flex-col gap-4 p-4">
              {mode === 'fix' && exportTypeIssues.length > 0 && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-xs font-medium text-gray-700 dark:text-gray-300">
                    For the {exportTypeIssues.length} selected unused export{exportTypeIssues.length === 1 ? '' : 's'}/type
                    {exportTypeIssues.length === 1 ? '' : 's'}:
                  </legend>
                  {EXPORT_TYPE_MODES.map((opt) => (
                    <label key={opt.value} className="flex items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name="export-type-mode"
                        className="mt-0.5"
                        checked={currentExportTypeMode === opt.value}
                        onChange={() => {
                          for (const issue of exportTypeIssues) setModeOverride(issue.id, opt.value);
                        }}
                      />
                      <span>
                        <span className="font-medium">{opt.label}</span>
                        <span className="block text-xs text-gray-500 dark:text-gray-400">{opt.hint}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}

              {mode === 'fix' && deletePaths.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
                  <p className="font-medium text-amber-900 dark:text-amber-100">
                    {deletePaths.length} file{deletePaths.length === 1 ? '' : 's'} will be deleted:
                  </p>
                  <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-5 font-mono text-xs text-amber-900 dark:text-amber-100">
                    {deletePaths.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                  <label className="mt-2 flex items-center gap-2 text-xs text-amber-900 dark:text-amber-100">
                    <input type="checkbox" checked={confirmDelete} onChange={(e) => setConfirmDelete(e.target.checked)} />
                    I understand these files will be permanently deleted.
                  </label>
                </div>
              )}

              {mode === 'ignore' && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  This adds ignore entries to your knip config (for files/dependencies/binaries) or inserts an{' '}
                  <code>@public</code> JSDoc tag directly in source (for exports/types/enum/namespace members) so knip
                  stops flagging these. The exact file changed will be shown in the preview.
                </p>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={requestClose}
                  className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={optionsNextBlocked(mode, deletePaths, confirmDelete)}
                  onClick={handleNext}
                  className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
                >
                  Next
                </button>
              </div>
            </div>
          )}

          {flow.status === 'previewing' && (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">Generating preview…</p>
          )}

          {flow.status === 'previewed' && (
            <div className="flex flex-col gap-3 p-4">
              {flow.diffs.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400">No file changes to preview.</p>
              )}
              {flow.diffs.map((d) => (
                <DiffView key={d.filePath} diff={d} />
              ))}

              {flow.items.some((i) => !i.ok) && (
                <div className="rounded border border-red-300 bg-red-50 p-3 text-xs text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
                  <p className="font-medium">Could not be compiled:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {flow.items
                      .filter((i) => !i.ok)
                      .map((i) => (
                        <li key={i.issueId}>
                          {issueLabel(i.issueId, issues)} — {i.reason}
                        </li>
                      ))}
                  </ul>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'reset' })}
                  className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-700"
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={flow.items.filter((i) => i.ok).length === 0}
                  onClick={handleApply}
                  className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
                >
                  Apply
                </button>
              </div>
            </div>
          )}

          {flow.status === 'applying' && (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">Applying changes…</p>
          )}

          {flow.status === 'failed' && (
            <div className="flex flex-col gap-3 p-4">
              <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
                {flow.error}
              </p>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'reset' })}
                  className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-700"
                >
                  Back to options
                </button>
              </div>
            </div>
          )}

          {flow.status === 'applied' && (
            <ResultsStep
              mode={mode}
              flow={flow}
              planIssues={planIssuesRef.current}
              summary={summaryRef.current}
              rescanning={reportQuery.data?.status === 'scanning'}
              isRepo={gitStatusQuery.data?.isRepo ?? false}
              onDone={requestClose}
            />
          )}
        </div>
      </div>
    </dialog>
  );
}

function ResultsStep({
  mode,
  flow,
  planIssues,
  summary,
  rescanning,
  isRepo,
  onDone,
}: {
  mode: 'fix' | 'ignore';
  flow: Extract<ReturnType<typeof applyFlowReducer>, { status: 'applied' }>;
  planIssues: Issue[];
  summary: string;
  rescanning: boolean;
  isRepo: boolean;
  onDone: () => void;
}) {
  const rows = useMemo(
    () => joinResults(flow.diffs, flow.results, flow.items, planIssues),
    [flow.diffs, flow.results, flow.items, planIssues],
  );
  const okPaths = useMemo(() => rows.filter((r) => r.status === 'ok').map((r) => r.filePath), [rows]);
  // The commit message must claim only what actually landed: the frozen
  // selection summary overclaims when a file went stale/missing between
  // preview and apply (okPaths already excludes it — the message must
  // agree). Recomputed from the issues whose patches applied ok; falls back
  // to the frozen summary only if that reconciliation comes up empty (in
  // which case Commit is effectively moot anyway — okPaths is empty too).
  const commitSummary = useMemo(() => {
    const okIds = appliedOkIssueIds(flow.items, rows, planIssues);
    return summaryByType({ selected: new Set(okIds) }, planIssues) || summary;
  }, [flow.items, rows, planIssues, summary]);

  // Activity logging (Task 5): once per successful ResultsStep mount — this
  // component only mounts when flow.status turns 'applied', so a ref-guarded
  // effect (rather than logging inline in handleApply, before rows/
  // commitSummary are reconciled) fires exactly once per apply with the same
  // "what actually landed" summary CommitPanel's prefilled message uses.
  // Nothing is logged when every row failed (okPaths empty) — there's
  // nothing to report happening.
  const log = useActivityStore((s) => s.log);
  const loggedRef = useRef(false);
  useEffect(() => {
    if (loggedRef.current || okPaths.length === 0) return;
    loggedRef.current = true;
    log({ kind: mode, summary: commitSummary, at: new Date().toISOString() });
    // Runs once per mount; commitSummary/okPaths/log/mode are read at that
    // moment, not re-triggered on their own later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 p-4">
        <ul className="flex flex-col gap-1 text-sm">
          {rows.map((row, idx) => (
            <li
              key={`${row.filePath}-${idx}`}
              data-testid={`result-row-${row.filePath}`}
              className={`flex items-center gap-2 rounded px-2 py-1 ${
                row.status === 'ok'
                  ? 'bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100'
                  : 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100'
              }`}
            >
              <span className="font-mono text-xs">{row.filePath}</span>
              <span data-testid={`result-status-${row.filePath}`} className="ml-auto shrink-0 text-xs font-medium">
                {row.status}
              </span>
              {row.reason && <span className="shrink-0 text-xs opacity-80">({row.reason})</span>}
            </li>
          ))}
        </ul>

        {rescanning && <p className="text-xs text-gray-500 dark:text-gray-400">Rescanning…</p>}
      </div>

      {isRepo ? (
        <CommitPanel paths={okPaths} defaultMessage={defaultCommitMessage(commitSummary, mode)} onDone={onDone} />
      ) : (
        <div className="flex justify-end border-t border-gray-200 p-4 dark:border-gray-800">
          <button
            type="button"
            onClick={onDone}
            className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-gray-100 dark:text-gray-900"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
