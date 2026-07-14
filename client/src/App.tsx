import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { ApiError, setOnUnauthorized } from './api.js';
import { AppSidebar } from './components/app-shell/AppSidebar.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ActionModal } from './components/flows/ActionModal.js';
import { ActivityPage } from './components/pages/ActivityPage.js';
import { CodePage } from './components/pages/CodePage.js';
import { Dashboard } from './components/pages/Dashboard.js';
import { IgnoredPage } from './components/pages/IgnoredPage.js';
import { PackagesPage } from './components/pages/PackagesPage.js';
import { SetupScreen } from './components/pages/SetupScreen.js';
import { Button } from './components/ui/button.js';
import { SidebarInset, SidebarProvider, SidebarTrigger } from './components/ui/sidebar.js';
import { Toaster } from './components/ui/sonner.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { useReport } from './state/queries.js';
import { useSelectionStore } from './state/selection.js';
import { useUiStore } from './state/ui.js';

// A knip-not-found error means knip can't even be resolved from this project;
// a knip-failed error with exitCode >= 2 means knip itself exited fatally
// (bad/missing config, or some other non-"issues found" failure — see
// src/core/knip-runner.ts's runScan, which only rejects at exitCode >= 2).
// Either way there's no report to show and no amount of retrying without
// fixing the project will help — SetupScreen replaces the page body instead.
// A `bad-json`/`internal` error, or a knip-failed with exitCode < 2 (there
// isn't one today, but nothing rules it out), falls through to the plain
// error message below instead — those aren't "go fix your knip setup"
// problems in the same way.
function isSetupError(error: { code: string; exitCode?: number } | undefined): boolean {
  if (!error) return false;
  if (error.code === 'knip-not-found') return true;
  return error.code === 'knip-failed' && (error.exitCode ?? 0) >= 2;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Never retry a 401 (Task 6 review fix, root-caused live): the token is
      // baked into the served page, so a 401 can't heal without a reload —
      // and retrying it is what softlocked Re-run against a restarted server.
      // The chain: scanMutation 401s -> its onSettled returns
      // invalidateQueries(report) -> react-query awaits the report REFETCH,
      // which also 401s -> the query retryer schedules retries gated on
      // `focusManager.isFocused()` (see @tanstack/query-core retryer.ts:
      // `sleep(delay).then(() => canContinue() ? undefined : pause())`) -> the
      // moment the tab is hidden/unfocused (e.g. the user switching to the
      // terminal to find the new URL — the exact stale-token scenario) the
      // retryer pauses INDEFINITELY -> the refetch promise never settles ->
      // Mutation.execute awaits options.onSettled BEFORE dispatching its
      // final state (query-core mutation.ts) -> isPending stays true forever.
      // Failing fast on 401 unblocks that await; the setOnUnauthorized hook
      // below then replaces the UI outright, making the whole state
      // unreachable regardless.
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status === 401) && failureCount < 3,
    },
  },
});

// Full-screen replacement for the entire app once any API response comes back
// 401 (see api.ts's setOnUnauthorized doc comment): the session token is dead
// and only a reload can mint a page with the new one, so there's nothing any
// individual page could usefully render — including the sidebar, whose badges
// are themselves query-backed.
function SessionExpiredScreen() {
  return (
    <div
      data-testid="session-expired"
      className="flex h-svh flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground"
    >
      <KeyRound className="size-8 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-lg font-semibold">Session expired</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        knip-gui was restarted. Reload this page after checking the terminal for the new URL.
      </p>
      <Button type="button" onClick={() => location.reload()}>
        Reload
      </Button>
    </div>
  );
}

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
    // Ignored/Activity are never report-dependent (their own server
    // query / session store, respectively — see AppSidebar.tsx's doc
    // comment), so they render normally regardless of report/scan state,
    // including the setup-error state below: the sidebar stays reachable and
    // useful even while Dashboard/Code/Packages can't show anything.
    if (page === 'ignored') return <IgnoredPage />;
    if (page === 'activity') return <ActivityPage />;

    if (isLoading) return <p className="p-4 text-sm text-muted-foreground">Loading report…</p>;
    if (error) {
      return (
        <p className="p-4 text-sm text-destructive">
          Failed to load the report: {error instanceof Error ? error.message : String(error)}
        </p>
      );
    }
    if (data?.status === 'error' && isSetupError(data.error)) {
      return <SetupScreen error={data.error!} />;
    }
    if (data?.status === 'error') {
      return <p className="p-4 text-sm text-destructive">{data.error?.message ?? 'The last scan failed.'}</p>;
    }

    switch (page) {
      case 'dashboard':
        return <Dashboard />;
      case 'code':
        return <CodePage issues={issues} onOpenModal={onOpenModal} />;
      case 'packages':
        return <PackagesPage issues={issues} onOpenModal={onOpenModal} />;
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{renderPage()}</div>
      </SidebarInset>

      {modalMode && <ActionModal mode={modalMode} issues={issues} onClose={() => setModalMode(null)} />}
    </SidebarProvider>
  );
}

export default function App() {
  const [sessionExpired, setSessionExpired] = useState(false);

  // Registered once for the app's lifetime; fires on the first (and any
  // subsequent — setState(true) is idempotent) 401 from any api.ts call.
  useEffect(() => {
    setOnUnauthorized(() => setSessionExpired(true));
    return () => setOnUnauthorized(undefined);
  }, []);

  // Early return BEFORE the providers: unmounting QueryClientProvider's whole
  // subtree drops every query observer, so nothing keeps polling the dead
  // session — the only remaining action is the Reload button.
  if (sessionExpired) return <SessionExpiredScreen />;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AppShell />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
