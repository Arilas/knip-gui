import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripExport } from '../../src/fix/transforms/strip-export.js';
import { deleteDeclaration } from '../../src/fix/transforms/delete-declaration.js';
import type { TransformResult } from '../../src/fix/transforms/source.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/single/src/', import.meta.url));

function expectOk(result: TransformResult): string {
  if (!result.ok) throw new Error(`expected ok:true, got ok:false reason=${result.reason}`);
  return result.newContent;
}

describe('stripExport: plain declarations (mirrors knip --fix)', () => {
  it.each([
    ['export const', 'export const foo = 1;\n', 'foo', 'const foo = 1;\n'],
    [
      'export function',
      'export function foo() {\n  return 1;\n}\n',
      'foo',
      'function foo() {\n  return 1;\n}\n',
    ],
    ['export type', 'export type Foo = string;\n', 'Foo', 'type Foo = string;\n'],
    [
      'export interface',
      'export interface Foo {\n  x: number;\n}\n',
      'Foo',
      'interface Foo {\n  x: number;\n}\n',
    ],
    ['export enum', 'export enum Foo {\n  A,\n  B,\n}\n', 'Foo', 'enum Foo {\n  A,\n  B,\n}\n'],
    [
      'export class',
      'export class Foo {\n  m() {\n    return 1;\n  }\n}\n',
      'Foo',
      'class Foo {\n  m() {\n    return 1;\n  }\n}\n',
    ],
  ])('%s -> removes only the `export ` keyword', (_label, content, symbol, expected) => {
    const result = stripExport({ filePath: 'a.ts', content, symbol });
    expect(expectOk(result)).toBe(expected);
  });
});

describe('stripExport / deleteDeclaration: JSDoc-attached declaration', () => {
  const content =
    '/**\n * Doc.\n */\nexport function foo() {\n  return 1;\n}\nexport const bar = 2;\n';

  it('stripExport keeps the JSDoc, removes only `export `', () => {
    const result = stripExport({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe(
      '/**\n * Doc.\n */\nfunction foo() {\n  return 1;\n}\nexport const bar = 2;\n',
    );
  });

  it('deleteDeclaration removes the JSDoc, the declaration, and its trailing newline', () => {
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe('export const bar = 2;\n');
  });
});

describe('stripExport: export list bindings (comma hygiene)', () => {
  const content =
    'function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\nexport { a, b, c };\n';

  it.each([
    ['first', 'a', 'export { b, c };\n'],
    ['middle', 'b', 'export { a, c };\n'],
    ['last', 'c', 'export { a, b };\n'],
  ])('removes the %s binding from the list', (_label, symbol, expectedLastLine) => {
    const result = stripExport({ filePath: 'a.ts', content, symbol });
    const prefix =
      'function a() { return 1; }\nfunction b() { return 2; }\nfunction c() { return 3; }\n';
    expect(expectOk(result)).toBe(prefix + expectedLastLine);
  });

  it('emptying a single-binding list removes the whole statement', () => {
    const emptyingContent = 'function onlyOne() { return 1; }\nexport { onlyOne };\n';
    const result = stripExport({ filePath: 'a.ts', content: emptyingContent, symbol: 'onlyOne' });
    expect(expectOk(result)).toBe('function onlyOne() { return 1; }\n\n');
  });
});

describe('stripExport: re-export list bindings (`export { x } from "./y.js"`)', () => {
  it('emptying a single-specifier re-export removes the whole statement', () => {
    const content = "export { x } from './y.js';\n";
    const result = stripExport({ filePath: 'a.ts', content, symbol: 'x' });
    expect(expectOk(result)).toBe('\n');
  });

  it('removes one binding from a multi-specifier re-export, keeping the rest', () => {
    const content = "export { x, y } from './mod.js';\n";
    const result = stripExport({ filePath: 'a.ts', content, symbol: 'x' });
    expect(expectOk(result)).toBe("export { y } from './mod.js';\n");
  });
});

describe('stripExport: default export', () => {
  it('named default (function) -> removes only `export default `', () => {
    const content = 'export default function foo() {\n  return 1;\n}\n';
    const result = stripExport({ filePath: 'a.ts', content, symbol: 'default' });
    expect(expectOk(result)).toBe('function foo() {\n  return 1;\n}\n');
  });

  it('anonymous default (object expression) -> removes the whole statement', () => {
    const content = 'export default { a: 1 };\n';
    const result = stripExport({ filePath: 'a.ts', content, symbol: 'default' });
    expect(expectOk(result)).toBe('\n');
  });
});

describe('deleteDeclaration: default export always removes the value', () => {
  it('named default (function) -> removes the whole statement, unlike stripExport', () => {
    const content = 'export default function foo() {\n  return 1;\n}\nexport const bar = 2;\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'default' });
    expect(expectOk(result)).toBe('export const bar = 2;\n');
  });
});

describe('deleteDeclaration: list bindings delete the local declaration AND the list entry', () => {
  it('removes the standalone function declaration and its export-list binding', () => {
    const content =
      'function keep() { return 1; }\nfunction gone() { return 2; }\nexport { keep, gone };\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'gone' });
    expect(expectOk(result)).toBe('function keep() { return 1; }\nexport { keep };\n');
  });

  it('a re-export binding has no local declaration to delete, so only the list entry goes', () => {
    const content = "export { x } from './y.js';\n";
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'x' });
    expect(expectOk(result)).toBe('');
  });
});

describe('deleteDeclaration: plain declaration', () => {
  it('removes the whole export statement and its trailing newline', () => {
    const content = 'export const foo = 1;\nexport const bar = 2;\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe('export const bar = 2;\n');
  });
});

describe('multi-declarator `export const a = 1, b = 2`', () => {
  it.each([
    ['first', 'a', 'export const b = 2;\n'],
    ['last', 'b', 'export const a = 1;\n'],
  ])(
    'deleteDeclaration removes only the %s declarator, keeping the live sibling',
    (_label, symbol, expected) => {
      const content = 'export const a = 1, b = 2;\n';
      const result = deleteDeclaration({ filePath: 'a.ts', content, symbol });
      expect(expectOk(result)).toBe(expected);
    },
  );

  it('deleteDeclaration removes a middle declarator with comma hygiene', () => {
    const content = 'export const a = 1, b = 2, c = 3;\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'b' });
    expect(expectOk(result)).toBe('export const a = 1, c = 3;\n');
  });

  it('deleteDeclaration of the sole declarator removes the whole statement', () => {
    const content = 'export const only = 1;\nexport const keep = 2;\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'only' });
    expect(expectOk(result)).toBe('export const keep = 2;\n');
  });

  it('stripExport removes the `export ` keyword for the WHOLE statement (mirrors knip --fix; intentional, do not "fix")', () => {
    // knip --fix unexports the entire `export const a = 1, b = 2;` statement even
    // when only one declarator is unused — stripExport deliberately mirrors that.
    // Per-declarator surgery is a deleteDeclaration behavior only.
    const content = 'export const a = 1, b = 2;\n';
    const result = stripExport({ filePath: 'a.ts', content, symbol: 'b' });
    expect(expectOk(result)).toBe('const a = 1, b = 2;\n');
  });
});

describe('deleteDeclaration: decorated class', () => {
  it('sweeps a single decorator above `export class` into the deletion', () => {
    const content = '@Component()\nexport class Foo {}\nexport const keep = 1;\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'Foo' });
    expect(expectOk(result)).toBe('export const keep = 1;\n');
  });

  it('sweeps multiple decorators above `export class` into the deletion', () => {
    const content = '@Component()\n@Injectable()\nexport class Foo {}\nexport const keep = 1;\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'Foo' });
    expect(expectOk(result)).toBe('export const keep = 1;\n');
  });

  it('removes a JSDoc sitting above the decorators too (comment -> decorator -> export class)', () => {
    const content =
      '/**\n * Doc.\n */\n@Component()\nexport class Foo {}\nexport const keep = 1;\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'Foo' });
    expect(expectOk(result)).toBe('export const keep = 1;\n');
  });
});

describe('deleteDeclaration: list-exported local TS type declarations', () => {
  it('deletes a local `type` alias together with its `export type { T }` binding', () => {
    const content = 'type T = string;\nexport type { T };\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'T' });
    expect(expectOk(result)).toBe('');
  });

  it('deletes a local `interface` together with its list binding', () => {
    const content = 'interface I {\n  x: number;\n}\nexport type { I };\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'I' });
    expect(expectOk(result)).toBe('');
  });

  it('deletes a local `enum` together with its list binding', () => {
    const content = 'enum E {\n  A,\n}\nexport { E };\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'E' });
    expect(expectOk(result)).toBe('');
  });
});

describe('deleteDeclaration: CRLF line endings', () => {
  it('removes an attached JSDoc when lines end with \\r\\n', () => {
    const content =
      '/**\r\n * Doc.\r\n */\r\nexport function foo() {\r\n  return 1;\r\n}\r\nexport const bar = 2;\r\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe('export const bar = 2;\r\n');
  });
});

describe('locate failures', () => {
  it('symbol-name mismatch at a given pos -> ok:false', () => {
    const content = 'export const foo = 1;\n';
    const fooPos = content.indexOf('foo');
    const result = stripExport({ filePath: 'a.ts', content, symbol: 'bar', pos: fooPos });
    expect(result).toEqual({
      ok: false,
      reason: `symbol mismatch at position ${fooPos}: expected 'bar', found 'foo'`,
    });
  });

  it('symbol not found anywhere at top level -> ok:false', () => {
    const content = 'export const foo = 1;\n';
    const result = stripExport({ filePath: 'a.ts', content, symbol: 'nope' });
    expect(result).toEqual({ ok: false, reason: "symbol 'nope' not found" });
  });

  it('deleteDeclaration also reports symbol not found -> ok:false', () => {
    const content = 'export const foo = 1;\n';
    const result = deleteDeclaration({ filePath: 'a.ts', content, symbol: 'nope' });
    expect(result).toEqual({ ok: false, reason: "symbol 'nope' not found" });
  });
});

describe('non-ASCII content: oxc spans are UTF-16 code-unit offsets, matching JS string indices', () => {
  it('locates a symbol by pos correctly when preceding content has multi-byte UTF-8 characters', () => {
    // "🎉" is a surrogate pair (2 UTF-16 code units, 4 UTF-8 bytes); "é" is 1 UTF-16
    // code unit but 2 UTF-8 bytes. A byte-offset pos would land on the wrong
    // character here; a UTF-16 code-unit pos (plain JS string index) lands exactly
    // on `afterEmoji`.
    const content = 'const emoji = "🎉café";\nexport const afterEmoji = 1;\n';
    const pos = content.indexOf('afterEmoji');
    const result = stripExport({ filePath: 'a.ts', content, symbol: 'afterEmoji', pos });
    expect(expectOk(result)).toBe('const emoji = "🎉café";\nconst afterEmoji = 1;\n');
  });
});

describe('real fixture: knip-captured pos lands on the right node (single/src)', () => {
  it('stripExport(unusedHelper, pos 93) in used.ts removes only `export `', () => {
    const filePath = `${FIXTURES_DIR}used.ts`;
    const content = readFileSync(filePath, 'utf8');
    const result = stripExport({ filePath, content, symbol: 'unusedHelper', pos: 93 });
    expect(expectOk(result)).toBe(
      content.replace('export function unusedHelper', 'function unusedHelper'),
    );
  });

  it('stripExport(listUnused, pos 109) in forms.ts removes it from the export list', () => {
    const filePath = `${FIXTURES_DIR}forms.ts`;
    const content = readFileSync(filePath, 'utf8');
    const result = stripExport({ filePath, content, symbol: 'listUnused', pos: 109 });
    expect(expectOk(result)).toBe(
      content.replace('export { listUsed, listUnused };', 'export { listUsed };'),
    );
  });

  it('stripExport(default, pos 148) in forms.ts removes only `export default `', () => {
    const filePath = `${FIXTURES_DIR}forms.ts`;
    const content = readFileSync(filePath, 'utf8');
    const result = stripExport({ filePath, content, symbol: 'default', pos: 148 });
    expect(expectOk(result)).toBe(
      content.replace('export default function defaultUnused', 'function defaultUnused'),
    );
  });
});
