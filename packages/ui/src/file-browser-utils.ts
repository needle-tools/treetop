export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  mtime?: string;
}

export function joinPath(base: string, name: string): string {
  return base.endsWith("/") ? base + name : base + "/" + name;
}

export function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatMtime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export async function fetchDir(path: string): Promise<FileEntry[]> {
  const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to list ${path}`);
  const data = await res.json();
  return data.entries ?? [];
}
