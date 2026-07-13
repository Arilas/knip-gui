// Lazy shiki wiring for the code pane (Task 4).
//
// API confirmed against the installed shiki 4.3.1 (node_modules/shiki, backed
// by @shikijs/types — the top-level README is just a pointer to
// https://shiki.style, so the real contract was read from
// node_modules/@shikijs/types/dist/index.d.mts):
//   - `createHighlighter({ themes, langs })` returns a `Highlighter` whose
//     `loadLanguage(...)` can add grammars after the fact — this is what
//     lets languages be fetched on demand instead of bundled statically.
//   - Dual-theme rendering is `codeToHtml(code, { lang, themes: { light,
//     dark }, defaultColor: false })`: `CodeOptionsMultipleThemes.themes` is
//     `Partial<Record<string, ...>>` (keys are arbitrary color names, not
//     fixed to 'light'/'dark' — see the JSDoc example there). `defaultColor:
//     false` (documented at the same symbol) skips the inline
//     `color`/`background-color` shiki would otherwise apply for a single
//     "default" theme, emitting *only* the `--shiki-light`/`--shiki-dark`
//     (per `cssVariablePrefix`, default `--shiki-`) CSS custom properties on
//     every token span. That leaves the actual light/dark switch entirely to
//     our own CSS — see client/src/index.css's `.code-pane` rules, which key
//     off `prefers-color-scheme` exactly as shiki's dual-theme guide
//     (https://shiki.style/guide/dual-themes) recommends.
//   - Each bundled language/theme is loaded via its own `import()` inside
//     shiki's internal bundle map (node_modules/shiki/dist/langs-bundle-full-*.mjs),
//     so Vite code-splits every language into its own chunk automatically;
//     passing `langs: []` up front and calling `loadLanguage` per extension
//     (memoized below) means only the languages a user actually opens a file
//     in ever get fetched.
import type { Highlighter } from 'shiki';
import type { Issue } from '../../../src/core/types.js';

// The only two themes the highlighter instance ever loads — see App-wide
// Global Constraint "Dark/light via prefers-color-scheme (shiki dual themes)".
export const SHIKI_THEMES = { light: 'github-light', dark: 'github-dark' } as const;

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'jsonc',
};

/** Pure: file path -> shiki grammar name, or undefined when unhighlightable (CodePane's plain-<pre> fallback). */
export function langForPath(path: string): string | undefined {
  const match = /\.([^./]+)$/.exec(path);
  if (!match) return undefined;
  return EXT_TO_LANG[match[1]!.toLowerCase()];
}

/**
 * Pure: buckets a file's issues by line number for gutter markers, excluding
 * whole-file issues (no `line`, e.g. an unused 'files' issue) — those render
 * as CodePane's banner instead. Filters to `path` itself so callers can pass
 * either the whole report's issues or an already-filtered subset.
 */
export function issueLines(issues: Issue[], path: string): Map<number, Issue[]> {
  const byLine = new Map<number, Issue[]>();
  for (const issue of issues) {
    if (issue.filePath !== path || issue.line === undefined) continue;
    const existing = byLine.get(issue.line);
    if (existing) existing.push(issue);
    else byLine.set(issue.line, [issue]);
  }
  return byLine;
}

// Module singleton: the highlighter (and its wasm engine) is expensive to
// spin up, so every caller across the app shares one lazily-created
// instance/promise rather than each CodePane mount racing to create its own.
let highlighterPromise: Promise<Highlighter> | undefined;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({ themes: [SHIKI_THEMES.light, SHIKI_THEMES.dark], langs: [] }),
    );
  }
  return highlighterPromise;
}

async function highlightWithLang(content: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  if (!loadedLangs.has(lang)) {
    await highlighter.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0]);
    loadedLangs.add(lang);
  }

  return highlighter.codeToHtml(content, {
    lang,
    themes: SHIKI_THEMES,
    defaultColor: false,
  });
}

/**
 * Dual-theme highlighted HTML for `content` at `path`. Throws if `path` has
 * no known language — callers must check `langForPath` first and fall back
 * to a plain `<pre>` (CodePane does this for the non-highlightable-extension
 * state).
 */
export async function highlightToHtml(content: string, path: string): Promise<string> {
  const lang = langForPath(path);
  if (!lang) throw new Error(`No shiki language mapped for ${path}`);
  return highlightWithLang(content, lang);
}

// DiffView's (Task 5) per-file unified diffs aren't path-derived — there's no
// extension to infer a language from — so this bypasses langForPath entirely
// and loads shiki's bundled 'diff' grammar directly (confirmed present in
// shiki's bundledLanguages map), sharing the same lazily-loaded highlighter
// singleton and loadLanguage-memoization as highlightToHtml above.
export async function highlightDiff(diff: string): Promise<string> {
  return highlightWithLang(diff, 'diff');
}
