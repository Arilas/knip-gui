import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { detectFormatting } from '../core/jsonc-format.js';
import type { TransformResult } from '../fix/transforms/source.js';

export interface IgnoreEdit {
  kind: 'ignore' | 'ignoreDependencies' | 'ignoreBinaries';
  value: string;
  workspace?: string;
}

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
const JSON_CONFIG_NAMES = ['knip.json', '.knip.json'];
const JSONC_CONFIG_NAMES = ['knip.jsonc', '.knip.jsonc'];
const CODE_CONFIG_NAMES = ['knip.ts', 'knip.js', 'knip.config.ts', 'knip.config.js'];

export function findKnipConfig(projectDir: string): { kind: KnipConfigKind; path?: string } {
  for (const name of JSON_CONFIG_NAMES) {
    const path = join(projectDir, name);
    if (existsSync(path)) return { kind: 'knip.json', path };
  }
  for (const name of JSONC_CONFIG_NAMES) {
    const path = join(projectDir, name);
    if (existsSync(path)) return { kind: 'knip.jsonc', path };
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
