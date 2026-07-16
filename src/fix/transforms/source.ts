import { parseSync } from 'oxc-parser';
import type {
  Comment,
  Declaration,
  ExportDefaultDeclarationKind,
  ExportSpecifier,
  ModuleExportName,
  Program,
} from 'oxc-parser';
import MagicString from 'magic-string';

export interface TransformInput {
  filePath: string;
  content: string;
  symbol: string;
  pos?: number;
  line?: number;
}

export type TransformResult = { ok: true; newContent: string } | { ok: false; reason: string };

/** A removal ([start,end) deleted), an insertion (start===end, text added),
 *  or a replacement (start<end with text — applied as an overwrite; needed
 *  for the public-tag single-line-JSDoc expansion). */
export interface SourceEdit {
  start: number;
  end: number;
  text?: string;
}
export type BatchOpResult = { ok: true } | { ok: false; reason: string };
/** One transform op, compiler-agnostic (no issueId/mode). */
export interface SourceOp {
  symbol: string;
  pos?: number;
  parentSymbol?: string;
}
/** An edit plus the indices (into the batch's `ops`) of the op(s) that produced it. */
export interface BatchEdit extends SourceEdit {
  owners: number[];
}
export interface SourceBatchResult {
  results: BatchOpResult[];
  edits: BatchEdit[];
}

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

export interface Span {
  start: number;
  end: number;
}

interface NamedSpan {
  name: string;
  start: number;
  end: number;
  // Index into VariableDeclaration.declarations when the candidate is one
  // declarator of a (possibly multi-declarator) variable declaration.
  declaratorIndex?: number;
}

export type ExportSite =
  | {
      kind: 'declaration';
      name: string;
      exportStart: number;
      declStart: number;
      statementEnd: number;
      // Earliest point of the full construct: min of `exportStart` and any class
      // decorator that sits ABOVE the `export` keyword (`@dec\nexport class Foo`).
      // oxc puts such decorators on the class node but OUTSIDE the
      // ExportNamedDeclaration span, so a whole-statement deletion that starts at
      // `exportStart` would leave dangling decorators behind (a syntax error).
      // Equal to `exportStart` when there are no decorators before it.
      deleteStart: number;
      // Present only when the matched symbol is one declarator of an
      // `export const a = 1, b = 2;` statement: spans of ALL declarators plus
      // which one matched, so deleteDeclaration can surgically remove just the
      // flagged declarator instead of deleting live siblings.
      declarators?: Span[];
      declaratorIndex?: number;
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
    for (let i = 0; i < decl.declarations.length; i++) {
      const d = decl.declarations[i];
      if (d && d.id.type === 'Identifier') {
        out.push({ name: d.id.name, start: d.id.start, end: d.id.end, declaratorIndex: i });
      }
    }
    return out;
  }
  const { id } = decl;
  if (id && id.type === 'Identifier') {
    return [{ name: id.name, start: id.start, end: id.end }];
  }
  return [];
}

// Builds the 'declaration' ExportSite for a matched name candidate of an
// `export <declaration>` statement, folding in decorator and declarator info.
function declarationSite(
  stmt: { start: number; end: number; declaration: Declaration },
  cand: NamedSpan,
): ExportSite {
  const decl = stmt.declaration;
  // Decorators above the `export` keyword live on the class node but outside the
  // ExportNamedDeclaration span (verified against oxc-parser 0.137.0; decorators
  // AFTER `export`, as in `export @dec class`, are inside it and need no widening).
  let deleteStart = stmt.start;
  if (decl.type === 'ClassDeclaration') {
    for (const dec of decl.decorators) {
      if (dec.start < deleteStart) deleteStart = dec.start;
    }
  }
  const site: ExportSite = {
    kind: 'declaration',
    name: cand.name,
    exportStart: stmt.start,
    declStart: decl.start,
    statementEnd: stmt.end,
    deleteStart,
  };
  if (decl.type === 'VariableDeclaration' && cand.declaratorIndex !== undefined) {
    site.declarators = decl.declarations.map((d) => ({ start: d.start, end: d.end }));
    site.declaratorIndex = cand.declaratorIndex;
  }
  return site;
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
        const declaration = stmt.declaration;
        for (const cand of declarationNameCandidates(declaration)) {
          if (pos >= cand.start && pos < cand.end) {
            return declarationSite({ start: stmt.start, end: stmt.end, declaration }, cand);
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
        const declaration = stmt.declaration;
        for (const cand of declarationNameCandidates(declaration)) {
          if (cand.name === symbol) {
            return declarationSite({ start: stmt.start, end: stmt.end, declaration }, cand);
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

// Collects every top-level `export function NAME` statement sharing one name. A TS
// function overload set is N signature declarations (parsed as TSDeclareFunction)
// plus one implementation (FunctionDeclaration); knip reports a single 'exports'
// issue for the name, but TS requires every signature AND the implementation to
// agree on `export` (TS2383), so a fix that touches only the first statement leaves
// a non-compiling file. Returns every matching site; callers use the multi-element
// result to sweep the whole set and otherwise fall through to the single-site path.
export function findExportedFunctionSites(
  program: Program,
  symbol: string,
): Extract<ExportSite, { kind: 'declaration' }>[] {
  const sites: Extract<ExportSite, { kind: 'declaration' }>[] = [];
  for (const stmt of program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || !stmt.declaration) continue;
    const decl = stmt.declaration;
    if (decl.type !== 'FunctionDeclaration' && decl.type !== 'TSDeclareFunction') continue;
    if (decl.id && decl.id.type === 'Identifier' && decl.id.name === symbol) {
      // Functions can't carry decorators, so deleteStart == exportStart == stmt.start.
      sites.push({
        kind: 'declaration',
        name: symbol,
        exportStart: stmt.start,
        declStart: decl.start,
        statementEnd: stmt.end,
        deleteStart: stmt.start,
      });
    }
  }
  return sites;
}

// Finds a plain (non-exported) top-level declaration statement by its local name —
// used by deleteDeclaration for the `export { a, b }` case, where the exported
// binding and its declaration are two separate top-level statements.
export function findTopLevelDeclarationSpan(program: Program, name: string): Span | null {
  for (const stmt of program.body) {
    if (
      stmt.type === 'FunctionDeclaration' ||
      stmt.type === 'ClassDeclaration' ||
      stmt.type === 'TSTypeAliasDeclaration' ||
      stmt.type === 'TSInterfaceDeclaration' ||
      stmt.type === 'TSEnumDeclaration'
    ) {
      // A bare (non-exported) decorated class's statement span already includes
      // its decorators (verified against oxc-parser 0.137.0), so no widening is
      // needed here — only `@dec\nexport class` puts decorators outside the span.
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

// Removes item `index` from a comma-separated list of spans — export-list
// specifiers (`export { a, b, c }`, `export { a } from '...'`) and variable
// declarators (`export const a = 1, b = 2`) share the same comma hygiene: when
// removing anything but the last item, the range extends through the start of the
// next item (eating its own text plus the following ", "); when removing the last
// item, the range starts at the end of the previous one (eating the preceding ", "
// plus its own text). Callers must check `items.length > 1` first — a list becoming
// empty means the whole statement should be removed instead (both stripExport and
// deleteDeclaration need this, hence it lives here).
export function removeListItem(s: MagicString, items: readonly Span[], index: number): void {
  const isLast = index === items.length - 1;
  if (isLast) {
    const prev = items[index - 1];
    const cur = items[index];
    if (!prev || !cur) return;
    s.remove(prev.end, cur.end);
  } else {
    const cur = items[index];
    const next = items[index + 1];
    if (!cur || !next) return;
    s.remove(cur.start, next.start);
  }
}

// Generalizes removeListItem to a batch of removed indices from one
// comma-separated list, computed against ORIGINAL offsets. Comma hygiene:
// each removed item with a surviving successor removes [cur.start,
// next.start); a run of removed items at the END of the list collapses into
// ONE edit [lastSurvivor.end, lastRemoved.end) so the edits never overlap.
// Precondition: sortedIndices is ascending, non-empty, and a STRICT subset
// of items — callers turn the all-items case into a whole-statement removal.
export function removeListItems(
  items: readonly Span[],
  sortedIndices: readonly number[],
): (SourceEdit & { itemIndices: number[] })[] {
  const removed = new Set(sortedIndices);
  let firstTrailing = items.length;
  while (firstTrailing > 0 && removed.has(firstTrailing - 1)) firstTrailing--;
  const edits: (SourceEdit & { itemIndices: number[] })[] = [];
  for (const index of sortedIndices) {
    if (index >= firstTrailing) continue; // folded into the trailing-run edit below
    edits.push({ start: items[index]!.start, end: items[index + 1]!.start, itemIndices: [index] });
  }
  if (firstTrailing < items.length) {
    const lastSurvivor = items[firstTrailing - 1]!; // exists: strict subset
    const lastRemoved = items[items.length - 1]!;
    edits.push({
      start: lastSurvivor.end,
      end: lastRemoved.end,
      itemIndices: sortedIndices.filter((i) => i >= firstTrailing),
    });
  }
  return edits;
}

// Appends an edit, deduping byte-identical edits onto shared owners. Two ops
// can legitimately compute the SAME edit (both declarators of one statement
// being strip-exported; two export-list bindings deleting one shared local
// declaration; two tag ops resolving to one anchor) — one edit, all owners.
export function pushEdit(edits: BatchEdit[], edit: SourceEdit, owners: readonly number[]): void {
  const existing = edits.find((e) => e.start === edit.start && e.end === edit.end && e.text === edit.text);
  if (existing) {
    for (const owner of owners) if (!existing.owners.includes(owner)) existing.owners.push(owner);
    return;
  }
  const next: BatchEdit = { start: edit.start, end: edit.end, owners: [...owners] };
  if (edit.text !== undefined) next.text = edit.text;
  edits.push(next);
}

// Applies a set of non-overlapping edits to one MagicString: removal
// (no text), insertion (start===end), or replacement (start<end + text).
// Callers guarantee non-overlap (batch coordination + the compiler's
// conflict rule) — magic-string is never handed overlapping removals.
export function applyEdits(content: string, edits: readonly SourceEdit[]): string {
  const s = new MagicString(content);
  for (const edit of edits) {
    if (edit.text !== undefined && edit.start < edit.end) s.overwrite(edit.start, edit.end, edit.text);
    else if (edit.text !== undefined) s.appendLeft(edit.start, edit.text);
    else s.remove(edit.start, edit.end);
  }
  return s.toString();
}

// Adapts a batch transform to the legacy one-op TransformResult contract:
// parse, run the batch with a single op, apply its edits. The entire
// pre-batch test suite runs through this wrapper — it is the regression
// harness proving the batch functions reproduce single-op behavior exactly.
export function applySingleOp(
  filePath: string,
  content: string,
  op: SourceOp,
  batchFn: (parsed: ParsedSource, content: string, ops: readonly SourceOp[]) => SourceBatchResult,
): TransformResult {
  const parsed = parseSource(filePath, content);
  const { results, edits } = batchFn(parsed, content, [op]);
  const first = results[0]!;
  if (!first.ok) return first;
  return { ok: true, newContent: applyEdits(content, edits) };
}

// Attached-comment detection for deleteDeclaration: a comment is "attached" to a node
// if it sits immediately above it — nothing but horizontal whitespace and exactly one
// newline (LF or CRLF, matching the trailing-side handling below) between the
// comment's end and the (possibly already-expanded) start. Chains backward so a run
// of stacked comments (e.g. a `//` line comment directly above a JSDoc block, with
// no blank line between either) is all included.
export function expandStartWithLeadingComments(content: string, comments: Comment[], start: number): number {
  let cursor = start;
  let changed = true;
  while (changed) {
    changed = false;
    for (const comment of comments) {
      if (comment.end > cursor) continue;
      const between = content.slice(comment.end, cursor);
      if (!/^[ \t]*\r?\n[ \t]*$/.test(between)) continue;
      // The comment must also START its own line. Otherwise it's a TRAILING
      // comment on the previous statement (`const keep = 1; // note`) that merely
      // happens to sit one line above us — sweeping it into our deletion would eat
      // a neighbor's comment (confirmed bug). Only whitespace may precede it.
      if (!startsOwnLine(content, comment.start)) continue;
      cursor = comment.start;
      changed = true;
      break;
    }
  }
  return cursor;
}

// True when only horizontal whitespace separates `pos` from the start of its line
// (i.e. nothing but indentation precedes it) — the test for "this comment/token
// begins its own line" rather than trailing other code.
export function startsOwnLine(content: string, pos: number): boolean {
  const lineStart = content.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*$/.test(content.slice(lineStart, pos));
}

// Extends `end` through one trailing newline (LF or CRLF), if present, so deleting a
// statement doesn't leave a blank line behind.
export function expandEndWithTrailingNewline(content: string, end: number): number {
  if (content.startsWith('\r\n', end)) return end + 2;
  if (content[end] === '\n') return end + 1;
  return end;
}
