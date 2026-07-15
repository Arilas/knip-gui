// Sidebar-header workspace combobox (Task 1, UX overhaul): replaces TopBar's
// old native `<select>` (design spec: "Native workspace `<select>` unusable at
// 200 entries"). Entries are "All workspaces" (pinned first) + report
// .workspaces sorted alphabetically, each with a right-aligned issue count;
// the search input filters via cmdk's own value-matching. Selecting a
// workspace calls the existing scoped-scan mutation (`postScan(workspace)`,
// unchanged semantics from TopBar). Collapses to an icon-only trigger when
// the sidebar is in icon-rail mode (`group-data-[collapsible=icon]:` — same
// pattern the rest of the shadcn sidebar chrome uses to hide its own labels).
import { useMemo, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Check, ChevronsUpDown, FolderGit2 } from 'lucide-react';
import type { Issue } from '../../../../src/core/types.js';
import { cn } from '../../lib/utils.js';
import { pluralizeWord } from '../../lib/pluralize.js';
import { useBusy, useReport, useScanMutation } from '../../state/queries.js';
import { useSelectionStore } from '../../state/selection.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog.js';
import { Button } from '../ui/button.js';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command.js';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js';

// The scope value meaning "the whole project" — matches Report.scope's own
// convention (absent/'.' = unscoped) and TopBar's old `<option value=".">`.
const ALL_WORKSPACES = '.';

export interface WorkspaceSwitcherProps {
  workspaces: string[];
  issues: Issue[];
}

interface Entry {
  value: string;
  label: string;
  count: number;
}

export function WorkspaceSwitcher({ workspaces, issues }: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  // Target scope of a switch awaiting confirmation because it would discard a
  // non-empty selection (the rescan prunes out-of-scope ids). null = no prompt.
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const { data } = useReport();
  const scanMutation = useScanMutation();
  const navigate = useNavigate();
  const busy = useBusy();
  const selectionCount = useSelectionStore((s) => s.selected.size);
  // Never let a scoped rescan land while the Review page is open — it prunes the
  // selection under a frozen "Fix N issues" title and can leave a compiled plan
  // pointing at a report that no longer matches.
  const reviewing = useRouterState({ select: (s) => s.location.pathname === '/review' });

  const currentScope = data?.report?.scope ?? ALL_WORKSPACES;

  const entries = useMemo<Entry[]>(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) counts.set(issue.workspace, (counts.get(issue.workspace) ?? 0) + 1);
    const rest = workspaces
      .filter((ws) => ws !== ALL_WORKSPACES)
      .sort((a, b) => a.localeCompare(b))
      .map((ws) => ({ value: ws, label: ws, count: counts.get(ws) ?? 0 }));
    return [{ value: ALL_WORKSPACES, label: 'All workspaces', count: issues.length }, ...rest];
  }, [workspaces, issues]);

  const current = entries.find((e) => e.value === currentScope) ?? entries[0];

  function runSwitch(value: string) {
    const ws = value === ALL_WORKSPACES ? undefined : value;
    // Mirror the new scope into the URL (All/'.' removes the param) so a
    // reload/bookmark restores it via the root's boot hydration. `replace` (not
    // push): `ws` is derived state mirrored to the URL, not a distinct history
    // stop — the root's reconcile effect keeps the two in sync one way per
    // phase (see router.tsx), so a pushed entry would only get snapped back.
    navigate({ to: '.', search: (prev) => ({ ...prev, ws }), replace: true });
    scanMutation.mutate(ws);
  }

  function select(value: string) {
    setOpen(false);
    if (value === currentScope) return;
    // A scope change rescans, which prunes any selected issues outside the new
    // scope — warn before silently discarding a non-empty cart.
    if (selectionCount > 0) {
      setPendingScope(value);
      return;
    }
    runSwitch(value);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Switch workspace"
          data-testid="workspace-switcher"
          disabled={busy || reviewing}
          title={reviewing ? 'Finish or cancel the review first' : current?.label}
          className="w-full justify-between group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
        >
          <span className="flex min-w-0 items-center gap-2">
            <FolderGit2 className="size-4 shrink-0" />
            <span className="truncate group-data-[collapsible=icon]:hidden">
              {current?.label ?? 'All workspaces'}
            </span>
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50 group-data-[collapsible=icon]:hidden" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search workspaces…" />
          <CommandList>
            <CommandEmpty>No workspace found.</CommandEmpty>
            <CommandGroup>
              {entries.map((entry) => (
                <CommandItem
                  key={entry.value}
                  value={entry.label}
                  data-testid={`workspace-option-${entry.value}`}
                  onSelect={() => select(entry.value)}
                >
                  <Check className={cn('size-4', entry.value === currentScope ? 'opacity-100' : 'opacity-0')} />
                  <span className="flex-1 truncate">{entry.label}</span>
                  <span className="ml-2 text-xs tabular-nums text-muted-foreground">{entry.count}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>

      <AlertDialog open={pendingScope !== null} onOpenChange={(next) => !next && setPendingScope(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              You have {pluralizeWord(selectionCount, 'issue')} selected. Switching workspaces
              re-scans and clears any selection outside the new scope.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingScope(null)}>Keep selection</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingScope !== null) runSwitch(pendingScope);
                setPendingScope(null);
              }}
            >
              Switch anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Popover>
  );
}
