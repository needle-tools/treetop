/**
 * Decide how to put text on the system clipboard, robust to the
 * strict-Permissions contexts supergit actually runs in (electrobun's
 * WebView2 on Windows in particular).
 *
 * Why the ORDER matters — this is the whole point of the module:
 *
 * The async Clipboard API (`navigator.clipboard.writeText`) is the modern
 * path, but in WebView2 it can *exist yet silently reject* under strict
 * clipboard permissions. The legacy `execCommand("copy")` route (an
 * offscreen textarea) is the one WebView2 actually honors — BUT
 * `execCommand` only works synchronously, while the trusted user-gesture
 * call stack is still unwinding. So the synchronous copy MUST be attempted
 * FIRST. The old code wrote async-first and only reached `execCommand`
 * inside the promise's `.catch`; by then the gesture was over and
 * `execCommand` was denied too, so Ctrl+C-with-selection silently did
 * nothing in the native app. Trying the sync path first fixes that and is
 * harmless in normal browsers (execCommand-during-gesture works there too).
 */
export interface ClipboardWriteDeps {
  /** Synchronous, in-gesture copy (offscreen textarea + execCommand).
   *  Returns true on success. Runs while the trusted gesture is still on
   *  the stack, which is the only reason WebView2 honors it. */
  syncCopy: (text: string) => boolean;
  /** Async Clipboard API write, or null when unavailable (e.g. an insecure
   *  context where `navigator.clipboard` is undefined). */
  asyncWrite: ((text: string) => Promise<void>) | null;
  /** Surface a hard failure so a dropped copy isn't silent. */
  warn?: (message: string) => void;
}

/**
 * Decode the payload of an OSC 52 clipboard-write sequence
 * (`ESC ] 52 ; <selection> ; <base64> BEL`) into the text it carries.
 *
 * `data` is what xterm's OSC handler receives — everything after `52;`,
 * e.g. `"c;SGVsbG8="`. The first field is the selection target (c, p, …)
 * which we don't distinguish; the second is base64 of the UTF-8 bytes.
 *
 * Returns null for a read request (`<selection>;?`), an empty payload, or
 * malformed base64 — callers should skip the clipboard write in those cases
 * rather than overwrite the clipboard with junk. We deliberately ignore read
 * requests so a TUI can't exfiltrate the user's clipboard back over the PTY.
 */
export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(";");
  if (sep === -1) return null;
  const payload = data.slice(sep + 1);
  if (payload === "" || payload === "?") return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  // OSC 52 base64 wraps UTF-8 bytes; decode them back to a proper string so
  // non-ASCII (accents, emoji, box-drawing) survives the round-trip.
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function writeClipboard(text: string, deps: ClipboardWriteDeps): void {
  if (!text) return;
  // 1. In-gesture synchronous path first — the route WebView2 reliably
  //    honors, and it MUST run on the gesture stack (not a promise .catch).
  if (deps.syncCopy(text)) return;
  // 2. Fall back to the async Clipboard API (e.g. a context where
  //    execCommand is disabled but the modern API is granted).
  if (deps.asyncWrite) {
    deps.asyncWrite(text).catch(() =>
      deps.warn?.(
        "supergit: clipboard write failed via execCommand and async Clipboard API",
      ),
    );
    return;
  }
  deps.warn?.(
    "supergit: clipboard write failed (execCommand denied, no async Clipboard API)",
  );
}
