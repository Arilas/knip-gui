// Pure guard/dispatch tests for the global keyboard shortcuts (Task P, #25).
// shortcutAction() is deliberately framework-free (see
// client/src/lib/shortcuts.ts's doc comment) so every guard is pinned here
// without mounting anything — the impure wiring (reading a real
// KeyboardEvent, calling navigate/mutate) lives in
// client/src/hooks/use-global-shortcuts.ts and is exercised by
// tests/e2e/command-palette.spec.ts instead.
import { describe, expect, it } from 'vitest';
import { shortcutAction, type ShortcutContext, type ShortcutKeyInfo } from '../../client/src/lib/shortcuts.js';

const NOT_TYPING: ShortcutContext = { dialogOpen: false, pathname: '/dashboard' };

function key(partial: Partial<ShortcutKeyInfo> & Pick<ShortcutKeyInfo, 'key'>): ShortcutKeyInfo {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isTypingTarget: false,
    ...partial,
  };
}

describe('shortcutAction — the ⌘K/Ctrl+K palette combo', () => {
  it('toggles the palette on Meta+K', () => {
    expect(shortcutAction(key({ key: 'k', metaKey: true }), NOT_TYPING)).toEqual({ kind: 'toggle-palette' });
  });

  it('toggles the palette on Ctrl+K', () => {
    expect(shortcutAction(key({ key: 'k', ctrlKey: true }), NOT_TYPING)).toEqual({ kind: 'toggle-palette' });
  });

  it('is case-insensitive (Caps Lock reports an uppercase K without setting shiftKey)', () => {
    expect(shortcutAction(key({ key: 'K', metaKey: true }), NOT_TYPING)).toEqual({
      kind: 'toggle-palette',
    });
  });

  it('rejects Meta+Shift+K — a genuinely different combo, not the same shortcut with Caps Lock on', () => {
    expect(shortcutAction(key({ key: 'K', metaKey: true, shiftKey: true }), NOT_TYPING)).toBeNull();
  });

  it('works even while the target is a typing context — the standard palette exception', () => {
    expect(shortcutAction(key({ key: 'k', metaKey: true, isTypingTarget: true }), NOT_TYPING)).toEqual({
      kind: 'toggle-palette',
    });
  });

  it('works even while a dialog is already open (toggling only adds/removes an overlay; it mutates nothing)', () => {
    expect(shortcutAction(key({ key: 'k', metaKey: true }), { ...NOT_TYPING, dialogOpen: true })).toEqual({
      kind: 'toggle-palette',
    });
  });

  it('works even on the /review page', () => {
    expect(shortcutAction(key({ key: 'k', metaKey: true }), { ...NOT_TYPING, pathname: '/review' })).toEqual({
      kind: 'toggle-palette',
    });
  });
});

describe('shortcutAction — typing-context guard', () => {
  it('ignores a bare "r" typed into an input', () => {
    expect(shortcutAction(key({ key: 'r', isTypingTarget: true }), NOT_TYPING)).toBeNull();
  });

  it('ignores a digit typed into a textarea/contenteditable target', () => {
    expect(shortcutAction(key({ key: '2', isTypingTarget: true }), NOT_TYPING)).toBeNull();
  });

  it('ignores "/" typed into an input (a literal slash character, not the shortcut)', () => {
    expect(shortcutAction(key({ key: '/', isTypingTarget: true }), NOT_TYPING)).toBeNull();
  });
});

describe('shortcutAction — modifier guard', () => {
  it('ignores Shift+1 (not the bare digit shortcut)', () => {
    expect(shortcutAction(key({ key: '1', shiftKey: true }), NOT_TYPING)).toBeNull();
  });

  it('ignores Alt+r', () => {
    expect(shortcutAction(key({ key: 'r', altKey: true }), NOT_TYPING)).toBeNull();
  });

  it('ignores Meta+r (a modifier held on a non-K key is never the palette combo)', () => {
    expect(shortcutAction(key({ key: 'r', metaKey: true }), NOT_TYPING)).toBeNull();
  });

  it('ignores Ctrl+/ ', () => {
    expect(shortcutAction(key({ key: '/', ctrlKey: true }), NOT_TYPING)).toBeNull();
  });
});

describe('shortcutAction — dialog/palette-open guard', () => {
  it('ignores "r" while a dialog is open', () => {
    expect(shortcutAction(key({ key: 'r' }), { ...NOT_TYPING, dialogOpen: true })).toBeNull();
  });

  it('ignores a digit while a dialog is open', () => {
    expect(shortcutAction(key({ key: '3' }), { ...NOT_TYPING, dialogOpen: true })).toBeNull();
  });

  it('ignores "/" while a dialog is open', () => {
    expect(shortcutAction(key({ key: '/' }), { ...NOT_TYPING, dialogOpen: true })).toBeNull();
  });
});

describe('shortcutAction — rescan ("r")', () => {
  it('returns the rescan action outside of /review', () => {
    expect(shortcutAction(key({ key: 'r' }), NOT_TYPING)).toEqual({ kind: 'rescan' });
  });

  it('is inert on /review — a mutating shortcut must not prune a frozen review', () => {
    expect(shortcutAction(key({ key: 'r' }), { ...NOT_TYPING, pathname: '/review' })).toBeNull();
  });

  it('is case-insensitive ("R" behaves the same as "r")', () => {
    expect(shortcutAction(key({ key: 'R' }), NOT_TYPING)).toEqual({ kind: 'rescan' });
  });
});

describe('shortcutAction — page digits 1-5', () => {
  const cases: Array<[string, string]> = [
    ['1', '/dashboard'],
    ['2', '/code'],
    ['3', '/packages'],
    ['4', '/ignored'],
    ['5', '/activity'],
  ];

  for (const [digit, to] of cases) {
    it(`"${digit}" navigates to ${to}`, () => {
      expect(shortcutAction(key({ key: digit }), NOT_TYPING)).toEqual({ kind: 'navigate', to });
    });
  }

  it('page navigation is not gated by /review (non-mutating)', () => {
    expect(shortcutAction(key({ key: '2' }), { ...NOT_TYPING, pathname: '/review' })).toEqual({
      kind: 'navigate',
      to: '/code',
    });
  });
});

describe('shortcutAction — "/" focuses the tree filter', () => {
  it('returns the focus-filter action', () => {
    expect(shortcutAction(key({ key: '/' }), NOT_TYPING)).toEqual({ kind: 'focus-filter' });
  });
});

describe('shortcutAction — unknown keys', () => {
  it('returns null for a key with no binding', () => {
    expect(shortcutAction(key({ key: 'q' }), NOT_TYPING)).toBeNull();
  });

  it('returns null for "0" and "6" (outside the 1-5 range)', () => {
    expect(shortcutAction(key({ key: '0' }), NOT_TYPING)).toBeNull();
    expect(shortcutAction(key({ key: '6' }), NOT_TYPING)).toBeNull();
  });

  it('returns null for Escape (left to the dialog/palette\'s own handling, not this hook)', () => {
    expect(shortcutAction(key({ key: 'Escape' }), NOT_TYPING)).toBeNull();
  });
});
