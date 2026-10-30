import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Worktree } from "./git";

interface DiscoveryRepo {
  id: string;
  path: string;
  worktrees: Worktree[];
}
/** Last-known topology speeds repeated daemon starts. Session contents, remote
 * credentials and Git status are deliberately not stored in this cache. */
export function createWorktreeDiscoveryCache(
  path: string,
  onError: (error: unknown) => void,
) {
  let loaded: Promise<DiscoveryRepo[]> | undefined;
  return {
    load(): Promise<DiscoveryRepo[]> {
      return (loaded ??= readFile(path, "utf8")
        .then((raw) => {
          const value = JSON.parse(raw);
          if (value.version !== 1 || !Array.isArray(value.repos))
            throw new Error("Invalid worktree discovery cache");
          return value.repos.filter(
            (repo: any) =>
              typeof repo.id === "string" &&
              typeof repo.path === "string" &&
              Array.isArray(repo.worktrees) &&
              repo.worktrees.every(
                (wt: any) =>
                  typeof wt.path === "string" &&
                  typeof wt.branch === "string" &&
                  typeof wt.head === "string",
              ),
          );
        })
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            onError(error);
          return [];
        }));
    },
    async save(repos: DiscoveryRepo[]) {
      const value = repos.map((repo) => ({
        id: repo.id,
        path: repo.path,
        worktrees: repo.worktrees.map((wt) => ({
          path: wt.path,
          branch: wt.branch,
          head: wt.head,
          bare: wt.bare,
          detached: wt.detached,
          ...(wt.nonGit ? { nonGit: true } : {}),
        })),
      }));
      const temp = `${path}.tmp-${randomUUID()}`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(temp, JSON.stringify({ version: 1, repos: value }));
        await rename(temp, path);
        loaded = Promise.resolve(value);
      } catch (error) {
        onError(error);
      } finally {
        await rm(temp, { force: true }).catch(onError);
      }
    },
  };
}

/** Start telemetry work without holding an HTTP connection. Repeated polls
 * join the actual operation, even when it outlives the client's next poll. */
export function createBackgroundRefresh(onError: (error: unknown) => void) {
  const inflight = new Set<string>();
  return (key: string, load: () => Promise<unknown>): boolean => {
    if (inflight.has(key)) return false;
    inflight.add(key);
    void Promise.resolve()
      .then(load)
      .catch(onError)
      .finally(() => inflight.delete(key));
    return true;
  };
}

export interface StaleWhileRevalidateOptions<T> {
  ttlMs: number;
  load: () => Promise<T>;
  clock?: () => number;
  onRefreshError?: (error: unknown) => void;
  /** Telemetry can serve an empty snapshot while its first scan runs. */
  initialValue?: T;
}

export interface StaleWhileRevalidateCache<T> {
  get(): Promise<T>;
  clear(): void;
}

export function createStaleWhileRevalidateCache<T>({
  ttlMs,
  load,
  clock = Date.now,
  onRefreshError,
  initialValue,
}: StaleWhileRevalidateOptions<T>): StaleWhileRevalidateCache<T> {
  let cache: { at: number; value: T } | null =
    initialValue === undefined ? null : { at: -Infinity, value: initialValue };
  let inflight: Promise<T> | null = null;

  const refresh = (): Promise<T> => {
    if (inflight) return inflight;
    inflight = load()
      .then((value) => {
        cache = { at: clock(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async get(): Promise<T> {
      const now = clock();
      if (cache && now - cache.at < ttlMs) {
        return cache.value;
      }
      if (cache) {
        if (!inflight) void refresh().catch((err) => onRefreshError?.(err));
        return cache.value;
      }
      return refresh();
    },
    clear(): void {
      cache = null;
    },
  };
}
