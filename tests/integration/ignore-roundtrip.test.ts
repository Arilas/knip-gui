import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runScan } from '../../src/core/knip-runner.js';
import { normalize } from '../../src/core/normalize.js';
import type { Issue } from '../../src/core/types.js';
import { compileIgnorePlan } from '../../src/ignore/compile.js';
import { applyPatches } from '../../src/fix/patch.js';

// Lives under the repo's own .tmp-tests/ (not the OS tmpdir) so the copied
// fixture can still resolve knip via the repo's node_modules walk-up.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureDir = fileURLToPath(new URL('../fixtures/single/', import.meta.url));
const workDir = join(repoRoot, '.tmp-tests', `ignore-roundtrip-${randomBytes(6).toString('hex')}`);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('ignore plan round-trip against real knip (member-level @public)', () => {
  it('suppresses ONLY the tagged enum member; other unused members stay reportable', async () => {
    await mkdir(workDir, { recursive: true });
    await cp(fixtureDir, workDir, { recursive: true });

    // Add a SECOND unused enum member so we can distinguish "suppressed the
    // tagged member" from "suppressed the whole enum" (the parent-level-tag
    // failure mode this test exists to catch).
    const usedPath = join(workDir, 'src', 'used.ts');
    const original = await readFile(usedPath, 'utf8');
    const withGreen = original.replace('  Blue,\n}', '  Blue,\n  Green,\n}');
    expect(withGreen).not.toBe(original);
    await writeFile(usedPath, withGreen, 'utf8');

    const issue: Issue = {
      id: 'blue',
      type: 'enumMembers',
      workspace: '.',
      filePath: 'src/used.ts',
      symbol: 'Blue',
      parentSymbol: 'Color',
      pos: withGreen.indexOf('Blue'),
      fixable: false,
      fixModes: [],
    };

    const plan = await compileIgnorePlan(workDir, [issue], ['blue']);
    expect(plan.items).toEqual([{ issueId: 'blue', ok: true, filePath: 'src/used.ts' }]);
    expect(plan.patches).toHaveLength(1);

    const results = await applyPatches(workDir, plan.patches);
    expect(results).toEqual([{ filePath: 'src/used.ts', ok: true }]);

    const raw = await runScan(workDir);
    const issues = normalize(raw, ['.']);
    const enumMembers = issues.filter((i) => i.type === 'enumMembers' && i.parentSymbol === 'Color');
    const names = enumMembers.map((i) => i.symbol);
    expect(names).not.toContain('Blue'); // tagged member suppressed
    expect(names).toContain('Green'); // untagged sibling still reported
  }, 30_000);
});
