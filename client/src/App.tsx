import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActionModal } from './components/ActionModal.js';
import { AppSidebar } from './components/app-shell/AppSidebar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ActivityPage } from './components/pages/ActivityPage.js';
import { CodePage } from './components/pages/CodePage.js';
import { Dashboard } from './components/pages/Dashboard.js';
import { IgnoredPage } from './components/pages/IgnoredPage.js';
import { PackagesPage } from './components/pages/PackagesPage.js';
import { SelectionBar } from './components/SelectionBar.js';
import { ToastProvider } from './components/Toast.js';
import { SidebarInset, SidebarProvider, SidebarTrigger } from './components/ui/sidebar.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { useReport } from './state/queries.js';
import { useSelectionStore } from './state/selection.js';
import { useUiStore } from './state/ui.js';

const queryClient = new QueryClient();

function AppShell() {
  const [modalMode, setModalMode] = useState<'fix' | 'ignore' | null>(null);
  const { data, isLoading, error } = useReport();
  const page = useUiStore((s) => s.page);

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
        return <Dashboard />;
      case 'code':
        return <CodePage issues={issues} />;
      case 'packages':
        return <PackagesPage issues={issues} />;
      case 'ignored':
        return <IgnoredPage />;
      case 'activity':
        return <ActivityPage />;
      default:
        return null;
    }
  }

  return (
    // h-svh + overflow-hidden cap the shell at the viewport. sidebar.tsx's own
    // wrapper class is only min-h-svh — a floor, not a cap — so without this
    // the wrapper grows to fit content, the PAGE becomes the scroller, and
    // every inner overflow-auto / sticky-header / virtualized container
    // silently stops working because its clientHeight === scrollHeight. With
    // the cap, each page's content area is the real scroll container; the
    // min-h-0s keep the flex chain shrinkable below content height so that
    // actually happens (flex children default to min-height:auto).
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar issues={issues} workspaces={workspaces} />
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <SidebarTrigger data-testid="sidebar-trigger" />
          <h1 className="text-sm font-semibold capitalize">{page}</h1>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-12">{renderPage()}</div>
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
