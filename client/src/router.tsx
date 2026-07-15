// TanStack Router route tree + router instance (Task R, #14). Replaces the old
// zustand `page` switch that lived in App.tsx's AppShell: the active page and
// the open Code file now live in the URL (pathname + `/code`'s `file` search
// param), so a reload/deep-link/bookmark restores exactly where the user was
// and browser Back/Forward move between pages.
//
// Shape (code-based, no file-based routing, no Vite plugin, no loaders —
// react-query owns all data fetching):
//   root  ── the layout: SidebarProvider + AppSidebar + header + <Outlet/>,
//   │        plus the workspace `ws` search param (validated here, retained
//   │        across every navigation by the retainSearchParams middleware) and
//   │        the one-shot ws boot-hydration / scope-reconcile effects.
//   ├─ _report (pathless layout) ── renders the report gate (loading / error /
//   │   │        SetupScreen / scanning) around its own <Outlet/>; only the
//   │   │        report-derived pages sit under it.
//   │   ├─ /dashboard   (index `/` redirects here; so does not-found)
//   │   ├─ /code         ── validates the optional `file` search param
//   │   └─ /packages
//   ├─ /ignored   ── NOT report-gated (own server query), so a sibling of _report
//   ├─ /activity  ── NOT report-gated (session store), likewise
//   └─ /review    ── beforeLoad redirects to /code when no review is pending
//
// The ErrorBoundary + session-expired gate stay OUTSIDE this router (App.tsx):
// a dead session or a render crash must replace the ENTIRE tree, router chrome
// included.
import { useEffect, useRef } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  retainSearchParams,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { CommandPalette } from './components/CommandPalette.js';
import { CodePage } from './components/pages/CodePage.js';
import { Dashboard } from './components/pages/Dashboard.js';
import { ActivityPage } from './components/pages/ActivityPage.js';
import { IgnoredPage } from './components/pages/IgnoredPage.js';
import { PackagesPage } from './components/pages/PackagesPage.js';
import { ReviewPage } from './components/pages/ReviewPage.js';
import { SetupScreen } from './components/pages/SetupScreen.js';
import { AppSidebar } from './components/app-shell/AppSidebar.js';
import { SidebarInset, SidebarProvider, SidebarTrigger } from './components/ui/sidebar.js';
import { useGlobalShortcuts } from './hooks/use-global-shortcuts.js';
// ALL_WORKSPACES ('.') is the shared "whole project" scope convention —
// defined once next to the workspace-switch flow it belongs to.
import { ALL_WORKSPACES } from './hooks/use-workspace-switch.js';
import { useBusy, useReport, useScanMutation } from './state/queries.js';
import { useSelectionStore } from './state/selection.js';
import { useUiStore } from './state/ui.js';

// A knip-not-found error means knip can't even be resolved from this project; a
// knip-failed error with exitCode >= 2 means knip itself exited fatally. Either
// way there's no report to show and retrying without fixing the project won't
// help — SetupScreen replaces the page body. Everything else falls through to
// the plain error message. (Moved verbatim from App.tsx's AppShell.)
function isSetupError(error: { code: string; exitCode?: number } | undefined): boolean {
  if (!error) return false;
  if (error.code === 'knip-not-found') return true;
  return error.code === 'knip-failed' && (error.exitCode ?? 0) >= 2;
}

// Human page name for the header, derived from the pathname rather than a store
// field — "/code" -> "code", styled `capitalize` by the header. "/" never
// renders (it redirects to /dashboard) so an empty fallback is unreachable.
function pageTitleFromPath(pathname: string): string {
  return pathname.replace(/^\//, '').split('/')[0] || 'dashboard';
}

function RootLayout() {
  const { data } = useReport();
  const { ws } = rootRoute.useSearch();
  const navigate = useNavigate();
  const scanMutation = useScanMutation();
  const busy = useBusy();
  const pruneMissing = useSelectionStore((s) => s.pruneMissing);
  const pageTitle = useRouterState({ select: (s) => pageTitleFromPath(s.location.pathname) });
  // Command palette + bare shortcuts (Task P, #25) — mounted here, not
  // App.tsx, because both need live navigate()/useRouterState() from router
  // context, which only exists inside the routed tree; RootLayout is the
  // router-context equivalent of "the app root" the task called for. See
  // hooks/use-global-shortcuts.ts's doc comment for the full rationale.
  const { paletteOpen, setPaletteOpen } = useGlobalShortcuts();

  const report = data?.report;
  const issues = report?.issues ?? [];
  const workspaces = report?.workspaces ?? [ALL_WORKSPACES];

  // Apply-flow obligation (Task 5, unchanged from AppShell): whenever a fresh
  // report lands, drop selected/mode-overridden ids it no longer contains so
  // the cart never shows a stale count. Keyed on scannedAt so it runs once per
  // actual new scan, not on every poll (the `report` ref changes each poll).
  useEffect(() => {
    if (!report) return;
    pruneMissing(report.issues.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.scannedAt]);

  // --- Workspace scope <-> URL `ws`: one direction each, per phase. ---
  // The `ws` param is a MIRROR of the current report scope, written by the
  // workspace switcher (and reconciled below). It is READ to DRIVE a scan
  // exactly once, on boot, so a reload/bookmark of `?ws=foo` restores that
  // scope. After boot it never drives a scan again — mid-session the flow is
  // strictly scope(state) -> URL, so Back/Forward over `ws` can't kick off
  // surprise rescans and the two effects below never fight each other.
  const hydratedRef = useRef(false);
  // True from the moment the boot effect fires its scoped rescan until that
  // mutation settles. A REF, not a render value, on purpose: both effects run
  // in the SAME commit when the first report settles, and on that commit every
  // render snapshot (`busy`, `scanMutation.isPending`, a useIsMutating count)
  // is still the pre-mutate false — only a ref written synchronously by the
  // boot effect is visible to the reconcile effect running moments later.
  const bootRescanRef = useRef(false);

  // Boot hydration (URL -> state, exactly once). Waits for the first SETTLED
  // report (report present AND not busy — the server's initial fire-and-forget
  // scan may still be running). Then, if the URL pins a non-default scope that
  // disagrees with what actually got scanned, rescan to it. Latches
  // unconditionally either way so this can never fire a second time.
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!report || busy) return;
    hydratedRef.current = true;
    const urlWs = ws ?? ALL_WORKSPACES;
    const scope = report.scope ?? ALL_WORKSPACES;
    if (urlWs !== ALL_WORKSPACES && urlWs !== scope) {
      bootRescanRef.current = true;
      // The mutate-level onSettled fires only after the mutation fully settles
      // — and useScanMutation's hook-level onSettled (which the mutation
      // AWAITS before dispatching its final state; see queries.ts/App.tsx's
      // 401 comment for that mechanism) has refetched the report by then. So
      // the first reconcile run after this clears sees the POST-rescan scope:
      // a match on success (no-op), a genuine mismatch on failure (the URL
      // snaps back to the scope that actually exists).
      scanMutation.mutate(ws, {
        onSettled: () => {
          bootRescanRef.current = false;
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, busy, ws]);

  // Scope reconcile (state -> URL, mid-session). Once boot has settled, a
  // report whose scope disagrees with the URL (a rescan that changed scope
  // without touching the param — a sweep, an all-stale Rescan, a Re-run after
  // the scope drifted) snaps the URL to match with a `replace` (no history
  // spam). Why this can't fight the two writers that also touch scope/ws:
  //  - runSwitch (WorkspaceSwitcher) batches navigate+mutate in one handler,
  //    so by the time this effect's deps next change, either the scan is in
  //    flight (`busy` — waited out below; the mutation stays pending until
  //    the report REFETCH lands, per useScanMutation's awaited onSettled) or
  //    the fresh scope already matches the `ws` runSwitch wrote.
  //  - the boot rescan above is the one writer that fires in the SAME commit
  //    this effect first becomes eligible (hydratedRef just flipped true) —
  //    and on that commit `busy` is still the render's stale false, so the
  //    busy guard alone would let this strip `ws` here only for the boot
  //    scan's landing to re-add it (a redundant URL flap). bootRescanRef,
  //    set synchronously by the boot effect and cleared when its scan
  //    settles, closes exactly that window.
  useEffect(() => {
    if (!hydratedRef.current || bootRescanRef.current || busy || !report) return;
    const urlWs = ws ?? ALL_WORKSPACES;
    const scope = report.scope ?? ALL_WORKSPACES;
    if (scope !== urlWs) {
      navigate({
        to: '.',
        search: (prev) => ({ ...prev, ws: scope === ALL_WORKSPACES ? undefined : scope }),
        replace: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.scope, busy]);

  return (
    // h-svh + overflow-hidden cap the shell at the viewport (see the long note
    // preserved from AppShell): without the cap the page becomes the scroller
    // and every inner overflow-auto/sticky/virtualized container breaks.
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar issues={issues} workspaces={workspaces} />
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <SidebarTrigger data-testid="sidebar-trigger" />
          <h1 className="text-sm font-semibold capitalize">{pageTitle}</h1>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  );
}

// The report gate, wrapping only the report-derived pages (dashboard/code/
// packages). Ignored/Activity/Review deliberately sit OUTSIDE it — they render
// regardless of report/scan state (their own data sources) so the app stays
// useful even when a scan hasn't produced a report yet or the config is broken.
function ReportGate() {
  const { data, isLoading, error } = useReport();

  if (isLoading) {
    return (
      <p className="p-4 text-sm text-muted-foreground" role="status">
        Loading report…
      </p>
    );
  }
  if (error) {
    return (
      <p className="p-4 text-sm text-destructive" role="status">
        Failed to load the report: {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }
  if (data?.status === 'error' && isSetupError(data.error)) {
    return <SetupScreen error={data.error!} />;
  }
  if (data?.status === 'error') {
    return (
      <p className="p-4 text-sm text-destructive" role="status">
        {data.error?.message ?? 'The last scan failed.'}
      </p>
    );
  }
  // First scan hasn't produced a report yet (idle/scanning with no report).
  // Without this the pages fall through to their "no issues — knip is happy"
  // empty states and falsely report a clean project mid-scan. A rescan is
  // exempt: it keeps status 'scanning' but data.report still holds the previous
  // report, so the pages stay visible.
  if (!data?.report && (data?.status === 'scanning' || data?.status === 'idle')) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center" role="status">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-sm font-medium">Scanning your project…</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Running knip. This can take a moment on a large project.
        </p>
      </div>
    );
  }

  return <Outlet />;
}

// --- Route-component adapters: read the report (and, for code, the `file`
// search param) and hand the pages the plain props they already expect, so the
// page components stay router-agnostic where they can. ---
function CodeRouteComponent() {
  const { data } = useReport();
  const { file } = codeRoute.useSearch();
  return <CodePage issues={data?.report?.issues ?? []} file={file} />;
}

function PackagesRouteComponent() {
  const { data } = useReport();
  return <PackagesPage issues={data?.report?.issues ?? []} />;
}

function ReviewRouteComponent() {
  const { data } = useReport();
  const review = useUiStore((s) => s.review);
  // beforeLoad already redirected if no review was pending at navigation time;
  // this guards only the render between clearReview() and the navigation that
  // always accompanies it (ReviewPage's handleLeave does both).
  if (!review) return null;
  return <ReviewPage issues={data?.report?.issues ?? []} review={review} />;
}

const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>): { ws?: string } => ({
    ws: typeof search.ws === 'string' && search.ws.length > 0 ? search.ws : undefined,
  }),
  // Retain `ws` across every in-app navigation (Link, router.navigate, redirect)
  // so the scope stays pinned in the URL without every call site re-threading it.
  search: { middlewares: [retainSearchParams(['ws'])] },
  component: RootLayout,
});

// Pathless layout route: no path segment of its own, so its children keep their
// absolute paths (/dashboard, /code, /packages) — it exists only to wrap them
// in the report gate.
const reportLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'report-layout',
  component: ReportGate,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/dashboard' });
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => reportLayoutRoute,
  path: '/dashboard',
  component: Dashboard,
});

const codeRoute = createRoute({
  getParentRoute: () => reportLayoutRoute,
  path: '/code',
  validateSearch: (search: Record<string, unknown>): { file?: string } => ({
    file: typeof search.file === 'string' && search.file.length > 0 ? search.file : undefined,
  }),
  component: CodeRouteComponent,
});

const packagesRoute = createRoute({
  getParentRoute: () => reportLayoutRoute,
  path: '/packages',
  component: PackagesRouteComponent,
});

const ignoredRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ignored',
  component: IgnoredPage,
});

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  component: ActivityPage,
});

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/review',
  // Replaces App.tsx's old guard effect: `/review` is only meaningful alongside
  // a pending review request (SelectionDock sets it before navigating here). A
  // direct load/reload/stray Back to /review with no request has nothing to
  // render — bounce to Code. Reads the zustand store directly since the guard
  // is pure store state, not router data.
  beforeLoad: () => {
    if (!useUiStore.getState().review) throw redirect({ to: '/code' });
  },
  component: ReviewRouteComponent,
});

const routeTree = rootRoute.addChildren([
  reportLayoutRoute.addChildren([dashboardRoute, codeRoute, packagesRoute]),
  indexRoute,
  ignoredRoute,
  activityRoute,
  reviewRoute,
]);

// A not-found path resolves to Dashboard (matches the `/` redirect) rather than
// a dead-end screen — an unknown in-app URL is almost always a stale bookmark.
function NotFoundRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate({ to: '/dashboard', replace: true });
  }, [navigate]);
  return null;
}

export const router = createRouter({
  routeTree,
  // react-query owns data; there is nothing for the router to preload on hover.
  defaultPreload: false,
  defaultNotFoundComponent: NotFoundRedirect,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
