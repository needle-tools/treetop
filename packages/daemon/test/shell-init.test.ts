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

  // Regression for the "every shell column ran in sh emulation" bug.
  // supergit wraps shell cmd[] through renameArgv() for argv[0]
  // rename (Activity Monitor visibility), producing
  //   ["bash", "-c", "exec -a 'supergit-tui-new-shell' '/bin/zsh' '-l'"]
  // The earlier isZshCmd only checked cmd[0] → saw "bash" → returned
  // false → skipped ZDOTDIR injection + history hardening. Worse: the
  // renamed argv[0] also made zsh fall back to sh emulation (no
  // ~/.zshrc, no zle, prompt is bare "$ ", history broken). The
  // detection MUST see through the wrapper or every later fix is
  // building on sand.
  test("matches zsh wrapped through `bash -c 'exec -a …'` (renameArgv)", () => {
    expect(
      isZshCmd([
        "bash",
        "-c",
        "exec -a 'supergit-tui-new-shell' '/bin/zsh' '-l'",
      ]),
    ).toBe(true);
    // Also when the inner shell is referred to by bare name with no
    // path (rare but valid — when PATH already covers it).
    expect(isZshCmd(["bash", "-c", "exec -a 'supergit-tui-x' zsh -l"])).toBe(
      true,
    );
    // Versioned binary inside the wrapper.
    expect(
      isZshCmd([
        "bash",
        "-c",
        "exec -a 'supergit-tui-x' /usr/local/bin/zsh-5.9 -l",
      ]),
    ).toBe(true);
  });

  test("does NOT mistake bash-wrapped non-zsh shells for zsh", () => {
    expect(
      isZshCmd(["bash", "-c", "exec -a 'supergit-tui-x' '/bin/bash' '-l'"]),
    ).toBe(false);
    expect(
      isZshCmd([
        "bash",
        "-c",
        "exec -a 'supergit-tui-x' '/opt/homebrew/bin/fish'",
      ]),
    ).toBe(false);
    // Bare words that LOOK like zsh-derivatives but aren't.
    expect(
      isZshCmd([
        "bash",
        "-c",
        "exec -a 'supergit-tui-x' '/usr/local/bin/mkzsh' '-l'",
      ]),
    ).toBe(false);
    expect(
      isZshCmd([
        "bash",
        "-c",
        "exec -a 'supergit-tui-x' '/usr/local/bin/zshare'",
      ]),
    ).toBe(false);
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
  // The snippet pins HISTFILE inside ZDOTDIR so each supergit column
  // gets its own per-PTY history. arrow-up then only surfaces commands
  // typed in this column's lineage (seeded from the JSONL on Resume),
  // never the user's global ~/.zsh_history. This was a deliberate
  // behavior change — the earlier snippet did the opposite (redirected
  // HISTFILE back to $HOME) because at the time we just wanted "arrow-up
  // works at all"; users asked for per-column scope instead.
  test("HISTFILE is pinned to a per-column file inside ZDOTDIR", () => {
    expect(ZSH_HISTORY_SNIPPET).toContain('HISTFILE="${ZDOTDIR}/.histfile"');
  });

  test("does NOT enable SHARE_HISTORY — columns are deliberately isolated", () => {
    expect(ZSH_HISTORY_SNIPPET).toContain("unsetopt SHARE_HISTORY");
    // Belt-and-braces: also assert we never SET it earlier in the snippet.
    // (?<![a-z]) avoids matching `unsetopt SHARE_HISTORY` further down.
    expect(ZSH_HISTORY_SNIPPET).not.toMatch(
      /(?<![a-z])setopt[^\n]*SHARE_HISTORY/,
    );
  });

  test("enables INC_APPEND_HISTORY + EXTENDED_HISTORY so every Enter flushes", () => {
    expect(ZSH_HISTORY_SNIPPET).toContain("INC_APPEND_HISTORY");
    expect(ZSH_HISTORY_SNIPPET).toContain("EXTENDED_HISTORY");
  });

  test("re-reads HISTFILE so the in-memory buffer reflects the seeded file", () => {
    // /etc/zshrc loads $HOME/.zsh_history into the in-memory buffer
    // BEFORE our snippet runs. Without an explicit `fc -R`, arrow-up
    // would still surface those global commands instead of our seeded
    // per-column ones.
    expect(ZSH_HISTORY_SNIPPET).toContain('fc -R "${HISTFILE}"');
  });

  test("HISTSIZE / SAVEHIST set high enough to retain typical chain across N resumes", () => {
    expect(ZSH_HISTORY_SNIPPET).toContain("HISTSIZE=10000");
    expect(ZSH_HISTORY_SNIPPET).toContain("SAVEHIST=10000");
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
      expect(rc).toContain('HISTFILE="${ZDOTDIR}/.histfile"');
    } finally {
      await cleanupZdotdir(dir);
    }
  });

  test("the rc sources the user .zshrc BEFORE applying our overrides", async () => {
    const dir = await makeZshZdotdir();
    try {
      const rc = await readFile(join(dir, ".zshrc"), "utf-8");
      const sourceIdx = rc.indexOf('source "$HOME/.zshrc"');
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

  // Regression guard: setting ZDOTDIR makes zsh skip $HOME/.zshenv
  // and $HOME/.zprofile entirely. On a typical macOS setup those
  // files hold PATH/FPATH and p10k instant-prompt setup; without
  // them the line editor renders a broken prompt and arrow keys /
  // inline echo stop working ("last letter on a new line" bug).
  // We MUST stub every startup file zsh looks at, each sourcing
  // its $HOME equivalent.
  test("writes .zshenv / .zprofile / .zlogin that source the $HOME equivalents", async () => {
    const dir = await makeZshZdotdir();
    try {
      for (const name of [".zshenv", ".zprofile", ".zlogin"]) {
        const path = join(dir, name);
        expect(existsSync(path)).toBe(true);
        const body = await readFile(path, "utf-8");
        expect(body).toContain(`source "$HOME/${name}"`);
        // Must be guarded — a fresh macOS user often has no
        // .zlogin; sourcing a missing file unconditionally would
        // raise.
        expect(body).toContain(`[[ -f "$HOME/${name}" ]]`);
      }
    } finally {
      await cleanupZdotdir(dir);
    }
  });

  describe("historyPreload (Resume seeding)", () => {
    test("no preload → no .histfile is written (fresh shell starts empty)", async () => {
      const dir = await makeZshZdotdir();
      try {
        expect(existsSync(join(dir, ".histfile"))).toBe(false);
      } finally {
        await cleanupZdotdir(dir);
      }
    });

    test("with preload → .histfile contains one line per command, in order", async () => {
      const dir = await makeZshZdotdir(["ls", "pwd", "echo hi"]);
      try {
        const path = join(dir, ".histfile");
        expect(existsSync(path)).toBe(true);
        const body = await readFile(path, "utf-8");
        // Plain "<cmd>\n" — zsh tolerates plain entries in a file that
        // EXTENDED_HISTORY then later appends to.
        expect(body).toBe("ls\npwd\necho hi\n");
      } finally {
        await cleanupZdotdir(dir);
      }
    });

    test("multi-line commands are flattened so each histfile entry stays single-line", async () => {
      // zsh's histfile format is one entry per line. A carried-over cmd
      // that somehow contains a literal newline would split into two
      // entries on read; flatten to a space so the chain stays intact.
      const dir = await makeZshZdotdir(["echo a\nb", "ls"]);
      try {
        const body = await readFile(join(dir, ".histfile"), "utf-8");
        expect(body).toBe("echo a b\nls\n");
      } finally {
        await cleanupZdotdir(dir);
      }
    });

    test("empty preload array → no .histfile written", async () => {
      const dir = await makeZshZdotdir([]);
      try {
        expect(existsSync(join(dir, ".histfile"))).toBe(false);
      } finally {
        await cleanupZdotdir(dir);
      }
    });
  });
});
