# knip-gui Plan 2: Engines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The fix engine (preview → apply with hash-guarded patches), the ignore engine (knip config + `@public` tags), the `knip --fix` sweep, and git integration — all exposed as API routes on the Plan 1 server.

**Architecture:** All fixes flow through one path: transforms compute `FilePatch[]` from oxc-parser ASTs + magic-string edits; a plan compiler assembles patches per selection into a stored `FixPlan`; preview returns rendered diffs; apply writes exactly the stored patches after re-hashing files. `knip --fix` delegation is a separate explicit "sweep" endpoint (no preview, auto-rescan) — see Design resolution below.

**Tech Stack (new deps):** `oxc-parser`, `magic-string`, `diff` (unified diff rendering), `jsonc-parser` (format-preserving JSON edits). Git via `execFile('git', ...)` — no wrapper lib.

**Spec:** `docs/superpowers/specs/2026-07-13-knip-gui-design.md` (see Errata section — no `classMembers`; members are enum/namespace with a `namespace` parent field).

## Design resolution (deviation from spec §Fix engine, to be added to spec errata on merge)

The spec's hybrid routed whole-category selections through `knip --fix`. That conflicts with the spec's own stronger guarantee — "preview computes concrete text patches; Apply writes those exact patches" — because `knip --fix` writes directly and cannot be previewed. Resolution: the own fixer handles **every** previewed fix (cherry-picks and whole categories; it must exist for cherry-picks anyway and its export/dep semantics mirror knip's). `knip --fix` remains as an explicit **sweep** endpoint (`POST /api/sweep`) that the UI offers as "Fix everything with knip --fix" — direct apply, then automatic rescan. Delegation stays an optimization the user opts into, never a hidden code path under preview.

## Global Constraints

- Every content-modifying route (`fix/apply`, `ignore/apply`, `sweep`, `git/*` mutations) is POST, behind the Plan 1 token+origin middleware.
- Preview == apply byte-for-byte: `FixPlan` stores concrete before-hashes and full replacement content per file; apply re-hashes and rejects stale files per-file (partial fault-tolerance: other files still apply).
- Transforms never guess: every transform locates its AST node via knip's reported `pos` (or symbol lookup for entries without pos) and validates the node's name against the issue's symbol; mismatch → that item fails safely with a reported reason, no write.
- All paths written must resolve (realpath) inside the project dir — same containment rule as `GET /api/file`.
- `git commit` stages ONLY paths the tool changed (explicit path list to `git add --`), never `-A`.
- Node >= 20, ESM, strict TS; conventional commits; TDD per step.

---

### Task 1: Fixture expansion + recapture (ground truth for duplicates, namespace members, export forms)

**Files:**
- Modify: `tests/fixtures/single/src/used.ts`, `tests/fixtures/single/src/index.ts`
- Create: `tests/fixtures/single/src/forms.ts`
- Regenerate: `tests/fixtures/single-report.json` (via existing `scripts/capture-fixture-report.ts`)
- Modify: `tests/unit/normalize.test.ts` (extend assertions), `tests/integration/knip-runner.test.ts` if counts asserted

**Interfaces:**
- Produces: fixture now also yields real knip issues for: `duplicates` (same value exported under two names), `namespaceMembers` (unused member of a used namespace), and export forms the transforms must handle: an unused named export in an `export { a, b }` list, an unused `export default`, an unused re-export in `export { x } from './y.js'`. The captured JSON is the contract for Tasks 3–4 transforms.

- [ ] **Step 1: Add `forms.ts` to the fixture**

`tests/fixtures/single/src/forms.ts`:

```ts
function listUsed(): number {
  return 1;
}
function listUnused(): number {
  return 2;
}
export { listUsed, listUnused };

export default function defaultUnused(): string {
  return 'never imported';
}

export namespace Config {
  export const usedFlag = true;
  export const unusedFlag = false;
}

export const dupeSource = 42;
export { dupeSource as dupeAlias };
```

Wire into `tests/fixtures/single/src/index.ts` so the "used" halves are used:

```ts
import { usedHelper, Color, Geo } from './used.js';
import { listUsed, Config, dupeSource } from './forms.js';
import type { Shape } from './shapes.js';

const s: Shape = { kind: 'circle' };
console.log(usedHelper(s.kind), Color.Red, new Geo().perimeter(), listUsed(), Config.usedFlag, dupeSource);
```

- [ ] **Step 2: Recapture and inspect**

Run: `npx tsx scripts/capture-fixture-report.ts`
Expected new issues (verify by reading the JSON; exact keys are ground truth for later tasks): `exports: listUnused` (in the export list), `exports: defaultUnused` or `default` (note knip's actual symbol name for default exports), `namespaceMembers: { namespace: 'Config', name: 'unusedFlag' }`, `duplicates` entry for `dupeSource`/`dupeAlias` (note its exact shape — first real observation). If a scenario doesn't produce the expected issue, adjust the fixture minimally and document why. Record the observed shapes in your report — Tasks 3–4 implementers read it.

- [ ] **Step 3: Update normalize/runner tests for the new ground truth**

Extend `tests/unit/normalize.test.ts` with assertions for the `duplicates` and `namespaceMembers` entries (shape per Step 2 observation — `parentSymbol` from `namespace` field for namespaceMembers; for duplicates, whatever knip reports, normalized to one Issue per duplicate group with `symbol` = the duplicated name(s) as reported). If `normalize` needs a tweak for the observed duplicates shape, make it here with the test.

Run: `npm test` → all pass.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: fixture coverage for duplicates, namespace members, export forms"
```

---

### Task 2: Patch infrastructure

**Files:**
- Create: `src/fix/patch.ts`, `src/fix/diff.ts`
- Test: `tests/unit/patch.test.ts`

**Interfaces:**
- Produces (consumed by every later task):

```ts
// patch.ts
export interface FilePatch {
  filePath: string;                     // repo-relative
  kind: 'modify' | 'delete' | 'create';
  hashBefore: string | null;            // sha256 hex of current content; null for create
  contentAfter: string | null;          // full new content; null for delete
}
export interface PatchResult { filePath: string; ok: boolean; reason?: 'stale' | 'missing' | 'io-error'; detail?: string }
export function hashContent(content: string): string;
export async function hashFile(absPath: string): Promise<string | null>;  // null if missing
export async function applyPatches(projectDir: string, patches: FilePatch[]): Promise<PatchResult[]>;
// diff.ts
export function renderDiff(patch: FilePatch, contentBefore: string | null): string; // unified diff via `diff` pkg
```

- `applyPatches`: per patch — realpath-containment check, re-hash current file, mismatch → `{ok:false, reason:'stale'}`; delete → `fs.rm`; modify/create → write `contentAfter`. Independent per file; one failure never aborts others. Returns results in input order.

- [ ] **Step 1: Failing tests** — cover: hash roundtrip; apply modify writes exact content; stale detection (mutate file between plan and apply → `stale`, file untouched); delete removes; create writes; missing file on modify → `missing`; path escaping project (e.g. `../x`) → `io-error` and no write; partial failure (one stale + one good in same call → good one applied); `renderDiff` output contains `---`/`+++` headers and the changed lines for modify, full-file removal for delete. Use `fs.mkdtemp` sandboxes.
- [ ] **Step 2: Run to verify fail** — `npx vitest run tests/unit/patch.test.ts`
- [ ] **Step 3: Implement** — `npm i diff && npm i -D @types/diff`. Use `createTwoFilesPatch` from `diff`.
- [ ] **Step 4: Run to verify pass, full suite, commit** — `git commit -m "feat: hash-guarded file patches and unified diff rendering"`

---

### Task 3: Source transforms — strip-export and delete-declaration

**Files:**
- Create: `src/fix/transforms/source.ts` (shared oxc parse/locate helpers), `src/fix/transforms/strip-export.ts`, `src/fix/transforms/delete-declaration.ts`
- Test: `tests/unit/transform-exports.test.ts`

**Interfaces:**
- Produces:

```ts
// source.ts
export interface TransformInput { filePath: string; content: string; symbol: string; pos?: number; line?: number }
export interface TransformResult { ok: true; newContent: string } | { ok: false; reason: string }
export function parseSource(filePath: string, content: string): /* oxc program + comments */;
// strip-export.ts
export function stripExport(input: TransformInput): TransformResult;
// delete-declaration.ts
export function deleteDeclaration(input: TransformInput): TransformResult;
```

- `stripExport` semantics (mirror `knip --fix`): direct `export const/function/class/type/interface/enum X` → remove the `export ` keyword; named-list binding `export { a, b }` → remove the binding (+comma); list becomes empty → remove the whole statement (for `export { x } from '...'` re-exports too); `export default <expr|function|class>` → remove the `export default ` prefix when the declaration is named, else remove the whole statement (an anonymous default's value is dead without its export).
- `deleteDeclaration` semantics: remove the entire declaration statement including attached leading JSDoc/comments and the trailing newline; for list bindings, delete the local declaration AND its list binding.
- Both: locate the declaration by `pos` when provided (validate located name === symbol), else by top-level symbol lookup; not found / name mismatch → `{ ok: false, reason }`.
- oxc-parser API note: `parseSync(filename, content)` returns `{ program, comments, errors }` with ESTree-ish spans (`start`/`end` byte offsets) — spans feed `magic-string` `remove()/slice()`. Verify the exact API against the installed version's README/types before writing code; adjust helper accordingly.

- [ ] **Step 1: Failing tests** — table-driven over real code snippets, asserting exact output strings, covering: plain `export const`, `export function`, `export type`, `export interface`; JSDoc'd declaration (strip keeps JSDoc; delete removes it); `export { a, b }` middle/first/last binding removal incl. comma hygiene; list-emptying removes statement; re-export `export { x } from './y.js'`; named `export default function name()`; anonymous `export default { ... }` (strip → remove statement); symbol-name mismatch at pos → `ok:false`; symbol not found → `ok:false`. Also one test running `stripExport` against the real fixture file + captured pos for `unusedHelper` (read both from tests/fixtures) proving knip's pos lands on the right node.
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement** — magic-string for edits; helper `findExportAt(program, pos, symbol)` walking top-level statements (declarations, ExportNamedDeclaration specifiers, ExportDefaultDeclaration). Attached-comment detection for delete-declaration: any comment whose end is on the line(s) immediately above the node start with only whitespace between.
- [ ] **Step 4: Run to verify pass, full suite, commit** — `git commit -m "feat: strip-export and delete-declaration transforms"`

---

### Task 4: Source transforms — member removal, duplicate removal, @public tag insertion

**Files:**
- Create: `src/fix/transforms/remove-member.ts`, `src/fix/transforms/remove-duplicate.ts`, `src/ignore/public-tag.ts`
- Test: `tests/unit/transform-members.test.ts`

**Interfaces:**
- Produces:

```ts
export function removeMember(input: TransformInput & { parentSymbol: string }): TransformResult;   // enum + namespace members
export function removeDuplicate(input: TransformInput): TransformResult;                            // remove the duplicate export binding, keep the canonical one
export function insertPublicTag(input: TransformInput): TransformResult;                            // /** @public */ above the declaration (or merge into existing JSDoc)
```

- `removeMember`: enum member → remove member + trailing comma (or preceding comma if last); namespace member → remove the member declaration statement inside the namespace body. Parent located by name, member by name within parent (pos as tiebreak).
- `removeDuplicate`: given the issue from knip's duplicates report (symbol shape observed in Task 1), remove the aliased re-export binding (`export { dupeSource as dupeAlias }` → statement removed if it empties) while leaving the original export untouched. Use Task 1's captured shape to decide which binding is "the duplicate" (knip lists the duplicated symbols; the transform receives the alias name to remove — plan compiler passes `symbol` = the non-canonical name).
- `insertPublicTag`: existing JSDoc directly above → insert ` * @public` line before its closing `*/`; none → insert `/** @public */\n` line above with matching indentation. Idempotent: content already containing `@public` for that node → `{ok:true}` unchanged.

- [ ] **Step 1: Failing tests** — enum middle/last member comma cases; enum member with comment on same line; namespace member const/function; parent not found → `ok:false`; duplicate removal for the fixture's `dupeAlias` shape (drive from captured JSON where possible); @public insertion fresh + into existing JSDoc + idempotency; exact-string assertions throughout.
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Pass, full suite, commit** — `git commit -m "feat: member/duplicate removal and @public tag transforms"`

---

### Task 5: package.json dep removal + knip config ignore writer

**Files:**
- Create: `src/fix/transforms/package-json.ts`, `src/ignore/config-writer.ts`
- Test: `tests/unit/config-edits.test.ts`

**Interfaces:**
- Produces:

```ts
// package-json.ts
export function removeDependency(content: string, depName: string, issueType: 'dependencies' | 'devDependencies' | 'optionalPeerDependencies'): TransformResult;
// config-writer.ts — locates the project's knip config (knip.json > knip.jsonc > package.json#knip; knip.ts/js → { ok:false, reason:'code-config' })
export interface IgnoreEdit { kind: 'ignore' | 'ignoreDependencies' | 'ignoreBinaries'; value: string; workspace?: string }
export function findKnipConfig(projectDir: string): { kind: 'knip.json' | 'knip.jsonc' | 'package.json' | 'code' | 'none'; path?: string };
export function addIgnores(content: string, configKind: 'knip.json' | 'knip.jsonc' | 'package.json', edits: IgnoreEdit[]): TransformResult;
```

- Both use `jsonc-parser`'s `modify` + `applyEdits` (format-preserving, comment-safe). `optionalPeerDependencies` maps to the `peerDependencies` key in package.json (knip's issue type refers to optional peers — verify against fixture if unsure and note in report). `removeDependency`: key absent → `{ok:false, reason:'not-found'}`. `addIgnores` appends to the array (creating it if missing), dedupes existing values; `workspace` set → writes under `workspaces['<ws>']` per knip config schema; `package.json` kind → same edits under the `knip` property.
- [ ] **Step 1: Failing tests** — remove middle/only dep preserving indentation + trailing chars byte-exactly; dep-not-found; jsonc with comments preserved; addIgnores create-array, append, dedupe; workspace-scoped ignore lands under workspaces key; package.json#knip variant; knip.ts detection → code/none kinds.
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement** — `npm i jsonc-parser`.
- [ ] **Step 4: Pass, full suite, commit** — `git commit -m "feat: package.json dep removal and knip config ignore writer"`

---

### Task 6: Plan compiler + fix/ignore services

**Files:**
- Create: `src/fix/compiler.ts`, `src/fix/plan-store.ts`
- Test: `tests/unit/compiler.test.ts`

**Interfaces:**
- Consumes: all transforms; `Issue`, `FixMode`; `FilePatch`, `hashContent`, `renderDiff`.
- Produces:

```ts
export interface FixSelection { issueIds: string[]; modeOverrides?: Record<string, FixMode> }  // default mode = issue.fixModes[0]
export interface PlanItem { issueId: string; ok: boolean; reason?: string }
export interface FixPlan {
  planId: string;                       // random hex
  kind: 'fix' | 'ignore';
  patches: FilePatch[];
  diffs: { filePath: string; diff: string }[];
  items: PlanItem[];                    // per-issue compile outcome (transform failures land here)
  createdAt: string;
}
export function compileFixPlan(projectDir: string, issues: Issue[], selection: FixSelection): Promise<FixPlan>;
export function compileIgnorePlan(projectDir: string, issues: Issue[], issueIds: string[]): Promise<FixPlan>;
export class PlanStore { put(plan: FixPlan): void; take(planId: string): FixPlan | undefined }  // take = get+delete, single-use plans
```

- Compiler groups selected issues by file, reads content once per file, threads it through that file's transforms in issue order (position-descending within a file so earlier edits don't shift later spans — or recompute by re-locating per step on the current content; choose re-locate: simpler and safe since each transform parses fresh), produces one `FilePatch` per touched file. `delete-file` mode → `kind:'delete'` patch (and wins over other edits to the same file). Dep issues patch the owning workspace's `package.json` (workspace-aware path join). Ignore plan: files→`ignore` (workspace-scoped IgnoreEdit), deps→`ignoreDependencies`, binaries→`ignoreBinaries`, export/type/member issues→`insertPublicTag` patches; `code`-kind config → those items fail with `reason:'code-config'` while tag-insertions still succeed.
- [ ] **Step 1: Failing tests** — multi-issue same file (two exports stripped in one patch, hash/diff correct); mixed file+export selection; mode override delete-declaration; unknown issueId → item `ok:false`; unfixable issue selected → `ok:false, reason:'not-fixable'`; ignore plan mixes config edit + tag patches; workspace dep → correct package.json path; plan-store take-once semantics. Drive with synthetic `Issue[]` + mkdtemp file trees; one test compiles against the REAL single fixture using captured report ids end-to-end (no apply).
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Pass, full suite, commit** — `git commit -m "feat: fix/ignore plan compiler with single-use plan store"`

---

### Task 7: Git wrapper + knip --fix sweep runner

**Files:**
- Create: `src/git/git.ts`, `src/fix/sweep.ts`
- Test: `tests/unit/git.test.ts`, `tests/integration/sweep.test.ts`

**Interfaces:**
- Produces:

```ts
// git.ts — all via execFile('git', [...], { cwd }); every fn throws GitError { stderr } on nonzero exit
export interface GitStatus { isRepo: boolean; branch?: string; dirty?: boolean; dirtyFiles?: string[] }
export function gitStatus(projectDir: string): Promise<GitStatus>;
export function gitCreateBranch(projectDir: string, name: string): Promise<void>;          // git checkout -b
export function gitCommitPaths(projectDir: string, paths: string[], message: string): Promise<{ sha: string }>; // git add -- <paths> (deleted paths too), git commit -m, rev-parse
// sweep.ts
export interface SweepOptions { workspace?: string; fixTypes?: string[]; allowRemoveFiles?: boolean }
export function runSweep(projectDir: string, opts: SweepOptions): Promise<{ ok: boolean; stderr?: string }>;  // spawns project knip with --fix [--fix-type t]... [--allow-remove-files] [--workspace ws]; exit 0/1 ok
export function probeSweepCapabilities(projectDir: string): Promise<{ fix: boolean; fixType: boolean; allowRemoveFiles: boolean; workspace: boolean }>; // parse `knip --help` once, cache per dir
```

- [ ] **Step 1: Failing tests** — git: init a temp repo (config user.name/email locally), status on non-repo (`isRepo:false`), clean/dirty detection with file list, branch create + status reflects it, commitPaths commits ONLY listed paths (create two changes, commit one, assert other still dirty; include a deleted file in paths), GitError on bad input (commit with no changes). sweep (integration): copy the single fixture into a gitignored `.tmp-tests/` dir INSIDE the repo (so knip resolves via walk-up), run `runSweep` with `fixTypes:['dependencies']`, assert `left-pad` gone from the copy's package.json and no source files changed; probe returns all-true for installed knip 6.
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement** — reuse `resolveKnip`. Add `.tmp-tests/` to `.gitignore`.
- [ ] **Step 4: Pass, full suite, commit** — `git commit -m "feat: git wrapper and knip --fix sweep runner"`

---

### Task 8: API routes + end-to-end loop test

**Files:**
- Modify: `src/server/index.ts` (mount new routes; keep file small — extract routes to `src/server/routes-fix.ts`, `src/server/routes-git.ts` if index exceeds ~150 lines)
- Test: `tests/unit/server-fix.test.ts`, `tests/integration/e2e-loop.test.ts`

**Interfaces:**
- Produces routes (all behind existing middleware; `createServer` unchanged signature):
  - `POST /api/fix/preview` `{ issueIds, modeOverrides? }` → compiled `FixPlan` (id, diffs, items; patches withheld) — requires store status `ready`; unknown store → 409.
  - `POST /api/fix/apply` `{ planId }` → `{ results: PatchResult[], failedItems: PlanItem[] }`; plan unknown/used → 404; after apply, auto-rescan in background (same fire-and-forget as CLI initial scan) and include `{ rescanning: true }`.
  - `POST /api/ignore/preview` `{ issueIds }` / `POST /api/ignore/apply` `{ planId }` — same shapes via `compileIgnorePlan`.
  - `POST /api/sweep` `{ workspace?, fixTypes?, allowRemoveFiles? }` → runs `runSweep`, then awaited rescan, returns new issue count. `GET /api/sweep/capabilities` → probe result.
  - `GET /api/git/status` → `GitStatus`. `POST /api/git/branch` `{ name }`. `POST /api/git/commit` `{ message, paths }` → `{ sha }`; paths validated inside project.
- [ ] **Step 1: Failing tests** — unit (injected scan, mkdtemp project with git repo): preview returns diffs + items and withholds patch content; apply of a taken planId → 404 on second call; apply after external file edit → per-file stale result; ignore preview/apply writes knip.json; git status/branch/commit routes happy + error paths; all routes 401 without token. Integration `e2e-loop.test.ts`: copy single fixture to `.tmp-tests/e2e-<rand>` + `git init` it; boot `createServer` with real `runScan`; POST scan → pick `unusedHelper` export + `orphan.ts` file + `left-pad` dep from report → preview (assert 3 diffs) → apply (assert all ok) → poll rescan → assert those ids gone from new report → git commit via route → `git log` shows sha and only expected paths staged. Full tsc check on the mutated copy is NOT required (fixture imports stay valid because only unused code was removed — assert `usedHelper` still exported instead).
- [ ] **Step 2: Run to verify fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Pass, full suite (`npm run typecheck && npm test`), commit** — `git commit -m "feat: fix/ignore/sweep/git API routes with e2e fix loop"`
