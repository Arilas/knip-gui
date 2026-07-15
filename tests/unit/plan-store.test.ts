import { describe, expect, it } from 'vitest';
import { PlanStore } from '../../src/fix/plan-store.js';
import type { FixPlan } from '../../src/fix/compiler.js';

// Minimal fake plans — only planId matters to the store, the rest is never
// read by put/take/delete. Cast to satisfy FixPlan's shape without dragging
// in a real compile.
function fakePlan(planId: string): FixPlan {
  return { planId, kind: 'fix', patches: [], diffs: [], items: [], createdAt: '' } as FixPlan;
}

describe('PlanStore', () => {
  it('takes a plan exactly once (get+delete)', () => {
    const store = new PlanStore();
    store.put(fakePlan('p1'));
    expect(store.take('p1')).toEqual(fakePlan('p1'));
    expect(store.take('p1')).toBeUndefined();
  });

  it('evicts the oldest plan once maxPlans is exceeded (insertion order, not access order)', () => {
    const store = new PlanStore({ maxPlans: 2 });
    store.put(fakePlan('p1'));
    store.put(fakePlan('p2'));
    store.put(fakePlan('p3')); // evicts p1, the oldest by insertion
    expect(store.take('p1')).toBeUndefined();
    expect(store.take('p2')).toEqual(fakePlan('p2'));
    expect(store.take('p3')).toEqual(fakePlan('p3'));
  });

  it('does not evict on mere growth up to the cap', () => {
    const store = new PlanStore({ maxPlans: 2 });
    store.put(fakePlan('p1'));
    store.put(fakePlan('p2'));
    expect(store.take('p1')).toEqual(fakePlan('p1'));
    expect(store.take('p2')).toEqual(fakePlan('p2'));
  });

  it('expires a plan once ttlMs has elapsed, per an injected now()', () => {
    let now = 0;
    const store = new PlanStore({ ttlMs: 1000, now: () => now });
    store.put(fakePlan('p1'));
    now = 999;
    expect(store.take('p1')).toEqual(fakePlan('p1'));

    store.put(fakePlan('p2'));
    now += 1000; // p2's age is now exactly ttlMs — treated as expired (>=)
    expect(store.take('p2')).toBeUndefined();
  });

  it('prunes expired entries on put, so an expired plan does not count against the cap', () => {
    let now = 0;
    const store = new PlanStore({ maxPlans: 1, ttlMs: 100, now: () => now });
    store.put(fakePlan('p1'));
    now = 200; // p1 is now expired
    store.put(fakePlan('p2')); // put should prune p1 first, so p2 doesn't evict it via the cap path
    expect(store.take('p1')).toBeUndefined();
    expect(store.take('p2')).toEqual(fakePlan('p2'));
  });

  it('delete removes a live plan and reports true; deleting an unknown id reports false', () => {
    const store = new PlanStore();
    store.put(fakePlan('p1'));
    expect(store.delete('p1')).toBe(true);
    expect(store.take('p1')).toBeUndefined();
    expect(store.delete('does-not-exist')).toBe(false);
  });

  it('delete treats an expired entry as already absent', () => {
    let now = 0;
    const store = new PlanStore({ ttlMs: 100, now: () => now });
    store.put(fakePlan('p1'));
    now = 200;
    expect(store.delete('p1')).toBe(false);
  });

  it('take treats an expired entry as absent', () => {
    let now = 0;
    const store = new PlanStore({ ttlMs: 100, now: () => now });
    store.put(fakePlan('p1'));
    now = 100; // age === ttlMs — expired
    expect(store.take('p1')).toBeUndefined();
  });
});
