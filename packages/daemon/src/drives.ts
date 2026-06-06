/**
 * Enumerate the filesystem roots of a box, so the folder picker can offer a
 * "This PC" level instead of hardcoding `C:\` (the system drive isn't always
 * C:, and repos may live on D:/E:/a mounted volume).
 *
 * Windows: probe drive letters A-Z and keep the ones that exist — no shell
 * (`wmic`/`fsutil` are deprecated / flaky), just `existsSync("X:\\")`.
 * POSIX: a single root, `/`.
 *
 * Pure: `exists` + `platform` are injected so it's unit-tested without a real
 * Windows disk. server.ts wires fs.existsSync + process.platform.
 */

export interface ListDrivesDeps {
  platform?: NodeJS.Platform;
  exists: (path: string) => boolean;
}

export function listDrives(deps: ListDrivesDeps): string[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return ["/"];
  const drives: string[] = [];
  for (let i = 0; i < 26; i++) {
    const root = `${String.fromCharCode(65 + i)}:\\`; // A:\ … Z:\
    if (deps.exists(root)) drives.push(root);
  }
  // Degenerate fallback: if probing somehow found nothing, assume C:\ so the
  // picker isn't empty (shouldn't happen on a real box).
  return drives.length > 0 ? drives : ["C:\\"];
}
