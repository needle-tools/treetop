/**
 * Per-shell keystroke line buffer used by server.ts to assemble
 * command-history transcripts for Terminal columns. Lives in its own
 * module so test/shell-input.test.ts can exercise the function without
 * booting the full daemon (server.ts has top-level Bun.serve side
 * effects we don't want firing in tests).
 *
 * Buffer state is module-scoped — one buffer per termId. Callers must
 * use a unique termId per shell session.
 */

const buffers = new Map<string, string>();

/** Clear the buffer for a termId. Server.ts calls this when the PTY
 *  exits so we don't keep stale state for dead shells. */
export function clearShellInputBuffer(termId: string): void {
  buffers.delete(termId);
}

/** Feed a chunk of raw user keystrokes into the per-shell line buffer.
 *  Returns whatever complete Enter-terminated lines were produced.
 *
 *  Best-effort line editing: backspace pops the last char, Ctrl-C /
 *  Ctrl-D clear the current line, ESC-prefixed sequences (arrow keys
 *  etc.) are skipped entirely. We don't try to mirror full shell line-
 *  editing — history navigation will produce a buffer that's "wrong"
 *  until Enter, but the *final* Enter-flushed text is what the user
 *  actually ran. */
export function feedShellInput(termId: string, bytes: Uint8Array): string[] {
  let buf = buffers.get(termId) ?? "";
  const lines: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b === 0x1b) {
      // ESC <X> [params] <terminator> — skip the whole escape sequence
      // so arrow keys / function keys don't pollute the buffer.
      i++;
      if (i < bytes.length && (bytes[i] === 0x5b || bytes[i] === 0x4f)) {
        i++; // CSI '[' or SS3 'O'
        while (i < bytes.length && bytes[i]! < 0x40) i++; // params
        if (i < bytes.length) i++; // terminator
      } else if (i < bytes.length) {
        i++; // single-byte tail (ESC X)
      }
      continue;
    }
    if (b === 0x03 || b === 0x04) {
      buf = ""; // Ctrl-C / Ctrl-D — cancel current line
      i++;
      continue;
    }
    if (b === 0x7f || b === 0x08) {
      if (buf.length > 0) buf = buf.slice(0, -1); // backspace
      i++;
      continue;
    }
    if (b === 0x0d || b === 0x0a) {
      if (buf.trim().length > 0) lines.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (b >= 0x20) {
      // Printable byte (including UTF-8 continuation bytes). For non-
      // ASCII typing the byte-by-byte char codes may produce a slightly
      // garbled string in the log; acceptable for V1 since shell command
      // lines are overwhelmingly ASCII.
      buf += String.fromCharCode(b);
    }
    i++;
  }
  buffers.set(termId, buf);
  return lines;
}
