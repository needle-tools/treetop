/**
 * Shell out to OS apps to open a worktree in an editor / Fork / terminal.
 *
 * Editor detection scans a whitelist of known commands; only commands that
 * resolve via `which` are exposed. openIn() only spawns allowlisted commands
 * to keep this from becoming an arbitrary-command-execution endpoint.
 */

export interface EditorDescriptor {
  name: string; // display name, e.g. "Cursor"
  cmd: string; // CLI command, e.g. "cursor"
}

const KNOWN_EDITORS: readonly EditorDescriptor[] = [
  { name: "Cursor", cmd: "cursor" },
  { name: "VSCode", cmd: "code" },
  { name: "Rider", cmd: "rider" },
  { name: "IntelliJ", cmd: "idea" },
  { name: "WebStorm", cmd: "webstorm" },
  { name: "Sublime Text", cmd: "subl" },
  { name: "Neovim", cmd: "nvim" },
];

const SPECIAL_APPS = new Set(["fork", "terminal"]);
const ALLOWED_EDITOR_CMDS = new Set(KNOWN_EDITORS.map((e) => e.cmd));

async function which(cmd: string): Promise<boolean> {
  const proc = Bun.spawn(["which", cmd], { stdout: "pipe", stderr: "pipe" });
  return (await proc.exited) === 0;
}

let editorsCache: EditorDescriptor[] | null = null;

export async function detectEditors(): Promise<EditorDescriptor[]> {
  if (editorsCache) return editorsCache;
  const checks = await Promise.all(
    KNOWN_EDITORS.map(async (e) => ({ e, present: await which(e.cmd) })),
  );
  editorsCache = checks.filter((c) => c.present).map((c) => c.e);
  return editorsCache;
}

export async function openIn(
  path: string,
  app: string,
): Promise<{ via: string }> {
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

  // Anything else must be a known editor cmd — keeps this from becoming
  // arbitrary-command execution.
  if (!ALLOWED_EDITOR_CMDS.has(app)) {
    const allowed = [...ALLOWED_EDITOR_CMDS, ...SPECIAL_APPS].join(", ");
    throw new Error(`unknown app: ${app} (allowed: ${allowed})`);
  }
  if (!(await which(app))) {
    throw new Error(`${app} is not on PATH`);
  }
  Bun.spawn([app, path], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  return { via: app };
}
