/**
 * Decide how an image paste into a TUI column should be delivered.
 *
 * Two delivery paths exist (see TerminalView's doClipboardPaste / onPaste):
 *
 *   - "direct"     — forward a native paste keystroke (0x16) into the PTY and
 *                    let the app read the image bytes off the OS clipboard
 *                    itself. Codex's TUI does this; the raw image lands in the
 *                    prompt with no temp file.
 *   - "attachment" — supergit resizes the image, saves it via /api/attach, and
 *                    types the saved file path into the PTY. Works in any TUI
 *                    that accepts a path argument.
 *
 * Claude's TUI ignores the forwarded paste keystroke (it does not read images
 * from the OS clipboard), so "direct" is a no-op there — the user presses
 * Ctrl+V and nothing happens. Hence the "auto" default: pick "direct" only for
 * agents known to read clipboard bytes (codex), and "attachment" for everyone
 * else (claude, copilot, ollama, plain shells, unknown). The agent is the
 * authoritative session kind threaded down from SessionView/NewSessionCol — we
 * never sniff it from the spawn argv.
 */

export type ImagePasteBehavior = "direct" | "attachment";
export type ImagePasteSetting = "auto" | ImagePasteBehavior;

/** Agents whose TUI reads image bytes from the OS clipboard on a paste key. */
const DIRECT_PASTE_AGENTS = new Set(["codex"]);

export function resolveImagePasteBehavior(
  setting: string | undefined,
  agent: string | undefined,
): ImagePasteBehavior {
  // Explicit user overrides win over the per-agent auto choice.
  if (setting === "direct" || setting === "attachment") return setting;
  return agent && DIRECT_PASTE_AGENTS.has(agent) ? "direct" : "attachment";
}

// ---------------------------------------------------------------------------
// Large text-paste throttling
//
// Pasting a big blob (e.g. a whole JSON response) into a TUI used to dump the
// entire string into the PTY in one `xterm.paste()` write. A TUI that drains
// its input slower than the bytes arrive overflows the kernel pty input buffer,
// which silently DROPS the overflow — the user sees a truncated paste. supergit
// already throttles the note-attachment paste path (pasteChunks, one chunk at a
// time); these helpers extend the same idea to plain text so a single big paste
// is split into modest chunks the receiver can keep up with. Small pastes stay
// on the untouched single-shot fast path.
// ---------------------------------------------------------------------------

/** Above this many Unicode code points, a text paste is chunked + throttled
 *  instead of written in one shot. Below it, nothing changes. */
export const PASTE_THROTTLE_THRESHOLD_CODEPOINTS = 8_192;
/** Code points per throttled chunk. */
export const PASTE_CHUNK_CODEPOINTS = 2_048;
/** Delay between throttled chunks, giving the PTY time to drain. */
export const PASTE_CHUNK_DELAY_MS = 8;

/** Whether a text paste is large enough to need chunked, throttled delivery.
 *  Counts code points (not UTF-16 units) so a wall of emoji isn't double
 *  counted against the threshold. */
export function shouldThrottlePaste(
  text: string,
  threshold = PASTE_THROTTLE_THRESHOLD_CODEPOINTS,
): boolean {
  return countCodePoints(text) > threshold;
}

/** Split text into chunks of at most `chunkSize` code points. Splitting on
 *  code-point (not UTF-16) boundaries guarantees a surrogate pair is never
 *  cut in half — a lone surrogate would encode to U+FFFD and corrupt the
 *  paste. `chunks.join("")` always reconstructs the original exactly. */
export function chunkPasteBody(
  text: string,
  chunkSize = PASTE_CHUNK_CODEPOINTS,
): string[] {
  if (!text) return [];
  if (chunkSize <= 0) return [text];
  const cps = Array.from(text); // iterates by code point
  if (cps.length <= chunkSize) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < cps.length; i += chunkSize) {
    chunks.push(cps.slice(i, i + chunkSize).join(""));
  }
  return chunks;
}

function countCodePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}
