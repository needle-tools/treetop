/**
 * Unit tests for the zsh history-hardening shell-init module.
 *
 * The pure module is testable in isolation: detect whether a cmd[]
 * is zsh, build a temp ZDOTDIR with a properly-shaped .zshrc, and
 * clean it up. The integration that actually spawns a zsh PTY with
 * this ZDOTDIR lives in `terminals.test.ts` and is gated on zsh
 * being installed (CI's Ubuntu image doesn't ship zsh).
 */

import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isZshCmd,
  makeZshZdotdir,
  cleanupZdotdir,
  ZSH_HISTORY_SNIPPET,
} from "../src/terminals/shell-init";

describe("isZshCmd", () => {
  test("matches plain `zsh`", () => {
    expect(isZshCmd(["zsh"])).toBe(true);
    expect(isZshCmd(["zsh", "-l"])).toBe(true);
  });

  test("matches absolute zsh paths", () => {
    expect(isZshCmd(["/bin/zsh"])).toBe(true);
    expect(isZshCmd(["/usr/local/bin/zsh", "-l"])).toBe(true);
    expect(isZshCmd(["/opt/homebrew/bin/zsh"])).toBe(true);
  });

  test("matches versioned zsh binaries", () => {
    expect(isZshCmd(["/usr/local/bin/zsh-5.9"])).toBe(true);
    expect(isZshCmd(["zsh-5.8"])).toBe(true);
  });

  test("does NOT match other shells", () => {
    expect(isZshCmd(["bash"])).toBe(false);
    expect(isZshCmd(["/bin/bash", "-l"])).toBe(false);
    expect(isZshCmd(["fish"])).toBe(false);
    expect(isZshCmd(["sh"])).toBe(false);
    expect(isZshCmd(["dash"])).toBe(false);
  });

  test("does NOT match TUI agents that happen to have z in the name", () => {
    // Paranoia — `claude`, `codex` etc. must never trigger ZDOTDIR.
    expect(isZshCmd(["claude"])).toBe(false);
    expect(isZshCmd(["codex"])).toBe(false);
    expect(isZshCmd(["fuzzy"])).toBe(false);
  });

  test("handles empty / odd input safely", () => {
    expect(isZshCmd([])).toBe(false);
    expect(isZshCmd([""])).toBe(false);
  });
});

describe("ZSH_HISTORY_SNIPPET", () => {
  test("sets the three history options we care about", () => {
    expect(ZSH_HISTORY_SNIPPET).toContain("INC_APPEND_HISTORY");
    expect(ZSH_HISTORY_SNIPPET).toContain("SHARE_HISTORY");
    expect(ZSH_HISTORY_SNIPPET).toContain("EXTENDED_HISTORY");
  });

  test("guards every default with a [[ -z ]] / = 0 check", () => {
    // Each of HISTFILE/HISTSIZE/SAVEHIST must be set conditionally
    // so we never clobber an explicit user preference.
    for (const v of ["HISTFILE", "HISTSIZE", "SAVEHIST"]) {
      const re = new RegExp(`\\[\\[[^\\]]*${v}[^\\]]*\\]\\]`);
      expect(ZSH_HISTORY_SNIPPET).toMatch(re);
    }
  });

  test("uses zsh-safe parameter expansion (no unbound-var error under `setopt NO_UNSET`)", () => {
    // `${HISTFILE-}` defaults to empty if unset; bare `$HISTFILE`
    // would raise under NO_UNSET. We want the snippet to survive
    // strict shells.
    expect(ZSH_HISTORY_SNIPPET).toContain("${HISTFILE-}");
    expect(ZSH_HISTORY_SNIPPET).toContain("${HISTSIZE-}");
    expect(ZSH_HISTORY_SNIPPET).toContain("${SAVEHIST-}");
  });
});

describe("makeZshZdotdir / cleanupZdotdir", () => {
  test("creates a directory containing a .zshrc with the snippet", async () => {
    const dir = await makeZshZdotdir();
    try {
      expect(existsSync(dir)).toBe(true);
      const rcPath = join(dir, ".zshrc");
      expect(existsSync(rcPath)).toBe(true);
      const rc = await readFile(rcPath, "utf-8");
      // Sources the user's real ~/.zshrc first…
      expect(rc).toContain('source "$HOME/.zshrc"');
      // …then layers our snippet on top.
      expect(rc).toContain("INC_APPEND_HISTORY");
      expect(rc).toContain("SHARE_HISTORY");
    } finally {
      await cleanupZdotdir(dir);
    }
  });

  test("the rc sources the user .zshrc BEFORE applying our overrides", async () => {
    const dir = await makeZshZdotdir();
    try {
      const rc = await readFile(join(dir, ".zshrc"), "utf-8");
      const sourceIdx = rc.indexOf("source \"$HOME/.zshrc\"");
      const setoptIdx = rc.indexOf("setopt INC_APPEND_HISTORY");
      expect(sourceIdx).toBeGreaterThan(-1);
      expect(setoptIdx).toBeGreaterThan(-1);
      // Order matters: if our setopt ran first, the user's .zshrc
      // could clobber it. Source-then-override is the only safe
      // ordering.
      expect(setoptIdx).toBeGreaterThan(sourceIdx);
    } finally {
      await cleanupZdotdir(dir);
    }
  });

  test("each call returns a fresh, distinct directory", async () => {
    const a = await makeZshZdotdir();
    const b = await makeZshZdotdir();
    try {
      expect(a).not.toBe(b);
      expect(existsSync(a)).toBe(true);
      expect(existsSync(b)).toBe(true);
    } finally {
      await cleanupZdotdir(a);
      await cleanupZdotdir(b);
    }
  });

  test("cleanupZdotdir removes the directory", async () => {
    const dir = await makeZshZdotdir();
    expect(existsSync(dir)).toBe(true);
    await cleanupZdotdir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  test("cleanupZdotdir tolerates a missing directory (idempotent)", async () => {
    const dir = await makeZshZdotdir();
    await cleanupZdotdir(dir);
    // Second call must not throw.
    await expect(cleanupZdotdir(dir)).resolves.toBeUndefined();
  });
});
