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
  removeListItem,
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
// - namespace member -> remove the member declaration statement inside the
//   namespace body (with attached leading comments/JSDoc). A member that is one
//   declarator of a multi-declarator `export const a = 1, b = 2;` removes only
//   its own declarator (comma hygiene via removeListItem), never live siblings
//   — same rule Task 3's deleteDeclaration applies at top level. Removal of a
//   non-last member statement is bounded at the NEXT statement's start (like
//   the enum path) so the survivor keeps exactly its own indentation; the last
//   member statement removes through its trailing newline.
//
// Parent (enum/namespace) is located by name only — top level or nested inside
// namespace bodies, bare or exported. The member is then located by name
// within that parent; `pos`, if given, only breaks ties between same-named
// members (this is deliberately looser than locateExport's strict "pos, then
// validate name" contract — see the brief: "Parent located by name, member by
// name within parent (pos as tiebreak)").
export function removeMember(input: TransformInput & { parentSymbol: string }): TransformResult {
  const { filePath, content, symbol, parentSymbol, pos } = input;
  const { program, comments } = parseSource(filePath, content);

  const parent = findParent(program.body, parentSymbol);
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

  const match = findNamespaceMember(parent.decl.body.body, symbol, pos);
  if (!match) {
    return { ok: false, reason: `member '${symbol}' not found in namespace '${parentSymbol}'` };
  }
  if (match.declarators && match.declarators.length > 1 && match.declaratorIndex !== undefined) {
    // One declarator of `export const a = 1, b = 2;` — surgically remove just
    // it (same comma-hygiene helper as export lists and top-level declarators).
    removeListItem(s, match.declarators, match.declaratorIndex);
    return { ok: true, newContent: s.toString() };
  }
  const from = expandStartWithLeadingComments(content, comments, match.stmt.start);
  if (match.next) {
    // Non-last member: bound the removal at the next statement's start — the
    // removed member's own leading indentation is left in place and becomes
    // the survivor's indentation (whose own indent is consumed with the rest
    // of the removed range), exactly like the enum path's non-last rule.
    // Removing "statement + its trailing newline" here instead would splice
    // the leftover indent onto the survivor's line, doubling its indentation.
    s.remove(from, match.next.start);
  } else {
    s.remove(from, expandEndWithTrailingNewline(content, match.stmt.end));
  }
  return { ok: true, newContent: s.toString() };
}

// Locates a member's anchor — the start offset of the enum member itself, or
// of the whole member statement inside a namespace body — without removing
// anything. Shares removeMember's parent/member matching rules exactly
// (parent by name, member by name within parent, `pos` only as a tiebreak
// between same-named members). Used by the ignore engine's
// insertMemberPublicTag, which needs to point AT a member to tag it @public.
export function locateMemberAnchor(
  program: Program,
  parentSymbol: string,
  symbol: string,
  pos?: number,
): { anchor: number } | { error: string } {
  const parent = findParent(program.body, parentSymbol);
  if (!parent) return { error: `parent '${parentSymbol}' not found` };
  if (parent.kind === 'enum') {
    const members = parent.decl.body.members;
    const index = findEnumMemberIndex(members, symbol, pos);
    if (index === -1) return { error: `member '${symbol}' not found in enum '${parentSymbol}'` };
    return { anchor: members[index]!.start };
  }
  const match = findNamespaceMember(parent.decl.body.body, symbol, pos);
  if (!match) return { error: `member '${symbol}' not found in namespace '${parentSymbol}'` };
  return { anchor: match.stmt.start };
}

type Parent =
  | { kind: 'enum'; decl: TSEnumDeclaration }
  | { kind: 'namespace'; decl: TSModuleDeclaration & { body: TSModuleBlock } };

// Matches the parent by name, whether it's exported (`export enum X` /
// `export namespace X`) or bare (`enum X` / `namespace X`), searching top-level
// statements first and then recursing into namespace bodies (depth-first,
// source order) so members of a nested `namespace Outer { namespace Inner {} }`
// are reachable by the inner parent's name.
function findParent(body: (Directive | Statement)[], name: string): Parent | null {
  for (const stmt of body) {
    const decl: Directive | Statement | Declaration =
      stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
    if (decl.type === 'TSEnumDeclaration' && decl.id.name === name) {
      return { kind: 'enum', decl };
    }
    if (decl.type === 'TSModuleDeclaration' && decl.body && decl.body.type === 'TSModuleBlock') {
      if (decl.id.type === 'Identifier' && decl.id.name === name) {
        return { kind: 'namespace', decl: decl as TSModuleDeclaration & { body: TSModuleBlock } };
      }
      const nested = findParent(decl.body.body, name);
      if (nested) return nested;
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
    // The last-member range starts at the previous member's own line-trailing end,
    // so cur's own leading comment (which sits between prev and cur) is already
    // swept in; prev's trailing comment stays put.
    const prev = members[index - 1];
    const from = prev ? lineTrailingEnd(content, comments, prev.end) : cur.start;
    const to = lineTrailingEnd(content, comments, cur.end);
    s.remove(from, to);
  } else {
    const next = members[index + 1];
    if (!next) return;
    // Take cur's own-line leading JSDoc/comments with it — otherwise they orphan
    // onto the following member. expandStartWithLeadingComments' own-line guard
    // keeps a same-line trailing comment on the PREVIOUS member out of the range.
    const from = expandStartWithLeadingComments(content, comments, cur.start);
    s.remove(from, next.start);
  }
}

interface NamespaceMemberMatch {
  // Span of the whole member statement (`export const ... ;` inside the body).
  stmt: Span;
  // The statement FOLLOWING the member in the namespace body, if any — used to
  // bound a non-last member's removal so the survivor's indentation survives.
  next: Span | null;
  // Present when the member's declaration is a VariableDeclaration and the
  // matched symbol is one of its declarators (same contract as source.ts's
  // 'declaration' ExportSite: spans of ALL declarators + which one matched).
  declarators?: Span[];
  declaratorIndex?: number;
}

// Mirrors source.ts's declarationNameCandidates: one candidate per simple
// Identifier binding, with `declaratorIndex` set when the candidate is one
// declarator of a (possibly multi-declarator) variable declaration.
function namedDeclCandidates(decl: Declaration): { name: string; declaratorIndex?: number }[] {
  if (decl.type === 'VariableDeclaration') {
    const out: { name: string; declaratorIndex: number }[] = [];
    for (let i = 0; i < decl.declarations.length; i++) {
      const d = decl.declarations[i];
      if (d && d.id.type === 'Identifier') out.push({ name: d.id.name, declaratorIndex: i });
    }
    return out;
  }
  if ('id' in decl && decl.id && decl.id.type === 'Identifier') return [{ name: decl.id.name }];
  return [];
}

function findNamespaceMember(
  body: (Directive | Statement)[],
  symbol: string,
  pos?: number,
): NamespaceMemberMatch | null {
  const matches: NamespaceMemberMatch[] = [];
  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];
    if (!stmt || stmt.type !== 'ExportNamedDeclaration' || !stmt.declaration) continue;
    const decl = stmt.declaration;
    for (const cand of namedDeclCandidates(decl)) {
      if (cand.name !== symbol) continue;
      const nextStmt = body[i + 1];
      const match: NamespaceMemberMatch = {
        stmt: { start: stmt.start, end: stmt.end },
        next: nextStmt ? { start: nextStmt.start, end: nextStmt.end } : null,
      };
      if (decl.type === 'VariableDeclaration' && cand.declaratorIndex !== undefined) {
        match.declarators = decl.declarations.map((d) => ({ start: d.start, end: d.end }));
        match.declaratorIndex = cand.declaratorIndex;
      }
      matches.push(match);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  if (pos !== undefined) {
    const byPos = matches.find((m) => pos >= m.stmt.start && pos < m.stmt.end);
    if (byPos) return byPos;
  }
  return matches[0]!;
}
