// Global command palette (Task P, #25): ⌘K/Ctrl+K, mounted once in
// router.tsx's RootLayout alongside useGlobalShortcuts (which owns
// open/onOpenChange — see that hook's doc comment for why it lives there and
// not App.tsx). Four groups:
//   - Pages: the five sidebar destinations.
//   - Files: every distinct issue.filePath in the current report, opened the
//     same way a tree-row click does (bumpOpenFileNonce + the `file` search
//     param — see CodePage.tsx's onOpenFile).
//   - Workspaces: identical semantics to the sidebar WorkspaceSwitcher,
//     via the SAME useWorkspaceSwitch hook (including its discard-selection
//     confirm and busy/reviewing gate) — see hooks/use-workspace-switch.ts.
//   - Actions: Re-run scan (same gate as GitFooter's Re-run) plus, only on
//     /code or /packages, one "Toggle filter: <type>" item per chip on that
//     page, reusing ui.ts's toggle setters and lib/filters.ts's type lists.
// Disabled items (busy/reviewing) render disabled with a `title` reason
// rather than being hidden, and every action closes the palette.
import { useMemo } from 'react';
import { useCommandState } from 'cmdk';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Check, EyeOff, FileCode2, Filter, History, LayoutDashboard, Package, RefreshCw } from 'lucide-react';
import { ALL_WORKSPACES, useWorkspaceSwitch } from '../hooks/use-workspace-switch.js';
import { CODE_TYPES, PACKAGE_TYPES, typeLabel } from '../lib/filters.js';
import { cn } from '../lib/utils.js';
import { useBusy, useReport, useScanMutation } from '../state/queries.js';
import { useUiStore } from '../state/ui.js';
import { WorkspaceSwitchConfirmDialog } from './app-shell/WorkspaceSwitchConfirmDialog.js';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from './ui/command.js';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PAGES = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/code', label: 'Code', icon: FileCode2 },
  { to: '/packages', label: 'Packages', icon: Package },
  { to: '/ignored', label: 'Ignored', icon: EyeOff },
  { to: '/activity', label: 'Activity', icon: History },
] as const satisfies ReadonlyArray<{ to: string; label: string; icon: typeof LayoutDashboard }>;

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { data } = useReport();
  const navigate = useNavigate();
  const busy = useBusy();
  const scanMutation = useScanMutation();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const reviewing = pathname === '/review';

  const codeFilters = useUiStore((s) => s.codeFilters);
  const packagesFilters = useUiStore((s) => s.packagesFilters);
  const toggleCodeFilter = useUiStore((s) => s.toggleCodeFilter);
  const togglePackagesFilter = useUiStore((s) => s.togglePackagesFilter);
  const bumpOpenFileNonce = useUiStore((s) => s.bumpOpenFileNonce);

  const report = data?.report;
  const issues = report?.issues ?? [];
  const workspaces = report?.workspaces ?? [ALL_WORKSPACES];

  const filePaths = useMemo(() => {
    const seen = new Set<string>();
    for (const issue of issues) seen.add(issue.filePath);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [issues]);

  const workspaceSwitch = useWorkspaceSwitch(workspaces, issues);

  function close() {
    onOpenChange(false);
  }

  function goTo(to: (typeof PAGES)[number]['to']) {
    navigate({ to });
    close();
  }

  function openFile(path: string) {
    // Same open-file contract as CodePage's tree-row click (CodePage.tsx's
    // onOpenFile): bump the nonce on every explicit open so CodePane's
    // scroll/pulse re-fires even when re-opening the already-open file.
    bumpOpenFileNonce();
    navigate({ to: '/code', search: (prev) => ({ ...prev, file: path }) });
    close();
  }

  function selectWorkspace(value: string) {
    // May only set pendingScope (discard-selection confirm) rather than
    // switch immediately — either way the palette itself is done with this
    // interaction; the shared AlertDialog below takes over if needed.
    workspaceSwitch.select(value);
    close();
  }

  function rerun() {
    if (busy || reviewing) return;
    scanMutation.mutate(report?.scope);
    close();
  }

  const pageFilterTypes = pathname === '/code' ? CODE_TYPES : pathname === '/packages' ? PACKAGE_TYPES : null;
  const activeFilters = pathname === '/code' ? codeFilters : packagesFilters;
  const toggleFilter = pathname === '/code' ? toggleCodeFilter : togglePackagesFilter;

  const rerunTitle = busy ? 'A scan is already running' : reviewing ? 'Finish or cancel the review first' : undefined;
  const workspaceItemTitle = workspaceSwitch.busy
    ? 'A scan is already running'
    : workspaceSwitch.reviewing
      ? 'Finish or cancel the review first'
      : undefined;

  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange}>
        <CommandInput placeholder="Search pages, files, workspaces, actions…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Pages">
            {PAGES.map((page, index) => (
              <CommandItem key={page.to} value={page.label} onSelect={() => goTo(page.to)}>
                <page.icon className="size-4" />
                <span>{page.label}</span>
                <CommandShortcut>{index + 1}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>

          <FilesGroup filePaths={filePaths} onOpenFile={openFile} />

          <CommandGroup heading="Workspaces">
            {workspaceSwitch.entries.map((entry) => (
              <CommandItem
                key={entry.value}
                value={entry.label}
                disabled={workspaceSwitch.busy || workspaceSwitch.reviewing}
                title={workspaceItemTitle}
                onSelect={() => selectWorkspace(entry.value)}
              >
                <Check
                  className={cn('size-4', entry.value === workspaceSwitch.currentScope ? 'opacity-100' : 'opacity-0')}
                />
                <span className="flex-1 truncate">{entry.label}</span>
                <span className="ml-2 text-xs tabular-nums text-muted-foreground">{entry.count}</span>
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup heading="Actions">
            <CommandItem value="Re-run scan" disabled={busy || reviewing} title={rerunTitle} onSelect={rerun}>
              <RefreshCw className={busy ? 'size-4 animate-spin' : 'size-4'} />
              <span>Re-run scan</span>
              <CommandShortcut>R</CommandShortcut>
            </CommandItem>
            {pageFilterTypes?.map((type) => (
              <CommandItem
                key={type}
                value={`Toggle filter: ${typeLabel(type)}`}
                onSelect={() => {
                  toggleFilter(type);
                  close();
                }}
              >
                <Filter className="size-4" />
                <Check className={cn('size-4', activeFilters.has(type) ? 'opacity-100' : 'opacity-0')} />
                <span>Toggle filter: {typeLabel(type)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      <WorkspaceSwitchConfirmDialog
        pendingScope={workspaceSwitch.pendingScope}
        selectionCount={workspaceSwitch.selectionCount}
        onCancel={workspaceSwitch.cancelSwitch}
        onConfirm={workspaceSwitch.confirmSwitch}
      />
    </>
  );
}

// Mounted-item cap for the Files group (#38): cmdk mounts a live
// CommandItem per rendered child and re-scores every one per keystroke —
// fine for pages/workspaces/actions (a handful), but 3–6k distinct file
// paths made ⌘K-open and each keystroke pay hundreds of ms. Below the
// cap nothing changes: every path mounts and cmdk's own fuzzy filter
// ranks them exactly as before (command-palette.spec.ts's small-fixture
// flow is byte-identical). Above it, a substring pre-limit over the FULL
// path list picks at most FILE_RESULTS_CAP items to mount — searching
// the whole list, not the capped slice, so a path outside the first 200
// is still reachable by typing — and cmdk then ranks those survivors (a
// substring match always scores positive under cmdk's command-score, so
// the pre-limit never hides an item the ranker would keep). Trade-off,
// accepted: above the cap, file matching is substring rather than
// cmdk's subsequence-fuzzy ('sfr' no longer hits src/forms.ts) — the
// alternative, shouldFilter={false}, is a whole-Command switch that
// would force hand-rolling matching for every OTHER group too.
const FILE_RESULTS_CAP = 200;

function FilesGroup({ filePaths, onOpenFile }: { filePaths: string[]; onOpenFile: (path: string) => void }) {
  // cmdk's live search text — this component renders inside
  // CommandDialog's <Command> wrapper (ui/command.tsx), which is the
  // context useCommandState needs. Subscribing here (rather than
  // controlling CommandInput from CommandPalette) keeps the input
  // uncontrolled, so its fresh-on-reopen behavior is untouched.
  const search = useCommandState((state) => state.search);
  const visiblePaths = useMemo(() => {
    if (filePaths.length <= FILE_RESULTS_CAP) return filePaths;
    const needle = search.trim().toLowerCase();
    if (!needle) return filePaths.slice(0, FILE_RESULTS_CAP);
    const out: string[] = [];
    for (const path of filePaths) {
      if (path.toLowerCase().includes(needle)) {
        out.push(path);
        if (out.length === FILE_RESULTS_CAP) break;
      }
    }
    return out;
  }, [filePaths, search]);

  if (visiblePaths.length === 0) return null;
  return (
    <CommandGroup heading="Files">
      {visiblePaths.map((path) => (
        <CommandItem key={path} value={path} onSelect={() => onOpenFile(path)}>
          <FileCode2 className="size-4" />
          <span className="truncate">{path}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
