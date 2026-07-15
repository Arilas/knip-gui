// Global keyboard shortcuts (Task P, #25): a single window keydown listener,
// mounted once alongside <CommandPalette/> in router.tsx's RootLayout, that
// dispatches through the pure shortcutAction() guard (lib/shortcuts.ts —
// see that file for the guard rules and the ⌘K-bypasses-everything
// rationale). This hook supplies the impure inputs shortcutAction can't see
// on its own (the real event.target's shape, whether any dialog is open, the
// current route) and carries out whatever ShortcutAction comes back.
//
// Mounted in RootLayout (not App.tsx, despite the task brief's file list)
// because navigate()/useRouterState() require router context — App.tsx sits
// ABOVE <RouterProvider>, so anything needing live navigation/pathname has to
// live inside the routed tree. RootLayout, literally "the root layout", is
// the router-context equivalent and is where GitFooter/WorkspaceSwitcher
// already get their own `reviewing` gate the same way.
import { useEffect, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { focusCodeTreeFilter } from '../lib/code-tree-focus.js';
import { shortcutAction, type ShortcutKeyInfo } from '../lib/shortcuts.js';
import { useBusy, useReport, useScanMutation } from '../state/queries.js';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

// Any dialog currently open — checked structurally via role="dialog" rather
// than threading every dialog's own open state in here, so a future dialog
// doesn't have to opt into this guard. This also naturally covers the
// command palette's own [role="dialog"] while it's open (on top of the
// `paletteOpen ||` below, which covers the render/paint gap between React
// flipping the state and Radix's portal actually committing the node).
function isAnyDialogOpen(): boolean {
  return document.querySelector('[role="dialog"]') !== null;
}

// Bounded retry via rAF rather than a fixed setTimeout: the input's mount
// depends on React committing a route change (CodePage -> TreeView -> Input
// registering itself, see lib/code-tree-focus.ts), which has no fixed
// duration to guess at — riding a few animation frames is cheap and self-
// limiting (stops as soon as the focus succeeds, or after 20 frames if the
// user navigated away again before it ever mounted).
const FOCUS_RETRY_FRAMES = 20;

function retryFocusUntilMounted(): void {
  let attempts = 0;
  const tryFocus = () => {
    if (focusCodeTreeFilter() || attempts++ >= FOCUS_RETRY_FRAMES) return;
    requestAnimationFrame(tryFocus);
  };
  requestAnimationFrame(tryFocus);
}

export interface UseGlobalShortcutsResult {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

export function useGlobalShortcuts(): UseGlobalShortcutsResult {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const busy = useBusy();
  const scanMutation = useScanMutation();
  const { data } = useReport();
  const currentScope = data?.report?.scope;

  useEffect(() => {
    function focusFilterInput() {
      if (pathname === '/code' && focusCodeTreeFilter()) return;
      if (pathname !== '/code') navigate({ to: '/code' });
      retryFocusUntilMounted();
    }

    function handleKeyDown(event: KeyboardEvent) {
      const keyInfo: ShortcutKeyInfo = {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        isTypingTarget: isTypingTarget(event.target),
      };
      const action = shortcutAction(keyInfo, { dialogOpen: paletteOpen || isAnyDialogOpen(), pathname });
      if (!action) return;
      // Every recognized shortcut owns its key: ⌘K would otherwise fall
      // through to the browser's own address-bar-focus binding in some
      // browsers, and the rest would otherwise type/scroll if a guard above
      // somehow let one through.
      event.preventDefault();
      switch (action.kind) {
        case 'toggle-palette':
          setPaletteOpen((open) => !open);
          break;
        case 'rescan':
          // Same client-side gate as GitFooter's Re-run button — the endpoint
          // is also latched server-side, so this is defense in depth.
          if (!busy) scanMutation.mutate(currentScope);
          break;
        case 'navigate':
          navigate({ to: action.to });
          break;
        case 'focus-filter':
          focusFilterInput();
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [paletteOpen, pathname, busy, scanMutation, navigate, currentScope]);

  return { paletteOpen, setPaletteOpen };
}
