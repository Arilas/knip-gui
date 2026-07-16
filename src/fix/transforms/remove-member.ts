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
import type {
  ParsedSource,
  SourceBatchResult,
  SourceOp,
  Span,
  TransformInput,
  TransformResult,
} from './source.js';
import type { BatchEdit, BatchOpResult } from './source.js';
import {
  applySingleOp,
  expandEndWithTrailingNewline,
  expandStartWithLeadingComments,
  pushEdit,
  removeListItems,
} from './source.js';

// Removes one member of an enum or namespace:
// - enum member -> remove the member + its comma (comma-hygiene mirrors
//   removeListItems' rule, but re-derived here rather than reused because enum
//   members commonly carry a same-line trailing `// comment` that
//   removeListItems' generic algorithm would mis-attribute across the boundary
//   — see `removeMemberBatch` below).
// - namespace member -> remove the member declaration statement inside the
//   namespace body (with attached leading comments/JSDoc). A member that is one
//   declarator of a multi-declarator `export const a = 1, b = 2;` removes only
//   its own declarator (comma hygiene via removeListItems), never live siblings
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
// Multi-op boundaries: consecutive removed members/statements collapse into
// RUN edits so ranges never overlap; a trailing enum run is bounded by
// lineTrailingEnd on both sides (comment-aware).
export function removeMemberBatch(
  parsed: ParsedSource,
  content: string,
  ops: readonly SourceOp[],
): SourceBatchResult {
  const { program, comments } = parsed;
  const results: BatchOpResult[] = ops.map(() => ({ ok: true }));
  const edits: BatchEdit[] = [];

  interface EnumGroup {
    decl: TSEnumDeclaration;
    indexOwners: Map<number, number[]>; // member index -> op indexes
  }
  interface NsEntry {
    match: NamespaceMemberMatch;
    owners: number[];
    declaratorOwners: Map<number, number[]>; // declarator index -> op indexes
  }
  interface NsGroup {
    body: (Directive | Statement)[];
    entries: Map<number, NsEntry>; // keyed by bodyIndex
  }
  const enumGroups = new Map<number, EnumGroup>(); // keyed by enum decl start
  const nsGroups = new Map<number, NsGroup>(); // keyed by namespace decl start

  ops.forEach((op, opIndex) => {
    if (op.parentSymbol === undefined) {
      results[opIndex] = { ok: false, reason: 'remove-member requires a parentSymbol' };
      return;
    }
    const parent = findParent(program.body, op.parentSymbol);
    if (!parent) {
      results[opIndex] = { ok: false, reason: `parent '${op.parentSymbol}' not found` };
      return;
    }
    if (parent.kind === 'enum') {
      const index = findEnumMemberIndex(parent.decl.body.members, op.symbol, op.pos);
      if (index === -1) {
        results[opIndex] = { ok: false, reason: `member '${op.symbol}' not found in enum '${op.parentSymbol}'` };
        return;
      }
      const group = enumGroups.get(parent.decl.start) ?? { decl: parent.decl, indexOwners: new Map() };
      group.indexOwners.set(index, [...(group.indexOwners.get(index) ?? []), opIndex]);
      enumGroups.set(parent.decl.start, group);
      return;
    }
    const match = findNamespaceMember(parent.decl.body.body, op.symbol, op.pos);
    if (!match) {
      results[opIndex] = {
        ok: false,
        reason: `member '${op.symbol}' not found in namespace '${op.parentSymbol}'`,
      };
      return;
    }
    const group = nsGroups.get(parent.decl.start) ?? { body: parent.decl.body.body, entries: new Map() };
    const entry = group.entries.get(match.bodyIndex) ?? { match, owners: [], declaratorOwners: new Map() };
    entry.owners.push(opIndex);
    if (match.declarators && match.declarators.length > 1 && match.declaratorIndex !== undefined) {
      entry.declaratorOwners.set(match.declaratorIndex, [
        ...(entry.declaratorOwners.get(match.declaratorIndex) ?? []),
        opIndex,
      ]);
    }
    group.entries.set(match.bodyIndex, entry);
    nsGroups.set(parent.decl.start, group);
  });

  // --- enum edits: runs of consecutive removed members ---
  for (const group of enumGroups.values()) {
    const members = group.decl.body.members;
    const sorted = [...group.indexOwners.keys()].sort((a, b) => a - b);
    const runs: number[][] = [];
    for (const index of sorted) {
      const run = runs[runs.length - 1];
      if (run && run[run.length - 1] === index - 1) run.push(index);
      else runs.push([index]);
    }
    for (const run of runs) {
      const first = members[run[0]!]!;
      const last = members[run[run.length - 1]!]!;
      const owners = run.flatMap((index) => group.indexOwners.get(index)!);
      if (run[run.length - 1]! < members.length - 1) {
        // A member survives after the run: the single-op non-last rule,
        // applied to the whole run (own-line leading comments swept in,
        // bounded at the survivor's start so it keeps its indentation).
        pushEdit(
          edits,
          {
            start: expandStartWithLeadingComments(content, comments, first.start),
            end: members[run[run.length - 1]! + 1]!.start,
          },
          owners,
        );
      } else {
        // Trailing run: comment-aware on both sides. The previous survivor's
        // same-line trailing comment stays; the removed members' commas and
        // trailing comments go. No previous survivor (whole list removed):
        // a single sole member keeps the old single-op range byte-for-byte;
        // a longer run sweeps the first member's leading comments too.
        const prev = members[run[0]! - 1];
        const start = prev
          ? lineTrailingEnd(content, comments, prev.end)
          : run.length === 1
            ? first.start
            : expandStartWithLeadingComments(content, comments, first.start);
        pushEdit(edits, { start, end: lineTrailingEnd(content, comments, last.end) }, owners);
      }
    }
  }

  // --- namespace edits ---
  for (const group of nsGroups.values()) {
    const fullRemovals: { bodyIndex: number; match: NamespaceMemberMatch; owners: number[] }[] = [];
    for (const [bodyIndex, entry] of group.entries) {
      const declarators = entry.match.declarators;
      const isPartial =
        declarators !== undefined &&
        declarators.length > 1 &&
        entry.declaratorOwners.size > 0 &&
        entry.declaratorOwners.size < declarators.length;
      if (isPartial) {
        // A strict subset of one statement's declarators: comma hygiene,
        // never touching live siblings — same rule as top level.
        const indices = [...entry.declaratorOwners.keys()].sort((a, b) => a - b);
        for (const removal of removeListItems(declarators, indices)) {
          pushEdit(
            edits,
            { start: removal.start, end: removal.end },
            removal.itemIndices.flatMap((i) => entry.declaratorOwners.get(i)!),
          );
        }
      } else {
        fullRemovals.push({ bodyIndex, match: entry.match, owners: entry.owners });
      }
    }
    fullRemovals.sort((a, b) => a.bodyIndex - b.bodyIndex);
    let run: typeof fullRemovals = [];
    const flush = (): void => {
      if (run.length === 0) return;
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const owners = run.flatMap((r) => r.owners);
      const from = expandStartWithLeadingComments(content, comments, first.match.stmt.start);
      const nextStmt = group.body[last.bodyIndex + 1];
      if (nextStmt) {
        // Bound at the next (surviving) statement's start so the survivor
        // keeps exactly one indentation — same rule as the single-op path.
        pushEdit(edits, { start: from, end: nextStmt.start }, owners);
      } else {
        pushEdit(
          edits,
          { start: from, end: expandEndWithTrailingNewline(content, last.match.stmt.end) },
          owners,
        );
      }
      run = [];
    };
    for (const removal of fullRemovals) {
      if (run.length > 0 && run[run.length - 1]!.bodyIndex !== removal.bodyIndex - 1) flush();
      run.push(removal);
    }
    flush();
  }

  return { results, edits };
}

export function removeMember(input: TransformInput & { parentSymbol: string }): TransformResult {
  return applySingleOp(
    input.filePath,
    input.content,
    { symbol: input.symbol, pos: input.pos, parentSymbol: input.parentSymbol },
    removeMemberBatch,
  );
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
// comment (see removeMemberBatch's enum trailing-run edit).
function lineTrailingEnd(content: string, comments: Comment[], pos: number): number {
  let i = pos;
  if (content[i] === ',') i++;
  while (content[i] === ' ' || content[i] === '\t') i++;
  const comment = comments.find((c) => c.type === 'Line' && c.start === i);
  if (comment) i = comment.end;
  return i;
}

interface NamespaceMemberMatch {
  // Span of the whole member statement (`export const ... ;` inside the body).
  stmt: Span;
  // Index of the member statement in its namespace body — run/boundary math.
  bodyIndex: number;
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
      const match: NamespaceMemberMatch = {
        stmt: { start: stmt.start, end: stmt.end },
        bodyIndex: i,
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
