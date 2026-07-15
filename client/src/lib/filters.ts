// Pure, framework-free filter/type helpers for the Code page (Task 3, UX
// overhaul): replaces the old facet-rail model (facets.ts, deleted this
// task) now that navigation is sidebar-driven and facet pages are gone.
// No React, no store — safe to unit-test directly (see
// tests/client/filters.test.ts).
import { IGNORABLE_ISSUE_TYPES, type Issue, type IssueType } from '../../../src/core/types.js';

// File-located issue types (dependency-shaped types excluded) — the set the
// Code page's filter chips cover. Canonical source for state/ui.ts's
// `codeFilters` default (re-exported there so existing import sites keep
// working) and for buildTree's callers.
export const CODE_TYPES: readonly IssueType[] = [
  'exports',
  'types',
  'enumMembers',
  'namespaceMembers',
  'files',
  'duplicates',
  'unresolved',
  'unlisted',
];

// Dependency/package-shaped issue types — everything that lives in a
// package.json rather than a source file. Canonical source for state/ui.ts's
// `packagesFilters` default; consumed by the future Packages page (Task 4).
export const PACKAGE_TYPES: readonly IssueType[] = [
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'binaries',
];

// Full human labels per issue type, reused everywhere a label is needed
// (Dashboard stat tiles/column headers, FilterChips tooltips) so the wording
// never drifts between call sites. nsExports/nsTypes/catalog/cycles have no
// dedicated filter chip or Dashboard destination (see CODE_TYPES/PACKAGE_TYPES
// above) but still get a label here since Dashboard's stat-tile grid shows
// every type the report contains, clickable or not.
const TYPE_LABELS: Record<IssueType, string> = {
  files: 'Unused files',
  exports: 'Unused exports',
  nsExports: 'Unused namespace exports',
  types: 'Unused types',
  nsTypes: 'Unused namespace types',
  enumMembers: 'Unused enum members',
  namespaceMembers: 'Unused namespace members',
  duplicates: 'Duplicate exports',
  dependencies: 'Unused dependencies',
  devDependencies: 'Unused dev dependencies',
  optionalPeerDependencies: 'Unused peer dependencies',
  unlisted: 'Unlisted dependencies',
  unresolved: 'Unresolved imports',
  binaries: 'Unused binaries',
  catalog: 'Catalog entries',
  cycles: 'Import cycles',
};

export function typeLabel(type: IssueType): string {
  return TYPE_LABELS[type];
}

export interface Fixability {
  ok: boolean;
  reason?: string;
}

const UNFIXABLE_REASONS: Partial<Record<IssueType, string>> = {
  nsExports: 'namespace re-exports are not auto-fixable yet',
  nsTypes: 'namespace re-exported types are not auto-fixable yet',
  unlisted: 'unlisted dependencies must be added to package.json manually',
  unresolved: 'unresolved imports must be fixed manually',
  binaries: 'unused binaries are not auto-fixable',
  catalog: 'catalog entries are not auto-fixable',
  cycles: 'import cycles are not auto-fixable',
};

// Mirrors FIX_MODES_BY_TYPE (src/core/types.ts): an issue is fixable exactly
// when it carries at least one fix mode. issue.fixable already encodes this
// server-side; this helper additionally supplies a human reason for the
// disabled state, which the server has no reason to send.
export function isFixable(issue: Issue): Fixability {
  if (issue.fixable && issue.fixModes.length > 0) return { ok: true };
  return { ok: false, reason: UNFIXABLE_REASONS[issue.type] ?? 'not fixable' };
}

// Ignorability is defined once in core (IGNORABLE_ISSUE_TYPES) and consumed by
// both the server's ignore engine and here — no more hand-kept mirror of
// compileIgnorePlan's switch that could silently drift.
const UNIGNORABLE_REASONS: Partial<Record<IssueType, string>> = {
  unlisted: 'unlisted dependencies cannot be suppressed via config',
  unresolved: 'unresolved imports cannot be suppressed via config',
  duplicates: 'duplicate exports cannot be suppressed via config',
  nsExports: 'namespace re-exports cannot be suppressed via config',
  nsTypes: 'namespace re-exported types cannot be suppressed via config',
  catalog: 'catalog entries cannot be suppressed via config',
  cycles: 'import cycles cannot be suppressed via config',
};

export function isIgnorable(issue: Issue): Fixability {
  if (IGNORABLE_ISSUE_TYPES.has(issue.type)) return { ok: true };
  return { ok: false, reason: UNIGNORABLE_REASONS[issue.type] ?? 'not ignorable' };
}

// An issue can ever land in the selection cart exactly when it's fixable or
// ignorable — shared by tree.ts (actionableIds rollup) and selection.ts
// (addFileFiltered) so "what counts as actionable" has exactly one
// definition.
export function isActionable(issue: Issue): boolean {
  return isFixable(issue).ok || isIgnorable(issue).ok;
}

// Combined type+text filter for the Code page: `enabled` gates which issue
// TYPES are visible at all (the FilterChips toolbar writes this), `query` is
// a case-insensitive substring match over path or symbol (empty/whitespace-
// only is a no-op). Used to build the tree AND to compute FilterChips' own
// live per-type counts (called there with a full "all types enabled" set so
// counts reflect the search scope only, not the chips' own on/off state).
export function filterIssues(issues: Issue[], enabled: ReadonlySet<IssueType>, query: string): Issue[] {
  const needle = query.trim().toLowerCase();
  return issues.filter((issue) => {
    if (!enabled.has(issue.type)) return false;
    if (!needle) return true;
    return issue.filePath.toLowerCase().includes(needle) || (issue.symbol?.toLowerCase().includes(needle) ?? false);
  });
}

export interface WorkspaceGroup {
  workspace: string;
  issues: Issue[];
}

// Test-file heuristic (Task 4, v0.3): a "files" (whole-file-unused) issue on
// what looks like a test file is very often a false positive — knip just
// isn't configured with the project's test runner (e.g. no `vitest`/`jest`
// plugin), so it can't see the runner picking the file up. CodePane's banner
// and TreeNode's file rows use this to show a hint pointing at knip's plugin
// docs rather than presenting it as an ordinary "delete this" candidate.
//
// Matching is SEGMENT-boundary based, not a bare substring test, specifically
// to avoid false positives like `src/latest/file.ts` (`latest` contains
// "test" but isn't the directory `test`) or `attest/file.ts` (same shape) or
// `contest.ts` (contains "test" but isn't `*.test.*`). The filename check
// requires the dot-delimited `.test.`/`.spec.`/`.stories.` infix (so
// `src/test-utils.ts` — "test" isn't dot-delimited there — correctly reads as
// a negative), and the directory check requires an EXACT path-segment match
// against a fixed set of conventional test-directory names.
const TEST_DIR_SEGMENTS = new Set(['__tests__', '__mocks__', 'e2e', 'test', 'tests']);
const TEST_FILENAME_RE = /\.(test|spec|stories)\.[^./]+$/i;

// Splits on a bare '/' only — safe because knip always emits forward-slash-
// delimited paths (even on Windows), so there's no backslash case to handle here.
export function isLikelyTestFile(path: string): boolean {
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  const filename = segments[segments.length - 1]!;
  if (TEST_FILENAME_RE.test(filename)) return true;
  const dirSegments = segments.slice(0, -1);
  return dirSegments.some((seg) => TEST_DIR_SEGMENTS.has(seg));
}

// Buckets issues by their `workspace` field for the Packages page (Task 4):
// one shadcn Table per workspace group. Never fabricates an empty group for a
// workspace with no issues — only workspaces actually present in `issues`
// appear. The root workspace ('.') always sorts first (it's the natural
// "top" of a project, not just another alphabetical entry); every other
// workspace follows in ascending alphabetical order. Issues within a group
// keep their original relative order — sorting within a group is the table's
// own concern (a sortable-column UI layered on top), not this grouping step.
export function groupByWorkspace(issues: Issue[]): WorkspaceGroup[] {
  const byWorkspace = new Map<string, Issue[]>();
  for (const issue of issues) {
    const existing = byWorkspace.get(issue.workspace);
    if (existing) existing.push(issue);
    else byWorkspace.set(issue.workspace, [issue]);
  }
  return [...byWorkspace.entries()]
    .map(([workspace, groupIssues]) => ({ workspace, issues: groupIssues }))
    .sort((a, b) => {
      if (a.workspace === '.') return -1;
      if (b.workspace === '.') return 1;
      return a.workspace.localeCompare(b.workspace);
    });
}
