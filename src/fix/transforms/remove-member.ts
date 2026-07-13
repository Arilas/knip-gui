import MagicString from 'magic-string';
import type {
  Comment,
  Declaration,
  Directive,
  Program,
  Statement,
  TSEnumDeclaration,
  TSEnumMember,
  TSModuleBlock,
  TSModuleDeclaration,
} from 'oxc-parser';
import {
  expandEndWithTrailingNewline,
  expandStartWithLeadingComments,
  parseSource,
  type Span,
  type TransformInput,
  type TransformResult,
} from './source.js';

// Removes one member of an enum or namespace:
// - enum member -> remove the member + its comma (comma-hygiene mirrors
//   removeListItem's rule, but re-derived here rather than reused because enum
//   members commonly carry a same-line trailing `// comment` that
//   removeListItem's generic algorithm would mis-attribute across the boundary
//   — see `removeEnumMember` below).
// - namespace member -> remove the whole member statement (with attached
//   leading comments/JSDoc and its trailing newline), same rule deleteDeclaration
//   uses for a top-level statement.
//
// Parent (enum/namespace) is located by name only, at top level (bare or
// exported). The member is then located by name within that parent; `pos`, if
// given, only breaks ties between same-named members (this is deliberately
// looser than locateExport's strict "pos, then validate name" contract — see
// the brief: "Parent located by name, member by name within parent (pos as
// tiebreak)").
export function removeMember(input: TransformInput & { parentSymbol: string }): TransformResult {
  const { filePath, content, symbol, parentSymbol, pos } = input;
  const { program, comments } = parseSource(filePath, content);

  const parent = findParent(program, parentSymbol);
  if (!parent) return { ok: false, reason: `parent '${parentSymbol}' not found` };

  const s = new MagicString(content);

  if (parent.kind === 'enum') {
    const members = parent.decl.body.members;
    const index = findEnumMemberIndex(members, symbol, pos);
    if (index === -1) {
      return { ok: false, reason: `member '${symbol}' not found in enum '${parentSymbol}'` };
    }
    removeEnumMember(s, content, comments, members, index);
    return { ok: true, newContent: s.toString() };
  }

  const stmtSpan = findNamespaceMemberStatement(parent.decl.body.body, symbol, pos);
  if (!stmtSpan) {
    return { ok: false, reason: `member '${symbol}' not found in namespace '${parentSymbol}'` };
  }
  const from = expandStartWithLeadingComments(content, comments, stmtSpan.start);
  const to = expandEndWithTrailingNewline(content, stmtSpan.end);
  s.remove(from, to);
  return { ok: true, newContent: s.toString() };
}

type Parent =
  | { kind: 'enum'; decl: TSEnumDeclaration }
  | { kind: 'namespace'; decl: TSModuleDeclaration & { body: TSModuleBlock } };

// Matches the parent by name at top level, whether it's exported
// (`export enum X` / `export namespace X`) or bare (`enum X` / `namespace X`).
function findParent(program: Program, name: string): Parent | null {
  for (const stmt of program.body) {
    const decl: Statement | Declaration =
      stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
    if (decl.type === 'TSEnumDeclaration' && decl.id.name === name) {
      return { kind: 'enum', decl };
    }
    if (
      decl.type === 'TSModuleDeclaration' &&
      decl.id.type === 'Identifier' &&
      decl.id.name === name &&
      decl.body &&
      decl.body.type === 'TSModuleBlock'
    ) {
      return { kind: 'namespace', decl: decl as TSModuleDeclaration & { body: TSModuleBlock } };
    }
  }
  return null;
}

function enumMemberName(member: TSEnumMember): string {
  if (member.id.type === 'Identifier') return member.id.name;
  // `StringLiteral`'s AST discriminant is actually "Literal" (oxc-parser
  // 0.137.0 — both StringLiteral and NumericLiteral share `type: "Literal"`,
  // distinguished only by `value`'s runtime type), for e.g. `enum Foo { "a b" }`.
  if (member.id.type === 'Literal') return String(member.id.value);
  return '';
}

function findEnumMemberIndex(members: TSEnumMember[], symbol: string, pos?: number): number {
  const matches: number[] = [];
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    if (member && enumMemberName(member) === symbol) matches.push(i);
  }
  if (matches.length === 0) return -1;
  if (matches.length === 1) return matches[0]!;
  if (pos !== undefined) {
    const byPos = matches.find((i) => {
      const m = members[i]!;
      return pos >= m.start && pos < m.end;
    });
    if (byPos !== undefined) return byPos;
  }
  return matches[0]!;
}

// Extends `pos` (the end of a member's identifier/initializer) through its own
// trailing comma, then through a same-line trailing `//` comment, stopping
// before the newline. Used to compute exactly what "belongs" to one member's
// own line, so comma-hygiene removal doesn't bleed into a NEIGHBOR's trailing
// comment (see removeEnumMember).
function lineTrailingEnd(content: string, comments: Comment[], pos: number): number {
  let i = pos;
  if (content[i] === ',') i++;
  while (content[i] === ' ' || content[i] === '\t') i++;
  const comment = comments.find((c) => c.type === 'Line' && c.start === i);
  if (comment) i = comment.end;
  return i;
}

// Comma-hygiene for enum members, same shape as removeListItem (remove through
// the start of the next member; for the last member, remove from the end of
// the previous one) EXCEPT the last-member case is comment-aware: it uses
// `lineTrailingEnd` on both sides so a same-line trailing comment on the
// PREVIOUS (kept) member is never swept away, while the REMOVED member's own
// trailing comma + comment are. Plain removeListItem can't be reused here
// because its last-item branch removes `[prev.end, cur.end)` unconditionally —
// correct with no comments (verified against the real `used.ts` fixture below)
// but wrong once either member has a same-line trailing `//` comment.
function removeEnumMember(
  s: MagicString,
  content: string,
  comments: Comment[],
  members: TSEnumMember[],
  index: number,
): void {
  const cur = members[index];
  if (!cur) return;
  const isLast = index === members.length - 1;
  if (isLast) {
    const prev = members[index - 1];
    const from = prev ? lineTrailingEnd(content, comments, prev.end) : cur.start;
    const to = lineTrailingEnd(content, comments, cur.end);
    s.remove(from, to);
  } else {
    const next = members[index + 1];
    if (!next) return;
    s.remove(cur.start, next.start);
  }
}

// Mirrors source.ts's declarationNameCandidates, but returns plain names (not
// spans) for matching a namespace member by name — the whole enclosing
// statement is what gets deleted, not a sub-span within it.
function namedDeclCandidates(decl: Declaration): string[] {
  if (decl.type === 'VariableDeclaration') {
    return decl.declarations
      .filter((d) => d.id.type === 'Identifier')
      .map((d) => (d.id as { name: string }).name);
  }
  if ('id' in decl && decl.id && decl.id.type === 'Identifier') return [decl.id.name];
  return [];
}

function findNamespaceMemberStatement(
  body: (Directive | Statement)[],
  symbol: string,
  pos?: number,
): Span | null {
  const matches: Span[] = [];
  for (const stmt of body) {
    if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
      if (namedDeclCandidates(stmt.declaration).includes(symbol)) {
        matches.push({ start: stmt.start, end: stmt.end });
      }
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  if (pos !== undefined) {
    const byPos = matches.find((m) => pos >= m.start && pos < m.end);
    if (byPos) return byPos;
  }
  return matches[0]!;
}
