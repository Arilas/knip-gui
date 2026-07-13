import { createHash } from 'node:crypto';
import { FIX_MODES_BY_TYPE, ISSUE_TYPES, type Issue, type IssueType } from './types.js';

type RawEntry = {
  name?: string;
  namespace?: string;
  line?: number;
  col?: number;
  pos?: number;
};

function issueId(parts: (string | undefined)[]): string {
  return createHash('sha256')
    .update(parts.map((p) => p ?? '').join('|'))
    .digest('hex')
    .slice(0, 12);
}

function workspaceFor(filePath: string, workspaceDirs: string[]): string {
  for (const dir of workspaceDirs) {
    if (dir !== '.' && (filePath === dir || filePath.startsWith(dir + '/'))) return dir;
  }
  return '.';
}

function flattenEntries(value: unknown): RawEntry[] {
  if (Array.isArray(value)) {
    return value.flat(2).filter((v): v is RawEntry => !!v && typeof v === 'object');
  }
  return [];
}

/**
 * knip's real JSON entries carry different fields depending on issue type:
 *  - `files`: { name } — the file itself is the issue; no symbol.
 *  - `enumMembers` / `namespaceMembers`: { namespace, name, line, col, pos } —
 *    `namespace` is the enclosing enum/namespace name (parentSymbol).
 *  - everything else with position info (`exports`, `nsExports`, `types`, `nsTypes`): { name, line, col, pos }.
 *  - dependency-shaped entries (`dependencies`, `devDependencies`, `optionalPeerDependencies`,
 *    `unlisted`, `unresolved`, `binaries`, `catalog`): { name } with no position.
 *  - `duplicates` / `cycles`: shape not observed in captured fixtures (always empty there);
 *    parsed defensively via the generic { name, ... } fallback below.
 */
function symbolsFor(type: IssueType, item: RawEntry): { symbol?: string; parentSymbol?: string } {
  if (type === 'files') return {};
  if (type === 'enumMembers' || type === 'namespaceMembers') {
    return { symbol: item.name, parentSymbol: item.namespace };
  }
  return { symbol: item.name };
}

export function normalize(raw: unknown, workspaceDirs: string[]): Issue[] {
  const issues: Issue[] = [];
  const fileEntries = (raw as { issues?: unknown[] })?.issues ?? [];

  for (const entry of fileEntries as Record<string, unknown>[]) {
    const filePath = String(entry.file ?? '');
    const workspace = workspaceFor(filePath, workspaceDirs);

    for (const type of ISSUE_TYPES) {
      for (const item of flattenEntries(entry[type])) {
        const { symbol, parentSymbol } = symbolsFor(type, item);
        const fixModes = FIX_MODES_BY_TYPE[type];
        issues.push({
          id: issueId([workspace, filePath, type, parentSymbol, symbol]),
          type,
          workspace,
          filePath,
          symbol,
          parentSymbol,
          line: item.line,
          col: item.col,
          pos: item.pos,
          fixable: fixModes.length > 0,
          fixModes,
        });
      }
    }
  }
  return issues;
}
