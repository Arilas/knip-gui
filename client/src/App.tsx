import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IssueType } from '../../src/core/types.js';
import { ActionModal } from './components/ActionModal.js';
import { AppSidebar } from './components/app-shell/AppSidebar.js';
import { CodePane } from './components/CodePane.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Overview } from './components/Overview.js';
import { SelectionBar } from './components/SelectionBar.js';
import { TableView } from './components/TableView.js';
import { ToastProvider } from './components/Toast.js';
import { TreeView } from './components/TreeView.js';
import { SidebarInset, SidebarProvider, SidebarTrigger } from './components/ui/sidebar.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { issuesForFacet } from './lib/facets.js';
import { useReport } from './state/queries.js';
import { useSelectionStore } from './state/selection.js';
import { useUiStore } from './state/ui.js';

// Task 1 (UX overhaul) shim: the "Packages" nav item's real grouped-table
// rebuild is Task 4's job (see docs/superpowers/plans/2026-07-14-ux-overhaul.md).
// Until then this reuses the pre-existing TableView + the same dependency-
// shaped IssueTypes the old FacetRail's dependencies/unlisted/unresolved/
// binaries facets covered, purely so the app (and ignore.spec.ts's left-pad
// flow, which lives here) stay usable — same rationale as keeping the Code
// page's TreeView/CodePane below.
const PACKAGES_PREVIEW_TYPES: ReadonlySet<IssueType> = new Set([
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'binaries',
  'unresolved',
]);

const queryClient = new QueryClient();

function AppShell() {
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<'fix' | 'ignore' | null>(null);
  const { data, isLoading, error } = useReport();
  const page = useUiStore((s) => s.page);

  const selected = useSelectionStore((s) => s.selected);
  const toggle = useSelectionStore((s) => s.toggle);
  const pruneMissing = useSelectionStore((s) => s.pruneMissing);

  const report = data?.report;
  const issues = report?.issues ?? [];
  const workspaces = report?.workspaces ?? ['.'];

  // Task 5's apply-flow obligation: whenever a fresh report lands (the
  // post-apply background rescan, a manual re-run, a sweep — any of them),
  // drop any selected/mode-overridden ids the new report no longer contains,
  // so the cart never shows a stale count for an issue that's already gone.
  // Keyed on scannedAt (not the `report` object reference, which changes on
  // every poll) so this only runs once per actual new scan.
  useEffect(() => {
    if (!report) return;
    pruneMissing(report.issues.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.scannedAt]);

  function onOpenModal(mode: 'fix' | 'ignore') {
    setModalMode(mode);
  }

  function renderPage() {
    if (isLoading) return <p className="p-4 text-sm text-muted-foreground">Loading report…</p>;
    if (error) {
      return (
        <p className="p-4 text-sm text-destructive">
          Failed to load the report: {error instanceof Error ? error.message : String(error)}
        </p>
      );
    }
    if (data?.status === 'error') {
      return <p className="p-4 text-sm text-destructive">{data.error?.message ?? 'The last scan failed.'}</p>;
    }

    switch (page) {
      case 'dashboard':
        return <Overview issues={issues} workspaces={workspaces} />;
      case 'code':
        return (
          <div className="flex flex-1 overflow-hidden">
            <div className="flex flex-1 flex-col overflow-hidden">
              <TreeView
                issues={issuesForFacet('tree', issues)}
                selected={selected}
                onToggleIds={toggle}
                onOpenFile={setOpenFilePath}
              />
            </div>
            <aside className="flex w-96 shrink-0 flex-col overflow-hidden border-l border-border">
              {openFilePath && (
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="truncate font-mono text-xs" title={openFilePath}>
                    {openFilePath}
                  </span>
                  <button
                    type="button"
                    onClick={() => setOpenFilePath(null)}
                    aria-label="Close file panel"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    ✕
                  </button>
                </div>
              )}
              <CodePane
                filePath={openFilePath}
                issues={openFilePath ? issues.filter((i) => i.filePath === openFilePath) : []}
                selected={selected}
                onToggleIds={toggle}
              />
            </aside>
          </div>
        );
      case 'packages':
        return (
          <TableView
            issues={issues.filter((i) => PACKAGES_PREVIEW_TYPES.has(i.type))}
            selected={selected}
            onToggleIds={toggle}
          />
        );
      case 'ignored':
        return (
          <div className="p-4 text-sm text-muted-foreground">
            Ignored — coming in Task 5 (server-backed ignore-entry listing + removal).
          </div>
        );
      case 'activity':
        return (
          <div className="p-4 text-sm text-muted-foreground">
            Activity — coming in Task 5 (session-local apply/ignore/sweep/commit log).
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <SidebarProvider>
      <AppSidebar issues={issues} workspaces={workspaces} />
      <SidebarInset className="overflow-hidden">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <SidebarTrigger data-testid="sidebar-trigger" />
          <h1 className="text-sm font-semibold capitalize">{page}</h1>
        </header>
        <div className="flex flex-1 flex-col overflow-hidden pb-12">{renderPage()}</div>
      </SidebarInset>

      <SelectionBar issues={issues} onOpenModal={onOpenModal} />

      {modalMode && <ActionModal mode={modalMode} issues={issues} onClose={() => setModalMode(null)} />}
    </SidebarProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ToastProvider>
            <AppShell />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
