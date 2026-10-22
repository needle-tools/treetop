import { NATIVE_WINDOW_FOCUS_EVENT } from "./window-focus-events";

/** Keep the active session's caret across app switches, without scrolling
 * its column or taking focus from a control the user clicked on return. */
export function installSessionWindowFocus(
  doc: Document = document,
  win: Window = window,
): () => void {
  let previous: HTMLElement | null = null;
  let away = false;
  let frame: number | null = null;
  let attempts = 0;

  function remember() {
    const active = doc.activeElement as HTMLElement | null;
    previous =
      active?.closest(".session-col") &&
      (active.matches("textarea, input") || active.isContentEditable)
        ? active
        : null;
  }
  function onFocusIn() {
    if (!away) remember();
  }
  function onBlur() {
    // Some webviews clear activeElement before the window blur event.
    // In that case retain the input recorded by focusin.
    if (doc.activeElement && doc.activeElement !== doc.body) remember();
    away = true;
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
  }
  function onFocus() {
    if (!away || frame !== null) return;
    attempts = 0;
    restore();
  }
  function restore() {
    frame = win.requestAnimationFrame(() => {
      frame = null;
      // The native host's activation event precedes WebView2's document
      // focus. Retry briefly instead of losing this activation after one frame.
      if (doc.hidden || !doc.hasFocus()) {
        if (++attempts < 30) restore();
        return;
      }
      away = false;
      const active = doc.activeElement;
      if (
        !previous?.isConnected ||
        previous.matches(":disabled") ||
        previous.getClientRects().length === 0 ||
        doc.querySelector("dialog[open], [aria-modal='true']") ||
        (active && active !== doc.body && active !== previous)
      )
        return;
      previous.focus({ preventScroll: true });
    });
  }
  function onVisibility() {
    if (doc.hidden) onBlur();
    else onFocus();
  }
  function onNativeFocus(event: Event) {
    const focused = (event as CustomEvent<{ focused: boolean }>).detail
      ?.focused;
    if (focused === false) onBlur();
    else if (focused === true) {
      // Native activation is authoritative even if the page missed blur.
      // Keep any newly focused control (search, menus, dialogs) untouched.
      if (previous && doc.activeElement === doc.body) away = true;
      onFocus();
    }
  }
  remember();
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("blur", onBlur);
  win.addEventListener("focus", onFocus);
  win.addEventListener(NATIVE_WINDOW_FOCUS_EVENT, onNativeFocus);
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("blur", onBlur);
    win.removeEventListener("focus", onFocus);
    win.removeEventListener(NATIVE_WINDOW_FOCUS_EVENT, onNativeFocus);
  };
}
