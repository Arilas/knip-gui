import type { FixPlan } from './compiler.js';

const DEFAULT_MAX_PLANS = 20;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

interface Entry {
  plan: FixPlan;
  at: number;
}

// Single-use in-memory store for compiled plans: a plan is produced by
// compileFixPlan/compileIgnorePlan, `put` once, and `take`n exactly once at
// apply time (get+delete) so the same plan can never be replayed against a
// project whose files have since moved on.
//
// Plans carry full file contents/diffs, so an abandoned preview (the user
// navigates away or cancels client-side, which never calls take) would grow
// this map unboundedly. Two independent caps guard against that: an LRU-style
// count cap (oldest-by-insertion evicted first) and a TTL, so a plan is
// reclaimed even if the client never reconnects to delete it explicitly.
//
// No timer sweeps expired entries proactively — there's no unref'd interval
// to leak or to bookkeep across server lifecycle, and the store is only ever
// touched from route handlers, so pruning lazily on the next put/take/delete
// is sufficient; nothing needs entries gone before then.
export class PlanStore {
  private readonly plans = new Map<string, Entry>();
  private readonly maxPlans: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { maxPlans?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxPlans = opts.maxPlans ?? DEFAULT_MAX_PLANS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  put(plan: FixPlan): void {
    this.pruneExpired();
    // Drop any existing entry for this id first: a re-put is a refresh
    // (position + timestamp), not growth, so it must not trip the eviction
    // loop below into throwing out an unrelated older entry. Map.set alone
    // wouldn't do — it overwrites in place, keeping the old insertion slot.
    this.plans.delete(plan.planId);
    // Map preserves insertion order, so the first key is the oldest — evict it
    // before inserting the new one rather than after, so the map never
    // transiently exceeds maxPlans by more than the entry being added.
    while (this.plans.size >= this.maxPlans) {
      const oldest = this.plans.keys().next().value;
      if (oldest === undefined) break;
      this.plans.delete(oldest);
    }
    this.plans.set(plan.planId, { plan, at: this.now() });
  }

  take(planId: string): FixPlan | undefined {
    const entry = this.getLive(planId);
    if (entry) this.plans.delete(planId);
    return entry?.plan;
  }

  // Cancelled/abandoned previews: the client fires this on navigation so a
  // plan the user never applied doesn't sit around until TTL eviction. Pure
  // Map removal — deliberately does not take the shared busy latch (see
  // routes-fix.ts), since removing an in-memory plan can't race with a scan
  // or apply touching the filesystem.
  delete(planId: string): boolean {
    return this.getLive(planId) !== undefined && this.plans.delete(planId);
  }

  private getLive(planId: string): Entry | undefined {
    const entry = this.plans.get(planId);
    if (!entry) return undefined;
    if (this.now() - entry.at >= this.ttlMs) {
      this.plans.delete(planId);
      return undefined;
    }
    return entry;
  }

  private pruneExpired(): void {
    // Deleting during Map iteration is spec-safe (already-visited entries only)
    // and intentional — no snapshot copy needed.
    const now = this.now();
    for (const [id, entry] of this.plans) {
      if (now - entry.at >= this.ttlMs) this.plans.delete(id);
    }
  }
}
