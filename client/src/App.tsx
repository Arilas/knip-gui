import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FacetRail } from './components/FacetRail.js';
import { Overview } from './components/Overview.js';
import { TopBar } from './components/TopBar.js';
import type { Facet } from './lib/facets.js';
import { useReport } from './state/queries.js';

const queryClient = new QueryClient();

function AppShell() {
  const [activeFacet, setActiveFacet] = useState<Facet>('overview');
  const { data, isLoading, error } = useReport();

  const report = data?.report;
  const issues = report?.issues ?? [];
  const workspaces = report?.workspaces ?? ['.'];

  return (
    <div className="flex h-screen flex-col bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <FacetRail issues={issues} activeFacet={activeFacet} onSelectFacet={setActiveFacet} />
        <main className="flex flex-1 flex-col overflow-hidden">
          {isLoading && <p className="p-4 text-sm text-gray-500 dark:text-gray-400">Loading report…</p>}
          {error && (
            <p className="p-4 text-sm text-red-600 dark:text-red-400">
              Failed to load the report: {error instanceof Error ? error.message : String(error)}
            </p>
          )}
          {!isLoading && !error && data?.status === 'error' && (
            <p className="p-4 text-sm text-red-600 dark:text-red-400">
              {data.error?.message ?? 'The last scan failed.'}
            </p>
          )}
          {!isLoading && !error && data?.status !== 'error' && activeFacet === 'overview' && (
            <Overview issues={issues} workspaces={workspaces} />
          )}
          {!isLoading && !error && data?.status !== 'error' && activeFacet !== 'overview' && (
            <div className="p-4 text-sm text-gray-500 dark:text-gray-400">
              The {activeFacet} view lands in a later task.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
