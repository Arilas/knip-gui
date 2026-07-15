import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { detectFormatting } from '../core/jsonc-format.js';
import type { TransformResult } from '../fix/transforms/source.js';

export interface IgnoreEdit {
  kind: 'ignore' | 'ignoreDependencies' | 'ignoreBinaries';
  value: string;
  workspace?: string;
}

// Same shape as IgnoreEdit — a distinct name for the Task 5 (Ignored page)
// read/remove path, since callers there are describing an EXISTING config
// entry (listIgnores' output, removeIgnores' input) rather than a new one
// being added (addIgnores' input). `workspace` is always populated by
// listIgnores ('.' for root-level entries, mirroring how every other page
// labels the root workspace), so it reads as required in practice even though
// it stays optional here to match addIgnores/IgnoreEdit's shape exactly.
export type IgnoreEntry = IgnoreEdit;

export type KnipConfigKind = 'knip.json' | 'knip.jsonc' | 'package.json' | 'code' | 'none';

// Real config-file search order, per knip's own `KNIP_CONFIG_LOCATIONS`
// (node_modules/knip/dist/constants.js): knip.json, knip.jsonc, .knip.json,
// .knip.jsonc, knip.ts, knip.js, knip.config.ts, knip.config.js. At runtime knip
// merges package.json#knip UNDER whichever of those it finds (the dedicated config
// file wins on key conflicts) — that's knip's *resolution* semantics for running a
// scan, not ours here: this writer's job is to pick exactly ONE file to edit, per
// the task's specified precedence (knip.json > knip.jsonc > package.json#knip >
// code > none), which favors editing a dedicated JSON/JSONC file when one exists,
// else falling back to package.json#knip, and only reporting a knip.ts/knip.js
// config as present-but-unwritable ('code') when neither JSON option exists.
//
// The dotfile variants (`.knip.json` / `.knip.jsonc`) and the `knip.config.*`
// variants are real knip-supported filenames the task brief didn't name explicitly
// — they ARE supported below, folded into the same `kind` as their non-dotted /
// non-`.config` siblings since they're the identical file format (jsonc-parser
// doesn't care about the filename, only json vs jsonc dialect). Nothing is skipped
// from KNIP_CONFIG_LOCATIONS.
// Dedicated JSON/JSONC config files in knip's REAL resolution order
// (KNIP_CONFIG_LOCATIONS): knip.json, knip.jsonc, .knip.json, .knip.jsonc. The
// order matters — with both knip.jsonc and .knip.json present, knip reads
// knip.jsonc, so the writer must edit that same file. Each maps to its jsonc
// dialect `kind` (dotfile variants fold into their non-dotted sibling's kind).
const DEDICATED_CONFIG_NAMES: { name: string; kind: 'knip.json' | 'knip.jsonc' }[] = [
  { name: 'knip.json', kind: 'knip.json' },
  { name: 'knip.jsonc', kind: 'knip.jsonc' },
  { name: '.knip.json', kind: 'knip.json' },
  { name: '.knip.jsonc', kind: 'knip.jsonc' },
];
const CODE_CONFIG_NAMES = ['knip.ts', 'knip.js', 'knip.config.ts', 'knip.config.js'];

export function findKnipConfig(projectDir: string): { kind: KnipConfigKind; path?: string } {
  for (const { name, kind } of DEDICATED_CONFIG_NAMES) {
    const path = join(projectDir, name);
    if (existsSync(path)) return { kind, path };
  }
  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = parse(readFileSync(pkgPath, 'utf8'));
    if (pkg != null && typeof pkg === 'object' && pkg.knip !== undefined) {
      return { kind: 'package.json', path: pkgPath };
    }
  }
  for (const name of CODE_CONFIG_NAMES) {
    const path = join(projectDir, name);
    if (existsSync(path)) return { kind: 'code', path };
  }
  return { kind: 'none' };
}

// `edit.workspace` set (and not the root workspace `'.'`) scopes the edit under
// `workspaces['<ws>']`, per knip's config schema (node_modules/knip/schema.json:
// `workspaces` is `additionalProperties: { $ref: '#/definitions/workspace' }`, and
// `ignore`/`ignoreDependencies`/`ignoreBinaries` are all properties of that same
// `workspace` definition — i.e. valid at both the config root and per-workspace).
// `configKind: 'package.json'` nests everything one level deeper, under `knip`.
function ignorePath(configKind: 'knip.json' | 'knip.jsonc' | 'package.json', edit: IgnoreEdit): (string | number)[] {
  const base = configKind === 'package.json' ? ['knip'] : [];
  if (edit.workspace !== undefined && edit.workspace !== '.') {
    return [...base, 'workspaces', edit.workspace, edit.kind];
  }
  return [...base, edit.kind];
}

function getAtPath(root: unknown, path: readonly (string | number)[]): unknown {
  let cur = root;
  for (const segment of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    // Own-property only: a workspace/key literally named `constructor` etc. must
    // not resolve to an inherited Object.prototype member.
    if (!Object.hasOwn(cur, segment)) return undefined;
    cur = (cur as Record<string | number, unknown>)[segment];
  }
  return cur;
}

// Appends each edit's `value` to the array at its target path — creating the array
// (and any missing intermediate objects, e.g. `workspaces['pkg']`) if absent, and
// deduping against values already present. Uses jsonc-parser's `modify`/`applyEdits`
// so untouched formatting (and, for `knip.jsonc`, comments) survive byte-for-byte.
export function addIgnores(
  content: string,
  configKind: 'knip.json' | 'knip.jsonc' | 'package.json',
  edits: IgnoreEdit[],
): TransformResult {
  const formattingOptions = detectFormatting(content);
  let newContent = content;

  for (const edit of edits) {
    const path = ignorePath(configKind, edit);
    const root = parse(newContent);
    if (root === undefined) return { ok: false, reason: 'invalid-json' };
    const existing = getAtPath(root, path);
    // knip's own schema allows `ignore` (only `ignore` — not
    // ignoreDependencies/ignoreBinaries, which are array-only) to be a single
    // glob string instead of an array. Coerce that string into the first
    // element of the new array rather than rejecting it as a type mismatch.
    if (existing !== undefined && typeof existing === 'string' && edit.kind === 'ignore') {
      if (existing === edit.value) continue; // already ignored — no-op
      const nextValues = [existing, edit.value];
      newContent = applyEdits(newContent, modify(newContent, path, nextValues, { formattingOptions }));
      continue;
    }
    if (existing !== undefined && !Array.isArray(existing)) {
      return { ok: false, reason: `expected an array at '${path.join('.')}', found ${typeof existing}` };
    }
    const values: string[] = Array.isArray(existing) ? existing : [];
    if (values.includes(edit.value)) continue; // already ignored — no-op
    const nextValues = [...values, edit.value];
    newContent = applyEdits(newContent, modify(newContent, path, nextValues, { formattingOptions }));
  }

  return { ok: true, newContent };
}

// Removes each entry's `value` from the array at its target path — the
// inverse of addIgnores. Processes entries in order, threading content from
// one removal to the next (same atomic-batch behavior as addIgnores: a
// failure on any entry returns ok:false immediately, discarding edits already
// applied earlier in THIS call — the caller never sees a partially-applied
// content string). Removing the last remaining value from an array removes
// the key entirely (jsonc-parser's `modify` with a `value` of `undefined`
// deletes the property/array-element at that path) rather than leaving an
// empty `[]` behind.
export function removeIgnores(
  content: string,
  configKind: 'knip.json' | 'knip.jsonc' | 'package.json',
  entries: IgnoreEntry[],
): TransformResult {
  const formattingOptions = detectFormatting(content);
  let newContent = content;

  for (const entry of entries) {
    const path = ignorePath(configKind, entry);
    const root = parse(newContent);
    if (root === undefined) return { ok: false, reason: 'invalid-json' };
    const existing = getAtPath(root, path);
    if (!Array.isArray(existing) || !existing.includes(entry.value)) {
      return { ok: false, reason: 'not-found' };
    }
    const nextValues = existing.filter((v) => v !== entry.value);
    const nextValue = nextValues.length === 0 ? undefined : nextValues;
    newContent = applyEdits(newContent, modify(newContent, path, nextValue, { formattingOptions }));
  }

  return { ok: true, newContent };
}

const IGNORE_ENTRY_KINDS = ['ignore', 'ignoreDependencies', 'ignoreBinaries'] as const;

// Collects every ignore*-array entry directly on `node` (a config root or a
// single `workspaces[<ws>]` object) into `out`, tagged with `workspace`.
// Non-string array members are skipped rather than throwing — a malformed
// config (e.g. a stray number in `ignore`) shouldn't crash the listing; knip
// itself would presumably also choke on it at scan time, which is a more
// appropriate place for that to surface.
function collectIgnoreEntries(node: unknown, workspace: string, out: IgnoreEntry[]): void {
  if (node == null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  for (const kind of IGNORE_ENTRY_KINDS) {
    const arr = record[kind];
    if (!Array.isArray(arr)) continue;
    for (const value of arr) {
      if (typeof value === 'string') out.push({ kind, value, workspace });
    }
  }
}

export interface ListIgnoresResult {
  entries: IgnoreEntry[];
  configKind: KnipConfigKind;
  configPath?: string;
}

// Parses the same config discovery as findKnipConfig and flattens every
// ignore/ignoreDependencies/ignoreBinaries entry — root-level (workspace:
// '.') and per-workspace (workspaces[<ws>], workspace: <ws>) — into one list
// for the Ignored page. A 'code' config is present-but-unreadable-as-data (no
// safe way to statically enumerate a knip.ts/knip.js's exported object), and
// 'none' means there's nothing to list — both report their kind with empty
// entries so the page can render the right empty state instead of guessing
// from an empty array alone. `configPath` is project-relative, matching
// `Issue.filePath`'s convention elsewhere in this codebase.
export async function listIgnores(projectDir: string): Promise<ListIgnoresResult> {
  const config = findKnipConfig(projectDir);
  if (config.kind === 'code' || config.kind === 'none') {
    return { entries: [], configKind: config.kind, configPath: config.path && relative(projectDir, config.path) };
  }

  const content = await readFile(config.path!, 'utf8');
  const root = parse(content);
  const base = (config.kind === 'package.json' ? (root as Record<string, unknown> | undefined)?.knip : root) as
    | Record<string, unknown>
    | undefined;

  const entries: IgnoreEntry[] = [];
  collectIgnoreEntries(base, '.', entries);

  const workspaces = base?.workspaces;
  if (workspaces != null && typeof workspaces === 'object') {
    for (const [ws, wsConfig] of Object.entries(workspaces as Record<string, unknown>)) {
      collectIgnoreEntries(wsConfig, ws, entries);
    }
  }

  return { entries, configKind: config.kind, configPath: relative(projectDir, config.path!) };
}
