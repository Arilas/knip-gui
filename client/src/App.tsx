import { useEffect, useState } from 'react';

// Placeholder wiring check for Task 1: read the token the server injected
// into the meta tag (see client/index.html + GET / in src/server/index.ts),
// send it on a real API call, and surface success — proves the token makes
// it end-to-end from build → serve → browser → API auth. Task 2 replaces
// this with the full app shell / api.ts client.
function getToken(): string {
  return document.querySelector('meta[name="knip-gui-token"]')?.getAttribute('content') ?? '';
}

type ConnectionState = 'connecting' | 'connected' | 'error';

export default function App() {
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    const token = getToken();
    let cancelled = false;
    fetch('/api/report', { headers: { 'x-knip-gui-token': token } })
      .then((res) => {
        if (!cancelled) setState(res.ok ? 'connected' : 'error');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-white text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-3xl font-semibold">knip-gui</h1>
        <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">{state}</p>
      </div>
    </main>
  );
}
