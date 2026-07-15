import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Directories never treated as (or descended into while searching for) workspaces —
// they can contain thousands of nested package.json files that are not project
// workspaces, and a `**` glob would otherwise harvest all of them.
const SKIP_DIRS = new Set(['node_modules', '.git']);

export async function getWorkspaceDirs(projectDir: string): Promise<string[]> {
  const positive = new Set<string>();
  const negative = new Set<string>();

  for (const pattern of collectPatterns(projectDir)) {
    if (pattern.startsWith('!')) {
      negative.add(pattern.slice(1).replace(/\/$/, ''));
    } else {
      positive.add(pattern.replace(/\/$/, ''));
    }
  }

  const dirs = new Set<string>();
  for (const pattern of positive) {
    for (const match of expandPattern(projectDir, pattern)) dirs.add(match);
  }
  // Apply negative patterns against the fully-expanded set so `!packages/private`
  // (or `!packages/*`) actually excludes matches, rather than being silently dropped.
  for (const pattern of negative) {
    for (const match of [...dirs]) {
      if (matchesGlob(pattern.split('/'), match.split('/'))) dirs.delete(match);
    }
  }

  return [...[...dirs].sort((a, b) => b.length - a.length || a.localeCompare(b)), '.'];
}

// Reads workspace globs from package.json (`workspaces` array or
// `workspaces.packages`) and pnpm-workspace.yaml (only the list under the
// top-level `packages:` key — other list-valued keys like `catalog:` /
// `onlyBuiltDependencies:` must not be mistaken for workspace globs).
function collectPatterns(projectDir: string): string[] {
  const patterns: string[] = [];

  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
      if (Array.isArray(ws)) for (const p of ws) if (typeof p === 'string') patterns.push(p);
    } catch {
      // Malformed package.json — treat as no workspaces rather than throwing.
    }
  }

  const pnpmPath = join(projectDir, 'pnpm-workspace.yaml');
  if (existsSync(pnpmPath)) {
    let inPackages = false;
    for (const line of readFileSync(pnpmPath, 'utf8').split('\n')) {
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
function expandPattern(projectDir: string, pattern: string): string[] {
  const out: string[] = [];
  walk(projectDir, '', pattern.split('/').filter(Boolean), out);
  return out;
}

function walk(rootAbs: string, relSoFar: string, segments: string[], out: string[]): void {
  if (segments.length === 0) {
    if (relSoFar && existsSync(join(rootAbs, relSoFar, 'package.json'))) out.push(relSoFar);
    return;
  }
  const [seg, ...rest] = segments;
  const currentAbs = join(rootAbs, relSoFar);
  let entries: string[];
  try {
    entries = readdirSync(currentAbs, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name))
      .map((d) => d.name);
  } catch {
    return; // not a readable directory
  }

  if (seg === '**') {
    // `**` matches zero segments (try the rest right here) and one-or-more (recurse
    // into each subdir keeping `**` at the head).
    walk(rootAbs, relSoFar, rest, out);
    for (const name of entries) walk(rootAbs, join(relSoFar, name), segments, out);
    return;
  }

  const re = segmentRegex(seg!);
  for (const name of entries) {
    if (re.test(name)) walk(rootAbs, join(relSoFar, name), rest, out);
  }
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
