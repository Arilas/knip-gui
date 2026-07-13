// Last-resort crash barrier around the app shell. React unmounts the whole
// root on an uncaught render error with no DOM left behind — a blank white
// page, no way to recover short of a manual refresh, and no signal to the
// user that anything went wrong. This catches that instead and renders a
// minimal "reload" panel. Deliberately a plain class component (React only
// supports error boundaries via componentDidCatch/getDerivedStateFromError,
// no hook equivalent exists) and deliberately tiny — it's a safety net, not a
// feature; per-facet recovery is out of scope.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console -- last-resort diagnostic; no other reporting sink exists yet.
    console.error('knip-gui: uncaught render error', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-white p-6 text-center text-gray-900 dark:bg-gray-950 dark:text-gray-100">
        <p className="text-sm font-medium">Something went wrong.</p>
        <p className="max-w-md text-xs text-gray-500 dark:text-gray-400">{error.message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-gray-100 dark:text-gray-900"
        >
          Reload
        </button>
      </div>
    );
  }
}
