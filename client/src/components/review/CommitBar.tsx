// Post-apply commit bar docked at the bottom of the Review page (Task 3,
// v0.3 — replaces ActionModal-era CommitPanel, which lived as a footer
// INSIDE the modal's results step). Same behavior: branch toggle w/ a
// chore/knip-cleanup-<date> prefill, a reconciled+pluralized default commit
// message (computed by ReviewPage from apply-flow.ts's appliedOkIssueIds —
// see that module's doc comment for why the commit message must reflect what
// ACTUALLY applied ok, not the frozen selection summary), a warning when the
// working tree has OTHER dirty files beyond what this fix/ignore touched,
// and a Commit -> sha-inline / Skip -> leave pair. Only rendered when
// gitStatus.isRepo (ReviewPage's concern, mirroring the old
// `isRepo ? <CommitPanel/> : <Done button>` branch).
import { useState } from 'react';
import { toast } from 'sonner';
import { apiErrorMessage } from '../../api.js';
import { defaultBranchName } from '../../lib/apply-flow.js';
import { useActivityStore } from '../../state/activity.js';
import { useGitBranchMutation, useGitCommitMutation, useGitStatus } from '../../state/queries.js';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';

export interface CommitBarProps {
  /** Applied-ok file paths only — see module doc comment. */
  paths: string[];
  defaultMessage: string;
  /** Called by both Skip (before commit) and Done (after) — both just leave the Review page. */
  onLeave: () => void;
}

export function CommitBar({ paths, defaultMessage, onLeave }: CommitBarProps) {
  const gitStatusQuery = useGitStatus();
  const branchMutation = useGitBranchMutation();
  const commitMutation = useGitCommitMutation();
  const log = useActivityStore((s) => s.log);

  const [createBranch, setCreateBranch] = useState(false);
  const [branchName, setBranchName] = useState(() => defaultBranchName());
  const [message, setMessage] = useState(defaultMessage);
  const [sha, setSha] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  const status = gitStatusQuery.data;
  const busy = branchMutation.isPending || commitMutation.isPending;
  // Only warn about dirty files that AREN'T part of this fix/ignore — the
  // touched files themselves are expected to show up as dirty (applyPatches
  // writes straight to disk, not through git).
  const pathSet = new Set(paths);
  const otherDirtyFiles = (status?.dirtyFiles ?? []).filter((f) => !pathSet.has(f));

  async function handleCommit() {
    setCommitError(null);
    try {
      if (createBranch) {
        await branchMutation.mutateAsync(branchName.trim());
      }
      const result = await commitMutation.mutateAsync({ message: message.trim(), paths });
      setSha(result.sha);
      toast.success(`Committed ${result.sha.slice(0, 7)}`);
      log({ kind: 'commit', summary: message.trim(), sha: result.sha, at: new Date().toISOString() });
    } catch (e) {
      const msg = apiErrorMessage(e);
      setCommitError(msg);
      toast.error(msg);
    }
  }

  if (!status?.isRepo) return null;

  return (
    <div data-testid="review-commit-bar" className="flex shrink-0 flex-col gap-3 border-t border-border bg-background p-3">
      {otherDirtyFiles.length > 0 && !sha && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Your working tree also has {otherDirtyFiles.length} other uncommitted change(s) — only the {paths.length}{' '}
          file(s) just applied will be staged and committed.
        </p>
      )}

      {sha ? (
        <div
          data-testid="review-commit-sha"
          className="rounded-md border border-green-300 bg-green-50 px-2 py-2 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-100"
        >
          Committed <code className="font-mono">{sha}</code>
          {createBranch && (
            <>
              {' '}
              on branch <code className="font-mono">{branchName}</code>
            </>
          )}
        </div>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={createBranch}
              disabled={busy}
              onChange={(e) => setCreateBranch(e.target.checked)}
            />
            Create a new branch first
          </label>
          {createBranch && (
            <Input
              type="text"
              value={branchName}
              disabled={busy}
              onChange={(e) => setBranchName(e.target.value)}
              className="max-w-sm font-mono text-sm"
              aria-label="New branch name"
            />
          )}
          <Textarea
            value={message}
            disabled={busy}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            className="max-w-xl font-mono text-sm"
            aria-label="Commit message"
          />
          <p className="text-xs text-muted-foreground">
            {paths.length} file(s): {paths.join(', ')}
          </p>
          {commitError && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {commitError}
            </p>
          )}
        </>
      )}

      <div className="flex justify-end gap-2">
        {sha ? (
          <Button type="button" onClick={onLeave} data-testid="review-done">
            Done
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onLeave} data-testid="review-skip">
              Skip
            </Button>
            <Button
              type="button"
              disabled={busy || !message.trim() || paths.length === 0}
              onClick={handleCommit}
              data-testid="review-commit"
            >
              {busy ? 'Committing…' : 'Commit'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
