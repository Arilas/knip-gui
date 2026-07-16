// Shiki code pane (Task 4): fetches a file's content via useFile (useQuery
// wrapping api.ts's getFile), highlights it (client/src/lib/highlighter.ts),
// and overlays gutter markers/badges/checkboxes for the issues on each line.
// Whole-file issues (no `line`, e.g. an unused 'files' issue) render as a
// banner above the code instead of a gutter marker, since there's no single
// line to attach them to.
//
// Gutter markers are rendered as a separate, absolutely-positioned React
// overlay (not injected into the shiki HTML via a codeToHtml transformer):
// a `useLayoutEffect` measures the real DOM position of each flagged `.line`
// span (shiki's own per-line wrapper) after every highlight, so the overlay
// always lines up with the actual rendered line regardless of font/theme —
// simpler than teaching a transformer to splice checkbox/badge markup (with
// working React event handlers) into a raw HTML string.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Issue } from '../../../../src/core/types.js';
import { ApiError } from '../../api.js';
import { isFixable, isIgnorable, isLikelyTestFile } from '../../lib/filters.js';
import { highlightToHtml, isTooLargeToHighlight, issueLines, langForPath } from '../../lib/highlighter.js';
import { useFile } from '../../state/queries.js';
import { TestFileHint, TYPE_BADGE_LABELS, unactionableReason } from './TreeNode.js';

export interface CodePaneProps {
  /** null = nothing open yet (empty state). */
  filePath: string | null;
  /** This file's issues only — callers (App.tsx) filter Report.issues by filePath before passing them in. */
  issues: Issue[];
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
  /**
   * ui store's `openFileNonce` (Task 4, v0.3) — bumped on every explicit
   * file-open, including re-opening the same path. Combined with `filePath`
   * into CodeBlock's `scrollKey`, this is what lets the auto-scroll-to-
   * first-issue + pulse effect re-fire on a re-open, since `filePath` alone
   * wouldn't change in that case. See state/ui.ts's doc comment for why
   * `filePath` alone isn't a reliable enough signal on its own.
   */
  openFileNonce: number;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

// Non-highlightable extensions (and shiki-load failures) still get line
// numbers + gutter markers: reuse shiki's own `.shiki`/`.line` markup shape
// (see index.css) with plain escaped text instead of tokenized spans, so
// CodeBlock's DOM-measurement overlay logic doesn't need a separate code path.
function plainCodeHtml(content: string): string {
  const lines = content.split('\n').map((line) => `<span class="line">${escapeHtml(line)}</span>`);
  return `<pre class="shiki"><code>${lines.join('\n')}</code></pre>`;
}

function badgeLabel(issue: Issue): string {
  const type = TYPE_BADGE_LABELS[issue.type] ?? issue.type;
  return issue.symbol ? `${type}: ${issue.symbol}` : type;
}

interface Marker {
  line: number;
  top: number;
  height: number;
}

function CodeBlock({
  html,
  lineIssues,
  selected,
  onToggleIds,
  scrollKey,
}: {
  html: string;
  lineIssues: Map<number, Issue[]>;
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
  /**
   * Identity of "the file just opened" — `${filePath}#${openFileNonce}` (see
   * CodePane). The auto-scroll-to-first-issue + pulse effect below runs at
   * most once per distinct value: a mid-view content refresh (e.g. a rescan
   * landing after an ignore-apply elsewhere) changes `html`/`lineIssues`
   * without changing `scrollKey`, and must NOT yank the user's scroll
   * position or re-trigger the pulse.
   */
  scrollKey: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  // The pulsing marker, if any — React state rather than a DOM classList
  // mutation (see below for why that matters), cleared via setTimeout once
  // the 1.2s animation has had time to finish.
  const [pulseMarker, setPulseMarker] = useState<Marker | null>(null);
  // Tracks which `scrollKey` the auto-scroll/pulse has already run for, so it
  // fires exactly once per open (not on every re-measure caused by an
  // unrelated content refresh). A ref rather than state — it must survive
  // across renders without itself triggering one.
  const scrolledKeyRef = useRef<string | null>(null);
  // Bumped by the ResizeObserver below to force the measuring effect to
  // re-run when the container reflows (window resize, sidebar toggle, font
  // load, etc.) without the `.line` DOM/html/lineIssues themselves changing —
  // an absolutely-positioned overlay measured against stale offsetTop/Height
  // would otherwise drift out from under wrapped/reflowed lines. Only ever
  // used as a dep-array trigger; its actual value is irrelevant.
  const [measureTick, setMeasureTick] = useState(0);

  // Mount-scoped (not re-subscribed on every render) — ResizeObserver.observe
  // is stable across the container's lifetime, and only unmount needs to
  // disconnect it. Separate from the measuring effect below so bumping
  // `measureTick` here doesn't itself re-run this subscription effect.
  useEffect(() => {
    // jsdom (vitest) has no ResizeObserver; skip so tests don't crash.
    if (typeof ResizeObserver === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;
    // Fires once immediately on observe (per spec) — a harmless extra
    // measure pass on mount, on top of the measuring effect's own initial
    // run; not worth guarding against.
    const observer = new ResizeObserver(() => setMeasureTick((t) => t + 1));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      setMarkers([]);
      return;
    }
    const lineEls = container.querySelectorAll<HTMLElement>('.line');
    const next: Marker[] = [];
    let firstIssueMarker: Marker | undefined;
    lineEls.forEach((el, idx) => {
      const lineNo = idx + 1;
      if (lineIssues.has(lineNo)) {
        const marker = { line: lineNo, top: el.offsetTop, height: el.offsetHeight };
        next.push(marker);
        if (firstIssueMarker === undefined || lineNo < firstIssueMarker.line) firstIssueMarker = marker;
      }
    });
    setMarkers(next);
    // The flagged-line background tint and the pulse ring are BOTH rendered
    // as their own absolutely-positioned overlay elements below (React state,
    // like the badges already were) rather than a classList mutation on the
    // shiki-injected `.line` span itself, which is what this used to do. That
    // turned out to be genuinely broken in a production build: `setMarkers`
    // above schedules a re-render of this component, and — confirmed live by
    // instrumenting `Element.prototype.innerHTML`'s setter — React commits a
    // SECOND `dangerouslySetInnerHTML` write for the `.code-pane-html` div on
    // that follow-up render even though the `html` string itself is byte-
    // identical to the one already there, wiping any class just added onto
    // the (now-replaced) `.line` nodes with no further layout-effect run to
    // reapply it (this effect's own deps — `html`/`lineIssues`/`scrollKey` —
    // are unchanged by `setMarkers`, so it correctly does NOT re-fire). The
    // badges already dodged this because they were always React-rendered
    // overlay elements, never a mutation on the raw shiki HTML; matching that
    // pattern here is what actually fixes it, rather than fighting the reset.

    if (scrolledKeyRef.current === scrollKey) return;
    // Mark this open handled regardless of outcome — a whole-file-banner-only
    // file (no line-bearing issues) has no `firstIssueMarker` and simply
    // never scrolls; retrying on every subsequent re-measure would be wasted
    // work and risks scrolling later if a rescan happens to add a line issue
    // mid-view, which is exactly the "don't yank the scroll position on an
    // unrelated refresh" behavior this guard exists to prevent.
    scrolledKeyRef.current = scrollKey;
    const scroller = scrollerRef.current;
    if (!firstIssueMarker || !scroller) return;
    const target = firstIssueMarker.top - scroller.clientHeight / 2 + firstIssueMarker.height / 2;
    scroller.scrollTop = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight));
    setPulseMarker(firstIssueMarker);
    const timer = setTimeout(() => setPulseMarker(null), 1200);
    return () => clearTimeout(timer);
    // `measureTick` added so a resize-triggered reflow re-measures marker
    // positions; it does NOT reopen the auto-scroll/pulse gate above — that's
    // still keyed on `scrolledKeyRef.current === scrollKey`, which a resize
    // never changes, so scrolling/pulsing still fires at most once per open.
  }, [html, lineIssues, scrollKey, measureTick]);

  return (
    <div ref={scrollerRef} className="relative flex-1 overflow-auto">
      <div ref={containerRef} className="code-pane-html" dangerouslySetInnerHTML={{ __html: html }} />
      {/* Flagged-line background tint + pulse ring: full-width, behind the
          code text (-z-10 — the scroller above is `position: relative`, so
          this negative z-index paints below its other, non-positioned
          static children within that stacking context, same visual result
          as the old background-color-on-the-line-span approach). */}
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10">
        {markers.map(({ line, top, height }) => (
          <div key={line} className="code-pane-flagged-line-bg absolute inset-x-0" style={{ top, height }} />
        ))}
        {pulseMarker && (
          <div
            className="code-pane-pulse-line-bg absolute inset-x-0"
            style={{ top: pulseMarker.top, height: pulseMarker.height }}
          />
        )}
      </div>
      <div className="pointer-events-none absolute inset-0 left-0 top-0">
        {markers.map(({ line, top, height }) => (
          <div key={line} className="pointer-events-none absolute right-1 flex items-center gap-1" style={{ top, height }}>
            {/* `markers` is layout-effect state, measured against a possibly-earlier
                `lineIssues`; a rescan can prune an issue between that measurement and
                this render, so `lineIssues` (the current prop) may no longer have this
                line. Render nothing for it rather than crashing — the next
                useLayoutEffect pass (keyed on `lineIssues`) will drop the stale marker. */}
            {(lineIssues.get(line) ?? []).map((issue) => {
              const actionable = isFixable(issue).ok || isIgnorable(issue).ok;
              return (
                <label
                  key={issue.id}
                  data-testid={`code-pane-badge-${issue.type}-${issue.symbol ?? issue.id}`}
                  className="pointer-events-auto flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-200/90 px-1.5 py-0.5 text-[10px] leading-none text-amber-900 shadow-sm dark:bg-amber-800/90 dark:text-amber-100"
                  title={actionable ? badgeLabel(issue) : `${badgeLabel(issue)} — ${unactionableReason(issue)}`}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(issue.id)}
                    disabled={!actionable}
                    onChange={() => onToggleIds([issue.id])}
                    className="h-3 w-3 disabled:cursor-not-allowed"
                  />
                  {badgeLabel(issue)}
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function WholeFileBanner({
  issue,
  filePath,
  selected,
  onToggleIds,
}: {
  issue: Issue;
  filePath: string;
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
}) {
  const actionable = isFixable(issue).ok || isIgnorable(issue).ok;
  const message =
    issue.type === 'files'
      ? 'This whole file is unused.'
      : `This file has an unused ${TYPE_BADGE_LABELS[issue.type] ?? issue.type} with no specific line.`;
  // The flask hint only ever applies to the whole-file 'files' issue type —
  // an unused export/type/etc. with no line info on an otherwise-live test
  // file isn't the "knip can't see your test runner" false positive this
  // hint is for.
  const showTestHint = issue.type === 'files' && isLikelyTestFile(filePath);
  return (
    <label
      className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
      title={actionable ? undefined : unactionableReason(issue)}
    >
      <input
        type="checkbox"
        checked={selected.has(issue.id)}
        disabled={!actionable}
        onChange={() => onToggleIds([issue.id])}
        className="disabled:cursor-not-allowed"
      />
      {message}
      {showTestHint && <TestFileHint />}
    </label>
  );
}

export function CodePane({ filePath, issues, selected, onToggleIds, openFileNonce }: CodePaneProps) {
  const fileQuery = useFile(filePath);
  const content = fileQuery.data?.content;
  const lang = filePath ? langForPath(filePath) : undefined;

  // #34 item 3 (scoped to a cap — no web worker in this batch): over-cap
  // files reuse the plain-<pre> + highlightNote path that non-highlightable
  // extensions already take, so no new UI surface is invented.
  const tooLargeToHighlight = content !== undefined && isTooLargeToHighlight(content);

  const highlightQuery = useQuery({
    // Keyed on the fetch's own timestamp, NOT the content string (#34 item 1):
    // TanStack computes queryHash via JSON.stringify(queryKey) on EVERY
    // render, and CodePane re-renders on every gutter-checkbox toggle,
    // selection change, and poll landing — a 2MB content string in the key
    // made each of those pay an O(2MB) stringify. `fileQuery.dataUpdatedAt`
    // is bumped by react-query on every successful file fetch, so it changes
    // exactly when `content` can have changed; `content` itself is read via
    // closure in queryFn, which is safe under that invariant.
    queryKey: ['highlight', filePath, lang, fileQuery.dataUpdatedAt] as const,
    queryFn: async () => {
      if (!filePath || !lang || content === undefined) {
        throw new Error('highlight query ran without a file path/language/content');
      }
      return highlightToHtml(content, filePath);
    },
    enabled: filePath !== null && lang !== undefined && content !== undefined && !tooLargeToHighlight,
    retry: false,
  });

  // Memoized plain-<pre> fallback (#34 item 2): plainCodeHtml over a 2MB file
  // is O(content) string work, and its result's IDENTITY matters — the old
  // inline call in render returned a fresh string each time, so React rewrote
  // the container's entire innerHTML (dangerouslySetInnerHTML diffs by string
  // identity) and re-fired CodeBlock's marker-measuring layout effect on
  // every checkbox toggle. undefined until content lands.
  const plainHtml = useMemo(() => (content === undefined ? undefined : plainCodeHtml(content)), [content]);

  if (filePath === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
        Select a file from the tree to view its source.
      </div>
    );
  }

  if (fileQuery.isLoading) {
    return (
      <div className="p-4 text-sm text-muted-foreground" aria-label="Loading file">
        Loading {filePath}…
      </div>
    );
  }

  // Hoisted above the error/loading returns (was previously computed only on
  // the happy path below) so the 413 branch can render whole-file banners too
  // — see that branch's comment for why. Cheap regardless of which branch
  // runs: `issues` is already this-file-only (CodePane's own doc comment),
  // so this is just an array filter, not a fetch.
  const wholeFileIssues = issues.filter((i) => i.line === undefined);
  // Shared between the 413 branch and the normal-path return below, so the
  // banner markup only lives in one place.
  const wholeFileBanners = wholeFileIssues.map((issue) => (
    <WholeFileBanner key={issue.id} issue={issue} filePath={filePath} selected={selected} onToggleIds={onToggleIds} />
  ));

  if (fileQuery.error || content === undefined) {
    const err = fileQuery.error;
    if (err instanceof ApiError && err.status === 413) {
      // A file too big to fetch/highlight (server-side MAX_FILE_BYTES cap,
      // src/server/index.ts) is exactly the case where a whole-file 'files'
      // issue ("this file is unused") is most actionable — a huge dead file
      // is expensive to keep around. Only the source-preview pane is
      // skipped; the banner (with its checkbox) still renders. Deliberately
      // NOT extended to the 404/generic-error branches below: a 404'd file's
      // issues are stale by definition (the file is gone), and the generic
      // error branch shouldn't silently grow banners for an unrelated
      // failure (e.g. a transient fetch error) — see issue #10.
      return (
        <div className="flex flex-1 flex-col overflow-hidden">
          {wholeFileBanners}
          <div className="p-4 text-sm text-amber-700 dark:text-amber-400">
            {filePath} is too large to preview here.
          </div>
        </div>
      );
    }
    if (err instanceof ApiError && err.status === 404) {
      return <div className="p-4 text-sm text-destructive">File not found: {filePath}</div>;
    }
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to load {filePath}
        {err instanceof Error ? `: ${err.message}` : ''}
      </div>
    );
  }

  const lineIssues = issueLines(issues, filePath);

  let html: string | undefined;
  let highlightNote: string | undefined;
  if (lang === undefined) {
    html = plainHtml;
    highlightNote = 'No syntax highlighting available for this file type.';
  } else if (tooLargeToHighlight) {
    html = plainHtml;
    highlightNote = 'Syntax highlighting is skipped for large files — showing plain text.';
  } else if (highlightQuery.data) {
    html = highlightQuery.data;
  } else if (highlightQuery.error) {
    html = plainHtml;
    highlightNote = 'Syntax highlighting failed — showing plain text.';
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {wholeFileBanners}
      {highlightNote && (
        <p className="border-b border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
          {highlightNote}
        </p>
      )}
      {html === undefined ? (
        <div className="p-4 text-sm text-muted-foreground">Highlighting…</div>
      ) : (
        <CodeBlock
          html={html}
          lineIssues={lineIssues}
          selected={selected}
          onToggleIds={onToggleIds}
          scrollKey={`${filePath}#${openFileNonce}`}
        />
      )}
    </div>
  );
}
