import MagicString from 'magic-string';
import type { Comment } from 'oxc-parser';
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
    // start of the closing `*/` itself; `indent` is whatever horizontal
    // whitespace already precedes it on its own line, reused so the new
    // `* @public` line matches the JSDoc's existing indentation style.
    const closingLineStart = lastLineStart(content, existing.end - 2);
    const indent = content.slice(closingLineStart, existing.end - 2);
    s.appendLeft(closingLineStart, `${indent}* @public${nl}`);
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
