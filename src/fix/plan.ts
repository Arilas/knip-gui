import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FilePatch } from './patch.js';

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
