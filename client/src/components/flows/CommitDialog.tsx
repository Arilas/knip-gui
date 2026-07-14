// Sidebar-footer commit affordance (Task 5, v0.3 papercuts): committing
// arbitrary dirty files from anywhere in the app, not just the files a
// fix/ignore just applied (that's the Review page's docked CommitBar,
// components/review/CommitBar.tsx — unchanged by this task). Opened by
// GitFooter's "N uncommitted" button whenever gitStatus.dirty is true.
//
// Built directly on shadcn's Dialog (same choice as RemoveIgnoreDialog, for
// the same reason: no generalizable shared modal shape here) with a
// checklist of every currently-dirty file (lib/commit-dialog.ts's pure
// buildChecklist/defaultCommitDialogMessage), pre-checking exactly the paths
// this session's activity log recorded as knip-gui-applied
// (state/activity.ts's appliedPaths()) — anything else dirty defaults
// UNCHECKED with a "not changed by knip-gui" hint, so committing from here
// never silently sweeps up an unrelated in-progress edit sitting in the same
// working tree.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { apiErrorMessage } from '../../api.js';
import { buildChecklist, defaultCommitDialogMessage, type ChecklistRow } from '../../lib/commit-dialog.js';
import { appliedPaths, useActivityStore } from '../../state/activity.js';
import { useGitCommitMutation, useGitStatus } from '../../state/queries.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Textarea } from '../ui/textarea.js';

export interface CommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommitDialog({ open, onOpenChange }: CommitDialogProps) {
  const { refetch: refetchGitStatus } = useGitStatus();
  const commitMutation = useGitCommitMutation();
  const log = useActivityStore((s) => s.log);

  const [rows, setRows] = useState<ChecklistRow[]>([]);
  // Never actually shown — the open-effect below sets a real default before
  // the dialog's first paint.
  const [message, setMessage] = useState('');
  const [messageEdited, setMessageEdited] = useState(false);
  const [sha, setSha] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rebuilds the checklist fresh every time the dialog opens (mirrors
  // RemoveIgnoreDialog's per-open preview effect, keyed there on `entry`;
  // there's no per-entity identity here, so this keys on `open` itself).
  // Explicitly REFETCHES gitStatus rather than trusting whatever's already
  // cached: GitFooter (which never unmounts) is this query's only other
  // subscriber and nothing invalidates it on a plain file edit made outside
  // this app, so the cache can be arbitrarily stale by the time someone
  // opens this dialog — and showing a stale dirty-file list here would be
  // actively wrong for the one screen whose entire job is "here's what's
  // dirty right now, pick what to commit." Deliberately NOT re-run on every
  // later gitStatus change while already open, though — that would yank
  // checked state out from under someone mid-review.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSha(null);
    setError(null);
    refetchGitStatus().then((result) => {
      if (cancelled) return;
      const dirtyFiles = result.data?.dirtyFiles ?? [];
      const nextRows = buildChecklist(dirtyFiles, appliedPaths());
      setRows(nextRows);
      setMessage(defaultCommitDialogMessage(nextRows));
      setMessageEdited(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toggleRow(path: string) {
    setRows((prev) => {
      const next = prev.map((r) => (r.path === path ? { ...r, checked: !r.checked } : r));
      // Keep the message reconciled to the current selection until the user
      // has actually typed their own — same "don't clobber a manual edit"
      // rule CommitBar's frozen default follows, just re-evaluated live here
      // since toggling a checkbox is itself part of composing the commit.
      if (!messageEdited) setMessage(defaultCommitDialogMessage(next));
      return next;
    });
  }

  const checkedPaths = rows.filter((r) => r.checked).map((r) => r.path);
  const busy = commitMutation.isPending;
  const disabled = busy || sha !== null || checkedPaths.length === 0 || message.trim().length === 0;

  async function handleCommit() {
    setError(null);
    try {
      const trimmed = message.trim();
      const result = await commitMutation.mutateAsync({ message: trimmed, paths: checkedPaths });
      setSha(result.sha);
      toast.success(`Committed ${result.sha.slice(0, 7)}`);
      log({ kind: 'commit', summary: trimmed, sha: result.sha, paths: checkedPaths, at: new Date().toISOString() });
    } catch (e) {
      const msg = apiErrorMessage(e);
      setError(msg);
      toast.error(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (!busy ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-w-lg" data-testid="commit-dialog">
        <DialogHeader>
          <DialogTitle>Commit changes</DialogTitle>
          <DialogDescription>Choose which uncommitted files to include in this commit.</DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No uncommitted files.</p>
        ) : (
          <ul data-testid="commit-dialog-checklist" className="flex max-h-64 flex-col gap-0.5 overflow-y-auto text-sm">
            {rows.map((row) => (
              <li key={row.path} data-testid={`commit-dialog-row-${row.path}`}>
                <label className="flex items-center gap-2 rounded px-1 py-1 hover:bg-muted">
                  <input
                    type="checkbox"
                    checked={row.checked}
                    disabled={busy || sha !== null}
                    onChange={() => toggleRow(row.path)}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.path}</span>
                  {!row.knipTouched && (
                    <span className="shrink-0 text-xs text-muted-foreground">not changed by knip-gui</span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        )}

        {sha ? (
          <div
            data-testid="commit-dialog-sha"
            className="rounded-md border border-green-300 bg-green-50 px-2 py-2 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-100"
          >
            Committed <code className="font-mono">{sha}</code>
          </div>
        ) : (
          <Textarea
            value={message}
            disabled={busy}
            onChange={(e) => {
              setMessageEdited(true);
              setMessage(e.target.value);
            }}
            rows={2}
            className="font-mono text-sm"
            aria-label="Commit message"
            data-testid="commit-dialog-message"
          />
        )}

        {error && (
          <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          {sha ? (
            <Button type="button" onClick={() => onOpenChange(false)} data-testid="commit-dialog-done">
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={disabled}
                onClick={handleCommit}
                data-testid="commit-dialog-commit"
              >
                {busy ? 'Committing…' : 'Commit'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

