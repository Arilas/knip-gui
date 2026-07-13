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
import { Check, ChevronsUpDown, FolderGit2 } from 'lucide-react';
import type { Issue } from '../../../../src/core/types.js';
import { cn } from '../../lib/utils.js';
import { useBusy, useReport, useScanMutation } from '../../state/queries.js';
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
  const { data } = useReport();
  const scanMutation = useScanMutation();
  const busy = useBusy();

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

  function select(value: string) {
    setOpen(false);
    if (value === currentScope) return;
    scanMutation.mutate(value === ALL_WORKSPACES ? undefined : value);
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
          disabled={busy}
          title={current?.label}
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
    </Popover>
  );
}
