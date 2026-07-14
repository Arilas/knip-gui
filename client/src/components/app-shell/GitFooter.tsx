// Sidebar-footer chrome (Task 1, UX overhaul): git branch + dirty dot (tooltip
// lists the dirty file count), last scan timestamp, Re-run — everything
// TopBar used to render in its trailing corner + Re-run button, now living in
// AppSidebar's <SidebarFooter>. Re-run stays disabled while useBusy() is true
// (client-side scan/sweep/apply serialization — Plan 3's carried-over
// obligation, unchanged from TopBar).
//
// Task 5 (v0.3 papercuts) adds the "N uncommitted" button: a commit
// affordance reachable from anywhere in the app, not just right after
// applying a fix/ignore (that's the Review page's docked CommitBar) — opens
// CommitDialog, which checklists the actual dirty files.
import { GitCommitVertical, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useBusy, useGitStatus, useReport, useScanMutation } from '../../state/queries.js';
import { CommitDialog } from '../flows/CommitDialog.js';
import { Button } from '../ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';

export function GitFooter() {
  const { data } = useReport();
  const { data: gitStatus } = useGitStatus();
  const scanMutation = useScanMutation();
  const busy = useBusy();
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const dirtyCount = gitStatus?.dirtyFiles?.length ?? 0;

  const report = data?.report;
  const currentScope = report?.scope;

  return (
    <div className="flex flex-col gap-2 group-data-[collapsible=icon]:items-center">
      {gitStatus?.isRepo && (
        <div className="flex items-center gap-1.5 px-1 text-xs text-sidebar-foreground/80">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid="git-dirty-dot"
                title={gitStatus.dirty ? `${dirtyCount} uncommitted file${dirtyCount === 1 ? '' : 's'}` : 'Working tree clean'}
                className={`h-2 w-2 shrink-0 rounded-full ${gitStatus.dirty ? 'bg-amber-500' : 'bg-emerald-500'}`}
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              {gitStatus.dirty ? `${dirtyCount} uncommitted file${dirtyCount === 1 ? '' : 's'}` : 'Working tree clean'}
            </TooltipContent>
          </Tooltip>
          <span className="truncate group-data-[collapsible=icon]:hidden">
            {gitStatus.branch ?? '(detached HEAD)'}
          </span>
        </div>
      )}

      {gitStatus?.isRepo && gitStatus.dirty && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="git-commit-button"
            onClick={() => setCommitDialogOpen(true)}
            className="w-full justify-center group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
          >
            <GitCommitVertical className="size-4" />
            <span className="group-data-[collapsible=icon]:hidden">
              {dirtyCount} uncommitted file{dirtyCount === 1 ? '' : 's'}
            </span>
          </Button>
          <CommitDialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen} />
        </>
      )}

      {report?.scannedAt && (
        <span className="px-1 text-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden">
          Scanned {new Date(report.scannedAt).toLocaleTimeString()}
        </span>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="rerun-button"
        disabled={busy}
        onClick={() => scanMutation.mutate(currentScope)}
        className="w-full justify-center group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
      >
        <RefreshCw className={busy ? 'size-4 animate-spin' : 'size-4'} />
        <span className="group-data-[collapsible=icon]:hidden">{busy ? 'Scanning…' : 'Re-run'}</span>
      </Button>
    </div>
  );
}
