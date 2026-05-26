export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  mtime?: string;
  git?: string;
  sync?: string;
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

export interface NavHistoryState {
  back: string[];
  forward: string[];
  current: string;
}

export class NavHistory {
  private back: string[] = [];
  private forward: string[] = [];
  private _current: string;

  constructor(initial: string) {
    this._current = initial;
  }

  get current(): string {
    return this._current;
  }

  canGoBack(): boolean {
    return this.back.length > 0;
  }

  canGoForward(): boolean {
    return this.forward.length > 0;
  }

  push(path: string): void {
    if (path === this._current) return;
    this.back.push(this._current);
    this._current = path;
    this.forward = [];
  }

  goBack(): string | null {
    if (this.back.length === 0) return null;
    this.forward.push(this._current);
    this._current = this.back.pop()!;
    return this._current;
  }

  goForward(): string | null {
    if (this.forward.length === 0) return null;
    this.back.push(this._current);
    this._current = this.forward.pop()!;
    return this._current;
  }

  serialize(): NavHistoryState {
    return { back: [...this.back], forward: [...this.forward], current: this._current };
  }

  static fromSerialized(data: unknown): NavHistory {
    if (!data || typeof data !== "object") {
      const h = new NavHistory("/");
      return h;
    }
    const d = data as Record<string, unknown>;
    const current = typeof d.current === "string" ? d.current : "/";
    const h = new NavHistory(current);
    if (Array.isArray(d.back)) {
      h.back = d.back.filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(d.forward)) {
      h.forward = d.forward.filter((x): x is string => typeof x === "string");
    }
    return h;
  }
}

export async function fetchGitStatus(path: string, gitWt: string): Promise<Map<string, string>> {
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(path)}&git=${encodeURIComponent(gitWt)}`);
    if (!res.ok) return new Map();
    const data = await res.json();
    const map = new Map<string, string>();
    for (const e of data.entries ?? []) {
      if (e.git) map.set(e.name, e.git);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Extract the terminal ID from a session source string.
 * Sources go through these forms:
 *   __new__:shell:<random>      → look up in newTermIds map
 *   __attached__:shell:<termId> → termId is the last segment
 */
export function resolveTermIdFromSource(
  source: string,
  newTermIds: Record<string, string>,
): string | undefined {
  if (newTermIds[source]) return newTermIds[source];
  if (source.startsWith("__attached__:")) return source.split(":").pop();
  return undefined;
}

/**
 * Parse a remote file browser source string into its termId.
 *   __remote__:<termId>:<uniqueId>
 */
export function parseRemoteSource(source: string): string | undefined {
  if (!source.startsWith("__remote__:")) return undefined;
  return source.split(":")[1];
}

export interface SshSessionInfo {
  user: string | undefined;
  host: string;
  port: number;
}

export async function fetchSshSessions(): Promise<Record<string, SshSessionInfo>> {
  try {
    const res = await fetch("/api/ssh/sessions");
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

export async function fetchRemoteDir(termId: string, path: string): Promise<FileEntry[]> {
  const res = await fetch(
    `/api/ssh/files?term=${encodeURIComponent(termId)}&path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) throw new Error(`Failed to list remote ${path}`);
  const data = await res.json();
  return data.entries ?? [];
}

export async function openRemoteFile(termId: string, remotePath: string): Promise<void> {
  const res = await fetch("/api/ssh/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ termId, remotePath }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to open remote file`);
  }
}
