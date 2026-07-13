import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/core/normalize.js';

const raw = JSON.parse(
  readFileSync(new URL('../fixtures/single-report.json', import.meta.url), 'utf8'),
);

describe('normalize', () => {
  const issues = normalize(raw, ['.']);

  it('flattens the unused file', () => {
    const f = issues.find((i) => i.type === 'files');
    expect(f).toMatchObject({ filePath: 'src/orphan.ts', workspace: '.', fixable: true, fixModes: ['delete-file'] });
    expect(f!.symbol).toBeUndefined();
  });

  it('flattens the unused export with position info', () => {
    const e = issues.find((i) => i.type === 'exports' && i.symbol === 'unusedHelper');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('src/used.ts');
    expect(e!.line).toBeGreaterThan(1);
    expect(e!.pos).toBeGreaterThan(0);
    expect(e!.fixModes).toEqual(['strip-export', 'delete-declaration']);
  });

  it('flattens the unused type', () => {
    const t = issues.find((i) => i.type === 'types' && i.symbol === 'UnusedShape');
    expect(t).toMatchObject({ filePath: 'src/shapes.ts', fixable: true });
  });

  it('flattens enum members with parentSymbol', () => {
    const em = issues.find((i) => i.type === 'enumMembers');
    expect(em).toMatchObject({ symbol: 'Blue', parentSymbol: 'Color', fixModes: ['remove-member'] });
  });

  it('flattens namespace members with parentSymbol from the namespace field', () => {
    const nm = issues.find((i) => i.type === 'namespaceMembers');
    expect(nm).toMatchObject({
      filePath: 'src/forms.ts',
      symbol: 'unusedFlag',
      parentSymbol: 'Config',
      fixModes: ['remove-member'],
    });
    expect(nm!.line).toBeGreaterThan(1);
    expect(nm!.pos).toBeGreaterThan(0);
  });

  it('collapses a duplicates group into one issue with the joined names as symbol', () => {
    const dup = issues.find((i) => i.type === 'duplicates');
    expect(dup).toBeDefined();
    expect(dup!.filePath).toBe('src/forms.ts');
    // knip's duplicates group lists the original declaration first, then each alias;
    // symbol is every name in the group joined together (ground truth per Task 1 capture).
    expect(dup!.symbol).toBe('dupeSource, dupeAlias');
    expect(dup!.parentSymbol).toBeUndefined();
    expect(dup!.fixModes).toEqual(['remove-duplicate']);
    // Position is the original declaration's, not the alias's.
    expect(dup!.line).toBeGreaterThan(1);
    expect(dup!.pos).toBeGreaterThan(0);
    // Exactly one issue for the group — not one per name.
    expect(issues.filter((i) => i.type === 'duplicates')).toHaveLength(1);
  });

  it('flattens the unused named export from an export { a, b } list', () => {
    const e = issues.find((i) => i.type === 'exports' && i.symbol === 'listUnused');
    expect(e).toMatchObject({ filePath: 'src/forms.ts', fixModes: ['strip-export', 'delete-declaration'] });
  });

  it("flattens an unused `export default` with knip's symbol name `default`", () => {
    const e = issues.find((i) => i.type === 'exports' && i.symbol === 'default' && i.filePath === 'src/forms.ts');
    expect(e).toBeDefined();
    expect(e!.line).toBeGreaterThan(1);
  });

  it("flattens an unused re-export (`export { x } from './y.js'`) as an exports issue in the re-exporting file", () => {
    const e = issues.find((i) => i.type === 'exports' && i.symbol === 'reexportSource');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('src/forms.ts');
  });

  it('groups duplicates by (workspace, file, symbol) for stable, non-colliding ids', () => {
    const dupRaw = {
      issues: [
        {
          file: 'src/x.ts',
          duplicates: [
            [
              { name: 'a', line: 1, col: 1, pos: 0 },
              { name: 'b', line: 2, col: 1, pos: 10 },
            ],
          ],
        },
      ],
    };
    const first = normalize(dupRaw, ['.']);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'duplicates', symbol: 'a, b', filePath: 'src/x.ts' });
    const second = normalize(dupRaw, ['.']);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  it('drops malformed duplicates groups instead of throwing', () => {
    const result = normalize(
      {
        issues: [
          {
            file: 'src/x.ts',
            duplicates: [null, 42, [], [null, undefined], [{ name: 'ok' }]],
          },
        ],
      },
      ['.'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'duplicates', symbol: 'ok' });
  });

  it('flattens the unused dependency as not-position-bearing', () => {
    const d = issues.find((i) => i.type === 'dependencies' && i.symbol === 'left-pad');
    expect(d).toMatchObject({ filePath: 'package.json', fixModes: ['remove-dependency'] });
  });

  it('assigns stable ids: same input, same ids; distinct issues, distinct ids', () => {
    const again = normalize(raw, ['.']);
    expect(again.map((i) => i.id)).toEqual(issues.map((i) => i.id));
    expect(new Set(issues.map((i) => i.id)).size).toBe(issues.length);
  });

  it('marks unresolved issues as not fixable with empty fixModes', () => {
    const [u] = normalize(
      { issues: [{ file: 'src/used.ts', unresolved: [{ name: './missing.js', line: 2, col: 1, pos: 10 }] }] },
      ['.'],
    );
    expect(u).toMatchObject({ type: 'unresolved', symbol: './missing.js', fixable: false, fixModes: [] });
  });

  it('gives duplicate (workspace,file,type,symbol) occurrences distinct, stable ids', () => {
    const dupRaw = {
      issues: [
        {
          file: 'src/used.ts',
          unresolved: [
            { name: './missing.js', line: 2, col: 1, pos: 10 },
            { name: './missing.js', line: 9, col: 1, pos: 140 },
          ],
        },
      ],
    };
    const first = normalize(dupRaw, ['.']);
    expect(first).toHaveLength(2);
    expect(first[0]!.id).not.toBe(first[1]!.id);
    const second = normalize(dupRaw, ['.']);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('skips malformed entries instead of throwing', () => {
    const result = normalize(
      {
        issues: [
          null,
          42,
          { file: 7, files: [{ name: 'x.ts' }] },
          { file: 'src/orphan.ts', files: [{ name: 'src/orphan.ts' }] },
        ],
      },
      ['.'],
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe('src/orphan.ts');
  });

  it('maps files to workspaces by longest prefix', () => {
    const scoped = normalize(
      { issues: [{ file: 'packages/lib/extra.ts', files: [{ name: 'packages/lib/extra.ts' }] }] },
      ['packages/lib', '.'],
    );
    expect(scoped[0]!.workspace).toBe('packages/lib');
  });
});
