import type { FixPlan } from './compiler.js';

// Single-use in-memory store for compiled plans: a plan is produced by
// compileFixPlan/compileIgnorePlan, `put` once, and `take`n exactly once at
// apply time (get+delete) so the same plan can never be replayed against a
// project whose files have since moved on.
export class PlanStore {
  private readonly plans = new Map<string, FixPlan>();

  put(plan: FixPlan): void {
    this.plans.set(plan.planId, plan);
  }

  take(planId: string): FixPlan | undefined {
    const plan = this.plans.get(planId);
    if (plan) this.plans.delete(planId);
    return plan;
  }
}
