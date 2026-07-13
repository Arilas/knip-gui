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
