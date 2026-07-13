# knip-gui Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `knip-gui` CLI that runs a project's local knip, normalizes results into a flat `Issue[]`, and serves them from a token-protected local Hono API (placeholder HTML shell; real SPA comes in Plan 3).

**Architecture:** Single npm package. `src/cli.ts` is the bin entry; `src/core/*` runs knip and normalizes its JSON; `src/server/*` is a Hono app with token + origin middleware. Tests run against fixture projects under `tests/fixtures/` using the repo root's own knip install (Node module resolution walks up from the fixture dir).

**Tech Stack:** TypeScript (ESM, NodeNext), Hono + @hono/node-server, vitest, knip (devDep, also the integration-test subject). npm as package manager.

**Spec:** `docs/superpowers/specs/2026-07-13-knip-gui-design.md`

## Global Constraints

- Node >= 20, `"type": "module"`, TypeScript strict.
- Server binds `127.0.0.1` only. Every `/api/*` request requires header `x-knip-gui-token` equal to the per-session token; requests with an `Origin` header that isn't the server's own origin are rejected 403.
- Never bundle/require knip directly from our code at build time — resolve the *project's* knip at runtime; missing knip is a supported state, not a crash.
- Knip exit codes: 0 (clean) and 1 (issues found) are both success; >=2 is an error and stderr must be preserved.
- Deviation from spec (approved): `POST /api/scan` is a single awaited request, no SSE. SSE progress is parked — knip emits no incremental progress anyway.
- Commit after every green test cycle. Conventional commit messages (`feat:`, `test:`, `chore:`).

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`, `src/index.ts` (placeholder export)

**Interfaces:**
- Produces: repo-wide toolchain. `npm test` runs vitest; `npm run build` emits `dist/`; `npm run typecheck` passes.

- [ ] **Step 1: Write config files**

`package.json` (versions: install with bare `npm i` commands below so latest compatible versions land):

```json
{
  "name": "knip-gui",
  "version": "0.1.0",
  "description": "Web GUI for knip — browse, fix, and commit unused-code cleanups",
  "type": "module",
  "license": "MIT",
  "bin": { "knip-gui": "./dist/cli.js" },
  "engines": { "node": ">=20" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`tsconfig.build.json`:

```json
{ "extends": "./tsconfig.json", "exclude": ["**/*.test.ts"] }
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000 },
});
```

`.gitignore`:

```
node_modules/
dist/
```

`src/index.ts`:

```ts
export {};
```

- [ ] **Step 2: Install dependencies**

```bash
npm i hono @hono/node-server open
npm i -D typescript vitest @types/node knip
```

- [ ] **Step 3: Verify toolchain**

Run: `npm run typecheck && npm test`
Expected: typecheck passes; vitest reports "no test files found" and exits 0 (if it exits 1 on empty, add `passWithNoTests: true` to the vitest config test block).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: scaffold knip-gui package"
```

---

### Task 2: Fixture projects + captured knip report

**Files:**
- Create: `tests/fixtures/single/{package.json,knip.json,tsconfig.json,src/index.ts,src/used.ts,src/orphan.ts,src/shapes.ts}`
- Create: `tests/fixtures/monorepo/{package.json,packages/app/{package.json,index.ts},packages/lib/{package.json,index.ts,extra.ts}}`
- Create: `scripts/capture-fixture-report.ts`, `tests/fixtures/single-report.json` (generated)

**Interfaces:**
- Produces: fixture dirs used by all integration tests; `tests/fixtures/single-report.json` — the real knip JSON output for the `single` fixture, the ground truth for `normalize` tests.
- The `single` fixture must produce at least: 1 unused file (`src/orphan.ts`), 1 unused export (`unusedHelper`), 1 unused exported type (`UnusedShape`), 1 unused enum member (`Color.Blue`), 1 unused class member (`Geo.area`), 1 unused dependency (`left-pad`).

- [ ] **Step 1: Write the `single` fixture**

`tests/fixtures/single/package.json`:

```json
{
  "name": "fixture-single",
  "version": "1.0.0",
  "type": "module",
  "dependencies": { "left-pad": "1.3.0" }
}
```

`tests/fixtures/single/knip.json`:

```json
{ "entry": ["src/index.ts"], "project": ["src/**/*.ts"] }
```

`tests/fixtures/single/tsconfig.json`:

```json
{ "compilerOptions": { "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": true } }
```

`tests/fixtures/single/src/index.ts`:

```ts
import { usedHelper, Color, Geo } from './used.js';
import type { Shape } from './shapes.js';

const s: Shape = { kind: 'circle' };
console.log(usedHelper(s.kind), Color.Red, new Geo().perimeter());
```

`tests/fixtures/single/src/used.ts`:

```ts
export function usedHelper(k: string): string {
  return k.toUpperCase();
}

export function unusedHelper(n: number): number {
  return n * 2;
}

export enum Color {
  Red,
  Blue,
}

export class Geo {
  perimeter(): number {
    return 4;
  }
  area(): number {
    return 1;
  }
}
```

`tests/fixtures/single/src/shapes.ts`:

```ts
export interface Shape {
  kind: string;
}

export type UnusedShape = { kind: 'square' };
```

`tests/fixtures/single/src/orphan.ts`:

```ts
export const nobodyImportsMe = true;
```

- [ ] **Step 2: Write the `monorepo` fixture (npm-style workspaces)**

`tests/fixtures/monorepo/package.json`:

```json
{
  "name": "fixture-monorepo",
  "version": "1.0.0",
  "type": "module",
  "workspaces": ["packages/*"]
}
```

`tests/fixtures/monorepo/packages/app/package.json`:

```json
{ "name": "@fixture/app", "version": "1.0.0", "type": "module", "main": "index.ts" }
```

`tests/fixtures/monorepo/packages/app/index.ts`:

```ts
export const appMain = 'app';
```

`tests/fixtures/monorepo/packages/lib/package.json`:

```json
{ "name": "@fixture/lib", "version": "1.0.0", "type": "module", "main": "index.ts" }
```

`tests/fixtures/monorepo/packages/lib/index.ts`:

```ts
export const libMain = 'lib';
export const libUnused = 'unused';
```

`tests/fixtures/monorepo/packages/lib/extra.ts`:

```ts
export const extraOrphan = true;
```

- [ ] **Step 3: Capture real knip JSON for the single fixture**

`scripts/capture-fixture-report.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fixture = new URL('../tests/fixtures/single/', import.meta.url).pathname;
const knipBin = require.resolve('knip/bin/knip.js', { paths: [fixture] });

let stdout = '';
try {
  stdout = execFileSync(process.execPath, [knipBin, '--reporter', 'json'], {
    cwd: fixture,
    encoding: 'utf8',
  });
} catch (e: any) {
  if (e.status === 1 && e.stdout) stdout = e.stdout;
  else throw e;
}
writeFileSync(new URL('../tests/fixtures/single-report.json', import.meta.url), stdout);
console.log(stdout);
```

Run: `npx tsx scripts/capture-fixture-report.ts` (add `tsx` as devDep: `npm i -D tsx`)
Expected: prints JSON containing `src/orphan.ts` as an unused file, `unusedHelper` export, `UnusedShape` type, enum member `Blue`, class member `area`, dependency `left-pad`. **Read the output carefully** — the exact shape of `enumMembers`/`classMembers`/`duplicates` entries in this file is the contract for Task 3. If `knip/bin/knip.js` isn't the bin path in the installed version, check `node_modules/knip/package.json` `"bin"` and adjust.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: add single + monorepo fixtures and captured knip report"
```

---

### Task 3: Core types, workspace detection, normalize

**Files:**
- Create: `src/core/types.ts`, `src/core/workspaces.ts`, `src/core/normalize.ts`
- Test: `tests/unit/normalize.test.ts`, `tests/unit/workspaces.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `ISSUE_TYPES` const array; `type IssueType`; `type FixMode = 'delete-file' | 'strip-export' | 'delete-declaration' | 'remove-member' | 'remove-duplicate' | 'remove-dependency'`; `interface Issue { id: string; type: IssueType; workspace: string; filePath: string; symbol?: string; parentSymbol?: string; line?: number; col?: number; pos?: number; fixable: boolean; fixModes: FixMode[] }`; `interface Report { issues: Issue[]; scannedAt: string; workspaces: string[] }`
  - `workspaces.ts`: `getWorkspaceDirs(projectDir: string): Promise<string[]>` — reads `package.json` `workspaces` (array or `{packages}`) and/or `pnpm-workspace.yaml` `packages:` globs, expands them against the filesystem (only dirs containing `package.json`), returns repo-relative dirs sorted longest-first; always includes `'.'` last.
  - `normalize.ts`: `normalize(raw: unknown, workspaceDirs: string[]): Issue[]` — knip JSON → flat issues. Workspace of an issue = first workspaceDir that prefixes its `filePath` (longest-first order makes nested workspaces win); `'.'` otherwise. `id` = first 12 hex chars of sha256 of `${workspace}|${filePath}|${type}|${parentSymbol ?? ''}|${symbol ?? ''}`.
- FixMode mapping: files→`['delete-file']`; exports/types→`['strip-export','delete-declaration']`; enumMembers/classMembers→`['remove-member']`; duplicates→`['remove-duplicate']`; dependencies/devDependencies/optionalPeerDependencies→`['remove-dependency']`; unlisted/unresolved/binaries→`[]` with `fixable: false`.

- [ ] **Step 1: Write failing normalize test against the captured report**

`tests/unit/normalize.test.ts`:

```ts
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

  it('flattens enum and class members with parentSymbol', () => {
    const em = issues.find((i) => i.type === 'enumMembers');
    const cm = issues.find((i) => i.type === 'classMembers');
    expect(em).toMatchObject({ symbol: 'Blue', parentSymbol: 'Color', fixModes: ['remove-member'] });
    expect(cm).toMatchObject({ symbol: 'area', parentSymbol: 'Geo', fixModes: ['remove-member'] });
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
```

**Important:** the captured report is ground truth. If its member/duplicate entry shapes differ from what this test assumes (e.g. members keyed by parent, `Color.Blue` combined names, nested arrays for duplicates), adjust `normalize` to *parse the real shape* and adjust assertions' expected `symbol`/`parentSymbol` split accordingly — the Issue interface itself must not change. Derive `parentSymbol` by splitting combined `"Parent.member"` names if that's how knip reports them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/normalize.test.ts`
Expected: FAIL — cannot find module `normalize.js`.

- [ ] **Step 3: Implement types.ts and normalize.ts**

`src/core/types.ts`:

```ts
export const ISSUE_TYPES = [
  'files', 'exports', 'types', 'enumMembers', 'classMembers', 'duplicates',
  'dependencies', 'devDependencies', 'optionalPeerDependencies',
  'unlisted', 'unresolved', 'binaries',
] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];

export type FixMode =
  | 'delete-file' | 'strip-export' | 'delete-declaration'
  | 'remove-member' | 'remove-duplicate' | 'remove-dependency';

export interface Issue {
  id: string;
  type: IssueType;
  workspace: string;
  filePath: string;
  symbol?: string;
  parentSymbol?: string;
  line?: number;
  col?: number;
  pos?: number;
  fixable: boolean;
  fixModes: FixMode[];
}

export interface Report {
  issues: Issue[];
  scannedAt: string;
  workspaces: string[];
}

export const FIX_MODES_BY_TYPE: Record<IssueType, FixMode[]> = {
  files: ['delete-file'],
  exports: ['strip-export', 'delete-declaration'],
  types: ['strip-export', 'delete-declaration'],
  enumMembers: ['remove-member'],
  classMembers: ['remove-member'],
  duplicates: ['remove-duplicate'],
  dependencies: ['remove-dependency'],
  devDependencies: ['remove-dependency'],
  optionalPeerDependencies: ['remove-dependency'],
  unlisted: [],
  unresolved: [],
  binaries: [],
};
```

`src/core/normalize.ts` (adapt entry parsing to the captured report's real shape):

```ts
import { createHash } from 'node:crypto';
import { FIX_MODES_BY_TYPE, ISSUE_TYPES, type Issue, type IssueType } from './types.js';

type RawEntry = { name: string; line?: number; col?: number; pos?: number };

function issueId(parts: (string | undefined)[]): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('|')).digest('hex').slice(0, 12);
}

function workspaceFor(filePath: string, workspaceDirs: string[]): string {
  for (const dir of workspaceDirs) {
    if (dir !== '.' && (filePath === dir || filePath.startsWith(dir + '/'))) return dir;
  }
  return '.';
}

export function normalize(raw: unknown, workspaceDirs: string[]): Issue[] {
  const issues: Issue[] = [];
  const fileEntries = (raw as { issues?: unknown[] })?.issues ?? [];

  for (const entry of fileEntries as Record<string, unknown>[]) {
    const filePath = String(entry.file ?? '');
    const workspace = workspaceFor(filePath, workspaceDirs);

    for (const type of ISSUE_TYPES) {
      const value = entry[type];
      if (!value) continue;
      for (const item of flattenEntries(value)) {
        const { symbol, parentSymbol } = splitSymbol(type, item.name);
        issues.push({
          id: issueId([workspace, filePath, type, parentSymbol, symbol]),
          type, workspace, filePath, symbol, parentSymbol,
          line: item.line, col: item.col, pos: item.pos,
          fixable: FIX_MODES_BY_TYPE[type].length > 0,
          fixModes: FIX_MODES_BY_TYPE[type],
        });
      }
    }
  }
  return issues;
}

function flattenEntries(value: unknown): RawEntry[] {
  if (Array.isArray(value)) return value.flat(2).filter((v): v is RawEntry => !!v && typeof v === 'object');
  return [];
}

function splitSymbol(type: IssueType, name: string): { symbol: string; parentSymbol?: string } {
  if ((type === 'enumMembers' || type === 'classMembers') && name.includes('.')) {
    const [parent, ...rest] = name.split('.');
    return { symbol: rest.join('.'), parentSymbol: parent };
  }
  return { symbol: name };
}
```

Special case: `files` entries — in knip's JSON an unused file appears as `{ file, files: [{ name }] }`; the issue's `symbol` should be left `undefined` for `files` type (add a guard: for `type === 'files'`, push a single issue with no symbol). Adjust per the captured report.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/normalize.test.ts`
Expected: PASS (after aligning with captured shape).

- [ ] **Step 5: Write failing workspaces test**

`tests/unit/workspaces.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getWorkspaceDirs } from '../../src/core/workspaces.js';

const monorepo = new URL('../fixtures/monorepo/', import.meta.url).pathname;
const single = new URL('../fixtures/single/', import.meta.url).pathname;

describe('getWorkspaceDirs', () => {
  it('expands npm-style workspaces globs, longest first, "." last', async () => {
    expect(await getWorkspaceDirs(monorepo)).toEqual(['packages/app', 'packages/lib', '.']);
  });

  it('returns ["."] for single-package projects', async () => {
    expect(await getWorkspaceDirs(single)).toEqual(['.']);
  });
});
```

- [ ] **Step 6: Run to verify fail, implement workspaces.ts**

Implement without new deps — expand only the common `<dir>/*` glob form plus literal dirs (YAGNI: knip itself validates workspace config; we only need dir discovery):

```ts
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function getWorkspaceDirs(projectDir: string): Promise<string[]> {
  const patterns = new Set<string>();

  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    for (const p of ws ?? []) patterns.add(p);
  }

  const pnpmPath = join(projectDir, 'pnpm-workspace.yaml');
  if (existsSync(pnpmPath)) {
    for (const line of readFileSync(pnpmPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?/);
      if (m) patterns.add(m[1]!);
    }
  }

  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      const abs = join(projectDir, base);
      if (!existsSync(abs)) continue;
      for (const d of readdirSync(abs, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(abs, d.name, 'package.json'))) dirs.add(`${base}/${d.name}`);
      }
    } else if (existsSync(join(projectDir, pattern, 'package.json'))) {
      dirs.add(pattern);
    }
  }

  return [...[...dirs].sort((a, b) => b.length - a.length || a.localeCompare(b)), '.'];
}
```

Note: the test expects `['packages/app', 'packages/lib', '.']` — equal lengths fall back to locale order, so assert accordingly.

Run: `npx vitest run tests/unit/workspaces.test.ts`
Expected: PASS

- [ ] **Step 7: Full suite + commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "feat: core types, workspace detection, knip report normalization"
```

---

### Task 4: Knip runner

**Files:**
- Create: `src/core/knip-runner.ts`
- Test: `tests/integration/knip-runner.test.ts`

**Interfaces:**
- Produces:
  - `resolveKnip(projectDir: string): { binPath: string; version: string } | null` — resolves `knip/package.json` via `createRequire` with `paths: [projectDir]`, derives the bin JS path from its `bin` field; null when unresolvable.
  - `runScan(projectDir: string, opts?: { workspace?: string }): Promise<unknown>` — spawns `process.execPath [binPath, '--reporter', 'json', ...(workspace ? ['--workspace', ws] : [])]` with `cwd: projectDir`; resolves with parsed JSON on exit 0/1; throws `KnipError` (with `.stderr` and `.exitCode`) otherwise or when knip is missing (`code: 'knip-not-found'`).
  - `class KnipError extends Error { exitCode?: number; stderr?: string; code?: 'knip-not-found' | 'knip-failed' | 'bad-json' }`

- [ ] **Step 1: Write failing integration test**

`tests/integration/knip-runner.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/integration/knip-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement knip-runner.ts**

```ts
import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export class KnipError extends Error {
  exitCode?: number;
  stderr?: string;
  code?: 'knip-not-found' | 'knip-failed' | 'bad-json';
  constructor(message: string, props: Partial<KnipError> = {}) {
    super(message);
    Object.assign(this, props);
  }
}

export function resolveKnip(projectDir: string): { binPath: string; version: string } | null {
  if (!existsSync(projectDir)) return null;
  try {
    const require = createRequire(join(projectDir, 'noop.js'));
    const pkgPath = require.resolve('knip/package.json', { paths: [projectDir] });
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.knip;
    if (!bin) return null;
    return { binPath: join(dirname(pkgPath), bin), version: pkg.version };
  } catch {
    return null;
  }
}

export function runScan(projectDir: string, opts: { workspace?: string } = {}): Promise<unknown> {
  const knip = resolveKnip(projectDir);
  if (!knip) {
    return Promise.reject(new KnipError('knip not found in project', { code: 'knip-not-found' }));
  }
  const args = [knip.binPath, '--reporter', 'json'];
  if (opts.workspace && opts.workspace !== '.') args.push('--workspace', opts.workspace);

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath, args,
      { cwd: projectDir, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = (error as NodeJS.ErrnoException & { code?: number | string })?.code;
        if (error && typeof exitCode === 'number' && exitCode >= 2) {
          return reject(new KnipError(`knip exited with ${exitCode}`, { code: 'knip-failed', exitCode, stderr }));
        }
        if (error && typeof exitCode !== 'number') {
          return reject(new KnipError(String(error.message), { code: 'knip-failed', stderr }));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new KnipError('knip produced invalid JSON', { code: 'bad-json', stderr }));
        }
      },
    );
  });
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/integration/knip-runner.test.ts`
Expected: PASS. Note: monorepo fixture scan must find `libUnused` export and `packages/lib/extra.ts` file — if knip needs `node_modules` in the fixture for workspace resolution, run `npm i --no-audit --no-fund` inside `tests/fixtures/monorepo` once and gitignore that path.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: knip resolver and scan runner with real-knip integration tests"
```

---

### Task 5: Hono server — security middleware, report/scan/file routes

**Files:**
- Create: `src/server/index.ts`, `src/server/store.ts`
- Test: `tests/unit/server.test.ts`

**Interfaces:**
- Consumes: `normalize`, `getWorkspaceDirs`, `runScan`, `KnipError`, `Report` from Tasks 3–4.
- Produces:
  - `store.ts`: `class ReportStore { status: 'idle' | 'scanning' | 'ready' | 'error'; report?: Report; error?: { code: string; message: string; stderr?: string } }` with `setScanning() / setReady(report) / setError(e)`.
  - `index.ts`: `createServer(opts: { projectDir: string; scan?: typeof runScan }): { app: Hono; token: string; store: ReportStore }`. `scan` is injectable so unit tests never spawn knip. Routes:
    - `GET /` → HTML shell, `text/html`, containing `<meta name="knip-gui-token" content="{token}">` (placeholder body until Plan 3).
    - `POST /api/scan` body `{ workspace?: string }` → runs scan, normalizes, stores; 200 `{ status: 'ready', issueCount }` or 500 `{ status: 'error', error }`. Concurrent scan → 409.
    - `GET /api/report` → `{ status, report?, error? }`.
    - `GET /api/file?path=src/x.ts` → `{ path, content }`; 400 on traversal outside projectDir, 404 missing, 413 over 2 MB.
  - Security middleware on `/api/*`: 401 unless `x-knip-gui-token` header matches; 403 if `Origin` present and not `http://127.0.0.1:*` or `http://localhost:*`.

- [ ] **Step 1: Write failing server test**

`tests/unit/server.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';

const single = new URL('../fixtures/single/', import.meta.url).pathname;

const fakeRaw = {
  issues: [
    { file: 'src/used.ts', exports: [{ name: 'unusedHelper', line: 5, col: 17, pos: 80 }] },
  ],
};

function makeServer(scan = async () => fakeRaw) {
  return createServer({ projectDir: single, scan });
}

describe('server security', () => {
  it('rejects api calls without token', async () => {
    const { app } = makeServer();
    const res = await app.request('/api/report');
    expect(res.status).toBe(401);
  });

  it('rejects cross-origin requests even with token', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/api/report', {
      headers: { 'x-knip-gui-token': token, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('serves the shell with the token embedded', async () => {
    const { app, token } = makeServer();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(token);
  });
});

describe('scan + report + file', () => {
  it('scan populates the report', async () => {
    const { app, token } = makeServer();
    const h = { 'x-knip-gui-token': token };
    const scanRes = await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    expect(scanRes.status).toBe(200);

    const rep = await (await app.request('/api/report', { headers: h })).json();
    expect(rep.status).toBe('ready');
    expect(rep.report.issues).toHaveLength(1);
    expect(rep.report.issues[0].symbol).toBe('unusedHelper');
    expect(rep.report.workspaces).toEqual(['.']);
  });

  it('scan failure surfaces error payload', async () => {
    const { app, token } = makeServer(async () => {
      const { KnipError } = await import('../../src/core/knip-runner.js');
      throw new KnipError('boom', { code: 'knip-failed', stderr: 'stack...' });
    });
    const h = { 'x-knip-gui-token': token };
    const res = await app.request('/api/scan', { method: 'POST', headers: h, body: '{}' });
    expect(res.status).toBe(500);
    const rep = await (await app.request('/api/report', { headers: h })).json();
    expect(rep.status).toBe('error');
    expect(rep.error.stderr).toBe('stack...');
  });

  it('serves file content within the project only', async () => {
    const { app, token } = makeServer();
    const h = { 'x-knip-gui-token': token };
    const ok = await app.request('/api/file?path=src/index.ts', { headers: h });
    expect(ok.status).toBe(200);
    expect((await ok.json()).content).toContain('usedHelper');

    expect((await app.request('/api/file?path=../../../etc/passwd', { headers: h })).status).toBe(400);
    expect((await app.request('/api/file?path=src/nope.ts', { headers: h })).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/unit/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement store.ts and index.ts**

`src/server/store.ts`:

```ts
import type { Report } from '../core/types.js';

export interface StoreError { code: string; message: string; stderr?: string }

export class ReportStore {
  status: 'idle' | 'scanning' | 'ready' | 'error' = 'idle';
  report?: Report;
  error?: StoreError;

  setScanning() { this.status = 'scanning'; this.error = undefined; }
  setReady(report: Report) { this.status = 'ready'; this.report = report; this.error = undefined; }
  setError(error: StoreError) { this.status = 'error'; this.error = error; }
}
```

`src/server/index.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { KnipError, runScan } from '../core/knip-runner.js';
import { normalize } from '../core/normalize.js';
import { getWorkspaceDirs } from '../core/workspaces.js';
import { ReportStore } from './store.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function createServer(opts: { projectDir: string; scan?: typeof runScan }) {
  const { projectDir, scan = runScan } = opts;
  const token = randomBytes(24).toString('hex');
  const store = new ReportStore();
  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    if (c.req.header('x-knip-gui-token') !== token) return c.json({ error: 'unauthorized' }, 401);
    const origin = c.req.header('origin');
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return c.json({ error: 'forbidden origin' }, 403);
    }
    await next();
  });

  app.get('/', (c) =>
    c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>knip-gui</title>` +
      `<meta name="knip-gui-token" content="${token}"></head>` +
      `<body><p>knip-gui server running. UI ships in a later phase.</p></body></html>`,
    ),
  );

  app.post('/api/scan', async (c) => {
    if (store.status === 'scanning') return c.json({ error: 'scan in progress' }, 409);
    const body = await c.req.json().catch(() => ({}));
    store.setScanning();
    try {
      const raw = await scan(projectDir, { workspace: body.workspace });
      const workspaces = await getWorkspaceDirs(projectDir);
      const issues = normalize(raw, workspaces);
      store.setReady({ issues, scannedAt: new Date().toISOString(), workspaces });
      return c.json({ status: 'ready', issueCount: issues.length });
    } catch (e) {
      const err = e instanceof KnipError
        ? { code: e.code ?? 'knip-failed', message: e.message, stderr: e.stderr }
        : { code: 'internal', message: String(e) };
      store.setError(err);
      return c.json({ status: 'error', error: err }, 500);
    }
  });

  app.get('/api/report', (c) =>
    c.json({ status: store.status, report: store.report, error: store.error }),
  );

  app.get('/api/file', async (c) => {
    const rel = c.req.query('path') ?? '';
    const abs = resolve(projectDir, rel);
    if (abs !== resolve(projectDir) && !abs.startsWith(resolve(projectDir) + sep)) {
      return c.json({ error: 'path outside project' }, 400);
    }
    try {
      const s = await stat(abs);
      if (!s.isFile()) return c.json({ error: 'not a file' }, 404);
      if (s.size > MAX_FILE_BYTES) return c.json({ error: 'file too large' }, 413);
      return c.json({ path: rel, content: await readFile(abs, 'utf8') });
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });

  return { app, token, store };
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `npx vitest run tests/unit/server.test.ts`
Expected: PASS

- [ ] **Step 5: Full suite + commit**

```bash
npm run typecheck && npm test
git add -A && git commit -m "feat: hono server with token/origin security, scan/report/file routes"
```

---

### Task 6: CLI entry

**Files:**
- Create: `src/cli.ts`
- Modify: `src/index.ts` (re-export public API: `createServer`, `runScan`, `resolveKnip`, `normalize`, types)
- Test: `tests/integration/cli.test.ts`

**Interfaces:**
- Consumes: `createServer`, `resolveKnip`.
- Produces: executable CLI. Flags via `node:util` `parseArgs`: `--port <n>` (default 0 = random), `--no-open`, `--dir <path>` (default cwd). Behavior: resolve knip (missing → print install hint, still start server so the UI can show setup screen), start `@hono/node-server` bound to `127.0.0.1`, print `knip-gui running at http://127.0.0.1:<port>`, kick off an initial background scan (fire-and-forget, errors land in the store), open browser via `open` unless `--no-open`.

- [ ] **Step 1: Write failing CLI test**

`tests/integration/cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { startCli } from '../../src/cli.js';

const single = new URL('../fixtures/single/', import.meta.url).pathname;

describe('cli', () => {
  it('starts the server, serves the shell, and scans in the background', async () => {
    const { url, close, token } = await startCli({ dir: single, open: false, port: 0 });
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const html = await (await fetch(url)).text();
      expect(html).toContain('knip-gui');

      let status = '';
      for (let i = 0; i < 120 && status !== 'ready'; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const rep = await (await fetch(`${url}/api/report`, { headers: { 'x-knip-gui-token': token } })).json();
        status = rep.status;
      }
      expect(status).toBe('ready');
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/integration/cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement cli.ts**

```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { createServer } from './server/index.js';
import { resolveKnip } from './core/knip-runner.js';

export interface CliHandle { url: string; token: string; close: () => Promise<void> }

export async function startCli(opts: { dir: string; port: number; open: boolean }): Promise<CliHandle> {
  const { dir, port, open } = opts;
  const knip = resolveKnip(dir);
  if (!knip) {
    console.error('knip not found in this project. Install it first: npm i -D knip');
  } else {
    console.log(`Using knip ${knip.version}`);
  }

  const { app, token } = createServer({ projectDir: dir });

  const server = await new Promise<ReturnType<typeof serve>>((res) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => res(s));
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`knip-gui running at ${url}`);

  if (knip) {
    fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'x-knip-gui-token': token, 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {});
  }
  if (open) (await import('open')).default(url).catch(() => {});

  return {
    url, token,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (invokedDirectly) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '0' },
      open: { type: 'boolean', default: true },
      'no-open': { type: 'boolean', default: false },
      dir: { type: 'string', default: process.cwd() },
    },
  });
  startCli({
    dir: values.dir!,
    port: Number(values.port),
    open: values.open! && !values['no-open'],
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

`src/index.ts`:

```ts
export { createServer } from './server/index.js';
export { runScan, resolveKnip, KnipError } from './core/knip-runner.js';
export { normalize } from './core/normalize.js';
export { getWorkspaceDirs } from './core/workspaces.js';
export * from './core/types.js';
```

- [ ] **Step 4: Run tests, build, smoke-test the binary**

```bash
npm run typecheck && npm test && npm run build
node dist/cli.js --dir tests/fixtures/single --no-open --port 4777 &
sleep 3 && curl -s http://127.0.0.1:4777 | grep -q knip-gui && echo SHELL_OK
kill %1
```

Expected: all tests pass; `SHELL_OK` printed.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: knip-gui CLI entry with background initial scan"
```
