// Module-level focus registry (Task P, #25): the global `/` shortcut needs to
// focus the Code page's tree filter input from ANYWHERE in the app —
// including before it's even mounted, when the shortcut has to navigate to
// /code first (see hooks/use-global-shortcuts.ts's retry loop). A React ref
// created at the root can't reach across that "not mounted yet" gap, and
// threading a ref down through CodePage -> TreeView -> Input from the root
// layout would mean either prop-drilling it through a component that has no
// other reason to know about global shortcuts, or standing up a context
// provider for a single element reference. A module-level slot that
// TreeView's own input registers into (and clears on unmount) is the
// smaller surface, at the cost of only ever supporting one registrant —
// acceptable since exactly one Code tree can be mounted at a time.
let filterInputEl: HTMLInputElement | null = null;

// TreeView's search Input calls this as its `ref` callback — React invokes it
// with the element on mount and with `null` on unmount, so a navigation away
// from /code always clears the slot rather than leaving a stale, unmounted
// element behind for a later shortcut to "successfully" focus into nothing.
export function registerCodeTreeFilterInput(el: HTMLInputElement | null): void {
  filterInputEl = el;
}

// Returns whether an element was actually focused — the shortcut hook uses a
// false return to know the input isn't mounted yet and keep retrying.
export function focusCodeTreeFilter(): boolean {
  if (!filterInputEl) return false;
  filterInputEl.focus();
  filterInputEl.select();
  return true;
}
