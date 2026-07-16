import { describe, expect, it } from 'vitest';
import { deleteDeclarationBatch } from '../../src/fix/transforms/delete-declaration.js';
import { applyEdits, parseSource, type SourceOp } from '../../src/fix/transforms/source.js';

function run(content: string, ops: SourceOp[]) {
  const parsed = parseSource('a.ts', content);
  const { results, edits } = deleteDeclarationBatch(parsed, content, ops);
  return { results, out: applyEdits(content, edits) };
}

describe('deleteDeclarationBatch: adjacent declarators of one statement', () => {
  const content = 'export const a = 1, b = 2, c = 3;\n';

  it('removes the two leading declarators', () => {
    const { results, out } = run(content, [
      { symbol: 'a', pos: content.indexOf('a = 1') },
      { symbol: 'b', pos: content.indexOf('b = 2') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('export const c = 3;\n');
  });

  it('removes the two trailing declarators with one combined edit', () => {
    const { out } = run(content, [
      { symbol: 'b', pos: content.indexOf('b = 2') },
      { symbol: 'c', pos: content.indexOf('c = 3') },
    ]);
    expect(out).toBe('export const a = 1;\n');
  });

  it('removes a non-adjacent pair', () => {
    const { out } = run(content, [
      { symbol: 'a', pos: content.indexOf('a = 1') },
      { symbol: 'c', pos: content.indexOf('c = 3') },
    ]);
    expect(out).toBe('export const b = 2;\n');
  });

  it('removing ALL declarators deletes the whole statement including attached comments', () => {
    const withDoc = '/**\n * Doc.\n */\nexport const a = 1, b = 2;\nexport const keep = 3;\n';
    const { results, out } = run(withDoc, [
      { symbol: 'a', pos: withDoc.indexOf('a = 1') },
      { symbol: 'b', pos: withDoc.indexOf('b = 2') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('export const keep = 3;\n');
  });
});

describe('deleteDeclarationBatch: emptying an export list', () => {
  it('removes both local declarations and the whole export statement', () => {
    const content = 'function a() { return 1; }\nfunction b() { return 2; }\nexport { a, b };\n';
    const { results, out } = run(content, [
      { symbol: 'a', pos: content.indexOf('a, b') },
      { symbol: 'b', pos: content.indexOf('b };') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('');
  });
});

describe('deleteDeclarationBatch: overload set + neighbor in one batch', () => {
  it('sweeps the whole overload set and deletes the neighbor declaration', () => {
    const content =
      'export function f(x: string): void;\n' +
      'export function f(x: number): void;\n' +
      'export function f(x: unknown): void {}\n' +
      'export const keep = 1;\n' +
      'export const gone = 2;\n';
    const { results, out } = run(content, [
      { symbol: 'f', pos: content.indexOf('f(') },
      { symbol: 'gone', pos: content.indexOf('gone') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('export const keep = 1;\n');
  });
});

describe('deleteDeclarationBatch: two list bindings sharing one local declaration', () => {
  it('dedupes the shared local-declaration edit instead of double-removing it', () => {
    const content = "function f() { return 1; }\nexport { f };\nexport { f as g };\n";
    const { results, out } = run(content, [
      { symbol: 'f', pos: content.indexOf('f };') },
      { symbol: 'g', pos: content.indexOf('f as g') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('');
  });
});

describe('deleteDeclarationBatch: adjacent whole statements with attached comments', () => {
  it('produces touching (non-overlapping) edits', () => {
    const content = '// a\nexport const a = 1;\n// b\nexport const b = 2;\nexport const keep = 3;\n';
    const { results, out } = run(content, [
      { symbol: 'a', pos: content.indexOf('a = 1') },
      { symbol: 'b', pos: content.indexOf('b = 2') },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(out).toBe('export const keep = 3;\n');
  });
});
