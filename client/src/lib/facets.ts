// Pure, framework-free projections of Report.issues into the facet rail /
// overview grid. No React, no store — safe to unit-test directly (see
// tests/client/facets.test.ts).
import type { Issue, IssueType } from '../../../src/core/types.js';

export const FACETS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tree', label: 'Tree' },
  { id: 'files', label: 'Unused files' },
  { id: 'exports', label: 'Unused exports' },
  { id: 'types', label: 'Unused types' },
  { id: 'enumMembers', label: 'Unused enum members' },
  { id: 'namespaceMembers', label: 'Unused namespace members' },
  { id: 'duplicates', label: 'Duplicate exports' },
  { id: 'dependencies', label: 'Unused dependencies' },
  { id: 'unlisted', label: 'Unlisted dependencies' },
  { id: 'unresolved', label: 'Unresolved imports' },
  { id: 'binaries', label: 'Unused binaries' },
] as const;

export type Facet = (typeof FACETS)[number]['id'];

// Facets that project 1:1 (or many:1) onto real IssueTypes. 'overview' and
// 'tree' are handled specially in issuesForFacet below — they aren't simple
// type unions.
const FACET_TYPES: Partial<Record<Facet, IssueType[]>> = {
  files: ['files'],
  // nsExports has no fix/ignore support of its own (see FIX_MODES_BY_TYPE and
  // the ignore compiler's default case) but is still an "unused export" in
  // spirit, so it's folded into the same facet as `exports` rather than
  // getting a facet nobody would click.
  exports: ['exports', 'nsExports'],
  types: ['types', 'nsTypes'],
  enumMembers: ['enumMembers'],
  namespaceMembers: ['namespaceMembers'],
  duplicates: ['duplicates'],
  dependencies: ['dependencies', 'devDependencies', 'optionalPeerDependencies'],
  unlisted: ['unlisted'],
  unresolved: ['unresolved'],
  binaries: ['binaries'],
};

// Types that carry a real position inside a single source file — these are
// exactly the types the Tree view (Task 3) can render as file/line rows.
// Dependency-shaped types (dependencies/devDependencies/optionalPeerDependencies/
// unlisted/unresolved/binaries/catalog) and cycles have no per-symbol source
// location (see src/core/normalize.ts's doc comment) and live only in their
// own table facet (or nowhere, for catalog/cycles, which Task 2 doesn't
// surface a dedicated view for).
const FILE_BEARING_TYPES: IssueType[] = [
  'files',
  'exports',
  'nsExports',
  'types',
  'nsTypes',
  'enumMembers',
  'namespaceMembers',
  'duplicates',
];

function scopeToWorkspace(issues: Issue[], workspace?: string): Issue[] {
  return workspace === undefined ? issues : issues.filter((i) => i.workspace === workspace);
}

export function issuesForFacet(facet: Facet, issues: Issue[], workspace?: string): Issue[] {
  const scoped = scopeToWorkspace(issues, workspace);
  if (facet === 'overview') return scoped;
  if (facet === 'tree') return scoped.filter((i) => FILE_BEARING_TYPES.includes(i.type));
  const types = FACET_TYPES[facet] ?? [];
  return scoped.filter((i) => types.includes(i.type));
}

// Counts issues per real IssueType (not per facet) — this is what the
// Overview grid renders per workspace column, and what FacetRail badges are
// derived from (a facet's badge is the sum of its FACET_TYPES' counts, or
// simply issuesForFacet(facet, issues, workspace).length).
export function facetCounts(issues: Issue[], workspace?: string): Partial<Record<IssueType, number>> {
  const scoped = scopeToWorkspace(issues, workspace);
  const counts: Partial<Record<IssueType, number>> = {};
  for (const issue of scoped) {
    counts[issue.type] = (counts[issue.type] ?? 0) + 1;
  }
  return counts;
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
