import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeMember } from '../../src/fix/transforms/remove-member.js';
import { removeDuplicate } from '../../src/fix/transforms/remove-duplicate.js';
import { insertMemberPublicTag, insertPublicTag } from '../../src/ignore/public-tag.js';
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

describe('removeMember: namespace members declared as multi-declarator `export const a = 1, b = 2;`', () => {
  it('removes only the first declarator, keeping the live sibling', () => {
    const content = 'export namespace NS {\n  export const a = 1, b = 2;\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'a', parentSymbol: 'NS' });
    expect(expectOk(result)).toBe('export namespace NS {\n  export const b = 2;\n}\n');
  });

  it('removes only the last declarator, keeping the live sibling', () => {
    const content = 'export namespace NS {\n  export const a = 1, b = 2;\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'b', parentSymbol: 'NS' });
    expect(expectOk(result)).toBe('export namespace NS {\n  export const a = 1;\n}\n');
  });

  it('removes a middle declarator with comma hygiene', () => {
    const content = 'export namespace NS {\n  export const a = 1, b = 2, c = 3;\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'b', parentSymbol: 'NS' });
    expect(expectOk(result)).toBe('export namespace NS {\n  export const a = 1, c = 3;\n}\n');
  });

  it('removes the whole statement when the sole declarator is removed (sibling member keeps its indent)', () => {
    const content = 'export namespace NS {\n  export const only = 1;\n  export const kept = 2;\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'only', parentSymbol: 'NS' });
    expect(expectOk(result)).toBe('export namespace NS {\n  export const kept = 2;\n}\n');
  });
});

describe("removeMember: non-last namespace member keeps the next sibling's indentation intact", () => {
  it("removes the first of two members without doubling the survivor's indent", () => {
    const content = 'export namespace NS {\n  export const gone = 1;\n  export const kept = 2;\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'gone', parentSymbol: 'NS' });
    expect(expectOk(result)).toBe('export namespace NS {\n  export const kept = 2;\n}\n');
  });

  it('handles a member of a namespace nested inside another namespace (deeper indent)', () => {
    const content =
      'export namespace Outer {\n  export namespace Inner {\n    export const gone = 1;\n    export const kept = 2;\n  }\n}\n';
    const result = removeMember({ filePath: 'a.ts', content, symbol: 'gone', parentSymbol: 'Inner' });
    expect(expectOk(result)).toBe(
      'export namespace Outer {\n  export namespace Inner {\n    export const kept = 2;\n  }\n}\n',
    );
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

describe('insertPublicTag: single-line JSDoc merge (expands to canonical multi-line form)', () => {
  it('merges @public into `/** Doc. */`', () => {
    const content = '/** Doc. */\nexport const foo = 1;\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe('/**\n * Doc.\n * @public\n */\nexport const foo = 1;\n');
  });

  it('merges @public into `/** @internal */` (non-@public tag, does not short-circuit)', () => {
    const content = '/** @internal */\nexport const foo = 1;\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe('/**\n * @internal\n * @public\n */\nexport const foo = 1;\n');
  });

  it('preserves indentation when expanding an indented single-line JSDoc', () => {
    const content = '  /** Doc. */\n  export const foo = 1;\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe(
      '  /**\n   * Doc.\n   * @public\n   */\n  export const foo = 1;\n',
    );
  });

  it('multi-line JSDoc whose `*/` shares a line with text -> inline @public before the close', () => {
    const content = '/**\n * Doc. */\nexport const foo = 1;\n';
    const result = insertPublicTag({ filePath: 'a.ts', content, symbol: 'foo' });
    expect(expectOk(result)).toBe('/**\n * Doc. @public */\nexport const foo = 1;\n');
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

describe('insertMemberPublicTag: enum members', () => {
  it('tags a middle enum member on its OWN line with the member indentation', () => {
    const content = 'export enum Color {\n  Red,\n  Blue,\n  Green,\n}\n';
    const result = insertMemberPublicTag({
      filePath: 'a.ts',
      content,
      symbol: 'Blue',
      parentSymbol: 'Color',
    });
    expect(expectOk(result)).toBe(
      'export enum Color {\n  Red,\n  /** @public */\n  Blue,\n  Green,\n}\n',
    );
  });

  it('tags the last enum member', () => {
    const content = 'export enum Color {\n  Red,\n  Blue,\n}\n';
    const result = insertMemberPublicTag({
      filePath: 'a.ts',
      content,
      symbol: 'Blue',
      parentSymbol: 'Color',
    });
    expect(expectOk(result)).toBe('export enum Color {\n  Red,\n  /** @public */\n  Blue,\n}\n');
  });

  it('does NOT tag the parent enum declaration itself', () => {
    const content = 'export enum Color {\n  Red,\n  Blue,\n}\n';
    const result = insertMemberPublicTag({
      filePath: 'a.ts',
      content,
      symbol: 'Blue',
      parentSymbol: 'Color',
    });
    const out = expectOk(result);
    // The tag must appear AFTER the enum's opening line, not above `export enum`.
    expect(out.startsWith('export enum Color {')).toBe(true);
  });

  it('merges @public into an existing member JSDoc', () => {
    const content = 'export enum Color {\n  Red,\n  /**\n   * Doc.\n   */\n  Blue,\n}\n';
    const result = insertMemberPublicTag({
      filePath: 'a.ts',
      content,
      symbol: 'Blue',
      parentSymbol: 'Color',
    });
    expect(expectOk(result)).toBe(
      'export enum Color {\n  Red,\n  /**\n   * Doc.\n   * @public\n   */\n  Blue,\n}\n',
    );
  });

  it('is idempotent when the member JSDoc already documents @public', () => {
    const content = 'export enum Color {\n  Red,\n  /** @public */\n  Blue,\n}\n';
    const result = insertMemberPublicTag({
      filePath: 'a.ts',
      content,
      symbol: 'Blue',
      parentSymbol: 'Color',
    });
    expect(expectOk(result)).toBe(content);
  });
});

describe('insertMemberPublicTag: namespace members', () => {
  it('tags a namespace member statement with the member indentation', () => {
    const content =
      'export namespace Config {\n  export const usedFlag = true;\n  export const unusedFlag = false;\n}\n';
    const result = insertMemberPublicTag({
      filePath: 'a.ts',
      content,
      symbol: 'unusedFlag',
      parentSymbol: 'Config',
    });
    expect(expectOk(result)).toBe(
      'export namespace Config {\n  export const usedFlag = true;\n  /** @public */\n  export const unusedFlag = false;\n}\n',
    );
  });

  it('merges @public into an existing namespace-member JSDoc', () => {
    const content =
      'export namespace Config {\n  /**\n   * Doc.\n   */\n  export const unusedFlag = false;\n}\n';
    const result = insertMemberPublicTag({
      filePath: 'a.ts',
      content,
      symbol: 'unusedFlag',
      parentSymbol: 'Config',
    });
    expect(expectOk(result)).toBe(
      'export namespace Config {\n  /**\n   * Doc.\n   * @public\n   */\n  export const unusedFlag = false;\n}\n',
    );
  });
});

describe('insertMemberPublicTag: failures', () => {
  it('parent not found -> ok:false', () => {
    const content = 'export enum Color {\n  Red,\n}\n';
    const result = insertMemberPublicTag({
      filePath: 'a.ts',
      content,
      symbol: 'Red',
      parentSymbol: 'Nope',
    });
    expect(result).toEqual({ ok: false, reason: "parent 'Nope' not found" });
  });

  it('member not found in parent -> ok:false', () => {
    const content = 'export enum Color {\n  Red,\n}\n';
    const result = insertMemberPublicTag({
      filePath: 'a.ts',
      content,
      symbol: 'Blue',
      parentSymbol: 'Color',
    });
    expect(result).toEqual({ ok: false, reason: "member 'Blue' not found in enum 'Color'" });
  });
});
