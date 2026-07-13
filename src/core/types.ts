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
