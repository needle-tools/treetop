/**
 * Per-terminal byte-stream filter that recolours an agent TUI's
 * "user message" box so the user's own turns stand out against the
 * assistant text.
 *
 * Why this lives in the daemon and not in xterm's theme: Claude Code
 * (and Codex) paint their UI with 24-bit truecolour SGR sequences
 * (`\x1b[48;2;R;G;Bm`), NOT the 16-colour indexed palette. xterm.js
 * renders truecolour cells verbatim, so the `theme` object in
 * TerminalView.svelte can't touch them. The only reliable lever is to
 * rewrite the bytes in the PTY stream before they reach the buffer and
 * the clients — which is what this does.
 *
 * Captured from Claude Code (2026-05) for a submitted user message:
 *
 *   \x1b[48;2;55;55;55m   box background  #373737
 *   \x1b[38;2;80;80;80m    "❯ " chevron    #505050
 *   \x1b[38;2;255;255;255m message text    #ffffff
 *   …text…  \x1b[39m  …padding…  \x1b[49m   ← bg reset closes the box
 *
 * The white text fg (#ffffff) is reused all over the TUI, so we can't
 * remap it globally. Instead this is a small state machine bracketed by
 * the box's background-set (`open`) and background-reset (`close`): the
 * inner fg remaps fire ONLY while we're inside the box, so identical fg
 * codes elsewhere are left alone.
 *
 * Robustness: operates on raw bytes (never UTF-8-decodes, so multibyte
 * glyphs like `❯` and box-drawing chars pass through untouched) and
 * carries a partial trailing CSI across chunk boundaries — PTY output
 * splits escape sequences at arbitrary byte offsets.
 */

export interface UserBoxTheme {
  /** SGR parameter string that opens the box (sets its background). */
  open: string;
  /** Replacement parameters for `open` — the new, punchier background. */
  openTo: string;
  /** SGR params that close the box (reset the background). Matching any
   *  of these clears the in-box state. Typically the bg-reset (`49`),
   *  the full reset (`0`) and the empty reset (`` ` `` `m`). */
  close: string[];
  /** While inside the box, remap these fg parameter strings to their
   *  replacements. Keys are exact SGR param strings (e.g. the chevron
   *  and the message text). */
  inner: Record<string, string>;
}

/**
 * Editable colour config for Claude's user-message box, as plain hex
 * strings. Two groups:
 *
 *   match* — what Claude *currently emits*. These are how we FIND the box
 *            in the stream, so they must equal Claude's real colours.
 *            If a Claude update changes its theme, re-capture and update
 *            these (the box would simply stop being recoloured until then,
 *            never break).
 *
 *   background / chevron / text — the punchier REPLACEMENTS. ← EDIT THESE.
 *
 * Accepts `#rrggbb` or `#rgb` (with or without the leading `#`).
 */
export interface UserBoxColors {
  matchBackground: string;
  matchChevron: string;
  matchText: string;
  background: string;
  chevron: string;
  text: string;
}

export const CLAUDE_USER_BOX_COLORS: UserBoxColors = {
  // ─── what Claude emits today (the match keys — re-capture if retheme) ───
  matchBackground: "#373737",
  matchChevron: "#505050",
  matchText: "#ffffff",
  // ─── EDIT THESE: the punchier replacement colours ───
  background: "#e6ffbd", // box background  (placeholder brand-green tint)
  chevron: "#d0ff00", // "❯" chevron     (placeholder brand green)
  text: "#000000", // message text    (placeholder)
};

/** Parse `#rrggbb` / `#rgb` (leading `#` optional) → `[r, g, b]`. */
export function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`invalid hex colour: ${hex}`);
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Hex → an SGR parameter string. `kind` picks foreground (`38`) vs
 *  background (`48`) truecolour. */
export function hexToSgr(hex: string, kind: "fg" | "bg"): string {
  const [r, g, b] = parseHex(hex);
  return `${kind === "bg" ? "48" : "38"};2;${r};${g};${b}`;
}

/** Build the low-level remap theme (raw SGR param strings) from an
 *  editable hex config. */
export function themeFromColors(c: UserBoxColors): UserBoxTheme {
  return {
    open: hexToSgr(c.matchBackground, "bg"),
    openTo: hexToSgr(c.background, "bg"),
    close: ["49", "0", ""],
    inner: {
      [hexToSgr(c.matchChevron, "fg")]: hexToSgr(c.chevron, "fg"),
      [hexToSgr(c.matchText, "fg")]: hexToSgr(c.text, "fg"),
    },
  };
}

export const CLAUDE_USER_BOX_THEME: UserBoxTheme =
  themeFromColors(CLAUDE_USER_BOX_COLORS);

/** Pick a readable text colour (`#1a1a1a` or `#ffffff`) for a given
 *  background, via OKLab lightness. Mirrors the UI's `repoChipFg()` so a
 *  repo-coloured box reads the same as that repo's chip: dark text on
 *  light repo colours, light text on dark ones. */
export function pickReadableFg(hex: string): string {
  let r8: number, g8: number, b8: number;
  try {
    [r8, g8, b8] = parseHex(hex).map((c) => c / 255) as [
      number,
      number,
      number,
    ];
  } catch {
    return "#ffffff";
  }
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);
  const lL = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const mL = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const sL = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const L =
    0.2104542553 * Math.cbrt(lL) +
    0.793617785 * Math.cbrt(mL) -
    0.0040720468 * Math.cbrt(sL);
  return L >= 0.6 ? "#1a1a1a" : "#ffffff";
}

/** Build a user-box theme that paints the box in a repo's accent colour
 *  (bold/direct) with auto-contrast text + chevron — so a TUI's user
 *  turns visually match the repo they belong to. The match keys stay
 *  Claude's real emitted colours; only the replacements are repo-driven. */
export function themeFromRepoColor(repoColor: string): UserBoxTheme {
  const fg = pickReadableFg(repoColor);
  return themeFromColors({
    matchBackground: CLAUDE_USER_BOX_COLORS.matchBackground,
    matchChevron: CLAUDE_USER_BOX_COLORS.matchChevron,
    matchText: CLAUDE_USER_BOX_COLORS.matchText,
    background: repoColor,
    chevron: fg,
    text: fg,
  });
}

const ESC = 0x1b;
const LBRACKET = 0x5b; // '['
const SGR_FINAL = 0x6d; // 'm'
/** A CSI ends on a byte in the 0x40–0x7e range ("@" … "~"). */
const isCsiFinal = (b: number) => b >= 0x40 && b <= 0x7e;
/** Cap the carry so a never-terminating ESC can't grow unbounded. */
const MAX_CARRY = 64;
const EMPTY = new Uint8Array(0);
const te = new TextEncoder();

export class UserBoxRemap {
  private carry: Uint8Array = EMPTY;
  private inBox = false;

  constructor(private theme: UserBoxTheme) {}

  /** Transform one chunk of PTY output. Returns the (possibly rewritten)
   *  bytes to forward; any partial trailing escape is held internally and
   *  prepended to the next call. */
  transform(chunk: Uint8Array): Uint8Array {
    const buf =
      this.carry.length === 0 ? chunk : concat(this.carry, chunk);
    this.carry = EMPTY;

    const out: number[] = [];
    let i = 0;
    const n = buf.length;

    while (i < n) {
      const b = buf[i]!;
      if (b !== ESC) {
        out.push(b);
        i++;
        continue;
      }
      // We're at ESC. Need the next byte to know if it's a CSI.
      if (i + 1 >= n) {
        // ESC is the last byte — could begin a CSI next chunk. Carry it.
        this.carry = buf.subarray(i);
        break;
      }
      if (buf[i + 1] !== LBRACKET) {
        // Not a CSI (OSC, charset switch, etc.) — emit ESC and let the
        // following bytes pass through normally.
        out.push(b);
        i++;
        continue;
      }
      // CSI: scan for the final byte.
      let j = i + 2;
      while (j < n && !isCsiFinal(buf[j]!)) j++;
      if (j >= n) {
        // Final byte hasn't arrived yet — carry the partial CSI, unless
        // it's grown implausibly long (then flush it to stay bounded).
        const partial = buf.subarray(i);
        if (partial.length <= MAX_CARRY) {
          this.carry = partial;
          break;
        }
        for (let k = i; k < n; k++) out.push(buf[k]!);
        i = n;
        break;
      }
      const finalByte = buf[j]!;
      if (finalByte !== SGR_FINAL) {
        // Some other CSI (cursor move, clear, …) — pass through verbatim.
        for (let k = i; k <= j; k++) out.push(buf[k]!);
        i = j + 1;
        continue;
      }
      // It's an SGR. Decode just the parameter bytes (pure ASCII).
      const params = asciiSlice(buf, i + 2, j);
      const replacement = this.remapParams(params);
      pushAscii(out, `\x1b[${replacement}m`);
      i = j + 1;
    }

    return Uint8Array.from(out);
  }

  /** Decide the SGR parameters to emit given the current in-box state,
   *  updating that state as a side effect. */
  private remapParams(params: string): string {
    if (params === this.theme.open) {
      this.inBox = true;
      return this.theme.openTo;
    }
    if (this.theme.close.includes(params)) {
      this.inBox = false;
      return params;
    }
    if (this.inBox && this.theme.inner[params] !== undefined) {
      return this.theme.inner[params]!;
    }
    return params;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Decode an ASCII-only byte range to a string. SGR parameters are
 *  always digits and ';' so this never sees multibyte input. */
function asciiSlice(buf: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let k = start; k < end; k++) s += String.fromCharCode(buf[k]!);
  return s;
}

function pushAscii(out: number[], s: string) {
  const bytes = te.encode(s);
  for (let k = 0; k < bytes.length; k++) out.push(bytes[k]!);
}
