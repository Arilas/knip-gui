// Pure guard/dispatch logic for the global keyboard shortcuts (Task P, #25).
// Framework-free by design (no DOM, no router, no zustand) so every guard —
// typing-context, held-modifier, dialog-open, and the /review mutation gate —
// is unit-testable without mounting anything; see tests/client/shortcuts.test.ts.
// The impure bits (reading event.target's tag/contenteditable, checking
// `document.querySelector('[role="dialog"]')`, calling navigate/mutate) live
// in hooks/use-global-shortcuts.ts, which reduces the real KeyboardEvent +
// app state down to this file's two plain-object inputs and carries out
// whatever ShortcutAction comes back.
export interface ShortcutKeyInfo {
  /** Raw event.key — case matters for the ⌘K combo detection below (Shift
   *  physically held reports 'K'), not for anything else here. */
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** event.target is an <input>/<textarea>/<select> or a contenteditable element. */
  isTypingTarget: boolean;
}

export interface ShortcutContext {
  /** The command palette itself, or any OTHER dialog (AlertDialog confirm,
   *  CommitDialog, …), is currently open. */
  dialogOpen: boolean;
  /** Current route pathname — consulted only for the /review mutation gate. */
  pathname: string;
}

export type ShortcutAction =
  | { kind: 'toggle-palette' }
  | { kind: 'rescan' }
  | { kind: 'navigate'; to: '/dashboard' | '/code' | '/packages' | '/ignored' | '/activity' }
  | { kind: 'focus-filter' };

type NavigateAction = Extract<ShortcutAction, { kind: 'navigate' }>;

const PAGE_BY_DIGIT: Record<string, NavigateAction | undefined> = {
  '1': { kind: 'navigate', to: '/dashboard' },
  '2': { kind: 'navigate', to: '/code' },
  '3': { kind: 'navigate', to: '/packages' },
  '4': { kind: 'navigate', to: '/ignored' },
  '5': { kind: 'navigate', to: '/activity' },
};

export function shortcutAction(key: ShortcutKeyInfo, ctx: ShortcutContext): ShortcutAction | null {
  const lower = key.key.toLowerCase();

  // ⌘K/Ctrl+K — standard command-palette convention (VSCode/Linear/Raycast):
  // the toggle combo always wins. It works mid-typing (jumping OUT of
  // whatever field has focus is the whole point of the shortcut) and with
  // another dialog already open (toggling only adds/removes the palette
  // overlay; it never mutates anything, so there's nothing for the
  // dialog-open guard below to protect) and on /review (also non-mutating).
  // Every other shortcut stays fully gated below.
  const isPaletteCombo = (key.metaKey || key.ctrlKey) && !key.altKey && !key.shiftKey && lower === 'k';
  if (isPaletteCombo) return { kind: 'toggle-palette' };

  if (ctx.dialogOpen) return null;
  if (key.metaKey || key.ctrlKey || key.altKey || key.shiftKey) return null;
  if (key.isTypingTarget) return null;

  if (lower === 'r') {
    // Mirrors GitFooter/WorkspaceSwitcher's `reviewing` gate: a rescan mid-
    // review prunes the selection out from under a frozen "Fix N issues"
    // title and can invalidate its compiled plan (see router.tsx/GitFooter's
    // own doc comments for the full rationale).
    if (ctx.pathname === '/review') return null;
    return { kind: 'rescan' };
  }

  if (key.key === '/') return { kind: 'focus-filter' };

  return PAGE_BY_DIGIT[key.key] ?? null;
}
