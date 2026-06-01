/**
 * Restore the page's saved vertical scroll position on reload — but only
 * if the user hasn't already taken over.
 *
 * On a reload the dashboard repaints from scrollTop=0, then repos stream
 * in and rows grow over several frames. Scrolling immediately would land
 * on a half-laid-out page (the saved offset doesn't exist yet). So the
 * caller waits until repos have loaded and then arms this with a short
 * extra `delayMs` for the rows to settle.
 *
 * But a person who reloads and *immediately* starts scrolling shouldn't be
 * yanked back to where they were last time — that's the most jarring
 * possible behavior. So any user-initiated scroll (wheel / touch / arrow
 * keys) during the delay window aborts the restore entirely.
 *
 * The timer and the user-scroll subscription are injected so the
 * abort-vs-fire contract is unit-testable without a DOM or real timers.
 */
import { type CoalescerTimer } from "./terminal-resize";

export interface ScrollRestoreEnv {
  /** Injectable timer (same shape the resize coalescer uses). */
  timer: CoalescerTimer;
  /** Imperatively scroll the page to vertical offset `y`. */
  scrollTo: (y: number) => void;
  /** Subscribe to a user-initiated scroll intent. Returns an unsubscribe
   *  fn; the restorer treats any emission before the timer fires as the
   *  user having taken over. */
  onUserScroll: (cb: () => void) => () => void;
}

/**
 * Arm a one-shot scroll restore. Returns a cancel fn (call on teardown)
 * that drops a still-pending restore. After the restore fires or aborts,
 * both cancel() and a late user scroll are harmless no-ops.
 */
export function restoreScrollAfterDelay(
  target: number,
  delayMs: number,
  env: ScrollRestoreEnv,
): () => void {
  let settled = false;
  // `unsub` and `handle` are assigned below but referenced inside the two
  // callbacks. Declare them up front (not `const` after the subscription):
  // if env.onUserScroll fires its callback SYNCHRONOUSLY during subscribe
  // — or the timer fires synchronously — a later `const` would be in its
  // temporal dead zone ("Cannot access … before initialization", which is
  // exactly the crash this caused once minified). Pre-declaring makes the
  // order-of-execution safe regardless of how the injected env behaves.
  let unsub: () => void = () => {};
  let handle: ReturnType<CoalescerTimer["set"]> | undefined;
  unsub = env.onUserScroll(() => {
    if (settled) return; // restore already fired — user scroll is normal now
    settled = true;
    if (handle !== undefined) env.timer.clear(handle);
    unsub();
  });
  handle = env.timer.set(() => {
    if (settled) return;
    settled = true;
    unsub();
    env.scrollTo(target);
  }, delayMs);
  return () => {
    if (settled) return;
    settled = true;
    if (handle !== undefined) env.timer.clear(handle);
    unsub();
  };
}
