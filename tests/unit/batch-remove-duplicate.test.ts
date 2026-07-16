import { describe, expect, it } from 'vitest';
import { removeDuplicateBatch } from '../../src/fix/transforms/remove-duplicate.js';
import { applyEdits, parseSource, type SourceOp } from '../../src/fix/transforms/source.js';

function run(content: string, ops: SourceOp[]) {
  const parsed = parseSource('a.ts', content);
  const { results, edits } = removeDuplicateBatch(parsed, content, ops);
  return { results, out: applyEdits(content, edits) };
}

describe('removeDuplicateBatch: multi-alias groups', () => {
  it('removes two aliasing statements (one with an attached comment), keeping the canonical', () => {
    const content =
      'export const src = 1;\nexport const alias1 = src;\n// alias2 doc\nexport const alias2 = src;\n';
    const { results, out } = run(content, [
      { symbol: 'alias1', pos: content.indexOf('alias1') },
      { symbol: 'alias2', pos: content.indexOf('alias2 =') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('export const src = 1;\n');
  });

  it('removes every alias specifier of one list -> whole statement', () => {
    const content = 'export const original = 1;\nexport { original as a1, original as a2 };\n';
    const { results, out } = run(content, [
      { symbol: 'a1', pos: content.indexOf('original as a1') },
      { symbol: 'a2', pos: content.indexOf('original as a2') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('export const original = 1;\n');
  });

  it('removes a subset of alias specifiers with comma hygiene', () => {
    const content =
      'export const original = 1;\nexport { original as a1, original as a2, original as a3 };\n';
    const { out } = run(content, [
      { symbol: 'a1', pos: content.indexOf('original as a1') },
      { symbol: 'a3', pos: content.indexOf('original as a3') },
    ]);
    expect(out).toBe('export const original = 1;\nexport { original as a2 };\n');
  });
});
