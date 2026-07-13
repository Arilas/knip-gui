import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeMember } from '../../src/fix/transforms/remove-member.js';
import { removeDuplicate } from '../../src/fix/transforms/remove-duplicate.js';
import { insertPublicTag } from '../../src/ignore/public-tag.js';
import type { TransformResult } from '../../src/fix/transforms/source.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/single/src/', import.meta.url));

function expectOk(result: TransformResult): string {
  if (!result.ok) throw new Error(`expected ok:true, got ok:false reason=${result.reason}`);
  return result.newContent;
}

describe('removeMember: enum members', () => {
  it('removes a middle member with comma hygiene on both sides', () => {
    const content = 'export enum Foo {\n  A,\n  B,\n  C,\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'B', parentSymbol: 'Foo' });
    expect(expectOk(result)).toBe('export enum Foo {\n  A,\n  C,\n}\n');
  });

  it('removes the first member', () => {
    const content = 'export enum Foo {\n  A,\n  B,\n  C,\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'A', parentSymbol: 'Foo' });
    expect(expectOk(result)).toBe('export enum Foo {\n  B,\n  C,\n}\n');
  });

  it('removes the last member, preserving the trailing comma on the new-last member', () => {
    // Real fixture: tests/fixtures/single/src/used.ts, `enumMembers` issue
    // { namespace: 'Color', name: 'Blue', pos: 175 } (see task-1-report.md).
    const filePath = `${FIXTURES_DIR}used.ts`;
    const content = readFileSync(filePath, 'utf8');
    const result = removeMember({ filePath, content, symbol: 'Blue', parentSymbol: 'Color', pos: 175 });
    expect(expectOk(result)).toBe(content.replace('  Red,\n  Blue,\n}', '  Red,\n}'));
  });

  it('removing the last member does not eat the PREVIOUS member\'s same-line trailing comment', () => {
    const content = 'export enum Foo {\n  Red, // r\n  Blue, // b\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'Blue', parentSymbol: 'Foo' });
    expect(expectOk(result)).toBe('export enum Foo {\n  Red, // r\n}\n');
  });

  it('removing a non-last member with a same-line trailing comment removes the comment too', () => {
    const content = 'export enum Foo {\n  Red, // r\n  Blue, // b\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'Red', parentSymbol: 'Foo' });
    expect(expectOk(result)).toBe('export enum Foo {\n  Blue, // b\n}\n');
  });

  it('member not found in an existing enum -> ok:false', () => {
    const content = 'export enum Foo {\n  A,\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'Z', parentSymbol: 'Foo' });
    expect(result).toEqual({ ok: false, reason: "member 'Z' not found in enum 'Foo'" });
  });
});

describe('removeMember: namespace members', () => {
  it('removes a const member statement', () => {
    // Real fixture: tests/fixtures/single/src/forms.ts, `namespaceMembers` issue
    // { namespace: 'Config', name: 'unusedFlag', pos: 277 } (see task-1-report.md).
    const filePath = `${FIXTURES_DIR}forms.ts`;
    const content = readFileSync(filePath, 'utf8');
    const result = removeMember({
      filePath,
      content,
      symbol: 'unusedFlag',
      parentSymbol: 'Config',
      pos: 277,
    });
    expect(expectOk(result)).toBe(content.replace('export const unusedFlag = false;\n', ''));
  });

  it('removes a function member statement, keeping other members', () => {
    const content =
      'export namespace NS {\n  export const kept = 1;\n  export function gone() {\n    return 1;\n  }\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'gone', parentSymbol: 'NS' });
    expect(expectOk(result)).toBe('export namespace NS {\n  export const kept = 1;\n  }\n');
  });
});

describe('removeMember: parent not found', () => {
  it('returns ok:false when the enum/namespace name does not exist', () => {
    const content = 'export enum Foo {\n  A,\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'A', parentSymbol: 'Nope' });
    expect(result).toEqual({ ok: false, reason: "parent 'Nope' not found" });
  });
});

describe('removeDuplicate: aliasing `export const` shape', () => {
  it("removes the fixture's dupeAlias declaration, leaving dupeSource untouched", () => {
    // Real fixture: tests/fixtures/single/src/forms.ts, `duplicates` issue group
    // [{ name: 'dupeSource', pos: 313 }, { name: 'dupeAlias', pos: 343 }] — the
    // plan compiler passes duplicateMembers[1] (dupeAlias) here (see
    // task-1-report.md's "remove-duplicate must target duplicateMembers[1..]").
    const filePath = `${FIXTURES_DIR}forms.ts`;
    const content = readFileSync(filePath, 'utf8');
    const result = removeDuplicate({ filePath, content, symbol: 'dupeAlias', pos: 343 });
    expect(expectOk(result)).toBe(content.replace('export const dupeAlias = dupeSource;\n', ''));
  });
});

describe('removeDuplicate: `export { x as y }` specifier shape', () => {
  it('removes the whole statement when the alias is the sole specifier, keeping the original', () => {
    const content = 'export const original = 1;\nexport { original as aliasName };\n';
    const result = removeDuplicate({ filePath: 'a.ts', content, symbol: 'aliasName' });
    expect(expectOk(result)).toBe('export const original = 1;\n');
  });

  it('removes just the alias specifier from a multi-specifier list, keeping the original and siblings', () => {
    const content =
      'export const original = 1;\nexport { original as aliasName, other };\nfunction other() {}\n';
    const result = removeDuplicate({ filePath: 'a.ts', content, symbol: 'aliasName' });
    expect(expectOk(result)).toBe(
      'export const original = 1;\nexport { other };\nfunction other() {}\n',
    );
  });
});

describe('removeDuplicate: `export default` aliasing shape', () => {
  it('removes the whole default-export statement, keeping the original', () => {
    const content = 'export const original = 1;\nexport default original;\n';
    const result = removeDuplicate({ filePath: 'a.ts', content, symbol: 'default' });
    expect(expectOk(result)).toBe('export const original = 1;\n');
  });
});

describe('removeDuplicate: not found', () => {
  it('returns ok:false when the symbol does not exist', () => {
    const content = 'export const original = 1;\n';
    const result = removeDuplicate({ filePath: 'a.ts', content, symbol: 'nope' });
    expect(result).toEqual({ ok: false, reason: "symbol 'nope' not found" });
  });
});

describe('insertPublicTag: fresh insertion (no existing JSDoc)', () => {
  it('inserts a `/** @public */` line above a plain declaration', () => {
    const content = 'export const foo = 1;\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe('/** @public */\nexport const foo = 1;\n');
  });

  it('matches the indentation of the declaration', () => {
    const content = '  export const foo = 1;\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe('  /** @public */\n  export const foo = 1;\n');
  });

  it('inserts above the whole `export default` construct', () => {
    const content = 'export default function foo() {\n  return 1;\n}\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'default' });
    expect(expectOk(result)).toBe('/** @public */\nexport default function foo() {\n  return 1;\n}\n');
  });

  it('for a list-exported symbol, tags the LOCAL declaration, not the export-list statement', () => {
    const content =
      'function keep() { return 1; }\nfunction gone() { return 2; }\nexport { keep, gone };\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'gone' });
    expect(expectOk(result)).toBe(
      'function keep() { return 1; }\n/** @public */\nfunction gone() { return 2; }\nexport { keep, gone };\n',
    );
  });
});

describe('insertPublicTag: existing JSDoc', () => {
  it('inserts ` * @public` before the closing `*/`', () => {
    const content = '/**\n * Doc.\n */\nexport function foo() {\n  return 1;\n}\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe(
      '/**\n * Doc.\n * @public\n */\nexport function foo() {\n  return 1;\n}\n',
    );
  });

  it('does the same on CRLF line endings', () => {
    const content = '/**\r\n * Doc.\r\n */\r\nexport function foo() {\r\n  return 1;\r\n}\r\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe(
      '/**\r\n * Doc.\r\n * @public\r\n */\r\nexport function foo() {\r\n  return 1;\r\n}\r\n',
    );
  });
});

describe('insertPublicTag: idempotency', () => {
  it('is a no-op when the existing JSDoc already documents @public', () => {
    const content = '/**\n * Doc.\n * @public\n */\nexport function foo() {\n  return 1;\n}\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe(content);
  });

  it('is a no-op for an already-tagged fresh single-line JSDoc', () => {
    const content = '/** @public */\nexport const foo = 1;\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe(content);
  });
});

describe('insertPublicTag: failures', () => {
  it('a re-exported symbol with no local declaration -> ok:false', () => {
    const content = "export { x } from './y.js';\n";
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'x' });
    expect(result).toEqual({
      ok: false,
      reason: "symbol 'x' is a re-export with no local declaration to tag",
    });
  });

  it('symbol not found -> ok:false', () => {
    const content = 'export const foo = 1;\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'nope' });
    expect(result).toEqual({ ok: false, reason: "symbol 'nope' not found" });
  });
});
