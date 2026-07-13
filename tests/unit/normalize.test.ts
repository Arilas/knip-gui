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

  it('flattens the unused dependency as not-position-bearing', () => {
    const d = issues.find((i) => i.type === 'dependencies' && i.symbol === 'left-pad');
    expect(d).toMatchObject({ filePath: 'package.json', fixModes: ['remove-dependency'] });
  });

  it('assigns stable ids: same input, same ids; distinct issues, distinct ids', () => {
    const again = normalize(raw, ['.']);
    expect(again.map((i) => i.id)).toEqual(issues.map((i) => i.id));
    expect(new Set(issues.map((i) => i.id)).size).toBe(issues.length);
  });

  it('maps files to workspaces by longest prefix', () => {
    const scoped = normalize(
      { issues: [{ file: 'packages/lib/extra.ts', files: [{ name: 'packages/lib/extra.ts' }] }] },
      ['packages/lib', '.'],
    );
    expect(scoped[0]!.workspace).toBe('packages/lib');
  });
});
