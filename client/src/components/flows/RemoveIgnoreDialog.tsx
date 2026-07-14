// Remove-ignore confirmation flow for the Ignored page (Task 5). Not built by
// generalizing ActionModal: ActionModal is shaped around the selection cart
// (multi-issue, fix-mode overrides, an options step, a post-apply commit
// panel) — none of which applies to removing one already-listed config
// entry (no options to choose, and Activity logging replaces a commit step
// here). Generalizing it to cover this case would mean threading a bunch of
// fix/ignore-only branches through a component that's ALSO not yet on shadcn
// Dialog itself (see docs/superpowers/specs/2026-07-14-ux-overhaul-design.md
// — that migration is its own follow-up task). Built directly on shadcn's
// Dialog instead (centers correctly by construction, unlike a native
// <dialog>+Tailwind-preflight combination), reusing DiffView for the diff
// render and apply-flow.ts's `joinResults` for the post-apply per-file
// ok/stale/missing/io-error rows — the same join ActionModal's ResultsStep
// uses, just fed empty `items`/`issues` arrays (there's nothing more to
// reconcile: preview already gates Remove on every entry compiling ok, so no
// compile-failed row can appear post-apply).
import { useEffect, useReducer } from 'react';
import type { IgnoreEntry, PatchResult, PlanItem } from '../../api.js';
import { apiErrorMessage } from '../../api.js';
import { joinResults, type DiffEntry } from '../../lib/apply-flow.js';
import { useActivityStore } from '../../state/activity.js';
import { useIgnoreRemoveApplyMutation, useIgnoreRemovePreviewMutation } from '../../state/queries.js';
import { DiffView } from '../DiffView.js';
import { useToast } from '../Toast.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';

type Flow =
  | { status: 'previewing' }
  | { status: 'previewed'; planId: string; diffs: DiffEntry[]; items: PlanItem[] }
  | { status: 'applying'; planId: string; diffs: DiffEntry[] }
  | { status: 'applied'; diffs: DiffEntry[]; results: PatchResult[] }
  | { status: 'failed'; error: string };

type FlowEvent =
  | { type: 'preview:start' }
  | { type: 'preview:success'; planId: string; diffs: DiffEntry[]; items: PlanItem[] }
  | { type: 'preview:error'; error: string }
  | { type: 'apply:start' }
  | { type: 'apply:success'; results: PatchResult[] }
  | { type: 'apply:error'; error: string };

function flowReducer(state: Flow, event: FlowEvent): Flow {
  switch (event.type) {
    case 'preview:start':
      return { status: 'previewing' };
    case 'preview:success':
      return { status: 'previewed', planId: event.planId, diffs: event.diffs, items: event.items };
    case 'preview:error':
      return { status: 'failed', error: event.error };
    case 'apply:start':
      if (state.status !== 'previewed') return state;
      return { status: 'applying', planId: state.planId, diffs: state.diffs };
    case 'apply:success':
      if (state.status !== 'applying') return state;
      return { status: 'applied', diffs: state.diffs, results: event.results };
    case 'apply:error':
      return { status: 'failed', error: event.error };
    default:
      return state;
  }
}

function entryLabel(entry: IgnoreEntry): string {
  return entry.workspace && entry.workspace !== '.' ? `${entry.value} (${entry.workspace})` : entry.value;
}

export interface RemoveIgnoreDialogProps {
  /** The entry to remove; the dialog is open iff this is non-null. */
  entry: IgnoreEntry | null;
  onOpenChange: (open: boolean) => void;
}

export function RemoveIgnoreDialog({ entry, onOpenChange }: RemoveIgnoreDialogProps) {
  const [flow, dispatch] = useReducer(flowReducer, { status: 'previewing' });
  const previewMutation = useIgnoreRemovePreviewMutation();
  const applyMutation = useIgnoreRemoveApplyMutation();
  const log = useActivityStore((s) => s.log);
  const { push } = useToast();

  // Fires the preview the moment a (new) entry opens the dialog — there's no
  // options step for a single already-known entry to configure first, unlike
  // ActionModal's idle step.
  useEffect(() => {
    if (!entry) return;
    dispatch({ type: 'preview:start' });
    previewMutation
      .mutateAsync([entry])
      .then((result) =>
        dispatch({ type: 'preview:success', planId: result.planId, diffs: result.diffs, items: result.items }),
      )
      .catch((e: unknown) => {
        const message = apiErrorMessage(e);
        dispatch({ type: 'preview:error', error: message });
        push('error', message);
      });
    // Re-run only when a DIFFERENT entry opens this dialog (IgnoredPage mounts
    // this once and swaps `entry` in/out); mutation/push identities and flow
    // status intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);

  async function handleApply() {
    if (flow.status !== 'previewed' || !entry) return;
    dispatch({ type: 'apply:start' });
    try {
      const result = await applyMutation.mutateAsync(flow.planId);
      dispatch({ type: 'apply:success', results: result.results });
      if (result.results.some((r) => r.ok)) {
        log({ kind: 'ignore-remove', summary: `removed ${entryLabel(entry)}`, at: new Date().toISOString() });
        push('success', `Removed ${entryLabel(entry)}`);
      } else {
        const reason = result.results[0]?.reason ?? 'apply failed';
        push('error', `Could not remove ${entryLabel(entry)}: ${reason}`);
      }
    } catch (e) {
      const message = apiErrorMessage(e);
      dispatch({ type: 'apply:error', error: message });
      push('error', message);
    }
  }

  // joinResults' 3rd/4th params (planItems/issues) only matter for resolving
  // a compile-failed row's file path — impossible to reach here (preview
  // already gates Remove behind every entry compiling ok), so both are `[]`.
  const rows = flow.status === 'applied' ? joinResults(flow.diffs, flow.results, [], []) : [];

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (flow.status !== 'applying' ? onOpenChange(open) : undefined)}>
      <DialogContent className="max-w-lg" data-testid="remove-ignore-dialog">
        <DialogHeader>
          <DialogTitle>Remove ignore entry</DialogTitle>
          <DialogDescription>
            {entry && (
              <>
                Removes <code className="font-mono">{entryLabel(entry)}</code> from your knip config.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {flow.status === 'previewing' && <p className="text-sm text-muted-foreground">Generating preview…</p>}

        {flow.status === 'previewed' && (
          <div className="flex flex-col gap-3">
            {flow.diffs.length === 0 && (
              <p className="text-sm text-muted-foreground">No file changes to preview.</p>
            )}
            {flow.diffs.map((d) => (
              <DiffView key={d.filePath} diff={d} />
            ))}
            {flow.items.some((i) => !i.ok) && (
              <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                {flow.items.find((i) => !i.ok)?.reason}
              </p>
            )}
          </div>
        )}

        {flow.status === 'applying' && <p className="text-sm text-muted-foreground">Removing…</p>}

        {flow.status === 'applied' && (
          <ul className="flex flex-col gap-1 text-sm">
            {rows.map((row) => (
              <li
                key={row.filePath}
                data-testid={`remove-ignore-result-${row.filePath}`}
                className={`flex items-center gap-2 rounded px-2 py-1 ${
                  row.status === 'ok'
                    ? 'bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100'
                    : 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100'
                }`}
              >
                <span className="font-mono text-xs">{row.filePath}</span>
                <span className="ml-auto shrink-0 text-xs font-medium">{row.status}</span>
              </li>
            ))}
          </ul>
        )}

        {flow.status === 'failed' && (
          <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            {flow.error}
          </p>
        )}

        <DialogFooter>
          {flow.status === 'previewed' && (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={flow.items.every((i) => !i.ok)} onClick={handleApply}>
                Remove
              </Button>
            </>
          )}
          {flow.status === 'applying' && (
            <Button type="button" disabled>
              Removing…
            </Button>
          )}
          {(flow.status === 'applied' || flow.status === 'failed') && (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
