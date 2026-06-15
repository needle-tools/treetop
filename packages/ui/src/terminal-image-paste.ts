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
