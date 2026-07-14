// Pure formatting helpers for the Activity page (Task 5) — kept separate from
// the zustand store (state/activity.ts) so they're directly unit-testable
// without any store interaction, same split as lib/dashboard.ts vs state/ui.ts.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * "just now" / "5m ago" / "3h ago" / "2d ago", falling back to a locale date
 * string beyond a week. Session entries never realistically get that old (the
 * log clears on restart), but a paused tab or a skewed system clock shouldn't
 * render a nonsense age — a plain date reads fine as a fallback.
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  if (diff < WEEK_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  return new Date(iso).toLocaleDateString();
}
