import { NATIVE_WINDOW_FOCUS_EVENT } from "./window-focus-events";

/** Keep the active session's caret across app switches, without scrolling
 * its column or taking focus from a control the user clicked on return. */
export function installSessionWindowFocus(
  doc: Document = document,
  win: Window = window,
  options: {
    diagnostic?: (message: string, extra: Record<string, unknown>) => void;
  } = {},
): () => void {
  let previous: HTMLElement | null = null;
  let previousColumn: HTMLElement | null = null;
  let previousSource: string | undefined;
  let nativeRepair = false;
  let deadline = 0;
  let away = false;
  let frame: number | null = null;
  let attempts = 0;
  let lastRestoredAt = -Infinity;

  const neutral = (element: Element | null) =>
    !element || element === doc.body || element === doc.documentElement;
  function report(message: string) {
    options.diagnostic?.(`session focus ${message}`, {
      attempts,
      documentFocused: doc.hasFocus(),
      visible: !doc.hidden,
      activeTag: doc.activeElement?.tagName,
      inputConnected: previous?.isConnected ?? false,
      source: previousSource,
    });
  }
  function remember() {
    const active = doc.activeElement as HTMLElement | null;
    previous =
      active?.closest(".session-col") &&
      (active.matches("textarea, input") || active.isContentEditable)
        ? active
        : null;
    previousColumn = previous?.closest<HTMLElement>(".session-col") ?? null;
    previousSource = previousColumn?.dataset.sessionSource;
  }
  function onFocusIn() {
    if (!away) remember();
  }
  function onBlur() {
    lastRestoredAt = -Infinity;
    // Some webviews clear activeElement before the window blur event.
    // In that case retain the input recorded by focusin.
    if (!neutral(doc.activeElement)) remember();
    away = true;
    report("window left");
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
  }
  function onFocus() {
    if (!away || frame !== null) return;
    attempts = 0;
    deadline = Date.now() + 3000;
    restore();
  }
  function restore() {
    frame = win.requestAnimationFrame(() => {
      frame = null;
      // The native host's activation event precedes WebView2's document
      // focus. Retry briefly instead of losing this activation after one frame.
      if (doc.hidden || !doc.hasFocus()) {
        ++attempts;
        if (Date.now() < deadline) restore();
        else report("document not ready");
        return;
      }
      away = false;
      const active = doc.activeElement;
      if (!neutral(active) && active !== previous) {
        report("kept another control");
        nativeRepair = false;
        return;
      }
      if (previous && !previous.isConnected) {
        const column = previousColumn?.isConnected
          ? previousColumn
          : previousSource
            ? doc.querySelector<HTMLElement>(
                `.session-col[data-session-source="${CSS.escape(previousSource)}"]`,
              )
            : null;
        const selector = previous.id
          ? `#${CSS.escape(previous.id)}`
          : previous.matches(".xterm-helper-textarea")
            ? ".xterm-helper-textarea"
            : previous.isContentEditable
              ? "[contenteditable='true']"
              : previous.tagName.toLowerCase();
        previous = column?.querySelector<HTMLElement>(selector) ?? null;
      }
      if (
        !previous?.isConnected ||
        previous.matches(":disabled") ||
        previous.getClientRects().length === 0 ||
        doc.querySelector("dialog[open], [aria-modal='true']")
      ) {
        report("no available session input");
        nativeRepair = false;
        return;
      }
      // WebView2 may retain DOM activeElement while dropping native keyboard
      // routing. A blur/focus edge also repairs xterm's cached focus state.
      if (nativeRepair && doc.activeElement === previous) previous.blur();
      previous.focus({ preventScroll: true });
      if (doc.activeElement === previous) lastRestoredAt = Date.now();
      report(doc.activeElement === previous ? "restored" : "restore failed");
      nativeRepair = false;
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
      // The native notification commonly follows ordinary window focus by
      // ~280ms. Do not cycle an already-restored caret a second time while
      // the user starts typing. A real blur or missing DOM focus still repairs.
      if (!away && doc.hasFocus() && doc.activeElement === previous && Date.now() - lastRestoredAt < 1000) return;
      // Native activation is authoritative even if the page missed blur.
      // Keep any newly focused control (search, menus, dialogs) untouched.
      nativeRepair = true;
      if (
        previous &&
        (neutral(doc.activeElement) || doc.activeElement === previous)
      )
        away = true;
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
