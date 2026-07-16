import { describe, expect, it } from 'vitest';
import { removeMemberBatch } from '../../src/fix/transforms/remove-member.js';
import { applyEdits, parseSource, type SourceOp } from '../../src/fix/transforms/source.js';

function run(content: string, ops: SourceOp[]) {
  const parsed = parseSource('a.ts', content);
  const { results, edits } = removeMemberBatch(parsed, content, ops);
  return { results, out: applyEdits(content, edits) };
}

describe('removeMemberBatch: enum members', () => {
  it('removes an adjacent middle run with one combined edit', () => {
    const content = 'export enum Foo {\n  A,\n  B,\n  C,\n  D,\n}\n';
    const { results, out } = run(content, [
      { symbol: 'B', parentSymbol: 'Foo' },
      { symbol: 'C', parentSymbol: 'Foo' },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('export enum Foo {\n  A,\n  D,\n}\n');
  });

  it('removes a trailing run without eating the survivor same-line trailing comment', () => {
    const content = 'export enum Foo {\n  Red, // r\n  Blue, // b\n  Green, // g\n}\n';
    const { results, out } = run(content, [
      { symbol: 'Blue', parentSymbol: 'Foo' },
      { symbol: 'Green', parentSymbol: 'Foo' },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('export enum Foo {\n  Red, // r\n}\n');
  });

  it('removes a non-adjacent pair including the last member', () => {
    const content = 'export enum Foo {\n  A,\n  B,\n  C,\n  D,\n}\n';
    const { out } = run(content, [
      { symbol: 'B', parentSymbol: 'Foo' },
      { symbol: 'D', parentSymbol: 'Foo' },
    ]);
    expect(out).toBe('export enum Foo {\n  A,\n  C,\n}\n');
  });

  it('removing ALL members leaves the empty enum shell (as op-by-op removal did)', () => {
    const content = 'export enum Foo {\n  A,\n  B,\n}\n';
    const { out } = run(content, [
      { symbol: 'A', parentSymbol: 'Foo' },
      { symbol: 'B', parentSymbol: 'Foo' },
    ]);
    expect(out).toBe('export enum Foo {\n  \n}\n');
  });

  it('an all-members run sweeps a leading JSDoc on the first member', () => {
    const content = 'enum E {\n  /** doc for A */\n  A = 1,\n  B = 2,\n}\n';
    const { out } = run(content, [
      { symbol: 'A', parentSymbol: 'E' },
      { symbol: 'B', parentSymbol: 'E' },
    ]);
    expect(out).toBe('enum E {\n  \n}\n');
  });
});

describe('removeMemberBatch: namespace members', () => {
  it('removes a non-last and the last member in one batch', () => {
    const content =
      'export namespace NS {\n  export const first = 1;\n  export const second = 2;\n  export const third = 3;\n}\n';
    const { results, out } = run(content, [
      { symbol: 'first', parentSymbol: 'NS' },
      { symbol: 'third', parentSymbol: 'NS' },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('export namespace NS {\n  export const second = 2;\n  }\n');
  });

  it('removes an adjacent run covering the whole body', () => {
    const content = 'export namespace NS {\n  export const a = 1;\n  export const b = 2;\n}\n';
    const { out } = run(content, [
      { symbol: 'a', parentSymbol: 'NS' },
      { symbol: 'b', parentSymbol: 'NS' },
    ]);
    expect(out).toBe('export namespace NS {\n  }\n');
  });

  it('removes a subset of declarators of one member statement', () => {
    const content = 'export namespace NS {\n  export const a = 1, b = 2, c = 3;\n}\n';
    const { out } = run(content, [
      { symbol: 'a', parentSymbol: 'NS' },
      { symbol: 'c', parentSymbol: 'NS' },
    ]);
    expect(out).toBe('export namespace NS {\n  export const b = 2;\n}\n');
  });

  it('removing every declarator of a member statement removes the whole statement', () => {
    const content = 'export namespace NS {\n  export const a = 1, b = 2;\n}\n';
    const { out } = run(content, [
      { symbol: 'a', parentSymbol: 'NS' },
      { symbol: 'b', parentSymbol: 'NS' },
    ]);
    expect(out).toBe('export namespace NS {\n  }\n');
  });

  it('an op without parentSymbol fails without disturbing the batch', () => {
    const content = 'export enum Foo {\n  A,\n  B,\n}\n';
    const { results, out } = run(content, [
      { symbol: 'A' },
      { symbol: 'B', parentSymbol: 'Foo' },
    ]);
    expect(results[0]).toEqual({ ok: false, reason: 'remove-member requires a parentSymbol' });
    expect(results[1]).toEqual({ ok: true });
    expect(out).toBe('export enum Foo {\n  A,\n}\n');
  });
});
