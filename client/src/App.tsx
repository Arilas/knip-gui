import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { ApiError, setOnUnauthorized } from './api.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Button } from './components/ui/button.js';
import { Toaster } from './components/ui/sonner.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { router } from './router.js';

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
  // session — the only remaining action is the Reload button. The router lives
  // INSIDE the providers below, so this (and ErrorBoundary) can replace the
  // entire routed tree, chrome included.
  if (sessionExpired) return <SessionExpiredScreen />;

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          {/* top-center (Task 3, v0.3 — sonner's own default is bottom-right):
              the Review page docks CommitBar's Commit/Skip/Done buttons at the
              real viewport bottom-right, the same corner a bottom-right toast
              would render in — a success toast landing there intercepted
              pointer events on the Done button underneath it. top-center never
              overlaps any docked bar's buttons. */}
          <Toaster position="top-center" />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
