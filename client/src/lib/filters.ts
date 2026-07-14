// Pure, framework-free filter/type helpers for the Code page (Task 3, UX
// overhaul): replaces the old facet-rail model (facets.ts, deleted this
// task) now that navigation is sidebar-driven and facet pages are gone.
// No React, no store — safe to unit-test directly (see
// tests/client/filters.test.ts).
import type { Issue, IssueType } from '../../../src/core/types.js';

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

// Only these types are ignorable — mirrors compileIgnorePlan's switch
// (src/fix/compiler.ts): everything else (unlisted, unresolved, duplicates,
// nsExports, nsTypes, catalog, cycles) falls through to its default 'not-
// ignorable' case there.
const IGNORABLE_TYPES = new Set<IssueType>([
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'binaries',
  'exports',
  'types',
  'enumMembers',
  'namespaceMembers',
]);

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
  if (IGNORABLE_TYPES.has(issue.type)) return { ok: true };
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
