import { $ } from "bun";

export type PickResult = { path: string } | { cancelled: true };

/**
 * Opens the OS-native folder picker on the machine running the daemon and
 * resolves with the chosen path, or { cancelled: true } if the user dismissed.
 *
 * Why this lives in the daemon: a browser cannot expose absolute filesystem
 * paths (security). Since the daemon runs on the same machine as the user, it
 * can shell out to the OS picker and return the real path the UI needs.
 */
export async function pickFolder(): Promise<PickResult> {
  const platform = process.platform;

  if (platform === "darwin") {
    const script =
      'POSIX path of (choose folder with prompt "Add repo to supergit")';
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) return { cancelled: true };
    return { path: stdout.trim() };
  }

  if (platform === "linux") {
    const proc = Bun.spawn(
      [
        "zenity",
        "--file-selection",
        "--directory",
        "--title=Add repo to supergit",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) return { cancelled: true };
    return { path: stdout.trim() };
  }

  if (platform === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog;",
      "$f.Description = 'Add repo to supergit';",
      "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }",
    ].join(" ");
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    const trimmed = stdout.trim();
    if (exit !== 0 || trimmed.length === 0) return { cancelled: true };
    return { path: trimmed };
  }

  throw new Error(`No folder picker implementation for platform ${platform}`);
}

/**
 * OS-native FILE picker. Same shape as `pickFolder` but targets a
 * single file. Used by the worktree row's custom-links feature: when
 * the user adds a "file" link we pop a picker so they get an absolute
 * path the daemon can later hand to `openDefault` without any browser
 * sandbox limitations.
 *
 * `startAt` (optional) tells the picker which directory to open in.
 * Pass either a directory or a file path — for files, the picker
 * opens that file's containing directory. Non-existent paths are
 * silently ignored so the caller can safely pass a stale "last pick".
 */
export async function pickFile(
  prompt = "Pick a file",
  startAt?: string,
): Promise<PickResult> {
  const platform = process.platform;
  const startDir = await resolveStartDir(startAt);

  if (platform === "darwin") {
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    const defaultLoc = startDir
      ? ` default location POSIX file "${startDir.replace(/"/g, '\\"')}"`
      : "";
    const script = `POSIX path of (choose file with prompt "${escapedPrompt}"${defaultLoc})`;
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) return { cancelled: true };
    return { path: stdout.trim() };
  }

  if (platform === "linux") {
    const args = ["--file-selection", `--title=${prompt}`];
    if (startDir) args.push(`--filename=${startDir}/`);
    const proc = Bun.spawn(["zenity", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) return { cancelled: true };
    return { path: stdout.trim() };
  }

  if (platform === "win32") {
    const initDir = startDir
      ? `$f.InitialDirectory = '${startDir.replace(/'/g, "''")}';`
      : "";
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$f = New-Object System.Windows.Forms.OpenFileDialog;",
      `$f.Title = '${prompt.replace(/'/g, "''")}';`,
      initDir,
      "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.FileName }",
    ].join(" ");
    const proc = Bun.spawn(
      ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    const trimmed = stdout.trim();
    if (exit !== 0 || trimmed.length === 0) return { cancelled: true };
    return { path: trimmed };
  }

  throw new Error(`No file picker implementation for platform ${platform}`);
}

/** Resolve a "start at" hint to an existing directory the OS picker
 *  can open in. Accepts either a directory (used as-is) or a file
 *  (uses its parent). Returns null when the path is missing, empty,
 *  or doesn't exist — letting the picker fall back to its default. */
async function resolveStartDir(p?: string): Promise<string | null> {
  if (!p) return null;
  const trimmed = p.trim();
  if (trimmed.length === 0) return null;
  const { stat } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  try {
    const s = await stat(trimmed);
    return s.isDirectory() ? trimmed : dirname(trimmed);
  } catch {
    return null;
  }
}
