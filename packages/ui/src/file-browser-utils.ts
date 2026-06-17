import { apiUrl } from "./api";
import { singleFlight } from "./single-flight";

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  mtime?: string;
  git?: string;
  sync?: string;
}

export function joinPath(base: string, name: string): string {
  // On Windows paths (e.g. `C:\git\repo`) use backslash to match the
  // base's style. Otherwise (Unix-style or remote SSH) use forward slash.
  const isWindows = /^[a-zA-Z]:[\\/]/.test(base) || base.includes("\\");
  const sep = isWindows ? "\\" : "/";
  if (base.endsWith("/") || base.endsWith("\\")) return base + name;
  return base + sep + name;
}

/** The address-bar renders each path segment as its own `<button>`
 *  flex child, with `<span>/</span>` separators between them. When the
 *  user drag-selects across segments and copies, browsers insert a
 *  newline between block-level children — so "C: / git / needle-cloud"
 *  ends up on the clipboard as five lines. Strip the synthetic newlines
 *  (CR, LF, or CRLF) so the clipboard text matches what was visually
 *  highlighted. We deliberately keep the separator characters that are
 *  ALREADY part of the selection (e.g. the "/" text nodes) — they're
 *  what makes the result usable as a path. */
export function cleanCopiedPathSelection(raw: string): string {
  return raw.replace(/[\r\n]+/g, "");
}

/** Should Ctrl/Cmd+C copy *paths* (the address-bar / multi-select copy
 *  behaviour) or fall through to the browser's native copy of whatever
 *  the user highlighted? Returns true when there's a usable text
 *  selection on the page — in that case the caller should NOT
 *  preventDefault and should NOT call the path-copy fallback.
 *
 *  Pure for testability: pass in a Selection-like object (or null when
 *  no selection API is available, e.g. SSR). */
export function shouldDeferToNativeCopy(
  sel: { isCollapsed: boolean; toString(): string } | null,
): boolean {
  if (!sel) return false;
  if (sel.isCollapsed) return false;
  return sel.toString().length > 0;
}

/** Split an absolute path into `{ dir, name }`. Works on both Windows
 *  (backslash) and POSIX (slash) paths and tolerates mixed separators.
 *  Used to invert a full path back into a parent directory + basename
 *  pair for handlers that need to call `openFile(name, dir)` etc. */
export function splitParent(fullPath: string): { dir: string; name: string } {
  // Trim trailing separators so /foo/bar/ returns { dir: "/foo", name: "bar" }.
  const trimmed = fullPath.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return { dir: "", name: trimmed };
  return { dir: trimmed.slice(0, idx), name: trimmed.slice(idx + 1) };
}

export function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

export async function fetchDir(path: string, daemonId?: string): Promise<FileEntry[]> {
  const res = await fetch(apiUrl(`/api/files?path=${encodeURIComponent(path)}`, daemonId));
  if (!res.ok) throw new Error(`Failed to list ${path}`);
  const data = await res.json();
  return data.entries ?? [];
}

export interface PathStat {
  exists: boolean;
  type?: "file" | "directory" | "symlink";
}

/** Bulk-stat a list of paths. Used by the starred-only view to grey
 *  out stars whose files were moved/deleted and to choose folder vs
 *  file icons based on the actual on-disk type. Empty input short-
 *  circuits without a fetch. Errors return all-missing rather than
 *  throwing — the view degrades to "show stars without status" rather
 *  than breaking entirely. */
export async function fetchPathStats(
  paths: string[],
  daemonId?: string,
): Promise<Record<string, PathStat>> {
  if (paths.length === 0) return {};
  try {
    const res = await fetch(apiUrl("/api/exists", daemonId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) return {};
    const data = (await res.json()) as { results?: Record<string, PathStat> };
    return data.results ?? {};
  } catch {
    return {};
  }
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
    return {
      back: [...this.back],
      forward: [...this.forward],
      current: this._current,
    };
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

/** Split a filesystem path into breadcrumb segments. Handles both
 *  Unix-style (`/Users/me/repo`) and Windows-style (`C:\git\repo` or
 *  `C:/git/repo`) paths. For Windows paths the first crumb is the
 *  drive (`C:` / `C:\`) and subsequent crumbs use whichever separator
 *  the input used. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const winMatch = path.match(/^([a-zA-Z]:)([\\/])?(.*)$/);
  if (winMatch) {
    const drive = winMatch[1]!;
    const sep = winMatch[2] ?? "\\";
    const rest = winMatch[3] ?? "";
    const parts = rest.split(/[\\/]/).filter(Boolean);
    const crumbs: { name: string; path: string }[] = [
      { name: drive, path: drive + sep },
    ];
    for (let i = 0; i < parts.length; i++) {
      crumbs.push({
        name: parts[i]!,
        path: drive + sep + parts.slice(0, i + 1).join(sep),
      });
    }
    return crumbs;
  }
  const parts = path.split("/").filter(Boolean);
  const crumbs: { name: string; path: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    crumbs.push({
      name: parts[i]!,
      path: "/" + parts.slice(0, i + 1).join("/"),
    });
  }
  return crumbs;
}

/** Normalize a filesystem path's separators so the same logical path
 *  always serializes the same way. Windows paths (those starting with
 *  a drive letter or containing a backslash) get all separators
 *  converted to `\`; Unix paths are left alone. */
export function normalizePath(path: string): string {
  const isWindows = /^[a-zA-Z]:/.test(path) || path.includes("\\");
  if (isWindows) return path.replace(/\//g, "\\");
  return path;
}

export interface StarredItem {
  /** Normalized full path. */
  fullPath: string;
  /** Display string: relative to wtPath when inside it, otherwise the
   *  full normalized path. */
  rel: string;
  /** True when the item is somewhere under wtPath; false when it's
   *  outside (a parent directory, sibling repo, /tmp, etc). */
  inWt: boolean;
}

/** Compute the list of starred items to show in the file browser's
 *  "starred only" view. Includes ALL stars (not just those inside
 *  wtPath) so items in parent directories or other repos still appear.
 *  Items inside wtPath are sorted first, then items outside; within each
 *  group, sorted alphabetically by path. */
export function computeStarredList(
  starred: Iterable<string>,
  wtPath: string,
): StarredItem[] {
  const wtNorm = normalizePath(wtPath);
  const sep = /^[a-zA-Z]:/.test(wtNorm) || wtNorm.includes("\\") ? "\\" : "/";
  const wtWithSep = wtNorm.endsWith(sep) ? wtNorm : wtNorm + sep;
  const items: StarredItem[] = [];
  for (const p of starred) {
    const norm = normalizePath(p);
    if (norm === wtNorm) {
      items.push({ fullPath: norm, rel: ".", inWt: true });
      continue;
    }
    if (norm.startsWith(wtWithSep)) {
      items.push({
        fullPath: norm,
        rel: norm.slice(wtWithSep.length),
        inWt: true,
      });
    } else {
      items.push({ fullPath: norm, rel: norm, inWt: false });
    }
  }
  items.sort((a, b) => {
    if (a.inWt !== b.inWt) return a.inWt ? -1 : 1;
    return a.rel.localeCompare(b.rel);
  });
  return items;
}

export interface SimpleKV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class StarStore {
  constructor(
    private readonly storage: SimpleKV,
    private readonly key: string,
  ) {}

  load(): Set<string> {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.key);
    } catch {
      return new Set();
    }
    if (raw === null) return new Set();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Set();
    }
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((x): x is string => typeof x === "string")
        .map(normalizePath),
    );
  }

  save(paths: Iterable<string>): void {
    try {
      this.storage.setItem(this.key, JSON.stringify([...paths]));
    } catch {
      // best-effort
    }
  }

  /** Returns a new Set with `path` toggled. Persists immediately.
   *  Both `current` and `path` are normalized so the same logical
   *  path can't appear twice with different separator styles. */
  toggle(current: Set<string>, path: string): Set<string> {
    const norm = normalizePath(path);
    const next = new Set([...current].map(normalizePath));
    if (next.has(norm)) next.delete(norm);
    else next.add(norm);
    this.save(next);
    return next;
  }
}

export async function fetchGitStatus(
  path: string,
  gitWt: string,
  daemonId?: string,
): Promise<Map<string, string>> {
  try {
    const res = await fetch(
      apiUrl(`/api/files?path=${encodeURIComponent(path)}&git=${encodeURIComponent(gitWt)}`, daemonId),
    );
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
  cwd?: string;
}

const SSH_SESSIONS_CACHE_MS = 900;
const sshSessionsCache = new Map<
  string,
  { expiresAt: number; value: Record<string, SshSessionInfo> }
>();
const sshSessionsFlights = new Map<
  string,
  () => Promise<Record<string, SshSessionInfo>>
>();

async function fetchSshSessionsUncached(
  daemonId?: string,
): Promise<Record<string, SshSessionInfo>> {
  try {
    const res = await fetch(apiUrl("/api/ssh/sessions", daemonId));
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

export async function fetchSshSessions(
  daemonId?: string,
): Promise<Record<string, SshSessionInfo>> {
  const key = daemonId ?? "";
  const now = Date.now();
  const cached = sshSessionsCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  let flight = sshSessionsFlights.get(key);
  if (!flight) {
    flight = singleFlight(async () => {
      const value = await fetchSshSessionsUncached(daemonId);
      sshSessionsCache.set(key, {
        expiresAt: Date.now() + SSH_SESSIONS_CACHE_MS,
        value,
      });
      return value;
    });
    sshSessionsFlights.set(key, flight);
  }
  return flight();
}

export async function fetchRemoteDir(
  termId: string,
  path: string,
): Promise<FileEntry[]> {
  const res = await fetch(
    apiUrl(`/api/ssh/files?term=${encodeURIComponent(termId)}&path=${encodeURIComponent(path)}`),
  );
  if (!res.ok) {
    // Surface whatever the daemon told us — without this the user
    // sees a generic "Failed to list remote ..." and has no idea
    // whether it's a permission issue, a dead session, or a typo.
    let body: { error?: string; hint?: string } = {};
    try { body = await res.json(); } catch {}
    const parts: string[] = [];
    if (body.error) parts.push(body.error);
    if (body.hint) parts.push(body.hint);
    const detail = parts.length > 0 ? parts.join(" — ") : `HTTP ${res.status}`;
    throw new Error(`Failed to list remote ${path}: ${detail}`);
  }
  const data = await res.json();
  return data.entries ?? [];
}

export async function fetchSshHome(termId: string): Promise<string> {
  try {
    const res = await fetch(apiUrl(`/api/ssh/home?term=${encodeURIComponent(termId)}`));
    if (!res.ok) return "/";
    const data = await res.json();
    return data.home ?? "/";
  } catch {
    return "/";
  }
}

export async function confirmRemoteUpload(localPath: string): Promise<void> {
  await fetch(apiUrl("/api/ssh/confirm-upload"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPath }),
  });
}

export async function dismissRemoteUpload(localPath: string): Promise<void> {
  await fetch(apiUrl("/api/ssh/dismiss-upload"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPath }),
  });
}

export async function fetchSshStatus(
  termId: string,
): Promise<
  {
    remotePath: string;
    localCachePath: string;
    state: string;
    error?: string;
  }[]
> {
  try {
    const res = await fetch(
      apiUrl(`/api/ssh/status?term=${encodeURIComponent(termId)}`),
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.files ?? [];
  } catch {
    return [];
  }
}

export async function openRemoteFile(
  termId: string,
  remotePath: string,
): Promise<void> {
  const res = await fetch(apiUrl("/api/ssh/open"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ termId, remotePath }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to open remote file`);
  }
}
