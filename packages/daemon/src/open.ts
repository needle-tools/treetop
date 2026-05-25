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

/** Absolute path to cmd.exe. Bare `"cmd"` fails under Bun.spawn when the
 *  cwd is a repo directory — Bun resolves it relative to cwd first. */
const CMD_EXE = process.env.COMSPEC ?? "cmd.exe";

export interface EditorDescriptor {
  name: string; // display name, e.g. "VSCode"
  cmd: string; // logical key the UI sends back to openIn()
}

interface EditorSpec {
  name: string;
  cmd: string;
  app?: string; // macOS .app bundle name (without .app)
  /** Windows process name (without .exe) used to find the editor's main
   *  window so we can SW_RESTORE it after the CLI hands off. The editor
   *  CLIs signal the running instance over IPC; if its window is
   *  minimized, Windows' foreground-prevention leaves it minimized
   *  (the taskbar just flashes). Spawn powershell + Win32 to un-min it. */
  winProcess?: string;
}

const KNOWN_EDITORS: readonly EditorSpec[] = [
  { name: "Cursor", cmd: "cursor", app: "Cursor", winProcess: "Cursor" },
  { name: "VSCode", cmd: "code", app: "Visual Studio Code", winProcess: "Code" },
  { name: "Rider", cmd: "rider", app: "Rider", winProcess: "rider64" },
  { name: "IntelliJ", cmd: "idea", app: "IntelliJ IDEA", winProcess: "idea64" },
  { name: "IntelliJ CE", cmd: "idea-ce", app: "IntelliJ IDEA CE", winProcess: "idea64" },
  { name: "WebStorm", cmd: "webstorm", app: "WebStorm", winProcess: "webstorm64" },
  { name: "Sublime Text", cmd: "subl", app: "Sublime Text", winProcess: "sublime_text" },
  { name: "Neovim", cmd: "nvim" },
];

const SPECIAL_APPS = new Set(["fork", "terminal", "files"]);
const CMD_TO_SPEC = new Map(KNOWN_EDITORS.map((e) => [e.cmd, e]));

async function which(cmd: string): Promise<boolean> {
  const bin = process.platform === "win32" ? "where" : "which";
  const proc = Bun.spawn([bin, cmd], { stdout: "pipe", stderr: "pipe" });
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

/**
 * Open a file (or any other path) with the operating system's default
 * application — the same handler a double-click in Finder/Explorer
 * would route to. Used by the dashboard's custom-link feature when
 * the user registers a "file" link instead of a URL.
 *
 * macOS  → `open <path>`
 * Linux  → `xdg-open <path>`
 * Win32  → `cmd /c start "" <path>` (the empty "" is the window title
 *          argument, not a real argument — `start` swallows the first
 *          quoted string).
 *
 * Returns the same `{ via }` shape `openIn()` uses so the route
 * handler can include it in the response.
 */
export async function openDefault(path: string): Promise<{ via: string }> {
  console.log(`openDefault: path=${path}`);
  if (process.platform === "darwin") {
    const proc = Bun.spawn(["open", path], { stdout: "pipe", stderr: "pipe" });
    const exit = await proc.exited;
    if (exit !== 0) throw new Error(`open exited ${exit}`);
    return { via: "default app" };
  }
  if (process.platform === "linux") {
    if (!(await which("xdg-open"))) {
      throw new Error("xdg-open not available — cannot open default app");
    }
    Bun.spawn(["xdg-open", path], { stdout: "ignore", stderr: "ignore" });
    return { via: "xdg-open" };
  }
  if (process.platform === "win32") {
    // `start` is a cmd builtin, not a binary on PATH. Wrap it in
    // `cmd /c`. The leading empty `""` is a quoted window title that
    // start eats so the rest of the line is treated as the target.
    Bun.spawn([CMD_EXE, "/c", "start", "", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return { via: "start" };
  }
  throw new Error(
    `default-app open not implemented for platform ${process.platform}`,
  );
}

/** Single-quote `s` for safe substitution into a `bash -c '…'` snippet.
 *  Closes the surrounding quotes around any embedded `'`, escapes the
 *  quote with `\'`, then reopens. Same trick `find -print0 | xargs -0`
 *  scripts use; doesn't depend on any shell beyond POSIX. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a PowerShell snippet that finds a process by name and, if its
 * main window is minimized, restores it. Used after spawning the
 * editor CLI on Windows — see EditorSpec.winProcess for why.
 *
 * `processName` is interpolated into the script verbatim, so callers
 * must pass a controlled value (we only call this with hardcoded
 * KNOWN_EDITORS entries). The single-quote replace is a defence-in-depth
 * guard for that invariant rather than a real escape layer.
 */
export function buildRestoreWindowScript(processName: string): string {
  const safe = processName.replace(/'/g, "''");
  // SW_RESTORE = 9. Get-Process throws when no match → SilentlyContinue.
  return `$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SgWin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@
$p = Get-Process -Name '${safe}' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  $h = $p.MainWindowHandle
  if ([SgWin]::IsIconic($h)) { [SgWin]::ShowWindow($h, 9) | Out-Null }
  [SgWin]::SetForegroundWindow($h) | Out-Null
}`;
}

function restoreWindowsWindow(processName: string): void {
  if (process.platform !== "win32") return;
  Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      buildRestoreWindowScript(processName),
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
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
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["open", "-a", "Fork", path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exit = await proc.exited;
      if (exit !== 0) throw new Error("could not open Fork (is it installed?)");
      return { via: "Fork" };
    }
    if (process.platform === "win32") {
      // Fork on Windows: the updater stub at %LOCALAPPDATA%\Fork\Fork.exe
      // launches current\Fork.exe with remaining args. Just pass the repo
      // path — no subcommand needed.
      const forkExe = join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Fork",
        "Fork.exe",
      );
      try {
        await access(forkExe);
      } catch {
        throw new Error(
          "Fork not found at " + forkExe,
        );
      }
      Bun.spawn([forkExe, path], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return { via: "Fork" };
    }
    throw new Error(
      `Fork integration is not implemented for ${process.platform}`,
    );
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
    if (process.platform === "win32") {
      // Prefer Windows Terminal (wt.exe) if available, fall back to
      // powershell.exe in a new window via `start`.
      // `wt.exe` is an AppX reparse point that Bun.spawn can't resolve
      // directly, so launch it through `cmd /c` which handles these.
      if (await which("wt")) {
        if (command) {
          Bun.spawn(
            [CMD_EXE, "/c", "wt", "-d", path, "powershell", "-NoExit", "-Command", command],
            { stdout: "ignore", stderr: "ignore" },
          );
        } else {
          Bun.spawn([CMD_EXE, "/c", "wt", "-d", path], {
            stdout: "ignore",
            stderr: "ignore",
          });
        }
        return { via: "Windows Terminal" };
      }
      // Fallback: spawn PowerShell in a new window.
      const psPath = path.replace(/'/g, "''");
      if (command) {
        Bun.spawn(
          [
            CMD_EXE, "/c", "start", "powershell", "-NoExit",
            "-Command", `Set-Location '${psPath}'; ${command}`,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
      } else {
        Bun.spawn(
          [CMD_EXE, "/c", "start", "powershell", "-NoExit", "-Command",
            `Set-Location '${psPath}'`],
          { stdout: "ignore", stderr: "ignore" },
        );
      }
      return { via: "PowerShell" };
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
    if (process.platform === "win32" && spec.winProcess) {
      restoreWindowsWindow(spec.winProcess);
    }
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
