import type { SFTPWrapper, FileEntry as Ssh2FileEntry } from "ssh2";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  mtime?: string;
}

export function cachePathFor(
  workspacePath: string,
  hostKey: string,
  remotePath: string,
): string {
  return join(workspacePath, ".remote-cache", hostKey, remotePath);
}

export async function listRemoteDir(
  sftp: SFTPWrapper,
  path: string,
): Promise<FileEntry[]> {
  const raw: Ssh2FileEntry[] = await new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) return reject(err);
      resolve(list ?? []);
    });
  });

  const entries: FileEntry[] = raw
    .filter((f) => f.filename !== "." && f.filename !== "..")
    .map((f) => {
      const attrs = f.attrs;
      let type: FileEntry["type"] = "file";
      if (attrs.isDirectory()) type = "directory";
      else if (attrs.isSymbolicLink()) type = "symlink";

      const entry: FileEntry = {
        name: f.filename,
        type,
      };
      if (type === "file" && typeof attrs.size === "number") {
        entry.size = attrs.size;
      }
      if (typeof attrs.mtime === "number") {
        entry.mtime = new Date(attrs.mtime * 1000).toISOString();
      }
      return entry;
    });

  entries.sort((a, b) => {
    const aDir = a.type === "directory" ? 0 : 1;
    const bDir = b.type === "directory" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

export async function downloadFile(
  sftp: SFTPWrapper,
  remotePath: string,
  localCachePath: string,
): Promise<void> {
  const dir = localCachePath.slice(0, localCachePath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });

  return new Promise<void>((resolve, reject) => {
    sftp.fastGet(remotePath, localCachePath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

export async function uploadFile(
  sftp: SFTPWrapper,
  localCachePath: string,
  remotePath: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sftp.fastPut(localCachePath, remotePath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
