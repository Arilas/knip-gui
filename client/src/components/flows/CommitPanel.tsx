// Post-apply commit step inside ActionModal (Task 5), shown only when
// gitStatus.isRepo. `paths` are the applied-ok files ONLY (the caller derives
// these from joinResults' 'ok' rows) — never the full diff list, so a
// stale/missing/io-error/compile-failed file never gets staged under a
// message that claims it was fixed.
//
// Moved from components/ to components/flows/ (Task 6, UX overhaul), and its
// toast calls swapped from the hand-rolled Toast.tsx (deleted this task) to
// sonner's toast.error/success — same call sites, same messages.
import { useState } from 'react';
import { toast } from 'sonner';
import { apiErrorMessage } from '../../api.js';
import { defaultBranchName } from '../../lib/apply-flow.js';
import { useActivityStore } from '../../state/activity.js';
import { useGitBranchMutation, useGitCommitMutation, useGitStatus } from '../../state/queries.js';

export interface CommitPanelProps {
  /** Applied-ok file paths only — see module doc comment. */
  paths: string[];
  defaultMessage: string;
  onDone: () => void;
}

export function CommitPanel({ paths, defaultMessage, onDone }: CommitPanelProps) {
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
  // Only warn about dirty files that AREN'T part of this fix — the fixed
  // files themselves are expected to show up as dirty (applyPatches writes
  // straight to disk, not through git), so `status.dirty` alone would warn on
  // every single successful fix even when there's nothing else going on.
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
    <div className="flex flex-col gap-3 border-t border-gray-200 p-4 dark:border-gray-800">
      <h3 className="text-sm font-semibold">Commit changes</h3>

      {otherDirtyFiles.length > 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          Your working tree also has {otherDirtyFiles.length} other uncommitted change(s) — only the{' '}
          {paths.length} file(s) just fixed will be staged and committed.
        </p>
      )}

      {sha ? (
        <div
          data-testid="commit-sha"
          className="rounded border border-green-300 bg-green-50 px-2 py-2 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-100"
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
            <input
              type="text"
              value={branchName}
              disabled={busy}
              onChange={(e) => setBranchName(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
              aria-label="New branch name"
            />
          )}
          <textarea
            value={message}
            disabled={busy}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            className="rounded border border-gray-300 px-2 py-1 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
            aria-label="Commit message"
          />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {paths.length} file(s): {paths.join(', ')}
          </p>
          {commitError && (
            <p className="rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
              {commitError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onDone}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs dark:border-gray-700"
            >
              Skip
            </button>
            <button
              type="button"
              disabled={busy || !message.trim() || paths.length === 0}
              onClick={handleCommit}
              className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
            >
              {busy ? 'Committing…' : 'Commit'}
            </button>
          </div>
        </>
      )}

      {sha && (
        <div className="flex justify-end">
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
