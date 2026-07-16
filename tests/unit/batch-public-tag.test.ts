import { describe, expect, it } from 'vitest';
import { insertMemberPublicTagBatch, insertPublicTagBatch } from '../../src/ignore/public-tag.js';
import { applyEdits, parseSource, type SourceOp } from '../../src/fix/transforms/source.js';

function runTop(content: string, ops: SourceOp[]) {
  const parsed = parseSource('a.ts', content);
  const { results, edits } = insertPublicTagBatch(parsed, content, ops);
  return { results, edits, out: applyEdits(content, edits) };
}

function runMember(content: string, ops: SourceOp[]) {
  const parsed = parseSource('a.ts', content);
  const { results, edits } = insertMemberPublicTagBatch(parsed, content, ops);
  return { results, edits, out: applyEdits(content, edits) };
}

describe('insertPublicTagBatch', () => {
  it('tags two declarations from one parse', () => {
    const content = 'export const a = 1;\nexport const b = 2;\n';
    const { results, out } = runTop(content, [
      { symbol: 'a', pos: content.indexOf('a = 1') },
      { symbol: 'b', pos: content.indexOf('b = 2') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('/** @public */\nexport const a = 1;\n/** @public */\nexport const b = 2;\n');
  });

  it('mixes a multi-line JSDoc merge with a fresh insertion', () => {
    const content = '/**\n * Doc.\n */\nexport function foo() {\n  return 1;\n}\nexport const bar = 2;\n';
    const { out } = runTop(content, [
      { symbol: 'foo', pos: content.indexOf('foo') },
      { symbol: 'bar', pos: content.indexOf('bar') },
    ]);
    expect(out).toBe(
      '/**\n * Doc.\n * @public\n */\nexport function foo() {\n  return 1;\n}\n/** @public */\nexport const bar = 2;\n',
    );
  });

  it('mixes a single-line JSDoc expansion (replacement edit) with a fresh insertion', () => {
    const content = '/** Doc. */\nexport const foo = 1;\nexport const bar = 2;\n';
    const { out } = runTop(content, [
      { symbol: 'foo', pos: content.indexOf('foo') },
      { symbol: 'bar', pos: content.indexOf('bar') },
    ]);
    expect(out).toBe(
      '/**\n * Doc.\n * @public\n */\nexport const foo = 1;\n/** @public */\nexport const bar = 2;\n',
    );
  });

  it('an already-tagged op is ok with no edit; the other op still lands', () => {
    const content = '/** @public */\nexport const a = 1;\nexport const b = 2;\n';
    const { results, edits, out } = runTop(content, [
      { symbol: 'a', pos: content.indexOf('a = 1') },
      { symbol: 'b', pos: content.indexOf('b = 2') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(edits).toHaveLength(1);
    expect(out).toBe('/** @public */\nexport const a = 1;\n/** @public */\nexport const b = 2;\n');
  });
});

describe('insertMemberPublicTagBatch', () => {
  it('tags two enum members from one parse', () => {
    const content = 'export enum Color {\n  Red,\n  Blue,\n  Green,\n}\n';
    const { results, out } = runMember(content, [
      { symbol: 'Red', parentSymbol: 'Color' },
      { symbol: 'Green', parentSymbol: 'Color' },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe(
      'export enum Color {\n  /** @public */\n  Red,\n  Blue,\n  /** @public */\n  Green,\n}\n',
    );
  });
});
