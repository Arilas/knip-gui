import MagicString from 'magic-string';
import type { Comment } from 'oxc-parser';
import { locateMemberAnchor } from '../fix/transforms/remove-member.js';
import {
  findTopLevelDeclarationSpan,
  locateExport,
  parseSource,
  type TransformInput,
  type TransformResult,
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
export function insertPublicTag(input: TransformInput): TransformResult {
  const { filePath, content, symbol, pos } = input;
  const { program, comments } = parseSource(filePath, content);
  const located = locateExport(program, symbol, pos);
  if ('error' in located) return { ok: false, reason: located.error };
  const site = located.site;

  let anchor: number;
  if (site.kind === 'declaration') {
    anchor = site.deleteStart;
  } else if (site.kind === 'default') {
    anchor = site.statementStart;
  } else {
    if (site.isReexport) {
      return {
        ok: false,
        reason: `symbol '${symbol}' is a re-export with no local declaration to tag`,
      };
    }
    const localSpan = findTopLevelDeclarationSpan(program, site.localName);
    if (!localSpan) {
      return {
        ok: false,
        reason: `no local declaration found for '${site.localName}'`,
      };
    }
    anchor = localSpan.start;
  }

  return applyPublicTagAtAnchor(content, comments, anchor);
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
export function insertMemberPublicTag(
  input: TransformInput & { parentSymbol: string },
): TransformResult {
  const { filePath, content, symbol, parentSymbol, pos } = input;
  const { program, comments } = parseSource(filePath, content);
  const located = locateMemberAnchor(program, parentSymbol, symbol, pos);
  if ('error' in located) return { ok: false, reason: located.error };
  return applyPublicTagAtAnchor(content, comments, located.anchor);
}

// Inserts `@public` into the JSDoc attached directly above `anchor`, creating
// a fresh `/** @public */` line (matching the anchor line's indentation) when
// no JSDoc exists. Idempotent: an existing JSDoc already documenting @public
// is returned untouched. Shared by insertPublicTag (top-level declarations)
// and insertMemberPublicTag (enum/namespace members) — the two differ only in
// how the anchor is located.
function applyPublicTagAtAnchor(
  content: string,
  comments: Comment[],
  anchor: number,
): TransformResult {
  // Per-file newline convention, used both for a fresh `/** @public */` line
  // and for the new `* @public` line merged into an existing JSDoc.
  const nl = content.includes('\r\n') ? '\r\n' : '\n';

  const existing = findAdjacentJSDoc(content, comments, anchor);
  if (existing) {
    // Idempotent: this node's JSDoc already documents @public -> no-op.
    if (/@public\b/.test(existing.value)) {
      return { ok: true, newContent: content };
    }
    const s = new MagicString(content);
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
      s.overwrite(
        existing.start,
        existing.end,
        `/**${nl}${innerLine}${commentIndent} * @public${nl}${commentIndent} */`,
      );
      return { ok: true, newContent: s.toString() };
    }
    const closingLineStart = lastLineStart(content, closingStart);
    const closingPrefix = content.slice(closingLineStart, closingStart);
    if (/^[ \t]*$/.test(closingPrefix)) {
      // Closing `*/` on its own line (the normal multi-line JSDoc shape):
      // insert a `* @public` line just above it, reusing that line's existing
      // indentation so the new line matches the JSDoc's style.
      s.appendLeft(closingLineStart, `${closingPrefix}* @public${nl}`);
    } else {
      // Closing `*/` shares its line with comment text (e.g. `/**\n * Doc. */`,
      // or a single-line JSDoc not starting its own line): inserting a whole
      // line here would split the comment mid-text, so fall back to an inline
      // `@public ` right before the `*/`.
      const before = content[closingStart - 1] ?? '';
      const pad = before === ' ' || before === '\t' ? '' : ' ';
      s.appendLeft(closingStart, `${pad}@public `);
    }
    return { ok: true, newContent: s.toString() };
  }

  const s = new MagicString(content);
  const lineStart = lastLineStart(content, anchor);
  const indent = content.slice(lineStart, anchor);
  s.appendLeft(lineStart, `${indent}/** @public */${nl}`);
  return { ok: true, newContent: s.toString() };
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
