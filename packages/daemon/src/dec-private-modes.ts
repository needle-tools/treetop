/**
 * Per-PTY DEC private-mode state tracker — fixes modes lost on reattach.
 *
 * When a TUI column scrolls off-screen it unmounts; scrolling back mounts a
 * BRAND-NEW xterm that reattaches to the still-live PTY and replays only the
 * recent scrollback (REPLAY_CAP, node-pty-backend.ts). A TUI enables its DEC
 * private modes once, early — e.g. claude sends `\x1b[?2004h` (bracketed paste)
 * when its prompt first arms. That enable is almost always OUTSIDE the replayed
 * tail, so the fresh xterm never sees it and defaults the mode OFF. For
 * bracketed paste that means a multi-line paste executes at the first newline
 * instead of being inserted (issue #10). Same class of bug for application
 * cursor keys, mouse reporting, etc.
 *
 * Fix: watch the PTY output stream, remember the last on/off state of a curated
 * set of "sticky" private modes, and re-assert them to a client right after the
 * scrollback replay so a reattaching xterm restores them.
 *
 * This tracker only OBSERVES — it never rewrites the stream. Alt-screen and
 * cursor-save modes are deliberately NOT tracked: those interact with the
 * screen-content replay and re-asserting them could clear/scramble it.
 */

const ESC = 0x1b;
const LBRACKET = 0x5b; // [
const QUESTION = 0x3f; // ?
const SEMI = 0x3b; // ;
const SET_FINAL = 0x68; // h
const RESET_FINAL = 0x6c; // l
const ZERO = 0x30;
const NINE = 0x39;

// Private modes that are safe to re-assert and known to break on reattach.
// Excludes alt-screen (47/1047/1048/1049) and cursor save on purpose.
const TRACKED: ReadonlySet<number> = new Set([
  1, // DECCKM — application cursor keys
  7, // DECAWM — autowrap
  25, // DECTCEM — cursor visibility
  1000, // X10/normal mouse tracking
  1002, // button-event mouse tracking
  1003, // any-event mouse tracking
  1004, // focus reporting
  1006, // SGR extended mouse coordinates
  2004, // bracketed paste
]);

// A private mode CSI (`ESC [ ? <params> <final>`) is short; if one is split
// across a chunk boundary we carry at most this many bytes waiting for the
// rest, then give up (bounded so a malformed stream can't grow it unbounded).
const MAX_CARRY = 64;
const EMPTY = new Uint8Array(0);

function isParamByte(b: number): boolean {
  return (b >= ZERO && b <= NINE) || b === SEMI;
}

export class DecPrivateModeTracker {
  /** Last observed on/off state, keyed by mode number. Only modes actually
   *  seen in the stream appear here — we never invent a default. */
  private states = new Map<number, boolean>();
  private carry: Uint8Array = EMPTY;

  /** Feed one chunk of PTY output. Updates tracked mode state. */
  observe(chunk: Uint8Array): void {
    if (chunk.length === 0 && this.carry.length === 0) return;
    const buf =
      this.carry.length === 0
        ? chunk
        : concat(this.carry, chunk);
    this.carry = EMPTY;

    const n = buf.length;
    let i = 0;
    while (i < n) {
      if (buf[i] !== ESC) {
        i++;
        continue;
      }
      // Need `ESC [ ?` to be a private-mode CSI.
      if (i + 2 >= n) {
        // Not enough bytes to decide — carry the tail if it could still be one.
        if (couldBeginPrivateCsi(buf, i) && n - i <= MAX_CARRY)
          this.carry = buf.subarray(i);
        break;
      }
      if (buf[i + 1] !== LBRACKET || buf[i + 2] !== QUESTION) {
        i++;
        continue;
      }
      // Scan parameter bytes (digits + ';') after `ESC [ ?`.
      let j = i + 3;
      while (j < n && isParamByte(buf[j]!)) j++;
      if (j >= n) {
        // Final byte not arrived yet — carry the partial sequence if bounded.
        if (n - i <= MAX_CARRY) this.carry = buf.subarray(i);
        break;
      }
      const finalByte = buf[j]!;
      if (finalByte === SET_FINAL || finalByte === RESET_FINAL) {
        const set = finalByte === SET_FINAL;
        applyModes(this.states, buf, i + 3, j, set);
      }
      // Skip past this sequence (h/l, or any other final like `$p` queries).
      i = j + 1;
    }
  }

  /** Bytes that re-assert every tracked mode's current state, for replay to a
   *  freshly reattached client after the scrollback. Empty when nothing
   *  relevant has been seen. */
  reassertBytes(): Uint8Array {
    if (this.states.size === 0) return EMPTY;
    let s = "";
    for (const [mode, on] of this.states) {
      s += `\x1b[?${mode}${on ? "h" : "l"}`;
    }
    return new TextEncoder().encode(s);
  }

  /** Test/debug view of the current tracked state. */
  snapshot(): Record<number, boolean> {
    return Object.fromEntries(this.states);
  }
}

function couldBeginPrivateCsi(buf: Uint8Array, i: number): boolean {
  // ESC, or ESC [, possibly the start of `ESC [ ?` — worth carrying.
  if (buf[i] !== ESC) return false;
  if (i + 1 >= buf.length) return true;
  if (buf[i + 1] !== LBRACKET) return false;
  if (i + 2 >= buf.length) return true;
  return buf[i + 2] === QUESTION;
}

function applyModes(
  states: Map<number, boolean>,
  buf: Uint8Array,
  start: number,
  end: number,
  set: boolean,
): void {
  let mode = 0;
  let seenDigit = false;
  const commit = () => {
    if (seenDigit && TRACKED.has(mode)) states.set(mode, set);
    mode = 0;
    seenDigit = false;
  };
  for (let k = start; k < end; k++) {
    const b = buf[k]!;
    if (b === SEMI) {
      commit();
      continue;
    }
    mode = mode * 10 + (b - ZERO);
    seenDigit = true;
  }
  commit();
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
