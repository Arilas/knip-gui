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
  /** The command palette itself is open (the hook's own React state — no DOM
   *  probing needed, and no render/commit gap: setState flips it synchronously
   *  with the toggle action). Split from `dialogOpen` (#25 review) because ⌘K
   *  treats them differently: it always CLOSES an open palette, but must not
   *  OPEN one over an unrelated dialog. */
  paletteOpen: boolean;
  /** Any OTHER dialog is open — a plain Dialog (role="dialog": CommitDialog)
   *  OR a Radix AlertDialog (role="alertdialog": the workspace-switch
   *  discard-selection confirm, SweepDialog). The hook's DOM query must cover
   *  BOTH roles (#25 review critical: the original `[role="dialog"]`-only
   *  selector let `r`/digits/`/` fire behind every AlertDialog confirm). */
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
  // works mid-typing (jumping OUT of whatever field has focus is the whole
  // point of the shortcut) and on /review (non-mutating). The one asymmetry
  // (#25 review): it always CLOSES an already-open palette, but never OPENS
  // one while an unrelated dialog (CommitDialog, an AlertDialog confirm) is
  // up — that would stack a second modal on top with nothing dismissing the
  // first. Every other shortcut stays fully gated below.
  const isPaletteCombo = (key.metaKey || key.ctrlKey) && !key.altKey && !key.shiftKey && lower === 'k';
  if (isPaletteCombo) {
    if (!ctx.paletteOpen && ctx.dialogOpen) return null;
    return { kind: 'toggle-palette' };
  }

  if (ctx.paletteOpen || ctx.dialogOpen) return null;
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
