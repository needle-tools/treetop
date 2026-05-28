import { test, expect, describe } from "bun:test";
import {
  UserBoxRemap,
  CLAUDE_USER_BOX_THEME,
  CLAUDE_USER_BOX_COLORS,
  parseHex,
  hexToSgr,
  themeFromColors,
  type UserBoxTheme,
} from "../src/terminals/sgr-remap";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const ESC = "\x1b";

/** Run a list of string chunks through one remap instance and return the
 *  concatenated decoded output. Mirrors how the backend feeds successive
 *  `data` events into a single per-terminal filter. */
function pipe(theme: UserBoxTheme, ...chunks: string[]): string {
  const r = new UserBoxRemap(theme);
  let out = "";
  for (const c of chunks) out += dec(r.transform(enc(c)));
  return out;
}

// A tiny synthetic theme so the assertions don't hinge on the exact
// placeholder hexes shipped in CLAUDE_USER_BOX_THEME (those get tuned
// later). Same shape as the real one.
const T: UserBoxTheme = {
  open: "48;2;55;55;55",
  openTo: "48;2;1;2;3",
  close: ["49", "0", ""],
  inner: {
    "38;2;80;80;80": "38;2;9;9;9", // chevron
    "38;2;255;255;255": "38;2;7;7;7", // text
  },
};

describe("UserBoxRemap", () => {
  test("recolors the box background opener", () => {
    const out = pipe(T, `${ESC}[48;2;55;55;55mhi${ESC}[49m`);
    expect(out).toContain(`${ESC}[48;2;1;2;3m`);
    expect(out).not.toContain(`${ESC}[48;2;55;55;55m`);
  });

  test("recolors chevron + text while inside the box", () => {
    // The exact byte layout Claude emits for a submitted user message.
    const line =
      `${ESC}[48;2;55;55;55m${ESC}[38;2;80;80;80m❯ ` +
      `${ESC}[38;2;255;255;255mhi there${ESC}[39m   ${ESC}[49m`;
    const out = pipe(T, line);
    expect(out).toContain(`${ESC}[38;2;9;9;9m`); // chevron remapped
    expect(out).toContain(`${ESC}[38;2;7;7;7m`); // text remapped
    expect(out).toContain("❯ "); // chevron glyph preserved
    expect(out).toContain("hi there"); // message text preserved
  });

  test("does NOT recolor the same fg codes outside the box", () => {
    // White + dim-gray fg with no preceding box background → untouched.
    const line = `${ESC}[38;2;255;255;255mwhite${ESC}[38;2;80;80;80mdim`;
    const out = pipe(T, line);
    expect(out).toBe(line);
  });

  test("stops remapping after the box closes (bg reset)", () => {
    const line =
      `${ESC}[48;2;55;55;55mbox${ESC}[49m` + // box opens + closes
      `${ESC}[38;2;255;255;255mafter`; // white AFTER close must survive
    const out = pipe(T, line);
    expect(out).toContain(`${ESC}[38;2;255;255;255mafter`);
  });

  test("handles an escape split across two chunks", () => {
    // Split mid-parameter: "\x1b[48;2;5" | "5;55;55m..."
    const out = pipe(T, `${ESC}[48;2;5`, `5;55;55mhi${ESC}[49m`);
    expect(out).toContain(`${ESC}[48;2;1;2;3m`);
    expect(out).not.toContain(`${ESC}[48;2;55;55;55m`);
    expect(out).toContain("hi");
  });

  test("split at the very ESC boundary", () => {
    const out = pipe(T, `${ESC}`, `[48;2;55;55;55mx${ESC}[49m`);
    expect(out).toContain(`${ESC}[48;2;1;2;3m`);
  });

  test("passes through unrelated CSI, plain text and UTF-8 untouched", () => {
    const line = `${ESC}[2J${ESC}[1;1Hplain ❯ text ${ESC}[31mred${ESC}[0m`;
    const out = pipe(T, line);
    expect(out).toBe(line);
  });

  test("full reset (ESC[0m) closes the box", () => {
    const line = `${ESC}[48;2;55;55;55mbox${ESC}[0m${ESC}[38;2;255;255;255mafter`;
    const out = pipe(T, line);
    expect(out).toContain(`${ESC}[38;2;255;255;255mafter`); // not remapped
  });

  test("parseHex accepts #rrggbb, #rgb and bare forms", () => {
    expect(parseHex("#373737")).toEqual([55, 55, 55]);
    expect(parseHex("373737")).toEqual([55, 55, 55]);
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(() => parseHex("#xyz123")).toThrow();
    expect(() => parseHex("#12")).toThrow();
  });

  test("hexToSgr emits fg/bg truecolour params", () => {
    expect(hexToSgr("#373737", "bg")).toBe("48;2;55;55;55");
    expect(hexToSgr("#ffffff", "fg")).toBe("38;2;255;255;255");
  });

  test("themeFromColors builds match keys from the captured hexes", () => {
    const theme = themeFromColors(CLAUDE_USER_BOX_COLORS);
    // Match keys must equal what Claude actually emits.
    expect(theme.open).toBe("48;2;55;55;55"); // #373737
    expect(theme.inner["38;2;80;80;80"]).toBeDefined(); // #505050 chevron
    expect(theme.inner["38;2;255;255;255"]).toBeDefined(); // #ffffff text
  });

  test("editing a replacement hex flows through to the remap", () => {
    const theme = themeFromColors({
      ...CLAUDE_USER_BOX_COLORS,
      background: "#ff0000",
    });
    const out = dec(
      new UserBoxRemap(theme).transform(enc(`${ESC}[48;2;55;55;55mx${ESC}[49m`)),
    );
    expect(out).toContain(`${ESC}[48;2;255;0;0m`); // #ff0000
  });

  test("ships a real Claude theme matching the captured sequence", () => {
    expect(CLAUDE_USER_BOX_THEME.open).toBe("48;2;55;55;55");
    expect(CLAUDE_USER_BOX_THEME.inner["38;2;255;255;255"]).toBeDefined();
    expect(CLAUDE_USER_BOX_THEME.inner["38;2;80;80;80"]).toBeDefined();
    // The opener must actually change (otherwise the box wouldn't pop).
    expect(CLAUDE_USER_BOX_THEME.openTo).not.toBe(CLAUDE_USER_BOX_THEME.open);
  });
});
