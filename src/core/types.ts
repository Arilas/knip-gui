export const ISSUE_TYPES = [
  'files',
  'dependencies',
  'devDependencies',
  'optionalPeerDependencies',
  'unlisted',
  'binaries',
  'unresolved',
  'exports',
  'nsExports',
  'types',
  'nsTypes',
  'enumMembers',
  'namespaceMembers',
  'duplicates',
  'catalog',
  'cycles',
] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];

// The issue types the ignore engine can suppress via knip config or a member-
// precise @public tag (compileIgnorePlan in src/ignore/compile.ts). The SINGLE
// source of truth for "is this ignorable", shared by the server (which guards
// its per-type ignore switch with it) and the client (filters.ts's isIgnorable /
// the SelectionDock's Ignore button). Anything not listed here — unlisted,
// unresolved, duplicates, nsExports, nsTypes, catalog, cycles — has no config
// affordance and reports 'not-ignorable'.
export const IGNORABLE_ISSUE_TYPES: ReadonlySet<IssueType> = new Set<IssueType>([
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

export type FixMode =
  | 'delete-file'
  | 'strip-export'
  | 'delete-declaration'
  | 'remove-member'
  | 'remove-duplicate'
  | 'remove-dependency';

export interface Issue {
  id: string;
  type: IssueType;
  workspace: string;
  filePath: string;
  symbol?: string;
  parentSymbol?: string;
  line?: number;
  col?: number;
  pos?: number;
  fixable: boolean;
  fixModes: FixMode[];
  /**
   * Only for type 'duplicates': every member of the duplicate-export group with
   * its own position, in knip's order (original declaration first, aliases after).
   * The top-level symbol/line/col/pos summarize the group (joined names + the
   * original declaration's position); fix engines removing an alias must target
   * the positions in duplicateMembers[1..], not the top-level position.
   */
  duplicateMembers?: { symbol: string; line?: number; col?: number; pos?: number }[];
}

export interface Report {
  issues: Issue[];
  scannedAt: string;
  workspaces: string[];
  /**
   * The workspace this scan was limited to (matches the `workspace` passed to
   * `runScan`/`/api/scan`), or absent when the scan covered the full project.
   * Rescans (post-apply background rescan, post-sweep awaited rescan) reuse
   * this value rather than silently widening back to a full-project scan.
   */
  scope?: string;
  /**
   * Whether this scan ran with knip's `--production` flag (fixed for the
   * lifetime of a server instance — see `createServer`'s `production` option).
   * Always present (default `false`) rather than optional, unlike `scope`,
   * since every scan has a definite production/non-production mode.
   */
  production: boolean;
}

export const FIX_MODES_BY_TYPE: Record<IssueType, FixMode[]> = {
  files: ['delete-file'],
  exports: ['strip-export', 'delete-declaration'],
  types: ['strip-export', 'delete-declaration'],
  enumMembers: ['remove-member'],
  namespaceMembers: ['remove-member'],
  duplicates: ['remove-duplicate'],
  dependencies: ['remove-dependency'],
  devDependencies: ['remove-dependency'],
  optionalPeerDependencies: ['remove-dependency'],
  nsExports: [],
  nsTypes: [],
  unlisted: [],
  unresolved: [],
  binaries: [],
  catalog: [],
  cycles: [],
};
