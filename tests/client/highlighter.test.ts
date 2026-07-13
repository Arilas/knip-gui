// Pure-helper tests for the shiki code pane's highlighter module (Task 4).
// Rendering itself (createHighlighter, codeToHtml) is exercised live via the
// manual serve check — see Plan 3's task 4 steps — not here, to keep this
// vitest project free of real shiki/WASM loading (heavy rendering tests stay
// out per the plan's Global Constraints).
import { describe, expect, it } from 'vitest';
import type { Issue } from '../../src/core/types.js';
import { issueLines, langForPath, SHIKI_THEMES } from '../../client/src/lib/highlighter.js';

let idSeq = 0;
function issue(partial: Partial<Issue> & Pick<Issue, 'type' | 'filePath'>): Issue {
  idSeq += 1;
  return {
    id: `issue-${idSeq}`,
    workspace: '.',
    fixable: false,
    fixModes: [],
    ...partial,
  };
}

describe('SHIKI_THEMES', () => {
  // Pins the Task 1 (UX overhaul) theme swap: vitesse's warm palette over
  // github-light/dark, to match the app's warm-stone/violet theme (index.css).
  it('uses the warm-toned vitesse dual themes', () => {
    expect(SHIKI_THEMES).toEqual({ light: 'vitesse-light', dark: 'vitesse-dark' });
  });
});

describe('langForPath', () => {
  it('maps known extensions to shiki grammar names', () => {
    expect(langForPath('src/used.ts')).toBe('typescript');
    expect(langForPath('src/App.tsx')).toBe('tsx');
    expect(langForPath('src/index.js')).toBe('javascript');
    expect(langForPath('src/Comp.jsx')).toBe('jsx');
    expect(langForPath('package.json')).toBe('json');
    expect(langForPath('tsconfig.jsonc')).toBe('jsonc');
    expect(langForPath('src/index.mjs')).toBe('javascript');
    expect(langForPath('src/index.cjs')).toBe('javascript');
  });

  it('is case-insensitive on the extension', () => {
    expect(langForPath('src/used.TS')).toBe('typescript');
  });

  it('returns undefined for unknown/missing extensions', () => {
    expect(langForPath('README.md')).toBeUndefined();
    expect(langForPath('Makefile')).toBeUndefined();
    expect(langForPath('')).toBeUndefined();
  });
});

describe('issueLines', () => {
  const issues: Issue[] = [
    issue({ type: 'exports', filePath: 'src/used.ts', symbol: 'unusedHelper', line: 5 }),
    issue({ type: 'enumMembers', filePath: 'src/used.ts', symbol: 'Blue', parentSymbol: 'Color', line: 11 }),
    // Same line, different issue — must accumulate, not overwrite.
    issue({ type: 'types', filePath: 'src/used.ts', symbol: 'AlsoOnLine11', line: 11 }),
    // Whole-file issue (no line) — must be excluded from the line map.
    issue({ type: 'files', filePath: 'src/orphan.ts' }),
    // Different file entirely — must be excluded.
    issue({ type: 'exports', filePath: 'src/shapes.ts', symbol: 'UnusedShape', line: 2 }),
  ];

  it('maps line -> issues for the given file only', () => {
    const map = issueLines(issues, 'src/used.ts');
    expect([...map.keys()].sort((a, b) => a - b)).toEqual([5, 11]);
    expect(map.get(5)!.map((i) => i.symbol)).toEqual(['unusedHelper']);
    expect(map.get(11)!.map((i) => i.symbol).sort()).toEqual(['AlsoOnLine11', 'Blue']);
  });

  it('excludes line-less (whole-file) issues', () => {
    const map = issueLines(issues, 'src/orphan.ts');
    expect(map.size).toBe(0);
  });

  it('returns an empty map for a file with no issues', () => {
    expect(issueLines(issues, 'src/never-seen.ts').size).toBe(0);
  });
});
