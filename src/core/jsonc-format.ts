import type { FormattingOptions } from 'jsonc-parser';

// jsonc-parser's `modify` only reformats the touched region (see its `withFormatting`
// helper), using whatever `FormattingOptions` the caller passes — it does NOT infer
// them from the document. To keep edits byte-exact everywhere except the actual
// change, we detect the file's own indentation/EOL style and feed it back in, so the
// "reformat" of the touched region is a no-op everywhere it already matches.
//
// Detection: scan for the smallest space-indent among lines that look like an
// indented JSON property (`  "key"`) — the smallest is the base indent step, since
// deeper nesting is a multiple of it. Tabs win outright if any line starts with one
// (mixed tab/space files aren't a real-world case worth optimizing for).
export function detectFormatting(content: string): FormattingOptions {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  if (/^\t/m.test(content)) return { tabSize: 1, insertSpaces: false, eol };
  const indents = [...content.matchAll(/^( +)"/gm)].map((m) => m[1]!.length);
  const tabSize = indents.length > 0 ? Math.min(...indents) : 2;
  return { tabSize, insertSpaces: true, eol };
}
