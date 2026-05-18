/**
 * Shell out to OS apps to open a worktree in an editor / Fork / terminal.
 *
 * Editor detection:
 *   - First try the CLI command (`cursor`, `code`, `rider`, ...) via `which`.
 *   - On macOS, also probe for the matching `.app` bundle in /Applications
 *     and ~/Applications. Many users have VSCode/Cursor installed but never
 *     ran the "install 'code' command in PATH" step, so the CLI is absent
 *     even when the app is there.
 *
 * openIn() only spawns allowlisted commands or `open -a <known app>` to keep
 * this from becoming arbitrary command execution.
 */

import { access, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export interface EditorDescriptor {
  name: string; // display name, e.g. "VSCode"
  cmd: string; // logical key the UI sends back to openIn()
}

interface EditorSpec {
  name: string;
  cmd: string;
  app?: string; // macOS .app bundle name (without .app)
}

const KNOWN_EDITORS: readonly EditorSpec[] = [
  { name: "Cursor", cmd: "cursor", app: "Cursor" },
  { name: "VSCode", cmd: "code", app: "Visual Studio Code" },
  { name: "Rider", cmd: "rider", app: "Rider" },
  { name: "IntelliJ", cmd: "idea", app: "IntelliJ IDEA" },
  { name: "IntelliJ CE", cmd: "idea-ce", app: "IntelliJ IDEA CE" },
  { name: "WebStorm", cmd: "webstorm", app: "WebStorm" },
  { name: "Sublime Text", cmd: "subl", app: "Sublime Text" },
  { name: "Neovim", cmd: "nvim" },
];

const SPECIAL_APPS = new Set(["fork", "terminal", "files"]);
const CMD_TO_SPEC = new Map(KNOWN_EDITORS.map((e) => [e.cmd, e]));

async function which(cmd: string): Promise<boolean> {
  const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
  return (await proc.exited) === 0;
}

/**
 * If `dir` contains a `*.code-workspace` file, return its full path. Prefers a
 * file matching the directory's basename when there are several (helps for
 * repos that ship multiple workspaces). VSCode/Cursor open these like a
 * project rather than a bare folder.
 */
export async function findWorkspaceFile(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const wsFiles = entries.filter((e) => e.endsWith(".code-workspace"));
  if (wsFiles.length === 0) return null;
  const baseName = basename(dir);
  const preferred =
    wsFiles.find((f) => f === `${baseName}.code-workspace`) ??
    wsFiles.find((f) => f.startsWith(baseName)) ??
    wsFiles[0]!;
  return join(dir, preferred);
}

async function macAppExists(appName: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const candidates = [
    `/Applications/${appName}.app`,
    join(homedir(), "Applications", `${appName}.app`),
  ];
  for (const c of candidates) {
    try {
      await access(c);
      return true;
    } catch {
      // not at this path; try next
    }
  }
  return false;
}

/** Result cache for detectEditors(). The detection runs 8 `which`
 *  subprocess spawns + macOS .app probes; on a slow disk that's
 *  hundreds of milliseconds of event-loop time per call. The dashboard
 *  calls /api/editors on every mount and column open. Editors don't
 *  appear/disappear during a session, so caching for 30s eliminates
 *  the cost without making the UI feel stale if the user installs a
 *  new editor mid-session. */
const EDITOR_DETECT_TTL_MS = 30_000;
let editorCache: { at: number; value: EditorDescriptor[] } | null = null;

export function resetDetectEditorsCache(): void {
  editorCache = null;
}

export async function detectEditors(): Promise<EditorDescriptor[]> {
  const now = Date.now();
  if (editorCache && now - editorCache.at < EDITOR_DETECT_TTL_MS) {
    return editorCache.value;
  }
  const present = await Promise.all(
    KNOWN_EDITORS.map(async (e) => {
      if (await which(e.cmd)) return e;
      if (e.app && (await macAppExists(e.app))) return e;
      return null;
    }),
  );
  const value = present
    .filter((e): e is EditorSpec => e !== null)
    .map(({ name, cmd }) => ({ name, cmd }));
  editorCache = { at: now, value };
  return value;
}

/** Single-quote `s` for safe substitution into a `bash -c '…'` snippet.
 *  Closes the surrounding quotes around any embedded `'`, escapes the
 *  quote with `\'`, then reopens. Same trick `find -print0 | xargs -0`
 *  scripts use; doesn't depend on any shell beyond POSIX. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export async function openIn(
  path: string,
  app: string,
  /** Optional shell command to run after opening the terminal. Only
   *  honoured when `app === "terminal"`. Used by the "Resume in external
   *  terminal" affordances to spawn `claude --resume <sid>` / similar
   *  in the user's preferred terminal at the session's cwd. */
  command?: string,
): Promise<{ via: string }> {
  // Trace the actual path we received so we can diagnose "VSCode opens
  // the wrong dir" / "Finder opens some git path" reports — almost
  // always a misunderstanding about which path supergit sent vs which
  // path the OS expanded it to.
  console.log(`openIn: app=${app} path=${path}${command ? ` command=${command}` : ""}`);
  if (app === "fork") {
    if (process.platform !== "darwin") {
      throw new Error("Fork integration is currently macOS-only");
    }
    const proc = Bun.spawn(["open", "-a", "Fork", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    if (exit !== 0) throw new Error("could not open Fork (is it installed?)");
    return { via: "Fork" };
  }

  if (app === "files") {
    // Open the path in the OS file manager (Finder / Explorer / xdg).
    if (process.platform === "darwin") {
      Bun.spawn(["open", path], { stdout: "ignore", stderr: "ignore" });
      return { via: "Finder" };
    }
    if (process.platform === "linux") {
      if (!(await which("xdg-open"))) {
        throw new Error("xdg-open not available — cannot open file manager");
      }
      Bun.spawn(["xdg-open", path], { stdout: "ignore", stderr: "ignore" });
      return { via: "Files" };
    }
    if (process.platform === "win32") {
      Bun.spawn(["explorer", path], { stdout: "ignore", stderr: "ignore" });
      return { via: "Explorer" };
    }
    throw new Error(
      `file manager open not implemented for ${process.platform}`,
    );
  }

  if (app === "terminal") {
    if (process.platform === "darwin") {
      if (command) {
        // macOS Terminal.app: drive it via AppleScript so we can launch
        // a fresh window AND run a command in it. `open -a Terminal`
        // alone has no way to pass a command, only a cwd.
        //
        // The script we hand `do script` is the user's shell init plus
        // `cd <cwd> && <command>`. Single-quoting the cwd makes paths
        // with spaces / dollars safe; the AppleScript double-quote layer
        // gets `\"` escaping for the inner `"`, plus `\\` for `\`.
        const inner = `cd ${shellQuote(path)} && ${command}`;
        const asEscaped = inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        Bun.spawn(
          [
            "osascript",
            "-e",
            `tell application "Terminal" to do script "${asEscaped}"`,
            "-e",
            `tell application "Terminal" to activate`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
      } else {
        Bun.spawn(["open", "-a", "Terminal", path], {
          stdout: "ignore",
          stderr: "ignore",
        });
      }
      return { via: "Terminal" };
    }
    if (process.platform === "linux") {
      const terminals = [
        "alacritty",
        "kitty",
        "gnome-terminal",
        "konsole",
        "xterm",
        "x-terminal-emulator",
      ];
      for (const t of terminals) {
        if (await which(t)) {
          if (command) {
            // `bash -c '…; exec bash'` runs the command and then drops
            // the user into an interactive shell so the window doesn't
            // vanish on exit. cwd is set via shell `cd` rather than the
            // terminal-specific --working-directory flag so this works
            // across the whole detection list.
            const inner = `cd ${shellQuote(path)} && ${command}; exec bash`;
            Bun.spawn([t, "-e", "bash", "-c", inner], {
              stdout: "ignore",
              stderr: "ignore",
            });
          } else {
            Bun.spawn([t], {
              cwd: path,
              stdout: "ignore",
              stderr: "ignore",
            });
          }
          return { via: t };
        }
      }
      throw new Error(
        "no terminal detected on PATH (tried: " + terminals.join(", ") + ")",
      );
    }
    throw new Error(
      `terminal open not implemented for platform ${process.platform}`,
    );
  }

  // Must be a known editor cmd. Try CLI first; on macOS, fall back to
  // launching the .app bundle so users don't have to install the shell CLI.
  const spec = CMD_TO_SPEC.get(app);
  if (!spec) {
    const allowed = [
      ...[...CMD_TO_SPEC.keys()],
      ...SPECIAL_APPS,
    ].join(", ");
    throw new Error(`unknown app: ${app} (allowed: ${allowed})`);
  }

  // VSCode and Cursor open `.code-workspace` files as full project workspaces;
  // prefer those when present.
  const supportsWorkspaceFile =
    spec.cmd === "code" || spec.cmd === "cursor";
  const target =
    (supportsWorkspaceFile ? await findWorkspaceFile(path) : null) ?? path;

  if (await which(spec.cmd)) {
    Bun.spawn([spec.cmd, target], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return { via: target === path ? spec.cmd : `${spec.cmd} (workspace file)` };
  }

  if (spec.app && (await macAppExists(spec.app))) {
    Bun.spawn(["open", "-a", spec.app, target], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return {
      via:
        target === path
          ? `${spec.app} (app bundle)`
          : `${spec.app} (workspace file)`,
    };
  }

  throw new Error(
    `${spec.name}: neither CLI '${spec.cmd}' on PATH nor app bundle '${spec.app}.app' found`,
  );
}
