import { parseSync } from 'oxc-parser';
import type {
  Comment,
  Declaration,
  ExportDefaultDeclarationKind,
  ExportSpecifier,
  ModuleExportName,
  Program,
} from 'oxc-parser';
import type MagicString from 'magic-string';

export interface TransformInput {
  filePath: string;
  content: string;
  symbol: string;
  pos?: number;
  line?: number;
}

export type TransformResult = { ok: true; newContent: string } | { ok: false; reason: string };

export interface ParsedSource {
  program: Program;
  comments: Comment[];
}

// oxc-parser API (verified against the installed 0.137.0 build — see task-3-report.md
// for the exploration that pinned this down): `parseSync(filename, content, options?)`
// returns a `ParseResult` with getter properties `program` (ESTree/TS-ESTree-shaped AST,
// spans as `start`/`end` UTF-16 code-unit offsets — confirmed to match plain JS string
// indices, not UTF-8 byte offsets, and therefore directly usable as magic-string indices
// and directly comparable to knip's captured `pos`), `comments` (`{ type, value, start,
// end }[]`), and `errors`. Language dialect is deduced from `filename`'s extension, which
// is why callers must pass a realistic `filePath` (e.g. `used.ts`, not `snippet`).
export function parseSource(filePath: string, content: string): ParsedSource {
  const result = parseSync(filePath, content);
  return { program: result.program, comments: result.comments };
}

// --- locating an export-ish node at a position or by top-level symbol lookup ---
//
// Kept generic (not stripExport/deleteDeclaration-specific) because Task 4's
// remove-member / remove-duplicate transforms reuse the position-matching and
// comment-attachment helpers below for non-export nodes (enum/namespace members,
// duplicate bindings).

interface NamedSpan {
  name: string;
  start: number;
  end: number;
}

export type ExportSite =
  | {
      kind: 'declaration';
      name: string;
      exportStart: number;
      declStart: number;
      statementEnd: number;
    }
  | {
      kind: 'specifier';
      name: string;
      localName: string;
      statementStart: number;
      statementEnd: number;
      specifiers: ExportSpecifier[];
      index: number;
      isReexport: boolean;
    }
  | {
      kind: 'default';
      name: 'default';
      isNamed: boolean;
      statementStart: number;
      declStart: number;
      statementEnd: number;
    };

function moduleExportName(node: ModuleExportName): string {
  if (node.type === 'Identifier') return node.name;
  return String(node.value);
}

// `Declaration` covers `export const/function/class/type/interface/enum X` (and a
// handful of TS-only forms knip doesn't currently flag, e.g. `export namespace`).
// Every member except `VariableDeclaration` carries a single `id`; `VariableDeclaration`
// carries one `id` per declarator (only simple `Identifier` bindings are handled —
// destructuring bindings are out of scope for this task's fixtures).
function declarationNameCandidates(decl: Declaration): NamedSpan[] {
  if (decl.type === 'VariableDeclaration') {
    const out: NamedSpan[] = [];
    for (const d of decl.declarations) {
      if (d.id.type === 'Identifier') out.push({ name: d.id.name, start: d.id.start, end: d.id.end });
    }
    return out;
  }
  const { id } = decl;
  if (id && id.type === 'Identifier') {
    return [{ name: id.name, start: id.start, end: id.end }];
  }
  return [];
}

// A default export is "named" (has a local identifier) only for
// `export default function name() {}` / `export default class Name {}`; an anonymous
// function/class expression, or any other expression, has no name binding of its own.
function isNamedDefault(decl: ExportDefaultDeclarationKind): boolean {
  return (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id != null;
}

function findByPos(program: Program, pos: number): ExportSite | null {
  for (const stmt of program.body) {
    if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration) {
        for (const cand of declarationNameCandidates(stmt.declaration)) {
          if (pos >= cand.start && pos < cand.end) {
            return {
              kind: 'declaration',
              name: cand.name,
              exportStart: stmt.start,
              declStart: stmt.declaration.start,
              statementEnd: stmt.end,
            };
          }
        }
      } else {
        for (let index = 0; index < stmt.specifiers.length; index++) {
          const spec = stmt.specifiers[index];
          if (!spec) continue;
          if (pos >= spec.start && pos < spec.end) {
            return {
              kind: 'specifier',
              name: moduleExportName(spec.exported),
              localName: moduleExportName(spec.local),
              statementStart: stmt.start,
              statementEnd: stmt.end,
              specifiers: stmt.specifiers,
              index,
              isReexport: stmt.source !== null,
            };
          }
        }
      }
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      if (pos >= stmt.start && pos < stmt.end) {
        return {
          kind: 'default',
          name: 'default',
          isNamed: isNamedDefault(stmt.declaration),
          statementStart: stmt.start,
          declStart: stmt.declaration.start,
          statementEnd: stmt.end,
        };
      }
    }
  }
  return null;
}

function findByName(program: Program, symbol: string): ExportSite | null {
  for (const stmt of program.body) {
    if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration) {
        for (const cand of declarationNameCandidates(stmt.declaration)) {
          if (cand.name === symbol) {
            return {
              kind: 'declaration',
              name: cand.name,
              exportStart: stmt.start,
              declStart: stmt.declaration.start,
              statementEnd: stmt.end,
            };
          }
        }
      } else {
        for (let index = 0; index < stmt.specifiers.length; index++) {
          const spec = stmt.specifiers[index];
          if (!spec) continue;
          if (moduleExportName(spec.exported) === symbol) {
            return {
              kind: 'specifier',
              name: symbol,
              localName: moduleExportName(spec.local),
              statementStart: stmt.start,
              statementEnd: stmt.end,
              specifiers: stmt.specifiers,
              index,
              isReexport: stmt.source !== null,
            };
          }
        }
      }
    } else if (stmt.type === 'ExportDefaultDeclaration' && symbol === 'default') {
      return {
        kind: 'default',
        name: 'default',
        isNamed: isNamedDefault(stmt.declaration),
        statementStart: stmt.start,
        declStart: stmt.declaration.start,
        statementEnd: stmt.end,
      };
    }
  }
  return null;
}

// Locates the export site for `symbol`. When `pos` is provided, the node AT that
// position is located first (regardless of name) and its located name is then
// validated against `symbol` — this is what lets callers distinguish "nothing at
// this position" from "something at this position, but it's not the symbol we
// expected" (a stale/mismatched pos). Without `pos`, falls back to a top-level
// symbol lookup by name.
export function locateExport(
  program: Program,
  symbol: string,
  pos?: number,
): { site: ExportSite } | { error: string } {
  if (pos !== undefined) {
    const site = findByPos(program, pos);
    if (!site) return { error: `no export found at position ${pos}` };
    if (site.name !== symbol) {
      return { error: `symbol mismatch at position ${pos}: expected '${symbol}', found '${site.name}'` };
    }
    return { site };
  }
  const site = findByName(program, symbol);
  if (!site) return { error: `symbol '${symbol}' not found` };
  return { site };
}

// Finds a plain (non-exported) top-level declaration statement by its local name —
// used by deleteDeclaration for the `export { a, b }` case, where the exported
// binding and its declaration are two separate top-level statements.
export function findTopLevelDeclarationSpan(program: Program, name: string): { start: number; end: number } | null {
  for (const stmt of program.body) {
    if (stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') {
      if (stmt.id && stmt.id.type === 'Identifier' && stmt.id.name === name) {
        return { start: stmt.start, end: stmt.end };
      }
    } else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name) {
          return { start: stmt.start, end: stmt.end };
        }
      }
    }
  }
  return null;
}

// Removes specifier `index` from an `export { a, b, c }` (or `export { a } from '...'`)
// list, handling comma hygiene: when removing anything but the last specifier, the
// range extends through the start of the next specifier (eating its own text plus the
// following ", "); when removing the last specifier, the range starts at the end of
// the previous one (eating the preceding ", " plus its own text). Callers must check
// `specifiers.length > 1` first — a single-specifier list becoming empty means the
// whole statement should be removed instead (both stripExport and deleteDeclaration
// need this, hence it lives here).
export function removeListSpecifier(s: MagicString, specifiers: ExportSpecifier[], index: number): void {
  const isLast = index === specifiers.length - 1;
  if (isLast) {
    const prev = specifiers[index - 1];
    const cur = specifiers[index];
    if (!prev || !cur) return;
    s.remove(prev.end, cur.end);
  } else {
    const cur = specifiers[index];
    const next = specifiers[index + 1];
    if (!cur || !next) return;
    s.remove(cur.start, next.start);
  }
}

// Attached-comment detection for deleteDeclaration: a comment is "attached" to a node
// if it sits immediately above it — nothing but horizontal whitespace and exactly one
// newline between the comment's end and the (possibly already-expanded) start. Chains
// backward so a run of stacked comments (e.g. a `//` line comment directly above a
// JSDoc block, with no blank line between either) is all included.
export function expandStartWithLeadingComments(content: string, comments: Comment[], start: number): number {
  let cursor = start;
  let changed = true;
  while (changed) {
    changed = false;
    for (const comment of comments) {
      if (comment.end > cursor) continue;
      const between = content.slice(comment.end, cursor);
      if (/^[ \t]*\n[ \t]*$/.test(between)) {
        cursor = comment.start;
        changed = true;
        break;
      }
    }
  }
  return cursor;
}

// Extends `end` through one trailing newline (LF or CRLF), if present, so deleting a
// statement doesn't leave a blank line behind.
export function expandEndWithTrailingNewline(content: string, end: number): number {
  if (content.startsWith('\r\n', end)) return end + 2;
  if (content[end] === '\n') return end + 1;
  return end;
}
