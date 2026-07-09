/**
 * Decide whether a Terminal column should grab focus when its WebSocket opens.
 *
 * A column autofocuses on WS-open so a freshly-mounted or Resumed terminal
 * takes keystrokes without a manual click (TerminalView's ws.onopen "autofocus
 * contract"). The problem: that same path also runs when a BACKGROUND column
 * reconnects, or a new one scrolls into view / spawns — and there it stole
 * focus out from under whoever was typing in another TUI or an input. This gate
 * keeps the convenience while refusing to yank an active caret away.
 *
 * Pure so the truth table is unit-testable; the DOM reads (document.activeElement,
 * containerEl.contains, tagName/isContentEditable) happen in the component.
 */
export interface AutofocusOnOpenState {
  /** Nothing meaningful holds focus (no active element, or it's <body>). */
  activeIsBodyOrNull: boolean;
  /** The focused element is already inside THIS terminal's container. */
  activeIsWithinThisTerminal: boolean;
  /** The focused element is a text-entry target (textarea / input /
   *  contenteditable) — i.e. someone is actively typing somewhere. */
  activeIsTextEntry: boolean;
}

export function shouldAutofocusOnWsOpen(state: AutofocusOnOpenState): boolean {
  // Nothing to steal from — this is exactly the Resume / fresh-mount case the
  // autofocus contract exists for.
  if (state.activeIsBodyOrNull) return true;
  // Already us (a reconnect while the user types here) — re-focus is a no-op.
  if (state.activeIsWithinThisTerminal) return true;
  // Something else is focused: only yield to a genuine text-entry target
  // (another TUI's textarea, a composer input, a search box). An incidental
  // focus on a button/div shouldn't block the autofocus contract.
  return !state.activeIsTextEntry;
}
