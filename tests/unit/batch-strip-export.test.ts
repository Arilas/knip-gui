import { describe, expect, it } from 'vitest';
import { stripExportBatch } from '../../src/fix/transforms/strip-export.js';
import {
  applyEdits,
  parseSource,
  removeListItems,
  type SourceOp,
} from '../../src/fix/transforms/source.js';

function run(content: string, ops: SourceOp[]) {
  const parsed = parseSource('a.ts', content);
  const { results, edits } = stripExportBatch(parsed, content, ops);
  return { results, out: applyEdits(content, edits) };
}

describe('removeListItems: generalized comma hygiene', () => {
  // spans of 'a', 'b', 'c' in the string 'a, b, c'
  const items = [
    { start: 0, end: 1 },
    { start: 3, end: 4 },
    { start: 6, end: 7 },
  ];

  it('single non-last index removes through the next item start', () => {
    expect(removeListItems(items, [1])).toEqual([{ start: 3, end: 6, itemIndices: [1] }]);
  });

  it('single last index removes from the previous survivor end', () => {
    expect(removeListItems(items, [2])).toEqual([{ start: 4, end: 7, itemIndices: [2] }]);
  });

  it('non-adjacent subset: one edit per non-trailing item plus a trailing-run edit', () => {
    expect(removeListItems(items, [0, 2])).toEqual([
      { start: 0, end: 3, itemIndices: [0] },
      { start: 4, end: 7, itemIndices: [2] },
    ]);
  });

  it('a trailing run collapses into a single edit owned by every removed item', () => {
    expect(removeListItems(items, [1, 2])).toEqual([{ start: 1, end: 7, itemIndices: [1, 2] }]);
  });
});

describe('stripExportBatch: multiple ops, one parse', () => {
  it('strips two declarations, each op using its own original pos', () => {
    const content = 'export const a = 1;\nexport const b = 2;\n';
    const { results, out } = run(content, [
      { symbol: 'a', pos: content.indexOf('a = 1') },
      { symbol: 'b', pos: content.indexOf('b = 2') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('removes a subset of an export list with comma hygiene (first + last)', () => {
    const content =
      'function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\nexport { a, b, c };\n';
    const { results, out } = run(content, [
      { symbol: 'a', pos: content.indexOf('a, b') },
      { symbol: 'c', pos: content.indexOf('c }') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe(
      'function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\nexport { b };\n',
    );
  });

  it('removes an adjacent middle run from a re-export list', () => {
    const content = "export { a, b, c, d } from './m.js';\n";
    const { results, out } = run(content, [
      { symbol: 'b', pos: content.indexOf('b,') },
      { symbol: 'c', pos: content.indexOf('c,') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe("export { a, d } from './m.js';\n");
  });

  it('ops that together empty a list remove the whole statement', () => {
    const content = "export { a, b } from './m.js';\n";
    const { results, out } = run(content, [
      { symbol: 'a', pos: content.indexOf('a,') },
      { symbol: 'b', pos: content.indexOf('b }') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('\n');
  });

  it('two declarator ops on one multi-declarator statement dedupe into one unexport', () => {
    const content = 'export const a = 1, b = 2;\n';
    const { results, out } = run(content, [
      { symbol: 'a', pos: content.indexOf('a = 1') },
      { symbol: 'b', pos: content.indexOf('b = 2') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('const a = 1, b = 2;\n');
  });

  it('a failing op does not disturb its neighbors', () => {
    const content = 'export const a = 1;\nexport const b = 2;\n';
    const { results, out } = run(content, [
      { symbol: 'nope', pos: 999 },
      { symbol: 'b', pos: content.indexOf('b = 2') },
    ]);
    expect(results[0]).toEqual({ ok: false, reason: 'no export found at position 999' });
    expect(results[1]).toEqual({ ok: true });
    expect(out).toBe('export const a = 1;\nconst b = 2;\n');
  });
});
