// Sticky bottom cart summary (design spec's "Selection bar" bullet): visible
// only once something's selected, showing summaryByType + Ignore/Fix…/Clear.
// onOpenModal is a Task 5 stub (ActionModal doesn't exist yet) — the busy
// disabling here is real (useBusy(), the client-side scan/sweep/apply
// serialization from Plan 3's carried-over obligations), even though the
// modal wiring isn't.
import type { Issue } from '../../../src/core/types.js';
import { summaryByType, useSelectionStore } from '../state/selection.js';
import { useBusy } from '../state/queries.js';

export interface SelectionBarProps {
  issues: Issue[];
  onOpenModal: (mode: 'fix' | 'ignore') => void;
}

export function SelectionBar({ issues, onOpenModal }: SelectionBarProps) {
  const selected = useSelectionStore((s) => s.selected);
  const clear = useSelectionStore((s) => s.clear);
  const busy = useBusy();

  if (selected.size === 0) return null;

  const summary = summaryByType({ selected }, issues);

  return (
    <div
      data-testid="selection-bar"
      className="fixed inset-x-0 bottom-0 z-10 flex items-center gap-3 border-t border-gray-200 bg-white px-4 py-2 shadow-[0_-1px_8px_rgba(0,0,0,0.08)] dark:border-gray-800 dark:bg-gray-950"
    >
      <span data-testid="selection-count" className="text-sm font-semibold">
        {selected.size} selected
      </span>
      {summary && <span className="text-xs text-gray-600 dark:text-gray-400">{summary}</span>}

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => clear()}
          className="rounded border border-gray-300 px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700"
        >
          Clear
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onOpenModal('ignore')}
          className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700"
        >
          Ignore
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onOpenModal('fix')}
          className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
        >
          Fix…
        </button>
      </div>
    </div>
  );
}
