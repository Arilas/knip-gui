// Sidebar-footer chrome (Task 1, UX overhaul): git branch + dirty dot (tooltip
// lists the dirty file count), last scan timestamp, Re-run — everything
// TopBar used to render in its trailing corner + Re-run button, now living in
// AppSidebar's <SidebarFooter>. Re-run stays disabled while useBusy() is true
// (client-side scan/sweep/apply serialization — Plan 3's carried-over
// obligation, unchanged from TopBar).
import { RefreshCw } from 'lucide-react';
import { useBusy, useGitStatus, useReport, useScanMutation } from '../../state/queries.js';
import { Button } from '../ui/button.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';

export function GitFooter() {
  const { data } = useReport();
  const { data: gitStatus } = useGitStatus();
  const scanMutation = useScanMutation();
  const busy = useBusy();

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
                title={
                  gitStatus.dirty
                    ? `${gitStatus.dirtyFiles?.length ?? 0} uncommitted file${gitStatus.dirtyFiles?.length === 1 ? '' : 's'}`
                    : 'Working tree clean'
                }
                className={`h-2 w-2 shrink-0 rounded-full ${gitStatus.dirty ? 'bg-amber-500' : 'bg-emerald-500'}`}
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              {gitStatus.dirty
                ? `${gitStatus.dirtyFiles?.length ?? 0} uncommitted file${gitStatus.dirtyFiles?.length === 1 ? '' : 's'}`
                : 'Working tree clean'}
            </TooltipContent>
          </Tooltip>
          <span className="truncate group-data-[collapsible=icon]:hidden">
            {gitStatus.branch ?? '(detached HEAD)'}
          </span>
        </div>
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
