import { createHash } from 'node:crypto';
import { FIX_MODES_BY_TYPE, ISSUE_TYPES, type Issue, type IssueType } from './types.js';

type RawEntry = {
  name?: string;
  namespace?: string;
  line?: number;
  col?: number;
  pos?: number;
};

function issueId(parts: (string | undefined)[], occurrence: number): string {
  // The occurrence ordinal disambiguates repeats of the same
  // (workspace, filePath, type, parentSymbol, symbol) key within one run —
  // e.g. the same unresolved specifier at two different lines in one file.
  // line/pos are deliberately NOT hashed so ids stay stable when unrelated
  // edits shift lines. The first occurrence omits the ordinal, keeping ids
  // identical to those produced before ordinals existed.
  const key = parts.map((p) => p ?? '').join('|');
  return createHash('sha256')
    .update(occurrence === 0 ? key : `${key}|${occurrence}`)
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
 *  - `duplicates`: shape observed via `export const b = a` / `export default a` aliasing
 *    (NOT `export { a as b }`, which knip treats as a plain re-export, not a duplicate) —
 *    `[[{name,line,col,pos}, {name,line,col,pos}, ...], ...]`, one sub-array ("group") per
 *    duplicated value, first element = the original declaration site, rest = each alias.
 *    Handled separately below since flattening would destroy the group structure.
 *  - `cycles`: shape not observed in captured fixtures (always empty there); would fall
 *    through the generic { name, ... } path below if ever populated.
 */
function symbolsFor(type: IssueType, item: RawEntry): { symbol?: string; parentSymbol?: string } {
  if (type === 'files') return {};
  if (type === 'enumMembers' || type === 'namespaceMembers') {
    return { symbol: item.name, parentSymbol: item.namespace };
  }
  return { symbol: item.name };
}

/**
 * Extracts `duplicates` groups defensively: each file's `duplicates` array holds one
 * sub-array per duplicate-export group. Anything that isn't an array of name-bearing
 * objects is dropped rather than throwing, matching the malformed-entry tolerance
 * elsewhere in this module.
 */
function duplicateGroups(value: unknown): RawEntry[][] {
  if (!Array.isArray(value)) return [];
  return value
    .map((group): RawEntry[] =>
      Array.isArray(group) ? group.filter((v): v is RawEntry => !!v && typeof v === 'object') : [],
    )
    .filter((group) => group.length > 0);
}

export function normalize(raw: unknown, workspaceDirs: string[]): Issue[] {
  const issues: Issue[] = [];
  const fileEntries = (raw as { issues?: unknown[] })?.issues ?? [];
  const keyCounts = new Map<string, number>();

  function pushIssue(
    type: IssueType,
    filePath: string,
    workspace: string,
    symbol: string | undefined,
    parentSymbol: string | undefined,
    position: { line?: number; col?: number; pos?: number },
  ): void {
    const fixModes = FIX_MODES_BY_TYPE[type];
    const keyParts = [workspace, filePath, type, parentSymbol, symbol];
    const key = keyParts.map((p) => p ?? '').join('|');
    const occurrence = keyCounts.get(key) ?? 0;
    keyCounts.set(key, occurrence + 1);
    issues.push({
      id: issueId(keyParts, occurrence),
      type,
      workspace,
      filePath,
      symbol,
      parentSymbol,
      line: position.line,
      col: position.col,
      pos: position.pos,
      fixable: fixModes.length > 0,
      fixModes,
    });
  }

  for (const entry of fileEntries as Record<string, unknown>[]) {
    // Skip malformed entries (null, non-objects, non-string `file`) rather than throwing.
    if (!entry || typeof entry !== 'object' || typeof entry.file !== 'string') continue;
    const filePath = entry.file;
    const workspace = workspaceFor(filePath, workspaceDirs);

    for (const type of ISSUE_TYPES) {
      if (type === 'duplicates') {
        // One Issue per duplicate group (not per name): symbol is every duplicated
        // name joined together, position is the original declaration's (the group's
        // first element).
        for (const group of duplicateGroups(entry[type])) {
          const symbol = group
            .map((g) => g.name)
            .filter((n): n is string => !!n)
            .join(', ');
          pushIssue(type, filePath, workspace, symbol, undefined, group[0]!);
        }
        continue;
      }
      for (const item of flattenEntries(entry[type])) {
        const { symbol, parentSymbol } = symbolsFor(type, item);
        pushIssue(type, filePath, workspace, symbol, parentSymbol, item);
      }
    }
  }
  return issues;
}
