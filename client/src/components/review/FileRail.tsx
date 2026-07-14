// Left-hand rail of the Review page (Task 3, v0.3): one row per file touched
// by the plan (lib/review.ts's buildFileRail — see ReviewPage.tsx for how its
// rows are built per step), a status icon + reason tooltip, and a click/
// Enter/Space to pick which file's diff the main area shows (ReviewPage keeps
// exactly ONE diff visible at a time — see the design brief's "no giant
// scroll wall" requirement — rather than ActionModal's old stacked-diffs
// list). Virtualized (TanStack Virtual, same library/pattern as Dashboard.tsx's
// workspace table) once the rail exceeds VIRTUALIZE_THRESHOLD rows; below
// that, a plain mapped list is simpler and just as fast.
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertOctagon, AlertTriangle, CheckCircle2, Circle, FileQuestion, XCircle } from 'lucide-react';
import type { ComponentType } from 'react';
import type { FileRailRow, RailStatus } from '../../lib/review.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js';

export interface FileRailProps {
  rows: FileRailRow[];
  selectedFilePath: string | null;
  onSelect: (filePath: string) => void;
}

const ROW_HEIGHT = 32;
const VIRTUALIZE_THRESHOLD = 100;

const STATUS_ICON: Record<RailStatus, ComponentType<{ className?: string }>> = {
  pending: Circle,
  ok: CheckCircle2,
  stale: AlertTriangle,
  missing: FileQuestion,
  'io-error': XCircle,
  'compile-failed': AlertOctagon,
};

const STATUS_CLASS: Record<RailStatus, string> = {
  pending: 'text-muted-foreground',
  ok: 'text-green-600 dark:text-green-500',
  stale: 'text-amber-600 dark:text-amber-500',
  missing: 'text-amber-600 dark:text-amber-500',
  'io-error': 'text-destructive',
  'compile-failed': 'text-destructive',
};

const STATUS_LABEL: Record<RailStatus, string> = {
  pending: 'pending',
  ok: 'applied ok',
  stale: 'stale',
  missing: 'missing',
  'io-error': 'I/O error',
  'compile-failed': 'compile failed',
};

function RailRow({
  row,
  active,
  onSelect,
}: {
  row: FileRailRow;
  active: boolean;
  onSelect: (filePath: string) => void;
}) {
  const Icon = STATUS_ICON[row.status];
  const icon = <Icon className={`size-3.5 shrink-0 ${STATUS_CLASS[row.status]}`} aria-hidden />;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      data-testid={`review-rail-row-${row.filePath}`}
      onClick={() => onSelect(row.filePath)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(row.filePath);
        }
      }}
      className={`flex h-8 shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-sm px-2 text-xs outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring ${
        active ? 'bg-muted font-medium' : ''
      }`}
    >
      {row.reason ? (
        <Tooltip>
          <TooltipTrigger asChild>{icon}</TooltipTrigger>
          <TooltipContent>{row.reason}</TooltipContent>
        </Tooltip>
      ) : (
        icon
      )}
      <span className="min-w-0 flex-1 truncate font-mono" title={row.filePath}>
        {row.filePath}
      </span>
      <span className="sr-only">{STATUS_LABEL[row.status]}</span>
    </div>
  );
}

export function FileRail({ rows, selectedFilePath, onSelect }: FileRailProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  if (rows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-3 text-center text-xs text-muted-foreground">
        No files yet.
      </div>
    );
  }

  if (!shouldVirtualize) {
    return (
      <div ref={parentRef} data-testid="review-rail" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1">
        {rows.map((row) => (
          <RailRow key={row.filePath} row={row} active={row.filePath === selectedFilePath} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div ref={parentRef} data-testid="review-rail" className="min-h-0 flex-1 overflow-y-auto p-1">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualItems.map((item) => {
          const row = rows[item.index]!;
          return (
            <div
              key={row.filePath}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: item.size,
                transform: `translateY(${item.start}px)`,
              }}
            >
              <RailRow row={row} active={row.filePath === selectedFilePath} onSelect={onSelect} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
