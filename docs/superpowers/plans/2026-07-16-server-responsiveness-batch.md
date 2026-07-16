# Server-Responsiveness Batch Implementation Plan (#33, #37)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Issue-number note:** the batch brief referred to the "server small wins" grab-bag as #36, but on GitHub that issue is **#37** ("Server small wins: cache the workspace walk, single-exec git status, batch ignore-config edits" — its body lists all four items planned here, including the assertContained/ARG_MAX item). GH #36 is the preview-diff/PlanStore-memory issue and is explicitly out of scope (see the out-of-scope section). Commits below reference **#37**.

**Goal:** Make the server responsive under the fix-issues-one-at-a-time workflow. (#33) Applying a fix currently holds the shared busy latch through the entire post-apply background rescan (`triggerBackgroundRescan`, `src/server/routes-fix.ts:56-63`), so on a monorepo where a scan takes 60–120s every subsequent apply 409s for that long. After this batch: applies return in milliseconds while rescans run as a coalescing background chain — N applies during one rescan cost exactly one corrective follow-up rescan, and the client's `/api/status` polling converges to the final report exactly as today. (#37) Four confirmed smaller costs: the sync recursive `getWorkspaceDirs` walk repeated on every rescan becomes async + mtime-cached and stops descending into build-output trees under `**` globs; `gitStatus` drops from 3 spawns + full untracked enumeration to 2 spawns with `--porcelain=v2 --branch -z --untracked-files=normal`; the O(edits × configSize) per-edit JSONC re-parse in ignore-config compilation becomes a single-parse batch that still reports per-edit failures; and `gitCommitPaths` parallelizes its serial containment checks and feeds pathspecs over stdin so ~10k-file commits can't hit ARG_MAX.

**Architecture:** #33 evolves the busy-latch model minimally: the `activeOp` latch (`ReportStore.tryBeginOp`/`endOp`, `src/server/store.ts:81-95`) keeps its exact contract and docs for every request-shaped op — manual scan, sweep, and all three applies still take it with the synchronous no-await-between check-and-set. What changes is that the **post-apply background rescan no longer holds it**. It runs as a "rescan chain" guarded by two new store flags (`rescanActive`, `rescanQueued`): applies landing mid-chain set `rescanQueued` and the chain loops one corrective iteration over the final disk state (**queued-follow-up, not abort-and-restart** — decision rationale in the design section). Scan and sweep routes gain a one-line `rescanActive` guard producing the same 409 wire shape (`{error: 'scan in progress', op: 'scan'}`) the latch-holding rescan produced, so the wire contract is unchanged. Two adjacent unlocks are required for the goal to be reachable end-to-end: the preview routes' gate relaxes from `status !== 'ready'` to `!store.report` (during a rescan the store is 'scanning' but still holds the previous report; per-file `hashBefore` staleness is the correctness guard), and `SelectionDock`'s Fix/Ignore entry buttons switch from `useBusy` (which includes `status === 'scanning'`) to a new mutations-only `useMutationBusy`. #37 items are four independent, separately-committable changes in `src/core/workspaces.ts`, `src/git/git.ts` (two items), and `src/ignore/config-writer.ts` + `src/ignore/compile.ts`.

**Tech Stack:** TypeScript (Node 20, ESM), Hono, jsonc-parser, vitest unit tests (in-process `app.request`, real temp git repos), Playwright e2e, pnpm 10. Dev git is 2.54; the stdin-pathspec change requires git ≥ 2.25 (Jan 2020).

## Global Constraints

- **Package manager: pnpm 10** (pnpm 11 is forbidden with Node 20). All commands run through pnpm: `pnpm test`, `pnpm test <file>`, `pnpm run typecheck`, `pnpm run test:e2e`.
- **Every existing unit AND e2e test passes unchanged.** The e2e suite (31 specs) is the behavioral gate for #33. Three timing contracts it pins:
  1. `tests/e2e/codepane-crash.spec.ts:79-84` polls `/api/report` right after an apply and asserts `status === 'scanning'` — so the rescan chain MUST set `setScanning()` **synchronously inside the apply request, before the response is sent** (no debounce/delay of the first rescan; only *followers* coalesce).
  2. `smoke.spec.ts` / `review.spec.ts` / `ignore.spec.ts` apply once and wait for the post-apply rescan to settle (badge/row disappears within 30s) — a single-apply chain must run exactly one iteration and land 'ready' with a fresh `scannedAt`, exactly like today.
  3. `tests/unit/server-fix.test.ts:249-275` and `tests/unit/ignores-endpoint.test.ts:173` pin that a **manually-held** `'scan'` latch (simulating a user-initiated `/api/scan`) still 409s applies with `{error: 'scan in progress', op: 'scan'}` — only the *background* rescan stops blocking applies; a manual scan keeps blocking them.
- **e2e runs are always the FULL suite (`pnpm run test:e2e`), never a filtered subset** — the suite has a documented alphabetical order dependency (ignore.spec.ts consumes the fixture's left-pad; context-preview.spec.ts must run before it).
- **Run `pnpm run typecheck` before every commit** (all three tsconfigs).
- **Wire contracts frozen:** the hyphenated `op` names in 409 bodies (`store.ts:20-34`), `ApplyResponse.rescanning: boolean`, `StatusResponse` shape, `GitStatus` field names. No client-visible schema changes anywhere in this batch.
- **Latch invariants stay true and documented:** no `await` between a guard and the `tryBeginOp` it protects; `endOp()` stays an unconditional clear (the chain never calls it); every route that *writes* the project or store either holds `activeOp` or is the rescan chain itself (whose store writes are coordinated by `rescanActive`/`rescanQueued` — the updated doc comments in Task 1 spell this out).
- This plan is executed on a feature branch, task by task, one commit per task.

---

## #33 design: the rescan-chain state machine (read before Task 1)

### Mechanism decision: queued follow-up, not abort-and-restart

The issue offers two mechanisms; **queued follow-up** is chosen because it is strictly simpler and touches nothing fragile:

- **No abort classification.** Abort-and-restart requires `runScanIntoStore` (`src/server/scan-runner.ts:20-42`) to distinguish "aborted, land nothing" from "failed, land setError" — otherwise the killed knip child's rejection lands `status: 'error'` mid-flight and the 2s status poll can catch it (error flash + spurious report invalidation client-side). Queued follow-up never aborts, so `runScanIntoStore` is untouched.
- **No latch-ownership transfer.** With the chain off the latch entirely, `applyPlanHandler` is byte-identical and `endOp`'s "clears unconditionally, nothing to compare against" doc stays true. Abort-preemption would need the aborted chain's `.finally` to *not* release a latch an apply now owns — a token/generation scheme grafted onto a model whose docs say exactly the opposite.
- **Bounded cost, right-shaped for the workflow.** The price is the doomed iteration's remaining runtime before the corrective one starts. What the user feels per apply is the *apply latency* (now ms, was scan-length); report freshness after the *last* apply is worst-case ~2 scan durations instead of ~1. `store.activeAbort` remains reserved for CLI shutdown (`abortActive`), its only current caller.

Accepted new overlap: an apply's `applyPatches` may write files while a chain iteration's knip child reads them. That iteration's landed result may be stale or even an error from a torn read — but any apply that overlapped it has set `rescanQueued`, so a corrective iteration over the final disk state always lands afterwards, and (see "observability" below) no HTTP request can observe the intermediate landing. Sweep and manual scan get **no** such corrective mechanism, which is exactly why their routes 409 while the chain runs.

### State

Two new public `ReportStore` fields (Task 1):

| Field | Meaning |
|---|---|
| `rescanActive: boolean` | A post-apply rescan chain is running. Blocks `/api/scan` and `/api/sweep` (409, reported as op `'scan'`), does NOT block applies. |
| `rescanQueued: boolean` | An apply landed while `rescanActive`; the chain runs exactly one corrective follow-up. Boolean, not a counter — N overlapping applies need one rescan of the final state. |

Existing state unchanged: `activeOp` (held only by request-shaped ops now), `status`, `lastScanScope`, `activeAbort` (still set per chain iteration via `beginScan`, so CLI shutdown reaps the in-flight knip child).

### Who holds what, when

| Event | `status` (/api/status) | `activeOp` | `rescanActive` | `rescanQueued` |
|---|---|---|---|---|
| idle, report ready | `ready` | — | false | false |
| apply #1 request (latched → patches → endOp) | `ready` during patches | `fix-apply` | false | false |
| apply #1 triggers chain (same tick, pre-response) | `scanning` | — | **true** | false |
| chain iteration 1: knip child running | `scanning` | — | true | false |
| apply #2 arrives mid-iteration: latch → patches → endOp → trigger sees `rescanActive` | `scanning` throughout | `fix-apply` → — | true | **true** (responds `{rescanning: true}` in ms) |
| iteration 1 lands (`setReady`/`setError`, stale) → loop sees `rescanQueued` → `setScanning` | `scanning` (intermediate landing unobservable, see below) | — | true | false (consumed) |
| iteration 2 (corrective) lands `setReady` → loop exits | `ready`, new `scannedAt` | — | **false** | false |
| `/api/scan` or `/api/sweep` while chain active | — | — | true → **409** `{error: 'scan in progress', op: 'scan'}` | |
| manual `/api/scan` in flight (user-initiated) | `scanning` | `scan` | false | — applies still **409** via `tryBeginOp` (unchanged, pinned by existing tests) |
| apply #2 while apply #1 still patching | | `fix-apply` → apply #2 **409s** `{error: 'fix apply in progress', op: 'fix-apply'}` | | applies stay mutually exclusive — two patch-appliers racing on disk is the data race the latch exists for; the window is ms, and the issue only complains about serializing behind *scans* |

**Observability guarantee (why the intermediate landing can't flap the client):** between iteration N's `setReady`/`setError` (inside `runScanIntoStore`) and the loop's next `setScanning`, control flows only through synchronous code and already-resolved-promise `await` resumptions — pure microtasks. An incoming HTTP request is a macrotask, and Node drains the microtask queue before running one. So `/api/status` observers see `scanning` continuously from the first apply until the FINAL landing, then `ready` with the final `scannedAt`. `useReportStatusSync` (`client/src/state/queries.ts:71-79`) sees `status` move `ready → scanning → ready` with one `scannedAt` bump → exactly one heavy report refetch. Convergent.

**Why `/api/scan` and `/api/sweep` must 409 during the chain:** a sweep's own awaited rescan (routes-fix.ts:171-179) could land, then the stale chain iteration lands *after* it and clobbers the fresh report with pre-sweep state; a concurrent manual scan means two knip children racing to land with ambiguous ordering. Neither has a queue to correct itself. Client UX is unchanged: `useBusy` already disables Re-run/sweep/workspace-switch while `status === 'scanning'`.

---

## Task 1: #33 — rescan chain off the busy latch, coalescing follow-ups

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/server/store.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/server/routes-fix.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/server/index.ts`
- Test (modify): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/server-fix.test.ts`

### Steps

- [ ] **Write the failing tests.** Append to `tests/unit/server-fix.test.ts` (uses the existing `makeProject`/`jsonHeaders`/`fakeRaw` helpers):

  ```ts
  describe('#33: applies do not serialize behind background rescans', () => {
    // Scan double whose FIRST call (the initial /api/scan) resolves
    // immediately and whose every later call (chain iterations) blocks until
    // released one at a time — lets a test hold a rescan "in flight".
    function makeGatedScan() {
      const pending: Array<() => void> = [];
      let calls = 0;
      return {
        scan: async () => {
          calls++;
          if (calls > 1) await new Promise<void>((r) => pending.push(r));
          return fakeRaw;
        },
        releaseOne: () => pending.shift()?.(),
        get calls() { return calls; },
        get blockedCount() { return pending.length; },
      };
    }

    async function waitFor(cond: () => boolean): Promise<void> {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(cond()).toBe(true);
    }

    async function makeGatedServer() {
      const dir = await makeProject();
      const gated = makeGatedScan();
      const server = createServer({ projectDir: dir, scan: gated.scan });
      const h = jsonHeaders(server.token);
      const scanRes = await server.app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
      expect(scanRes.status).toBe(200);
      return { ...server, dir, h, gated };
    }

    async function makePlan(server: Awaited<ReturnType<typeof makeGatedServer>>, kind: 'fix' | 'ignore', issueType: string) {
      const issue = server.store.report!.issues.find((i) => i.type === issueType)!;
      const res = await server.app.request(`/api/${kind}/preview`, {
        method: 'POST',
        headers: server.h,
        body: JSON.stringify({ issueIds: [issue.id] }),
      });
      expect(res.status).toBe(200);
      return (await res.json()).planId as string;
    }

    it('a second apply lands (200) while the first apply\'s rescan is in flight, and coalesces to ONE follow-up', async () => {
      const server = await makeGatedServer();
      // Both plans compiled up front, while the store is still 'ready'
      // (preview-during-scanning is Task 2's change, not this one's).
      const fixPlan = await makePlan(server, 'fix', 'exports');
      const ignorePlan = await makePlan(server, 'ignore', 'files');

      const apply1 = await server.app.request('/api/fix/apply', {
        method: 'POST', headers: server.h, body: JSON.stringify({ planId: fixPlan }),
      });
      expect(apply1.status).toBe(200);
      expect((await apply1.json()).rescanning).toBe(true);
      // Chain iteration 1 is now blocked inside the gated scan.
      await waitFor(() => server.gated.blockedCount === 1);
      expect(server.store.status).toBe('scanning');
      expect(server.store.rescanActive).toBe(true);

      // THE #33 pin: pre-change this 409'd with {error:'scan in progress'}.
      const apply2 = await server.app.request('/api/ignore/apply', {
        method: 'POST', headers: server.h, body: JSON.stringify({ planId: ignorePlan }),
      });
      expect(apply2.status).toBe(200);
      expect((await apply2.json()).rescanning).toBe(true);
      expect(server.store.rescanQueued).toBe(true);

      // Status stays 'scanning' the whole time (client polling contract).
      const statusMid = await server.app.request('/api/status', { headers: server.h });
      expect((await statusMid.json()).status).toBe('scanning');

      server.gated.releaseOne(); // iteration 1 lands (stale) → follow-up starts
      await waitFor(() => server.gated.blockedCount === 1);
      server.gated.releaseOne(); // corrective iteration lands
      await waitFor(() => server.store.status === 'ready');
      expect(server.store.rescanActive).toBe(false);
      // initial scan + iteration 1 + ONE corrective follow-up = 3.
      expect(server.gated.calls).toBe(3);
    });

    it('N applies during one in-flight rescan coalesce to exactly ONE follow-up (rescanQueued is a flag, not a counter)', async () => {
      const server = await makeGatedServer();
      const fixPlan = await makePlan(server, 'fix', 'exports');
      const ignorePlan = await makePlan(server, 'ignore', 'files');
      // A second ignore plan against the same files issue — it compiles
      // independently, and by the time it applies the knip.json it hashed has
      // moved (the first ignore apply rewrote it), so its patch lands a
      // per-file 'stale' result. That's fine: the latch/queue path — apply
      // 200s, rescanQueued coalesces — is what's under test here, and a
      // stale-result apply still triggers the rescan.
      const ignorePlan2 = await makePlan(server, 'ignore', 'files');

      await server.app.request('/api/fix/apply', {
        method: 'POST', headers: server.h, body: JSON.stringify({ planId: fixPlan }),
      });
      await waitFor(() => server.gated.blockedCount === 1);

      for (const planId of [ignorePlan, ignorePlan2]) {
        const res = await server.app.request('/api/ignore/apply', {
          method: 'POST', headers: server.h, body: JSON.stringify({ planId }),
        });
        expect(res.status).toBe(200);
      }

      server.gated.releaseOne();
      await waitFor(() => server.gated.blockedCount === 1);
      server.gated.releaseOne();
      await waitFor(() => server.store.status === 'ready');
      // initial + iteration 1 + ONE follow-up — not one per apply.
      expect(server.gated.calls).toBe(3);
    });

    it('scan and sweep 409 while the chain is active, naming op "scan" (same wire shape as the old latch-holding rescan)', async () => {
      const server = await makeGatedServer();
      const fixPlan = await makePlan(server, 'fix', 'exports');
      await server.app.request('/api/fix/apply', {
        method: 'POST', headers: server.h, body: JSON.stringify({ planId: fixPlan }),
      });
      await waitFor(() => server.gated.blockedCount === 1);

      const scanRes = await server.app.request('/api/scan', { method: 'POST', headers: server.h, body: '{}' });
      expect(scanRes.status).toBe(409);
      expect(await scanRes.json()).toEqual({ error: 'scan in progress', op: 'scan' });

      const sweepRes = await server.app.request('/api/sweep', { method: 'POST', headers: server.h, body: '{}' });
      expect(sweepRes.status).toBe(409);
      expect(await sweepRes.json()).toEqual({ error: 'scan in progress', op: 'scan' });

      server.gated.releaseOne();
      await waitFor(() => server.store.status === 'ready');
      expect(server.gated.calls).toBe(2); // no follow-up was queued
    });
  });
  ```

- [ ] Run `pnpm test tests/unit/server-fix.test.ts` — expected: the three new tests FAIL (`rescanActive` doesn't exist; apply2 409s), everything else green.

- [ ] **Store: add the two chain flags.** In `src/server/store.ts`, insert after the `activeOp` field (line 69) and BEFORE `tryBeginOp`:

  ```ts
  /**
   * True while the post-apply background rescan chain is running (#33). The
   * chain deliberately does NOT hold `activeOp` — that is the entire fix:
   * applies (fast, disk-write-bounded, still individually latched via their
   * own op) no longer serialize behind a full knip scan. The cost is that an
   * iteration overlapped by an apply may land a stale (or torn-read error)
   * result; `rescanQueued` guarantees a corrective follow-up lands afterwards,
   * and no HTTP observer can catch the intermediate landing (the chain flips
   * status back to 'scanning' within the same microtask turn — see
   * runRescanChain in routes-fix.ts). Scan and sweep have NO corrective
   * mechanism — a stale chain landing could clobber their fresh results — so
   * their routes 409 while this is true, reported as op 'scan', exactly the
   * wire shape the old latch-holding rescan produced.
   */
  rescanActive = false;
  /**
   * Set by triggerBackgroundRescan when an apply lands while `rescanActive`;
   * consumed (once) by the chain loop to run one follow-up rescan. A boolean,
   * not a counter: N applies overlapping one iteration need exactly ONE
   * corrective rescan of the final on-disk state.
   */
  rescanQueued = false;
  ```

  And extend the `activeOp` doc comment (lines 62-68) — append one sentence to the existing paragraph:

  ```ts
  // (append to the existing comment, before the closing */)
   * The one deliberate exception is the post-apply background rescan chain,
   * which reads (never writes) the project and coordinates through
   * rescanActive/rescanQueued below instead — see their comments for why
   * that is safe for applies and why scan/sweep still block on it.
  ```

- [ ] **routes-fix.ts: replace `triggerBackgroundRescan` with the chain.** Replace the whole block — the comment at lines 42-55 AND the function at lines 56-63 — with:

  ```ts
  // Fire-and-forget rescan chain after a fix/ignore apply (#33). Unlike the
  // pre-#33 version, this does NOT take the shared busy latch: holding
  // tryBeginOp('scan') through a 60–120s monorepo rescan made every
  // subsequent apply 409 behind it. Instead the chain runs under the store's
  // rescanActive flag; an apply landing mid-chain sets rescanQueued and gets
  // exactly one corrective follow-up iteration (see runRescanChain).
  // Scan/sweep routes 409 while the chain runs (their guards check
  // rescanActive) because a stale chain landing could clobber their fresh
  // results and they have no follow-up mechanism to correct it.
  // Exported for routes-ignores.ts via applyPlanHandler, same as before.
  export function triggerBackgroundRescan(ctx: FixRoutesCtx): boolean {
    const { store } = ctx;
    if (store.rescanActive) {
      // Coalesce: the running chain observes this once its current iteration
      // lands and runs ONE corrective follow-up over the final disk state.
      store.rescanQueued = true;
      return true;
    }
    // Cheap insurance, same spirit as the tryBeginOp('scan') guard this
    // replaces: from applyPlanHandler this can't fire (the handler released
    // its own op synchronously in the same tick, and nothing else can have
    // claimed the latch with no await in the gap), but a future caller
    // arriving while a sweep or manual scan holds the latch must not start a
    // chain that races it.
    if (store.activeOp) return false;
    store.rescanActive = true;
    // Synchronous with the apply that triggered us: the apply's HTTP response
    // is sent after this returns, so a client polling right after an apply
    // always observes 'scanning' (codepane-crash.spec.ts pins exactly this).
    store.setScanning();
    void runRescanChain(ctx);
    return true;
  }

  // The chain loop. Queued-follow-up was chosen over abort-and-restart
  // (store.activeAbort) deliberately: no abort-vs-failure classification in
  // runScanIntoStore, no latch-ownership transfer out of a preempted finally,
  // no killed-child semantics — the price is one doomed iteration's remaining
  // runtime before the corrective one, paid only when applies actually
  // overlap a rescan.
  //
  // Status is never observably wrong mid-chain: between an iteration's own
  // setReady/setError (inside runScanIntoStore) and the loop's next
  // setScanning there are only synchronous frames and already-resolved-
  // promise await resumptions — pure microtasks, which Node drains before
  // any macrotask, and an incoming HTTP request is a macrotask. Observers
  // therefore see 'scanning' continuously from the first apply until the
  // FINAL landing.
  async function runRescanChain(ctx: FixRoutesCtx): Promise<void> {
    const { store } = ctx;
    try {
      do {
        store.rescanQueued = false;
        store.setScanning();
        await performRescan(ctx);
      } while (store.rescanQueued);
    } finally {
      store.rescanActive = false;
    }
  }
  ```

  Also update `applyPlanHandler`'s doc comment (lines 66-70): replace the last sentence fragment `and endOp() released synchronously with no await before triggerBackgroundRescan's own tryBeginOp('scan') — nothing can slip into that gap.` with `and endOp() released synchronously with no await before triggerBackgroundRescan — so nothing can claim the latch in the gap, which is what lets triggerBackgroundRescan treat a held activeOp as "a caller other than us" (see its insurance guard).`

- [ ] **routes-fix.ts: sweep guard.** In the `/api/sweep` route, insert immediately BEFORE the existing `if (!store.tryBeginOp('sweep'))` (line 147), keeping both checks synchronous and adjacent (no await between them):

  ```ts
    // #33: the background rescan chain doesn't hold the shared latch, but a
    // sweep rewriting files under a chain iteration's knip read — and the
    // stale chain landing then clobbering the sweep's own awaited rescan
    // result — is exactly the race the latch used to prevent. Same 409 wire
    // shape the latch-holding rescan produced.
    if (store.rescanActive) {
      return c.json({ error: `${BUSY_OP_LABELS.scan} in progress`, op: 'scan' }, 409);
    }
  ```

- [ ] **index.ts: scan guard.** In `/api/scan` (`src/server/index.ts`), insert immediately BEFORE the existing `if (!store.tryBeginOp('scan'))` (line 173), same shape:

  ```ts
    // #33: a manual scan racing a background rescan chain would mean two knip
    // children landing results in ambiguous order. Same 409 wire shape the
    // latch-holding rescan produced; the client's Re-run control is disabled
    // while status is 'scanning' anyway (useBusy), so this is unreachable
    // from the UI.
    if (store.rescanActive) {
      return c.json({ error: `${BUSY_OP_LABELS.scan} in progress`, op: 'scan' }, 409);
    }
  ```

- [ ] Run `pnpm test tests/unit/server-fix.test.ts` — expected: PASS, including all pre-existing latch tests (manual-latch 409s, sweep-stall 409, production-mode rescan threading — the chain produces exactly the `>= 2` scan calls that test polls for).
- [ ] Run `pnpm test` — expected: full unit suite green (server-scope.test.ts's settle-poll and ignores-endpoint.test.ts's `rescanning: true` pins are chain-compatible).
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] Run `pnpm run test:e2e` — expected: FULL suite green. The hard gate is `codepane-crash.spec.ts` (status must read 'scanning' immediately post-apply — the chain sets it synchronously pre-response) and the smoke/review/ignore post-apply settle waits.
- [ ] Commit: `perf: post-apply rescans coalesce off the busy latch — applies no longer serialize behind scans (#33)`

---

## Task 2: #33 enablers — preview under a rescan, review-entry buttons not scan-gated

Without this task the latch fix is unreachable end-to-end: the *next* apply flow starts at preview, and `/api/fix/preview` 409s whenever `status !== 'ready'` (`routes-fix.ts:99`) — i.e. during the entire background rescan — while `SelectionDock`'s Fix…/Ignore… buttons are disabled by `useBusy` (which is true while `status === 'scanning'`, `client/src/state/queries.ts:260-266`).

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/server/routes-fix.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/state/queries.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/client/src/components/SelectionDock.tsx`
- Test (modify): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/server-fix.test.ts`

### Steps

- [ ] **Write the failing test.** Append inside the `#33: applies do not serialize behind background rescans` describe from Task 1:

  ```ts
    it('preview succeeds during a background rescan (compiles against the previous report)', async () => {
      const server = await makeGatedServer();
      const fixPlan = await makePlan(server, 'fix', 'exports');
      await server.app.request('/api/fix/apply', {
        method: 'POST', headers: server.h, body: JSON.stringify({ planId: fixPlan }),
      });
      await waitFor(() => server.gated.blockedCount === 1);
      expect(server.store.status).toBe('scanning');

      // Pre-change: 409 'no report available'. The previous report is still
      // in the store (setScanning doesn't clear it) and per-file hashBefore
      // staleness protects apply-time correctness.
      const previewRes = await server.app.request('/api/ignore/preview', {
        method: 'POST',
        headers: server.h,
        body: JSON.stringify({ issueIds: [server.store.report!.issues.find((i) => i.type === 'files')!.id] }),
      });
      expect(previewRes.status).toBe(200);
      expect((await previewRes.json()).planId).toEqual(expect.any(String));

      server.gated.releaseOne();
      await waitFor(() => server.store.status === 'ready');
    });
  ```

- [ ] Run `pnpm test tests/unit/server-fix.test.ts` — expected: the new test FAILS (409).

- [ ] **Relax both preview gates.** In `src/server/routes-fix.ts`, replace the guard line in `/api/fix/preview` (line 99) AND the identical one in `/api/ignore/preview` (line 129) — both currently `if (store.status !== 'ready' || !store.report) return c.json({ error: 'no report available' }, 409);` — with:

  ```ts
    // Requires a report to compile against, not a 'ready' status (#33):
    // during a post-apply background rescan the store is 'scanning' but still
    // holds the previous report, and gating on 'ready' here would
    // re-serialize consecutive apply flows behind the very scan the rescan
    // chain stopped blocking on. Compiling against a possibly-stale report is
    // safe: every patch carries hashBefore, so applyPatches lands a per-file
    // 'stale' result instead of clobbering content that moved (pinned by the
    // "reports a per-file stale result" test in tests/unit/server-fix.test.ts).
    if (!store.report) return c.json({ error: 'no report available' }, 409);
  ```

  (The existing "409s preview when the report is not ready yet" tests still pass: before any scan there is no report at all. `/api/ignores/remove/preview` in routes-ignores.ts never had a status gate — it lists from the config file — so nothing changes there.)

- [ ] **Client: mutations-only busy flag for review entry.** In `client/src/state/queries.ts`, replace the `useBusy` implementation (lines 260-266) with a composed pair (the existing doc comment above `useBusy` stays, with one appended sentence):

  ```ts
  /**
   * True while any scan/sweep/apply MUTATION this client started is in
   * flight. Unlike useBusy, deliberately ignores a server-side background
   * rescan (status 'scanning'): preview and apply are allowed under a rescan
   * server-side (#33), so the Fix…/Ignore… review-entry buttons must not stay
   * dead for a full monorepo scan after every apply. Controls that TRIGGER a
   * scan/sweep (Re-run, sweep button, workspace switch) keep useBusy — those
   * requests would 409 against the rescan chain anyway.
   */
  export function useMutationBusy(): boolean {
    return (
      useIsMutating({
        predicate: (mutation: Mutation) => BUSY_MUTATION_KEYS.includes(String(mutation.options.mutationKey?.[0])),
      }) > 0
    );
  }

  // True while a scan/sweep/apply mutation is in flight, or the last-known
  // report is still 'scanning' (covers the fire-and-forget rescan chain the
  // server runs after fix/ignore applies, which isn't itself one of our
  // mutations). Review ENTRY uses useMutationBusy instead — see its comment.
  export function useBusy(): boolean {
    const mutating = useMutationBusy();
    const { data } = useStatus();
    return mutating || data?.status === 'scanning';
  }
  ```

- [ ] **SelectionDock: switch the gate.** In `client/src/components/SelectionDock.tsx`, change the import (line 24) to `import { useMutationBusy } from '../state/queries.js';` and line 43 to:

  ```ts
  // useMutationBusy, not useBusy (#33): a background rescan after an apply
  // must not disable starting the NEXT fix/ignore review — the server now
  // accepts preview/apply under a rescan and coalesces the follow-up. An
  // apply mutation in flight still disables these (applies are mutually
  // exclusive server-side).
  const busy = useMutationBusy();
  ```

  All other `useBusy` call sites (GitFooter Re-run, Dashboard sweep, CommandPalette, use-workspace-switch, use-global-shortcuts, ReviewPage's all-stale Rescan button) are untouched — they all trigger scans/sweeps, which 409 during the chain.

- [ ] Run `pnpm test` — expected: green (new preview test passes).
- [ ] Run `pnpm run typecheck` — expected: clean (confirms no other consumer of the changed SelectionDock import).
- [ ] Run `pnpm run test:e2e` — expected: FULL suite green (specs only click selbar buttons while status is settled, so the gating swap is invisible to them).
- [ ] **Manual verification:** `pnpm run e2e:fixture` (or a dev run against a scratch monorepo with an artificially slow scan), apply one fix, and while the footer still shows the scan in flight: select another issue → Fix… button is clickable → preview renders → apply succeeds; the report refreshes once, after the follow-up rescan lands.
- [ ] Commit: `feat: preview + review entry stay available during background rescans (#33)`

---

## Task 3: #37 item 1 — async, mtime-cached getWorkspaceDirs; build-output dirs skipped in `**` globs

The sync `readdirSync` walk (`src/core/workspaces.ts:78-106`) blocks the event loop 100ms–2s per scan on big trees, repeats after every apply's rescan (called from `src/server/scan-runner.ts:31`), and descends into `dist/`/`.turbo/`-style trees under `**` globs.

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/core/workspaces.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/index.ts` (re-export `clearWorkspaceDirsCache`)
- Test (modify): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/workspaces.test.ts`

### Steps

- [ ] **Write the failing tests.** Append to `tests/unit/workspaces.test.ts` (extend the fs import on line 1 with `utimesSync`, and the workspaces import on line 5 with `clearWorkspaceDirsCache`):

  ```ts
  describe('getWorkspaceDirs: mtime-keyed cache (#37)', () => {
    let dir: string;
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

    function pkg(rel: string): void {
      mkdirSync(join(dir, rel), { recursive: true });
      writeFileSync(join(dir, rel, 'package.json'), JSON.stringify({ name: rel }));
    }

    it('reuses the cached walk while both manifests are unchanged (documented staleness)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-cache-'));
      clearWorkspaceDirsCache();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
      pkg('packages/a');
      expect(await getWorkspaceDirs(dir)).toContain('packages/a');

      // New dir matching the glob, manifests untouched → cache hit, stale by
      // design (the accepted contract; see the cache comment in workspaces.ts).
      pkg('packages/b');
      expect(await getWorkspaceDirs(dir)).not.toContain('packages/b');
    });

    it('re-walks when the root package.json mtime moves', async () => {
      dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-cache-'));
      clearWorkspaceDirsCache();
      const manifest = join(dir, 'package.json');
      writeFileSync(manifest, JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
      pkg('packages/a');
      await getWorkspaceDirs(dir);

      pkg('packages/b');
      // Bump mtime explicitly — same-content rewrites within one timestamp
      // granule would otherwise make this flaky.
      const later = new Date(Date.now() + 5_000);
      utimesSync(manifest, later, later);
      expect(await getWorkspaceDirs(dir)).toContain('packages/b');
    });

    it('clearWorkspaceDirsCache forces a re-walk', async () => {
      dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-cache-'));
      clearWorkspaceDirsCache();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
      pkg('packages/a');
      await getWorkspaceDirs(dir);
      pkg('packages/b');
      clearWorkspaceDirsCache();
      expect(await getWorkspaceDirs(dir)).toContain('packages/b');
    });

    it('returns a fresh array per call (cache hits are copies, not shared references)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-cache-'));
      clearWorkspaceDirsCache();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
      pkg('packages/a');
      const first = await getWorkspaceDirs(dir);
      first.length = 0; // a consumer mutating its copy...
      expect(await getWorkspaceDirs(dir)).toContain('packages/a'); // ...must not poison the cache
    });
  });

  describe('getWorkspaceDirs: build-output dirs and `**` (#37)', () => {
    let dir: string;
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

    function pkg(rel: string): void {
      mkdirSync(join(dir, rel), { recursive: true });
      writeFileSync(join(dir, rel, 'package.json'), JSON.stringify({ name: rel }));
    }

    it('`packages/**` does not descend into build-output dirs (dist, .turbo, coverage, ...)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-skip-'));
      clearWorkspaceDirsCache();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/**'] }));
      pkg('packages/a');
      pkg('packages/a/dist/bundled-fixture'); // stray package.json in build output
      pkg('packages/.turbo/cached');
      const dirs = await getWorkspaceDirs(dir);
      expect(dirs).toContain('packages/a');
      expect(dirs.some((d) => d.includes('dist') || d.includes('.turbo'))).toBe(false);
    });

    it('an explicit single-`*` glob still matches a directory literally named dist', async () => {
      dir = mkdtempSync(join(tmpdir(), 'knip-gui-ws-skip-'));
      clearWorkspaceDirsCache();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
      pkg('packages/dist'); // unusual but explicitly requested by the glob
      expect(await getWorkspaceDirs(dir)).toContain('packages/dist');
    });
  });
  ```

- [ ] Run `pnpm test tests/unit/workspaces.test.ts` — expected: FAIL (`clearWorkspaceDirsCache` unresolved; skip/cache behaviors absent).

- [ ] **Rewrite `src/core/workspaces.ts`.** Complete new module (the glob semantics — `expandPattern`, `segmentRegex`, `matchesGlob`, negative patterns, sort order — are byte-for-byte preserved; only I/O goes async and the cache + deep-glob skip are added):

  ```ts
  import { access, readdir, readFile, stat } from 'node:fs/promises';
  import { join } from 'node:path';

  // Directories never treated as (or descended into while searching for) workspaces —
  // they can contain thousands of nested package.json files that are not project
  // workspaces, and a `**` glob would otherwise harvest all of them.
  const SKIP_DIRS = new Set(['node_modules', '.git']);

  // Additionally skipped ONLY while expanding a `**` deep wildcard (#37):
  // build-output trees are deep, churn constantly, and can contain stray
  // package.json files (bundled fixtures, publish-staging dirs) that are not
  // workspaces. Explicit patterns keep working — a literal or single-`*`
  // segment still matches a directory named `dist`; only the unbounded `**`
  // harvest refuses to descend into these.
  const DEEP_GLOB_SKIP_DIRS = new Set([
    'dist', 'build', 'out', 'coverage',
    '.turbo', '.next', '.nuxt', '.output', '.cache', '.vite', '.svelte-kit',
  ]);

  // Walk-result cache, keyed per project dir, fingerprinted on the mtime+size
  // of both workspace manifests (#37): the walk used to rerun — synchronously,
  // 100ms–2s on big trees — after EVERY post-apply rescan. Staleness contract
  // (documented, accepted): creating or deleting a workspace DIRECTORY without
  // touching either manifest (e.g. `mkdir packages/new` under an existing
  // `packages/*` glob) is invisible until a manifest's mtime/size moves, the
  // cache is cleared, or the process restarts. The hot path re-walks exactly
  // when the glob SOURCE can have changed — workspace globs live only in the
  // root package.json and pnpm-workspace.yaml.
  interface CacheEntry { fingerprint: string; dirs: string[] }
  const cache = new Map<string, CacheEntry>();

  /** Test hook (and escape hatch for embedders): drop every cached walk. */
  export function clearWorkspaceDirsCache(): void {
    cache.clear();
  }

  async function manifestFingerprint(projectDir: string): Promise<string> {
    const parts = await Promise.all(
      ['package.json', 'pnpm-workspace.yaml'].map(async (name) => {
        try {
          const s = await stat(join(projectDir, name));
          // size alongside mtimeMs so a same-timestamp-granule rewrite that
          // changes length still misses the cache.
          return `${name}:${s.mtimeMs}:${s.size}`;
        } catch {
          return `${name}:absent`;
        }
      }),
    );
    return parts.join('|');
  }

  export async function getWorkspaceDirs(projectDir: string): Promise<string[]> {
    const fingerprint = await manifestFingerprint(projectDir);
    const hit = cache.get(projectDir);
    // Copies on the way out (both branches): report/normalize consumers own
    // their array; a mutated return value must never poison the cache.
    if (hit && hit.fingerprint === fingerprint) return [...hit.dirs];

    const positive = new Set<string>();
    const negative = new Set<string>();

    for (const pattern of await collectPatterns(projectDir)) {
      if (pattern.startsWith('!')) {
        negative.add(pattern.slice(1).replace(/\/$/, ''));
      } else {
        positive.add(pattern.replace(/\/$/, ''));
      }
    }

    const dirs = new Set<string>();
    for (const pattern of positive) {
      for (const match of await expandPattern(projectDir, pattern)) dirs.add(match);
    }
    // Apply negative patterns against the fully-expanded set so `!packages/private`
    // (or `!packages/*`) actually excludes matches, rather than being silently dropped.
    for (const pattern of negative) {
      for (const match of [...dirs]) {
        if (matchesGlob(pattern.split('/'), match.split('/'))) dirs.delete(match);
      }
    }

    const result = [...[...dirs].sort((a, b) => b.length - a.length || a.localeCompare(b)), '.'];
    cache.set(projectDir, { fingerprint, dirs: result });
    return [...result];
  }

  // Reads workspace globs from package.json (`workspaces` array or
  // `workspaces.packages`) and pnpm-workspace.yaml (only the list under the
  // top-level `packages:` key — other list-valued keys like `catalog:` /
  // `onlyBuiltDependencies:` must not be mistaken for workspace globs).
  async function collectPatterns(projectDir: string): Promise<string[]> {
    const patterns: string[] = [];

    try {
      const pkg = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (Array.isArray(ws)) for (const p of ws) if (typeof p === 'string') patterns.push(p);
    } catch {
      // Absent or malformed package.json — treat as no workspaces rather than throwing.
    }

    let pnpmYaml: string | undefined;
    try {
      pnpmYaml = await readFile(join(projectDir, 'pnpm-workspace.yaml'), 'utf8');
    } catch {
      // No pnpm-workspace.yaml.
    }
    if (pnpmYaml !== undefined) {
      let inPackages = false;
      for (const line of pnpmYaml.split('\n')) {
        if (/^\S/.test(line)) inPackages = /^packages:\s*(#.*)?$/.test(line); // a new top-level key
        if (!inPackages) continue;
        const m = line.match(/^\s+-\s*['"]?([^'"#\s]+)['"]?/);
        if (m) patterns.push(m[1]!);
      }
    }

    return patterns;
  }

  // Expands one workspace glob into the project-relative directories that both match
  // the pattern AND contain a package.json. Supports literal segments, single-segment
  // `*` wildcards (`packages/*`, `apps/*/plugin`), and the `**` deep wildcard
  // (`packages/**`, matching zero or more path segments).
  async function expandPattern(projectDir: string, pattern: string): Promise<string[]> {
    const out: string[] = [];
    await walk(projectDir, '', pattern.split('/').filter(Boolean), out);
    return out;
  }

  // Concurrent pushes into `out` (the Promise.all fan-outs below) make its
  // order nondeterministic; getWorkspaceDirs sorts the deduped set, so the
  // final result is deterministic regardless.
  async function walk(rootAbs: string, relSoFar: string, segments: string[], out: string[]): Promise<void> {
    if (segments.length === 0) {
      if (relSoFar) {
        try {
          await access(join(rootAbs, relSoFar, 'package.json'));
          out.push(relSoFar);
        } catch {
          // No package.json — matches the pattern but isn't a workspace.
        }
      }
      return;
    }
    const [seg, ...rest] = segments;
    const currentAbs = join(rootAbs, relSoFar);
    let entries: string[];
    try {
      entries = (await readdir(currentAbs, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
        .map((d) => d.name);
    } catch {
      return; // not a readable directory
    }

    if (seg === '**') {
      // `**` matches zero segments (try the rest right here) and one-or-more (recurse
      // into each subdir keeping `**` at the head). Build-output dirs are pruned from
      // the recursion ONLY here — see DEEP_GLOB_SKIP_DIRS.
      await walk(rootAbs, relSoFar, rest, out);
      await Promise.all(
        entries
          .filter((name) => !DEEP_GLOB_SKIP_DIRS.has(name))
          .map((name) => walk(rootAbs, join(relSoFar, name), segments, out)),
      );
      return;
    }

    const re = segmentRegex(seg!);
    await Promise.all(
      entries.filter((name) => re.test(name)).map((name) => walk(rootAbs, join(relSoFar, name), rest, out)),
    );
  }

  // Compiles a single path segment glob (`*`, `foo*`, `foo`) to an anchored regex.
  // `*` matches any run of characters within the one segment (no `/`).
  function segmentRegex(seg: string): RegExp {
    const escaped = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`);
  }

  // Whether a project-relative path (as segments) matches a glob (as segments),
  // used only to apply negative exclusion patterns to already-collected dirs.
  function matchesGlob(pattern: string[], path: string[]): boolean {
    if (pattern.length === 0) return path.length === 0;
    const [seg, ...rest] = pattern;
    if (seg === '**') {
      for (let i = 0; i <= path.length; i++) {
        if (matchesGlob(rest, path.slice(i))) return true;
      }
      return false;
    }
    if (path.length === 0) return false;
    if (!segmentRegex(seg!).test(path[0]!)) return false;
    return matchesGlob(rest, path.slice(1));
  }
  ```

- [ ] **Re-export the cache hook.** In `src/index.ts` line 4, extend to:

  ```ts
  export { getWorkspaceDirs, clearWorkspaceDirsCache } from './core/workspaces.js';
  ```

- [ ] Run `pnpm test tests/unit/workspaces.test.ts` — expected: PASS, including all pre-existing glob tests (each uses a fresh `mkdtemp` dir, so the per-projectDir cache can't cross-contaminate them; the two fixture-dir tests calling the same path twice get identical cached results).
- [ ] Run `pnpm test` — expected: full suite green (server tests each scan fresh temp dirs → distinct cache keys; the e2e fixture's applies edit knip.json / workspace-local package.jsons, neither of which is a fingerprint input, and the workspace-glob set genuinely doesn't change there).
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] Commit: `perf: async + mtime-cached getWorkspaceDirs walk; build-output dirs pruned from ** globs (#37)`

---

## Task 4: #37 item 2 — gitStatus via one porcelain-v2 exec (3 spawns → 2, no full untracked enumeration)

`gitStatus` (`src/git/git.ts:83-113`) spawns `rev-parse --show-toplevel`, `branch --show-current`, and `status --porcelain -z --untracked-files=all` on every call, and the client invalidates it after every write mutation (`client/src/state/queries.ts:138`). `--untracked-files=all` enumerates every file of every untracked tree — seconds on big cold worktrees.

**Scope decisions (from checking what the client actually consumes):** `GitStatus` is read by GitFooter (`dirtyFiles.length` count + `dirty` dot + `branch`), CommitBar (`dirtyFiles` filtered against plan paths for a *warning list*; the commit itself posts plan paths, never `dirtyFiles`), and ReviewPage (`isRepo`). All `dirtyFiles` consumers are display-only ⇒ `--untracked-files=normal` is safe: an untracked directory collapses to one `dir/` entry (count reads lower, warning list shows the dir), and every path an apply itself touches is an entry-by-entry modification of a tracked file or a tracked deletion, so the CommitBar filter keeps matching. The `rev-parse --show-toplevel` spawn **stays**: the repo-root identity check (isRepo only when `projectDir` IS the toplevel — pinned by `git.test.ts:52`) cannot be derived from porcelain v2 output, so this is 2 execs, not 1; the eliminated costs are the third spawn and the untracked enumeration, which were the actual reported pain.

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/git/git.ts`
- Test (modify): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/git.test.ts`

### Steps

- [ ] **Write the failing tests.** Append inside `git.test.ts`'s `describe('gitStatus', …)`:

  ```ts
    it('collapses an untracked directory to a single "dir/" entry (--untracked-files=normal, #37)', async () => {
      const dir = await makeTmpDir('knip-gui-git-untracked-dir-');
      await initRepo(dir);
      await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
      await commitAll(dir, 'initial');

      await mkdir(join(dir, 'newdir'));
      await writeFile(join(dir, 'newdir', 'one.txt'), '1', 'utf8');
      await writeFile(join(dir, 'newdir', 'two.txt'), '2', 'utf8');

      const status = await gitStatus(dir);
      expect(status.dirty).toBe(true);
      // One collapsed entry, not two enumerated files — the perf point of
      // dropping --untracked-files=all. dirtyFiles consumers are display-only
      // (GitFooter count, CommitBar warning list); commits post plan paths.
      expect(status.dirtyFiles).toEqual(['newdir/']);
    });

    it('reports branch: undefined on a detached HEAD (porcelain v2 "(detached)" mapping)', async () => {
      const dir = await makeTmpDir('knip-gui-git-detached-');
      await initRepo(dir);
      await writeFile(join(dir, 'a.txt'), 'hello', 'utf8');
      await commitAll(dir, 'initial');
      await git(dir, ['checkout', '--detach']);

      const status = await gitStatus(dir);
      expect(status.isRepo).toBe(true);
      expect(status.branch).toBeUndefined();
    });
  ```

  (The untracked-dir test also needs `mkdir` added to the `node:fs/promises` import on line 2 — it is already there.)

- [ ] Run `pnpm test tests/unit/git.test.ts` — expected: the untracked-dir test FAILS (current `=all` enumerates both files); the detached test may pass already (`branch --show-current` prints empty) — fine, it pins the v2 mapping.

- [ ] **Replace the parser and the status body.** In `src/git/git.ts`, replace `parsePorcelainZ` (the comment at lines 58-69 and function at 70-81) with:

  ```ts
  // Parses NUL-delimited `git status --porcelain=v2 --branch -z` output — ONE
  // exec now carries what `branch --show-current` + `status --porcelain -z`
  // used to take two for (#37). With -z, paths are always verbatim (no
  // C-quoting of spaces, no octal escapes for non-ASCII) — the same property
  // the old v1 parser relied on for the gitStatus → gitCommitPaths round-trip.
  //
  // Record shapes (git-status(1), "Porcelain Format Version 2"):
  //   `# <key> <value>`   headers; `# branch.head <name>` carries the branch,
  //                       where `(detached)` means detached HEAD → undefined.
  //   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`             changed
  //   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`  rename/copy,
  //       followed by a SEPARATE NUL-terminated field: the original path,
  //       which must be consumed with its record (same two-field pitfall the
  //       old v1 parser handled). We keep the new path.
  //   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`   unmerged
  //   `? <path>`                                                  untracked
  //   `! <path>` (ignored) can't appear without --ignored; skipped if it does.
  function parsePorcelainV2Z(stdout: string): { branch?: string; paths: string[] } {
    const fields = stdout.split('\0');
    let branch: string | undefined;
    const paths: string[] = [];
    for (let i = 0; i < fields.length; i++) {
      const record = fields[i];
      if (!record) continue; // trailing empty field after the final NUL
      if (record.startsWith('# ')) {
        const m = record.match(/^# branch\.head (.*)$/);
        if (m) branch = m[1] === '(detached)' ? undefined : m[1];
        continue;
      }
      const type = record[0];
      if (type === '1') {
        paths.push(restAfterNthSpace(record, 8));
      } else if (type === '2') {
        paths.push(restAfterNthSpace(record, 9));
        i++; // skip the rename/copy source field
      } else if (type === 'u') {
        paths.push(restAfterNthSpace(record, 10));
      } else if (type === '?') {
        paths.push(record.slice(2));
      }
    }
    return { branch, paths };
  }

  // The path is everything after the record's Nth space — indexOf-based so a
  // path containing spaces is never split.
  function restAfterNthSpace(record: string, n: number): string {
    let idx = 0;
    for (let k = 0; k < n; k++) idx = record.indexOf(' ', idx) + 1;
    return record.slice(idx);
  }
  ```

  Then in `gitStatus`, replace the two-exec tail (lines 106-112 — the `branchResult` block and the `statusResult` block) with:

  ```ts
    // One exec for branch + entries (#37). --untracked-files=normal, not
    // =all: `all` enumerates every file of every untracked tree (seconds on
    // big cold worktrees), while every consumer of dirtyFiles is display-only
    // (GitFooter's count, CommitBar's "other dirty files" warning) and the
    // commit flow posts plan paths, never dirtyFiles — so collapsed `dir/`
    // entries are an acceptable, cheaper answer.
    const statusResult = await execGit(projectDir, [
      'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal',
    ]);
    const { branch, paths: dirtyFiles } = parsePorcelainV2Z(statusResult.stdout);

    return { isRepo: true, branch, dirty: dirtyFiles.length > 0, dirtyFiles };
  ```

- [ ] Run `pnpm test tests/unit/git.test.ts` — expected: PASS, including the pre-existing spaces/utf8/rename round-trip pins (v2 `-z` paths are verbatim; the rename source field is consumed exactly as before) and the clean/dirty/branch tests.
- [ ] Run `pnpm test` — expected: full suite green (`server-fix.test.ts`'s git-route tests: clean-repo status, new-branch reflection, root-level `new.txt` untracked file — all compatible with `=normal`).
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] Commit: `perf: gitStatus via single porcelain-v2 exec with --untracked-files=normal (#37)`

---

## Task 5: #37 item 3 — single-parse batched ignore-config edits with per-edit failure reporting

`compileIgnorePlan`'s config loop (`src/ignore/compile.ts:125-147`) calls `addIgnores` once per edit through `chainTextEdits`, and `addIgnores` itself re-parses the whole config inside its loop (`src/ignore/config-writer.ts:151-177`) — ignoring 1k deps costs ~2k full JSONC parses, O(edits × configSize²) as the ignore list grows. The per-edit calling convention exists ONLY because exported `addIgnores` fails atomically (first bad edit aborts the whole call) while the plan needs per-edit outcomes.

**Design:** new export `addIgnoresBatch` — one up-front `assertParsable`, ONE `parse`, then an in-memory model of each touched path's final array (grouping edits by target path, replaying dedupe/string-coercion/type-mismatch per edit exactly as the sequential loop did), and one `modify`/`applyEdits` per *touched path* (bounded by workspaces × 3 kinds, not by edit count). `addIgnores` becomes a thin wrapper over it (first failing edit's reason, atomic contract preserved — every existing `config-edits.test.ts` pin passes unchanged). `removeIgnores` is untouched (already an intentionally-atomic batch; not named by the issue).

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/ignore/config-writer.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/ignore/compile.ts`
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/fix/plan.ts` (comment only)
- Test (modify): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/config-edits.test.ts`

### Steps

- [ ] **Write the failing tests.** Append to `tests/unit/config-edits.test.ts` (import `addIgnoresBatch` alongside the existing config-writer imports):

  ```ts
  describe('addIgnoresBatch (#37: one parse, per-edit outcomes)', () => {
    it('reports per-edit failures without discarding sibling successes (the contract addIgnores cannot offer)', () => {
      // `ignoreDependencies` already holds a non-array → both edits targeting
      // it fail with the same reason the sequential loop produced, while the
      // `ignore` edit succeeds and lands in the output content.
      const content = `{\n  "ignoreDependencies": "not-an-array"\n}\n`;
      const { content: out, changed, results } = addIgnoresBatch(content, 'knip.json', [
        { kind: 'ignoreDependencies', value: 'lodash' },
        { kind: 'ignore', value: 'src/gen/**' },
        { kind: 'ignoreDependencies', value: 'react' },
      ]);
      expect(results[0]).toEqual({ ok: false, reason: "expected an array at 'ignoreDependencies', found string" });
      expect(results[1]).toEqual({ ok: true });
      expect(results[2]).toEqual({ ok: false, reason: "expected an array at 'ignoreDependencies', found string" });
      expect(changed).toBe(true);
      expect(JSON.parse(out).ignore).toEqual(['src/gen/**']);
      expect(JSON.parse(out).ignoreDependencies).toBe('not-an-array'); // untouched
    });

    it('produces the same content as sequential single-edit addIgnores calls for a mixed batch', () => {
      const content = `{\n  "ignore": ["existing/**"]\n}\n`;
      const edits = [
        { kind: 'ignore' as const, value: 'a/**' },
        { kind: 'ignoreDependencies' as const, value: 'left-pad' },
        { kind: 'ignore' as const, value: 'a/**' }, // dedupe within batch
        { kind: 'ignoreBinaries' as const, value: 'rimraf', workspace: 'packages/app' },
        { kind: 'ignoreDependencies' as const, value: 'lodash' },
      ];
      let sequential = content;
      for (const edit of edits) {
        const r = addIgnores(sequential, 'knip.json', [edit]);
        if (r.ok) sequential = r.newContent;
      }
      const batch = addIgnoresBatch(content, 'knip.json', edits);
      expect(batch.results.every((r) => r.ok)).toBe(true);
      expect(batch.content).toBe(sequential);
    });

    it('coerces a string-form root `ignore` once and appends the rest of the batch to it', () => {
      const content = `{\n  "ignore": "solo.ts"\n}\n`;
      const { content: out, results } = addIgnoresBatch(content, 'knip.json', [
        { kind: 'ignore', value: 'first/**' },
        { kind: 'ignore', value: 'second/**' },
      ]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(JSON.parse(out).ignore).toEqual(['solo.ts', 'first/**', 'second/**']);
    });

    it('an all-no-op batch is a byte-exact passthrough (changed: false)', () => {
      const content = `{\n  "ignore": ["a.ts"]\n}\n`;
      const { content: out, changed, results } = addIgnoresBatch(content, 'knip.json', [
        { kind: 'ignore', value: 'a.ts' },
      ]);
      expect(results).toEqual([{ ok: true }]);
      expect(changed).toBe(false);
      expect(out).toBe(content);
    });

    it('a malformed config fails EVERY edit with the line/column reason and leaves content untouched', () => {
      const content = `{\n  "ignore": ["a.ts",\n`;
      const { content: out, changed, results } = addIgnoresBatch(content, 'knip.json', [
        { kind: 'ignore', value: 'b.ts' },
        { kind: 'ignoreDependencies', value: 'x' },
      ]);
      expect(changed).toBe(false);
      expect(out).toBe(content);
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/JSON syntax error at line \d+, column \d+/);
      }
    });
  });
  ```

- [ ] Run `pnpm test tests/unit/config-edits.test.ts` — expected: FAIL (unresolved `addIgnoresBatch`).

- [ ] **Implement `addIgnoresBatch` and rebase `addIgnores` on it.** In `src/ignore/config-writer.ts`, replace the exported `addIgnores` (the comment at lines 136-139 and function at 140-180) with:

  ```ts
  export type BatchEditOutcome = { ok: true } | { ok: false; reason: string };

  export interface AddIgnoresBatchResult {
    /** Final content — equal to the input when nothing changed or the config itself was refused. */
    content: string;
    changed: boolean;
    /** One outcome per edit, same order as the input. */
    results: BatchEditOutcome[];
  }

  // Batched variant (#37): ONE assertParsable + ONE parse for the whole batch,
  // an in-memory model of each touched path's final array, and one
  // modify/applyEdits per touched PATH (bounded by workspaces × 3 kinds) —
  // versus the old per-edit convention's full re-parse per edit, O(edits ×
  // configSize²) on large ignore batches. Per-edit semantics are replayed
  // exactly: dedupe against existing values AND within the batch, knip's
  // string-form `ignore` coerced into an array seed on first touch, a
  // non-array at a target path failing every edit aimed at it (each with the
  // same reason string the sequential loop produced) without touching sibling
  // paths. Key-creation order in the emitted document matches the sequential
  // version too: paths are materialized in first-touch order.
  export function addIgnoresBatch(
    content: string,
    configKind: 'knip.json' | 'knip.jsonc' | 'package.json',
    edits: IgnoreEdit[],
  ): AddIgnoresBatchResult {
    const parsable = assertParsable(content);
    if (!parsable.ok) {
      return { content, changed: false, results: edits.map(() => ({ ok: false, reason: parsable.reason })) };
    }
    const root = parse(content, undefined, VALIDATE_OPTIONS);
    if (root === undefined) {
      // Unreachable post-assertParsable; kept for the same belt-and-braces
      // reason the per-edit loop kept it.
      return { content, changed: false, results: edits.map(() => ({ ok: false, reason: 'invalid-json' })) };
    }
    const formattingOptions = detectFormatting(content);

    type PathState =
      | { path: (string | number)[]; values: unknown[]; dirty: boolean }
      | { mismatch: string };
    const states = new Map<string, PathState>();
    const results: BatchEditOutcome[] = [];

    for (const edit of edits) {
      const path = ignorePath(configKind, edit);
      const key = JSON.stringify(path);
      let state = states.get(key);
      if (state === undefined) {
        const existing = getAtPath(root, path);
        if (typeof existing === 'string' && edit.kind === 'ignore') {
          // knip's own schema allows `ignore` (only `ignore`) to be a single
          // glob string — coerce it into the array seed, mirroring the
          // single-edit path.
          state = { path, values: [existing], dirty: false };
        } else if (existing !== undefined && !Array.isArray(existing)) {
          state = { mismatch: `expected an array at '${path.join('.')}', found ${typeof existing}` };
        } else {
          state = { path, values: Array.isArray(existing) ? [...existing] : [], dirty: false };
        }
        states.set(key, state);
      }
      if ('mismatch' in state) {
        results.push({ ok: false, reason: state.mismatch });
        continue;
      }
      if (state.values.includes(edit.value)) {
        results.push({ ok: true }); // already ignored — no-op
        continue;
      }
      state.values.push(edit.value);
      state.dirty = true;
      results.push({ ok: true });
    }

    let newContent = content;
    for (const state of states.values()) {
      if ('mismatch' in state || !state.dirty) continue;
      newContent = applyEdits(newContent, modify(newContent, state.path, state.values, { formattingOptions }));
    }
    return { content: newContent, changed: newContent !== content, results };
  }

  // Appends each edit's `value` to the array at its target path — creating the array
  // (and any missing intermediate objects, e.g. `workspaces['pkg']`) if absent, and
  // deduping against values already present. Uses jsonc-parser's `modify`/`applyEdits`
  // so untouched formatting (and, for `knip.jsonc`, comments) survive byte-for-byte.
  // Atomic contract, unchanged since before #37: the FIRST failing edit's reason
  // fails the whole call and no partial content is returned — callers that need
  // per-edit outcomes use addIgnoresBatch directly (compileIgnorePlan does).
  export function addIgnores(
    content: string,
    configKind: 'knip.json' | 'knip.jsonc' | 'package.json',
    edits: IgnoreEdit[],
  ): TransformResult {
    const { content: newContent, results } = addIgnoresBatch(content, configKind, edits);
    const firstFailure = results.find((r) => !r.ok);
    if (firstFailure && !firstFailure.ok) return { ok: false, reason: firstFailure.reason };
    return { ok: true, newContent };
  }
  ```

- [ ] **Switch `compileIgnorePlan` to the batch.** In `src/ignore/compile.ts`: drop `chainTextEdits` from the `../fix/plan.js` import (line 7 — keep `newPlanId`, `readFileOrNull`, types) and add `addIgnoresBatch` to the `./config-writer.js` import; then replace the loop block (the comment at lines 125-131 and the `chainTextEdits` call at 132-134) with:

  ```ts
        // ONE parse for the whole batch (#37): addIgnoresBatch models every
        // edit against a single parsed tree and applies one text edit per
        // touched array, while still reporting per-edit failures — a single
        // bad edit (e.g. a workspace's `ignore` key already holding a
        // non-array value) fails only its own issue and never discards
        // sibling edits, exactly like the old per-edit chainTextEdits loop,
        // minus its O(edits × configSize) re-parses.
        const { content: current, changed, results } = addIgnoresBatch(
          contentBefore,
          configKind,
          configEdits.map((e) => e.edit),
        );
  ```

  (The `configEdits.forEach` results-mapping right below and the patch/diff block are unchanged — `results[i]` still lines up 1:1 with `configEdits[i]`, and `results[i].reason` is only read when `ok` is false, same as `TransformResult`.)

- [ ] **Retire the stale cross-reference.** In `src/fix/plan.ts`, `chainTextEdits`'s comment (lines 43-48) says "batching THOSE parses is #36" — update the parenthetical to `(the ignore-config path is batched via addIgnoresBatch since #37; package.json dependency removals in fix/compiler.ts still chain here, and stay cheap at that document size)`.

- [ ] Run `pnpm test tests/unit/config-edits.test.ts` — expected: PASS, including every pre-existing `addIgnores` pin (dedupe, coercion, workspace scoping, malformed-config refusal, byte-exact passthrough — all served by the wrapper).
- [ ] Run `pnpm test` — expected: full suite green (`ignores-endpoint.test.ts`, `server-fix.test.ts`'s ignore apply, `compiler-batch.test.ts` untouched).
- [ ] Run `pnpm run typecheck` — expected: clean (also proves compile.ts's `chainTextEdits` import removal left `fix/compiler.ts`'s own use intact).
- [ ] Run `pnpm run test:e2e` — expected: FULL suite green (`ignore.spec.ts` asserts the `diff-view-knip.json` content produced by this exact path).
- [ ] Commit: `perf: single-parse addIgnoresBatch for ignore-config edits, per-edit failures preserved (#37)`

---

## Task 6: #37 item 4 — parallel containment checks + stdin pathspecs in gitCommitPaths

`gitCommitPaths` (`src/git/git.ts:149-190`) awaits `assertContained` serially per path (`:161-163` — each is 1+ `realpath` calls), then passes every `:(literal)` pathspec as argv to `git add` and `git commit`. At ~10k files the argv approaches ARG_MAX (1MB on macOS, argv+env combined).

**Deviation from the issue's "chunk pathspecs" wording, justified:** `git add` chunks fine, but a single `git commit -- <paths>` *cannot* be chunked without becoming multiple commits. `--pathspec-from-file=- --pathspec-file-nul` (git ≥ 2.25, Jan 2020; dev env has 2.54) feeds pathspecs over stdin for BOTH commands — no ARG_MAX exposure at any count, single exec each, and NUL separation means paths with spaces, quotes, and even newlines pass verbatim. Pathspec magic still applies to stdin entries, so the `:(literal)` scope guarantee is unchanged.

**Files**
- Modify: `/Volumes/Dev/Projects/krona/knip-gui/src/git/git.ts`
- Test (modify): `/Volumes/Dev/Projects/krona/knip-gui/tests/unit/git.test.ts`

### Steps

- [ ] **Write the failing-or-pinning tests.** Append inside `git.test.ts`'s `describe('gitCommitPaths', …)`:

  ```ts
    it('commits thousands of paths in one call (stdin pathspecs — no ARG_MAX exposure, #37)', async () => {
      const dir = await makeTmpDir('knip-gui-git-many-');
      await initRepo(dir);
      await writeFile(join(dir, 'base.txt'), 'base', 'utf8');
      await commitAll(dir, 'initial');

      // Long-ish names so the equivalent argv form would measure in the
      // hundreds of KB — the regime where a single argv exec gets risky.
      const paths: string[] = [];
      for (let i = 0; i < 2500; i++) paths.push(`some/deeply/nested-path-segment/file-number-${String(i).padStart(5, '0')}.txt`);
      await mkdir(join(dir, 'some/deeply/nested-path-segment'), { recursive: true });
      await Promise.all(paths.map((p) => writeFile(join(dir, p), 'x', 'utf8')));

      const result = await gitCommitPaths(dir, paths, 'bulk commit');
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
      const { stdout } = await git(dir, ['show', '--name-only', '--pretty=format:', 'HEAD']);
      expect(stdout.split('\n').filter(Boolean)).toHaveLength(2500);
      const after = await gitStatus(dir);
      expect(after.dirty).toBe(false);
    });

    it('round-trips a filename containing a newline (NUL-separated stdin pathspecs)', async () => {
      const dir = await makeTmpDir('knip-gui-git-newline-');
      await initRepo(dir);
      await writeFile(join(dir, 'base.txt'), 'base', 'utf8');
      await commitAll(dir, 'initial');

      const weird = 'weird\nname.txt';
      await writeFile(join(dir, weird), 'newline in name', 'utf8');
      const result = await gitCommitPaths(dir, [weird], 'commit newline file');
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
      const after = await gitStatus(dir);
      expect(after.dirty).toBe(false);
    });
  ```

- [ ] Run `pnpm test tests/unit/git.test.ts` — expected: the bulk test likely PASSES on this machine (2500 × ~50B ≈ 125KB argv is under macOS's limit — it becomes the regression pin once stdin lands); the newline test FAILS pre-change if argv/pathspec handling mangles it, otherwise also pins. Either way both must be green after the implementation, alongside every existing scope-guarantee test.

- [ ] **execGit: optional stdin.** In `src/git/git.ts`, change `execGit` (lines 22-45) to accept and feed stdin:

  ```ts
  function execGit(
    cwd: string,
    args: string[],
    opts: { stdin?: string } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        // [existing callback body — UNCHANGED, all four branches]
      });
      if (opts.stdin !== undefined) {
        // If git exits before draining stdin, the write EPIPEs — swallow it;
        // the exit-code branch above reports the real failure.
        child.stdin?.on('error', () => {});
        child.stdin?.end(opts.stdin);
      }
    });
  }
  ```

- [ ] **gitCommitPaths: parallel checks + stdin pathspecs.** Replace the serial loop (lines 160-163) and the add/commit tail (lines 185-187):

  ```ts
    const root = await realpath(resolve(projectDir));
    // Independent per-path checks — realpath walks, no shared state — so run
    // them concurrently instead of one await per path (#37). Promise.all
    // rejects with the first GitError, same observable contract as the loop.
    await Promise.all(paths.map((p) => assertContained(root, p)));
  ```

  and (keeping the two long doc comments above the add/commit pair verbatim, plus this addition to the `:(literal)` paragraph: `Pathspecs travel over stdin (--pathspec-from-file=- --pathspec-file-nul, git >= 2.25) rather than argv: a single commit's pathspec cannot be chunked across invocations, and ~10k paths as argv brushes ARG_MAX (1MB on macOS including env). NUL separation keeps every byte of a path literal — spaces, quotes, even newlines. Pathspec magic still applies to stdin entries, so :(literal) keeps doing the scope-guarantee work described above.`):

  ```ts
    const specsNul = paths.map((p) => `:(literal)${p}`).join('\0');
    const pathspecArgs = ['--pathspec-from-file=-', '--pathspec-file-nul'];
    await execGit(projectDir, ['add', ...pathspecArgs], { stdin: specsNul });
    await execGit(projectDir, ['commit', '-m', message, ...pathspecArgs], { stdin: specsNul });
    const { stdout } = await execGit(projectDir, ['rev-parse', 'HEAD']);
    return { sha: stdout.trim() };
  ```

- [ ] Run `pnpm test tests/unit/git.test.ts` — expected: PASS, especially the pre-existing scope-guarantee pins (`:(literal)` magic-neutralization, pre-staged-file isolation, deletion pathspec-scoping, empty-paths guard, spaces/utf8 round-trips).
- [ ] Run `pnpm test` — expected: full suite green (`server-fix.test.ts` commit routes exercise the new path end-to-end).
- [ ] Run `pnpm run typecheck` — expected: clean.
- [ ] Commit: `perf: parallel containment checks + stdin pathspecs in gitCommitPaths (#37)`

---

## Post-implementation verification (before finishing the branch)

- [ ] `pnpm test` — full unit suite green.
- [ ] `pnpm run typecheck` — clean across all three tsconfigs.
- [ ] `pnpm run build` — compiles.
- [ ] `pnpm run test:e2e` — FULL suite green in one run. The #33-critical specs: `codepane-crash.spec.ts` (rescan observably in flight mid-poll), `smoke.spec.ts` / `review.spec.ts` / `ignore.spec.ts` (post-apply rescans settle), `commit-affordance.spec.ts` + `review.spec.ts` commit flows (Tasks 4/6), `ignore.spec.ts`'s knip.json diff (Task 5), `workspace-switcher.spec.ts` (Task 3's cache under real scans).
- [ ] Grep sanity: `grep -n "tryBeginOp('scan')" src/server/routes-fix.ts` — no hits (the chain owns no latch); `grep -rn "untracked-files=all\|--porcelain -z\|branch', '--show-current" src/` — no hits; `grep -n "chainTextEdits" src/ignore/` — no hits (compiler.ts's use remains, by design).
- [ ] Manual smoke (Task 2's step, if not already done): consecutive applies during a slow rescan on a real monorepo; confirm the footer's busy state converges to one final report refresh and `git status` in the project shows exactly the applied edits.

## Out of scope (explicit follow-ups, do not do here)

- **GH #36** (preview responses shipping whole-file delete diffs; PlanStore pinning `contentAfter` + diffs for 15min): separate issue, untouched — nothing in this batch changes `PreviewResponse`, diff rendering, or PlanStore retention.
- **Abort-and-restart rescans:** the queued-follow-up chain deliberately lets a doomed iteration finish. If real-world monorepo latency proves the extra iteration painful, upgrading the chain to abort `store.activeAbort` and suppress the aborted landing is a self-contained follow-up (the design section documents exactly what it must add).
- **Applies queueing behind each other:** two simultaneous applies still 409 (ms-scale window, correct — concurrent patch-appliers are a real data race). No wait-queue.
- **A TTL or watcher for the workspace cache:** mtime-fingerprint only, per the issue. The documented staleness (new dir matching an existing glob, manifests untouched) waits for watch mode (#18) or a manual re-scan after a manifest touch.
- **`useBusy` consumers beyond SelectionDock:** Re-run / sweep / workspace-switch / palette stay scan-gated on purpose — their requests 409 against the chain.
- **`removeIgnores` batching** and **`fix/compiler.ts`'s chainTextEdits dep-removal loop:** both small-N in practice; not named by #37's addIgnores item.

## Behavioral notes pinned by this plan (for reviewers)

- `/api/scan` and `/api/sweep` now 409 (`op: 'scan'`) during a post-apply background rescan — previously the same 409 came from the rescan holding the latch itself. Applies no longer 409 in that state; a *manually initiated* scan still blocks applies exactly as before.
- `ApplyResponse.rescanning` is now effectively always `true` from the apply routes (start or coalesce); the theoretical `false` remains only for a future non-handler caller hitting the insurance guard.
- Preview compiles against the previous report while a rescan runs; apply-time `hashBefore` staleness is the correctness backstop (existing per-file 'stale' behavior, already pinned).
- `GitStatus.dirtyFiles` reports untracked *directories* as single `dir/` entries now (`--untracked-files=normal`); `branch` is derived from porcelain v2's `branch.head` (detached → `undefined`, unchanged client rendering).
- `gitCommitPaths` requires git ≥ 2.25 (`--pathspec-from-file`); older git fails loudly with a GitError naming the unknown option.
- `getWorkspaceDirs` results can be stale until a workspace-manifest mtime/size changes (documented in the cache comment); `clearWorkspaceDirsCache()` is exported for tests/embedders. `**` globs no longer descend into `dist`/`build`/`out`/`coverage`/`.turbo`/`.next`/`.nuxt`/`.output`/`.cache`/`.vite`/`.svelte-kit`.
