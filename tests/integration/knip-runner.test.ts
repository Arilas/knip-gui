import { describe, expect, it } from 'vitest';
import { resolveKnip, runScan, KnipError } from '../../src/core/knip-runner.js';
import { normalize } from '../../src/core/normalize.js';

const single = new URL('../fixtures/single/', import.meta.url).pathname;
const monorepo = new URL('../fixtures/monorepo/', import.meta.url).pathname;

describe('knip runner', () => {
  it('resolves the walk-up knip install', () => {
    const k = resolveKnip(single);
    expect(k).not.toBeNull();
    expect(k!.version).toMatch(/^\d+\./);
  });

  it('returns null for a dir with no reachable knip', () => {
    expect(resolveKnip('/')).toBeNull();
  });

  it('scans the single fixture and finds the known issues', async () => {
    const raw = await runScan(single);
    const issues = normalize(raw, ['.']);
    const types = new Set(issues.map((i) => i.type));
    expect(types).toContain('files');
    expect(types).toContain('exports');
    expect(types).toContain('dependencies');
  });

  it('scans the monorepo fixture and finds per-workspace issues', async () => {
    const raw = await runScan(monorepo);
    const issues = normalize(raw, ['packages/app', 'packages/lib', '.']);
    expect(issues.some((i) => i.workspace === 'packages/lib')).toBe(true);
  });

  it('throws KnipError with stderr on hard failure', async () => {
    await expect(runScan('/nonexistent-dir-xyz')).rejects.toBeInstanceOf(KnipError);
  });
});
