import type { Comment } from 'oxc-parser';
import { locateMemberAnchor } from '../fix/transforms/remove-member.js';
import type {
  ParsedSource,
  SourceBatchResult,
  SourceEdit,
  SourceOp,
  TransformInput,
  TransformResult,
} from '../fix/transforms/source.js';
import type { BatchEdit, BatchOpResult } from '../fix/transforms/source.js';
import {
  applySingleOp,
  findTopLevelDeclarationSpan,
  locateExport,
  pushEdit,
  startsOwnLine,
} from '../fix/transforms/source.js';

// Tags a declaration as intentionally public (exempt from further unused-export
// nagging) by inserting `@public` into its JSDoc — creating one if none exists.
// Used by the ignore engine (Task 6: `export`/`type` issues -> insertPublicTag
// patches) as an alternative to removing the code.
//
// - Direct `export const/function/class/type/interface/enum X` -> tag goes
//   above the whole construct (decorators included, via the located site's
//   `deleteStart`, same anchor stripExport/deleteDeclaration use for sweeping).
// - `export { a, b }` list binding -> tag goes above the LOCAL declaration
//   (`a`'s own `function`/`class`/... statement), not the export-list
//   statement itself — a re-export (`export { x } from './y.js'`, no local
//   declaration to tag) fails with `ok:false`.
// - `export default ...` -> tag goes above the whole statement.
export function insertPublicTagBatch(
  parsed: ParsedSource,
  content: string,
  ops: readonly SourceOp[],
): SourceBatchResult {
  const { program, comments } = parsed;
  const results: BatchOpResult[] = ops.map(() => ({ ok: true }));
  const edits: BatchEdit[] = [];
  ops.forEach((op, opIndex) => {
    const located = locateExport(program, op.symbol, op.pos);
    if ('error' in located) {
      results[opIndex] = { ok: false, reason: located.error };
      return;
    }
    const site = located.site;
    let anchor: number;
    if (site.kind === 'declaration') {
      anchor = site.deleteStart;
    } else if (site.kind === 'default') {
      anchor = site.statementStart;
    } else {
      if (site.isReexport) {
        results[opIndex] = {
          ok: false,
          reason: `symbol '${op.symbol}' is a re-export with no local declaration to tag`,
        };
        return;
      }
      const localSpan = findTopLevelDeclarationSpan(program, site.localName);
      if (!localSpan) {
        results[opIndex] = { ok: false, reason: `no local declaration found for '${site.localName}'` };
        return;
      }
      anchor = localSpan.start;
    }
    const edit = publicTagEditAtAnchor(content, comments, anchor);
    // Two ops resolving to one anchor produce one identical insertion —
    // pushEdit dedupes it (batch-internal idempotency).
    if (edit) pushEdit(edits, edit, [opIndex]);
  });
  return { results, edits };
}

export function insertPublicTag(input: TransformInput): TransformResult {
  return applySingleOp(input.filePath, input.content, { symbol: input.symbol, pos: input.pos }, insertPublicTagBatch);
}

// Tags ONE member of an enum or namespace as @public — knip's per-member tag
// detection reads the jsDocTags at the MEMBER's own position (verified live:
// knip's analyze pass extracts getJSDocTags(member) per member, while a tag on
// the parent enum/namespace declaration suppresses ALL of its members). So the
// per-member ignore must insert `/** @public */` above the member's own line,
// never above the parent. Member location reuses removeMember's machinery
// (parent by name — top-level or nested, bare or exported — member by name
// within it, `pos` only as a same-name tiebreak); JSDoc creation/merge and
// idempotency follow exactly the same rules as insertPublicTag.
export function insertMemberPublicTagBatch(
  parsed: ParsedSource,
  content: string,
  ops: readonly SourceOp[],
): SourceBatchResult {
  const { program, comments } = parsed;
  const results: BatchOpResult[] = ops.map(() => ({ ok: true }));
  const edits: BatchEdit[] = [];
  ops.forEach((op, opIndex) => {
    if (op.parentSymbol === undefined) {
      results[opIndex] = { ok: false, reason: 'member public tag requires a parentSymbol' };
      return;
    }
    const located = locateMemberAnchor(program, op.parentSymbol, op.symbol, op.pos);
    if ('error' in located) {
      results[opIndex] = { ok: false, reason: located.error };
      return;
    }
    const edit = publicTagEditAtAnchor(content, comments, located.anchor);
    if (edit) pushEdit(edits, edit, [opIndex]);
  });
  return { results, edits };
}

export function insertMemberPublicTag(
  input: TransformInput & { parentSymbol: string },
): TransformResult {
  return applySingleOp(
    input.filePath,
    input.content,
    { symbol: input.symbol, pos: input.pos, parentSymbol: input.parentSymbol },
    insertMemberPublicTagBatch,
  );
}

// Computes the SourceEdit that inserts `@public` into the JSDoc attached
// directly above `anchor` (creating a fresh `/** @public */` line when
// none exists), or null when the JSDoc already documents @public
// (idempotent no-op). Shared by insertPublicTagBatch (top-level declarations)
// and insertMemberPublicTagBatch (enum/namespace members) — the two differ
// only in how the anchor is located.
function publicTagEditAtAnchor(content: string, comments: Comment[], anchor: number): SourceEdit | null {
  // Per-file newline convention, used both for a fresh `/** @public */` line
  // and for the new `* @public` line merged into an existing JSDoc.
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  const existing = findAdjacentJSDoc(content, comments, anchor);
  if (existing) {
    // Idempotent: this node's JSDoc already documents @public -> no-op.
    if (/@public\b/.test(existing.value)) return null;
    // Comment span includes the delimiters (verified against oxc-parser
    // 0.137.0: `end` lands exactly after the closing `*/`), so `end - 2` is the
    // start of the closing `*/` itself.
    const closingStart = existing.end - 2;
    const isSingleLine = !content.slice(existing.start, existing.end).includes('\n');
    const commentLineStart = lastLineStart(content, existing.start);
    const commentIndent = content.slice(commentLineStart, existing.start);
    if (isSingleLine && /^[ \t]*$/.test(commentIndent)) {
      // Single-line JSDoc (`/** Doc. */`) on its own line: expand to the
      // canonical multi-line form with @public added, matching the comment's
      // own indentation. (Chosen over an inline ` @public */` insertion: the
      // multi-line form is the canonical JSDoc-tag shape, unambiguous to every
      // downstream tag parser.)
      const inner = existing.value.replace(/^\*/, '').trim();
      const innerLine = inner === '' ? '' : `${commentIndent} * ${inner}${nl}`;
      return {
        start: existing.start,
        end: existing.end,
        text: `/**${nl}${innerLine}${commentIndent} * @public${nl}${commentIndent} */`,
      };
    }
    const closingLineStart = lastLineStart(content, closingStart);
    const closingPrefix = content.slice(closingLineStart, closingStart);
    if (/^[ \t]*$/.test(closingPrefix)) {
      // Closing `*/` on its own line (the normal multi-line JSDoc shape):
      // insert a `* @public` line just above it, reusing that line's existing
      // indentation so the new line matches the JSDoc's style.
      return { start: closingLineStart, end: closingLineStart, text: `${closingPrefix}* @public${nl}` };
    }
    // Closing `*/` shares its line with comment text (e.g. `/**\n * Doc. */`,
    // or a single-line JSDoc not starting its own line): inserting a whole
    // line here would split the comment mid-text, so fall back to an inline
    // `@public ` right before the `*/`.
    const before = content[closingStart - 1] ?? '';
    const pad = before === ' ' || before === '\t' ? '' : ' ';
    return { start: closingStart, end: closingStart, text: `${pad}@public ` };
  }
  const lineStart = lastLineStart(content, anchor);
  const indent = content.slice(lineStart, anchor);
  return { start: lineStart, end: lineStart, text: `${indent}/** @public */${nl}` };
}

// Finds the single Block comment directly attached above `start` — only
// horizontal whitespace and exactly one newline between the comment's end and
// `start` (same adjacency rule as source.ts's expandStartWithLeadingComments)
// — that also looks like JSDoc: a Block comment whose `value` starts with the
// extra `*` that makes `/*` into `/**` (oxc's comment `value` is the text
// between the delimiters, so `/**\n * Doc.\n */` has value `"*\n * Doc.\n "`).
// A plain `//` or non-JSDoc `/* */` comment directly above is NOT treated as
// "existing JSDoc" — a fresh `/** @public */` line is inserted between it and
// the declaration instead.
function findAdjacentJSDoc(content: string, comments: Comment[], start: number): Comment | null {
  for (const comment of comments) {
    if (comment.end > start) continue;
    const between = content.slice(comment.end, start);
    if (
      /^[ \t]*\r?\n[ \t]*$/.test(between) &&
      // Must start its own line — a same-line trailing JSDoc on the previous
      // statement (`const keep = 1; /** doc */`) is not OUR JSDoc; merging
      // @public into it would mutate a neighbor's doc comment.
      startsOwnLine(content, comment.start) &&
      comment.type === 'Block' &&
      comment.value.startsWith('*')
    ) {
      return comment;
    }
  }
  return null;
}

// Start of the line containing `pos` (index right after the nearest preceding
// `\n`, or 0 at the start of the file).
function lastLineStart(content: string, pos: number): number {
  let i = pos;
  while (i > 0 && content[i - 1] !== '\n') i--;
  return i;
}
