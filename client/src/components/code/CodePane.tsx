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
import { useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Issue } from '../../../../src/core/types.js';
import { ApiError } from '../../api.js';
import { isFixable, isIgnorable } from '../../lib/filters.js';
import { highlightToHtml, issueLines, langForPath } from '../../lib/highlighter.js';
import { useFile } from '../../state/queries.js';
import { TYPE_BADGE_LABELS, unactionableReason } from './TreeNode.js';

export interface CodePaneProps {
  /** null = nothing open yet (empty state). */
  filePath: string | null;
  /** This file's issues only — callers (App.tsx) filter Report.issues by filePath before passing them in. */
  issues: Issue[];
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
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
}: {
  html: string;
  lineIssues: Map<number, Issue[]>;
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      setMarkers([]);
      return;
    }
    const lineEls = container.querySelectorAll<HTMLElement>('.line');
    const next: Marker[] = [];
    lineEls.forEach((el, idx) => {
      const lineNo = idx + 1;
      el.classList.remove('code-pane-flagged-line');
      if (lineIssues.has(lineNo)) {
        el.classList.add('code-pane-flagged-line');
        next.push({ line: lineNo, top: el.offsetTop, height: el.offsetHeight });
      }
    });
    setMarkers(next);
    // `html` changing means shiki re-rendered fresh DOM (dangerouslySetInnerHTML
    // fully replaces innerHTML), so classes/measurements must be redone; `lineIssues`
    // changing (e.g. after a rescan prunes an issue) must also re-measure.
  }, [html, lineIssues]);

  return (
    <div className="relative flex-1 overflow-auto">
      <div ref={containerRef} className="code-pane-html" dangerouslySetInnerHTML={{ __html: html }} />
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
  selected,
  onToggleIds,
}: {
  issue: Issue;
  selected: ReadonlySet<string>;
  onToggleIds: (ids: string[]) => void;
}) {
  const actionable = isFixable(issue).ok || isIgnorable(issue).ok;
  const message = issue.type === 'files' ? 'This whole file is unused.' : `This file has an unused ${issue.type} with no specific line.`;
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
    </label>
  );
}

export function CodePane({ filePath, issues, selected, onToggleIds }: CodePaneProps) {
  const fileQuery = useFile(filePath);
  const content = fileQuery.data?.content;
  const lang = filePath ? langForPath(filePath) : undefined;

  const highlightQuery = useQuery({
    queryKey: ['highlight', filePath, lang, content] as const,
    queryFn: async () => {
      if (!filePath || !lang || content === undefined) {
        throw new Error('highlight query ran without a file path/language/content');
      }
      return highlightToHtml(content, filePath);
    },
    enabled: filePath !== null && lang !== undefined && content !== undefined,
    retry: false,
  });

  if (filePath === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-gray-500 dark:text-gray-400">
        Select a file from the tree to view its source.
      </div>
    );
  }

  if (fileQuery.isLoading) {
    return (
      <div className="p-4 text-sm text-gray-500 dark:text-gray-400" aria-label="Loading file">
        Loading {filePath}…
      </div>
    );
  }

  if (fileQuery.error || content === undefined) {
    const err = fileQuery.error;
    if (err instanceof ApiError && err.status === 413) {
      return (
        <div className="p-4 text-sm text-amber-700 dark:text-amber-400">
          {filePath} is too large to preview here.
        </div>
      );
    }
    if (err instanceof ApiError && err.status === 404) {
      return <div className="p-4 text-sm text-red-600 dark:text-red-400">File not found: {filePath}</div>;
    }
    return (
      <div className="p-4 text-sm text-red-600 dark:text-red-400">
        Failed to load {filePath}
        {err instanceof Error ? `: ${err.message}` : ''}
      </div>
    );
  }

  const wholeFileIssues = issues.filter((i) => i.line === undefined);
  const lineIssues = issueLines(issues, filePath);

  let html: string | undefined;
  let highlightNote: string | undefined;
  if (lang === undefined) {
    html = plainCodeHtml(content);
    highlightNote = 'No syntax highlighting available for this file type.';
  } else if (highlightQuery.data) {
    html = highlightQuery.data;
  } else if (highlightQuery.error) {
    html = plainCodeHtml(content);
    highlightNote = 'Syntax highlighting failed — showing plain text.';
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {wholeFileIssues.map((issue) => (
        <WholeFileBanner key={issue.id} issue={issue} selected={selected} onToggleIds={onToggleIds} />
      ))}
      {highlightNote && (
        <p className="border-b border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
          {highlightNote}
        </p>
      )}
      {html === undefined ? (
        <div className="p-4 text-sm text-gray-500 dark:text-gray-400">Highlighting…</div>
      ) : (
        <CodeBlock html={html} lineIssues={lineIssues} selected={selected} onToggleIds={onToggleIds} />
      )}
    </div>
  );
}
