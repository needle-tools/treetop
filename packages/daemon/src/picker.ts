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
export async function pickFolder(
  prompt = "Add repo to supergit",
  startAt?: string,
): Promise<PickResult> {
  const platform = process.platform;
  const startDir = await resolveStartDir(startAt);

  if (platform === "darwin") {
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    const defaultLoc = startDir
      ? ` default location POSIX file "${startDir.replace(/"/g, '\\"')}"`
      : "";
    const script = `POSIX path of (choose folder with prompt "${escapedPrompt}"${defaultLoc})`;
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
    const args = ["--file-selection", "--directory", `--title=${prompt}`];
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
    // Use the modern Vista+ IFileOpenDialog in folder-picking mode via
    // COM interop. This gives the full Explorer-style dialog with
    // navigation pane, breadcrumb bar, and search — instead of the
    // ancient SHBrowseForFolder tree from FolderBrowserDialog.
    // The C# source is written to a temp file to avoid PowerShell
    // quoting issues with inline code.
    const { writeFile, unlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join: pjoin } = await import("node:path");
    const csPath = pjoin(tmpdir(), `supergit-picker-${Date.now()}.cs`);
    const escapedTitle = prompt.replace(/"/g, '""');
    const escapedDir = (startDir ?? "").replace(/"/g, '""');
    // C# 5 compatible (PowerShell's Add-Type uses an older compiler).
    const cs = `
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
class FileOpenDialogClass {}

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwnd);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex();
    void Advise(); void Unadvise();
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection();
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel(); void SetFileNameLabel();
    void GetResult(out IShellItem ppsi);
    void AddPlace(); void SetDefaultExtension();
    void Close(); void SetClientGuid(); void ClearClientData(); void SetFilter();
}

[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellItem {
    void BindToHandler(); void GetParent();
    void GetDisplayName(uint sigdnName,
        [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(); void Compare();
}

public class FolderPicker {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    static extern int SHCreateItemFromParsingName(
        string pszPath, IntPtr pbc, [In] ref Guid riid, out IShellItem ppv);

    public static string Pick(string title, string initDir) {
        IFileDialog fd = (IFileDialog)new FileOpenDialogClass();
        uint opts;
        fd.GetOptions(out opts);
        fd.SetOptions(opts | 0x20); // FOS_PICKFOLDERS
        if (!string.IsNullOrEmpty(title)) fd.SetTitle(title);
        if (!string.IsNullOrEmpty(initDir)) {
            Guid iid = typeof(IShellItem).GUID;
            IShellItem si;
            if (SHCreateItemFromParsingName(initDir, IntPtr.Zero, ref iid, out si) == 0)
                fd.SetFolder(si);
        }
        if (fd.Show(IntPtr.Zero) != 0) return null;
        IShellItem item;
        fd.GetResult(out item);
        string path;
        item.GetDisplayName(0x80058000u, out path);
        return path;
    }
}
`;
    await writeFile(csPath, cs, "utf-8");
    try {
      const ps = `Add-Type -Path '${csPath.replace(/'/g, "''")}'; $r = [FolderPicker]::Pick('${escapedTitle}', '${escapedDir}'); if ($r) { Write-Output $r }`;
      const proc = Bun.spawn(
        ["powershell", "-NoProfile", "-STA", "-Command", ps],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      const trimmed = stdout.trim();
      if (trimmed.length === 0) return { cancelled: true };
      return { path: trimmed };
    } finally {
      unlink(csPath).catch(() => {});
    }
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
