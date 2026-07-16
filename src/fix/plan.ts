import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FilePatch } from './patch.js';
import type { TransformResult } from './transforms/source.js';

export interface PlanItem {
  issueId: string;
  ok: boolean;
  reason?: string;
  /**
   * The file this issue's patch lands in — the source file for source
   * transforms, the owning workspace's package.json for dependency fixes,
   * the knip config file for ignore-mode config edits. Unset only when it
   * cannot be known: unknown-issue, or no/code-config ignore failures.
   * The client's join/attribution logic (apply-flow.ts) reads this instead
   * of re-deriving it from the issue (#39).
   */
  filePath?: string;
}

export interface FixPlan {
  planId: string; // random hex
  kind: 'fix' | 'ignore' | 'ignore-remove';
  patches: FilePatch[];
  diffs: { filePath: string; diff: string }[];
  items: PlanItem[]; // per-issue compile outcome (transform failures land here)
  createdAt: string;
}

export async function readFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export function newPlanId(): string {
  return randomBytes(16).toString('hex');
}

// Chains genuinely-sequential text edits over tiny JSON documents
// (package.json dependency removals, knip-config ignore edits), where each
// step re-parses the current text — that per-step re-parse is fine for
// documents this small (the ignore-config path is batched via
// addIgnoresBatch since #37; package.json dependency removals in
// fix/compiler.ts still chain here, and stay cheap at that document size).
// NOT for oxc source transforms: those go through the per-mode batch
// functions, which see one parse and original offsets.
export function chainTextEdits<T>(
  contentBefore: string,
  ops: readonly T[],
  step: (current: string, op: T) => TransformResult,
): { content: string; changed: boolean; results: TransformResult[] } {
  let current = contentBefore;
  let changed = false;
  const results: TransformResult[] = [];
  for (const op of ops) {
    const result = step(current, op);
    if (result.ok) {
      if (result.newContent !== current) changed = true;
      current = result.newContent;
    }
    results.push(result);
  }
  return { content: current, changed, results };
}
