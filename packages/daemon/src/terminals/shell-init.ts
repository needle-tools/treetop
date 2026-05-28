/**
 * Shell-init helpers for PTYs supergit spawns.
 *
 * Right now this is just zsh history hardening: when we spawn the
 * user's login shell for a `terminal` column, we set up a temp
 * `ZDOTDIR` whose `.zshrc` sources the user's real `~/.zshrc` and
 * then forces sane history options. The user keeps all their normal
 * config; we just guarantee three things on top:
 *
 *   1. `HISTFILE` / `HISTSIZE` / `SAVEHIST` are set to reasonable
 *      values if the user hasn't set them (stock macOS leaves
 *      HISTSIZE=10 / SAVEHIST=0 → arrow-up shows nothing).
 *   2. `INC_APPEND_HISTORY` — every command is appended to the
 *      histfile immediately, not on shell exit. This matters
 *      because supergit's PTY can be killed mid-session (browser
 *      tab closed, helper restart) and the default "flush on exit"
 *      behavior would lose every command typed in that column.
 *   3. `SHARE_HISTORY` — arrow-up in one supergit shell column
 *      sees commands typed in another column. Matches what users
 *      expect from a "dashboard with many terminals" UX.
 *
 * bash / fish / pwsh: not handled. bash needs a `--rcfile` trick;
 * fish persists history automatically; PSReadLine on PowerShell
 * persists by default. Future work.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Heredoc-style snippet appended to the user's .zshrc when supergit
 *  spawns a zsh shell. Force HISTFILE to a per-column file inside
 *  ZDOTDIR so arrow-up only surfaces commands typed in *this* column's
 *  lineage (seeded from the JSONL carry-over on Resume), never the
 *  user's global ~/.zsh_history. INC_APPEND_HISTORY + EXTENDED_HISTORY
 *  keep each Enter-flushed line in the file. SHARE_HISTORY is OFF —
 *  two supergit columns deliberately don't bleed history into each
 *  other. The user's global history file is left untouched. */
export const ZSH_HISTORY_SNIPPET = `# supergit: per-column HISTFILE so arrow-up surfaces only the commands
# typed in this column's lineage (seeded from the JSONL on Resume).
# The user's ~/.zsh_history is intentionally NOT read here — supergit
# columns are their own scope, never written through.
HISTFILE="\${ZDOTDIR}/.histfile"
HISTSIZE=10000
SAVEHIST=10000
setopt INC_APPEND_HISTORY EXTENDED_HISTORY
unsetopt SHARE_HISTORY
# Re-read HISTFILE after we've overridden it. /etc/zshrc loaded the
# user's global history earlier; without an explicit re-read the in-
# memory buffer still reflects that. -R re-reads from our seeded file
# so arrow-up matches what's on disk.
fc -P 2>/dev/null
fc -R "\${HISTFILE}" 2>/dev/null
`;

/** True when the cmd[] supergit is about to spawn is a zsh shell.
 *  Matches `zsh`, `/bin/zsh`, `/usr/local/bin/zsh-5.9`. Does NOT
 *  match bash/fish/sh/dash — those use other init mechanisms.
 *
 *  Also matches the renameArgv() wrapped form:
 *    ["bash", "-c", "exec -a 'name' '/bin/zsh' '-l'"]
 *  because the daemon wraps shell PTYs through `bash -c 'exec -a …'`
 *  for argv[0] rename, which would otherwise hide the fact that the
 *  inner binary is zsh and skip our ZDOTDIR + history-hardening
 *  injection. Heuristic: cmd[0] is bash/sh and the third element
 *  references `/bin/zsh`, `'/bin/zsh'`, or a bare `zsh` token. */
export function isZshCmd(cmd: readonly string[]): boolean {
  if (!cmd.length) return false;
  const base = basename(cmd[0] ?? "");
  if (base === "zsh" || /^zsh-\d/.test(base)) return true;
  // Wrapped form: `bash -c "exec -a NAME '/path/to/zsh' …"`. The
  // third arg is the script body; look for a zsh executable
  // reference inside it. Conservative regex: a path or bare word
  // ending in zsh, optionally version-suffixed, bounded by quote
  // or whitespace so we don't match e.g. `mkzsh` or `zshare`.
  if (
    (base === "bash" || base === "sh") &&
    cmd[1] === "-c" &&
    typeof cmd[2] === "string"
  ) {
    if (/(?:^|[\s'"/])zsh(?:-\d[\d.]*)?(?:['"\s]|$)/.test(cmd[2])) return true;
  }
  return false;
}

/** Build a temp ZDOTDIR for a zsh PTY. Why all four files: when
 *  `ZDOTDIR` is set, zsh sources `$ZDOTDIR/.zshenv|.zprofile|.zshrc|
 *  .zlogin` *instead of* the `$HOME/` versions. So a temp dir
 *  containing only `.zshrc` makes zsh skip the user's `.zshenv`
 *  entirely — and on a typical macOS setup `.zshenv` is where
 *  `PATH`, `FPATH`, p10k instant-prompt, and other env-only setup
 *  live. Without it, the line editor (zle) renders a broken prompt
 *  that miscounts width → arrow keys and inline echo stop working.
 *
 *  Each file in our temp dir is a one-liner that sources the
 *  `$HOME/` equivalent if it exists. `.zshrc` additionally appends
 *  our history-hardening snippet *after* the user's rc, so user
 *  preferences win for anything we don't explicitly override.
 *
 *  Caller responsibilities:
 *   1. Set `ZDOTDIR=<returned path>` in the spawned PTY's env.
 *   2. Call `cleanupZdotdir()` when the PTY exits.   */
export async function makeZshZdotdir(
  historyPreload: readonly string[] = [],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "supergit-zsh-"));
  const sourceIfExists = (name: string) =>
    `# Auto-generated by supergit. Sources your real ~/${name}.\n` +
    `if [[ -f "$HOME/${name}" ]]; then\n` +
    `  source "$HOME/${name}"\n` +
    `fi\n`;
  const writes = [
    writeFile(join(dir, ".zshenv"), sourceIfExists(".zshenv"), "utf-8"),
    writeFile(join(dir, ".zprofile"), sourceIfExists(".zprofile"), "utf-8"),
    writeFile(join(dir, ".zlogin"), sourceIfExists(".zlogin"), "utf-8"),
    writeFile(
      join(dir, ".zshrc"),
      sourceIfExists(".zshrc") + ZSH_HISTORY_SNIPPET,
      "utf-8",
    ),
  ];
  // Seed the per-column HISTFILE with the carry-over commands from the
  // resumed column's JSONL. Plain "<line>\n" is a valid zsh histfile
  // entry; zsh tolerates a mix of plain + EXTENDED_HISTORY formats on
  // read, then writes its own appended entries in extended format.
  if (historyPreload.length > 0) {
    const body = historyPreload
      .map((line) => line.replace(/\r?\n/g, " "))
      .map((line) => line + "\n")
      .join("");
    writes.push(writeFile(join(dir, ".histfile"), body, "utf-8"));
  }
  await Promise.all(writes);
  return dir;
}

/** Remove a temp ZDOTDIR. Best-effort — tempfiles get GC'd by the
 *  OS anyway, so a failure here is not worth surfacing. */
export async function cleanupZdotdir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
}
