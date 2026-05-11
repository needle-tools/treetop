/**
 * Shell out to OS apps to open a worktree in editor / Fork / terminal.
 *
 * Editor detection tries common editors in priority order; first match wins.
 * Fork is macOS-only (no Linux/Windows port). Terminal uses platform-native
 * fallbacks. All shell-outs are fire-and-forget — the daemon does not wait
 * for the spawned app.
 */

export type OpenApp = "editor" | "fork" | "terminal";

const EDITOR_PRIORITY = [
  "cursor", // Cursor first (Marcel-likely)
  "code", // VSCode
  "rider", // JetBrains Rider
  "idea", // IntelliJ IDEA
  "webstorm",
  "subl", // Sublime Text
  "nvim", // Neovim (terminal editor — last resort)
];

async function which(cmd: string): Promise<boolean> {
  const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
  return (await proc.exited) === 0;
}

export async function openIn(
  path: string,
  app: OpenApp,
): Promise<{ via: string }> {
  if (app === "editor") {
    for (const editor of EDITOR_PRIORITY) {
      if (await which(editor)) {
        Bun.spawn([editor, path], {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
        return { via: editor };
      }
    }
    throw new Error(
      "no editor detected on PATH (tried: " + EDITOR_PRIORITY.join(", ") + ")",
    );
  }

  if (app === "fork") {
    if (process.platform !== "darwin") {
      throw new Error("Fork integration is currently macOS-only");
    }
    const proc = Bun.spawn(["open", "-a", "Fork", path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await proc.exited;
    if (exit !== 0) {
      throw new Error("could not open Fork (is it installed?)");
    }
    return { via: "Fork" };
  }

  if (app === "terminal") {
    if (process.platform === "darwin") {
      Bun.spawn(["open", "-a", "Terminal", path], {
        stdout: "ignore",
        stderr: "ignore",
      });
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
          Bun.spawn([t], {
            cwd: path,
            stdout: "ignore",
            stderr: "ignore",
          });
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

  throw new Error(`unknown app: ${app}`);
}
