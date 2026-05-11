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
