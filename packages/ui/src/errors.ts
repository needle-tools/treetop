/**
 * Frontend error tracking — feeds the "Events" popover.
 *
 * Collects three kinds of problems and routes them through one in-memory
 * store + a best-effort POST to the daemon (so they end up in
 * <workspace>/errors.jsonl too):
 *   1. fetch() responses that aren't 2xx (any status >= 300)
 *   2. fetch() that throws (network down, daemon restarting, portless 502
 *      before the daemon is back — the "502 Bad Gateway" case)
 *   3. window.onerror + unhandledrejection — uncaught browser errors
 *
 * Daemon-side errors arrive via the existing SSE stream as `event: error`
 * and the same store consumes them, deduping on id.
 *
 * The store is local-state plus a subscriber callback (Svelte 5 `$state`
 * is component-scoped, so we re-export a subscribe()-able list instead).
 */

export type FrontendErrorKind = "fetch" | "uncaught" | "rejection" | "server";
export type FrontendErrorSource = "browser" | "daemon";

export interface FrontendErrorEntry {
  id: string;
  timestamp: string;
  kind: FrontendErrorKind;
  source: FrontendErrorSource;
  message: string;
  stack?: string;
  route?: string;
  method?: string;
  status?: number;
  extra?: Record<string, unknown>;
  /** How many identical entries have been folded into this row. Set by
   *  the coalescing logic in `pushError` — a daemon restart that fires
   *  the same `GET /api/repos → Failed to fetch` error 30 times in a
   *  row collapses to one row with `count: 30` instead of flooding the
   *  popover. Absent / 1 means a single occurrence. */
  count?: number;
}

const MAX_ENTRIES = 200;
/** Window for the coalescing logic in `pushError`. Identical entries
 *  (same kind/route/method/status) arriving inside this window bump
 *  the existing row's `count` + `timestamp` instead of pushing a new
 *  row. 60s is generous enough to fold a full daemon-restart's
 *  worth of fallout (typically a ~10s flurry) without merging
 *  unrelated bursts that happen to share a route. */
const COALESCE_WINDOW_MS = 60_000;

const subscribers = new Set<(entries: FrontendErrorEntry[]) => void>();
const seenIds = new Set<string>();
let entries: FrontendErrorEntry[] = [];

function notify(): void {
  for (const fn of subscribers) {
    try {
      fn(entries);
    } catch {
      // a subscriber bug should not crash other subscribers
    }
  }
}

/** Subscribe to the error list. Returns an unsubscribe fn. */
export function subscribeErrors(
  fn: (entries: FrontendErrorEntry[]) => void,
): () => void {
  subscribers.add(fn);
  fn(entries);
  return () => {
    subscribers.delete(fn);
  };
}

/** Read-only snapshot of current entries (newest first). */
export function getErrors(): FrontendErrorEntry[] {
  return entries;
}

/**
 * Push an entry. Dedups by id. Most-recent-first. Capped to MAX_ENTRIES
 * so a runaway loop can't blow out the popover or the heap.
 *
 * Coalescing: if the incoming entry's "shape" (kind + route + method +
 * status) matches the most-recent entry AND we're still inside the
 * coalesce window, we bump the head row's count + timestamp instead of
 * pushing a new one. That folds daemon-restart bursts ("100× Failed
 * to fetch /api/repos in 8 seconds") into a single row, which is the
 * second half of the prod-error snapshot fix in plans/PLAN.md.
 */
export function pushError(entry: FrontendErrorEntry): void {
  if (seenIds.has(entry.id)) return;
  if (tryCoalesceWithHead(entry)) return;
  seenIds.add(entry.id);
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  notify();
}

/** Shape key for coalescing — two entries collapse iff they share this. */
function coalesceKey(e: FrontendErrorEntry): string {
  return [e.kind, e.method ?? "", e.route ?? "", e.status ?? ""].join("|");
}

/** Try to merge `entry` into the most-recent entry. Returns `true` if
 *  it did (caller should NOT push).
 *
 *  Only fires when both entries have a `route` — generic uncaught/
 *  rejection errors with no `route` each get their own row so unrelated
 *  events aren't folded together just because their shape happens to
 *  match. */
function tryCoalesceWithHead(entry: FrontendErrorEntry): boolean {
  const head = entries[0];
  if (!head) return false;
  if (!entry.route || !head.route) return false;
  if (coalesceKey(head) !== coalesceKey(entry)) return false;
  const dtMs = Date.parse(entry.timestamp) - Date.parse(head.timestamp);
  if (!Number.isFinite(dtMs) || dtMs > COALESCE_WINDOW_MS) return false;
  // Merge: update timestamp + bump count. Keep the head's id so existing
  // subscribers / DOM nodes (keyed by id) don't re-mount.
  const merged: FrontendErrorEntry = {
    ...head,
    timestamp: entry.timestamp,
    count: (head.count ?? 1) + 1,
  };
  entries = [merged, ...entries.slice(1)];
  notify();
  return true;
}

/** Replace the list (used on initial hydrate from GET /api/errors). */
export function setErrors(list: FrontendErrorEntry[]): void {
  entries = list.slice(0, MAX_ENTRIES);
  seenIds.clear();
  for (const e of entries) seenIds.add(e.id);
  notify();
}

/** Forget everything. Backend clear is separate (DELETE /api/errors). */
export function clearErrorsLocal(): void {
  entries = [];
  seenIds.clear();
  notify();
}

function newId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Last-ditch fallback for old browsers / non-DOM environments.
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function postEntry(entry: FrontendErrorEntry): Promise<void> {
  try {
    await originalFetch("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch {
    // If we can't reach the daemon (the very condition that probably
    // produced this error), just keep it in memory. The user still
    // sees it in the popover.
  }
}

/** Build + record + persist a browser-side error. */
export function recordBrowserError(
  input: Omit<FrontendErrorEntry, "id" | "timestamp">,
): FrontendErrorEntry {
  const entry: FrontendErrorEntry = {
    id: newId(),
    timestamp: new Date().toISOString(),
    ...input,
  };
  pushError(entry);
  void postEntry(entry);
  return entry;
}

/** "User-recoverable" 4xx responses that should NOT show up in the
 *  error popover. Today this is just 409 Conflict on non-GET — the
 *  daemon returns it for actions like "create a worktree on an
 *  existing branch" or "checkout a branch with a dirty working tree".
 *  In every case the UI catches the 409, opens a confirmation dialog,
 *  and the user resolves it intentionally. Recording these is pure
 *  noise.
 *
 *  Conservative: GETs returning 409 are kept (rare, probably real).
 *  4xx other than 409 (400/401/403/404 etc.) keep recording too — those
 *  are usually genuine bugs in callers. Extend this list only when a
 *  specific (status, method, route-pattern) is confirmed to be an
 *  intentional contract. */
function isExpectedClientError(status: number, method: string): boolean {
  return status === 409 && method !== "GET";
}

let originalFetch: typeof fetch = globalThis.fetch?.bind(globalThis);
let installed = false;

/** Test-only: re-set the install flag so a fresh `installFetchTracking`
 *  can capture a freshly-stubbed `globalThis.fetch` as its underlying
 *  fetch. Not exported for production callers — they should only call
 *  `installFetchTracking` once at startup. */
export function __resetFetchTrackingForTests(): void {
  installed = false;
}

/**
 * Wrap window.fetch so any non-ok response or network failure becomes a
 * recorded error. Idempotent. Returns the previous fetch (mostly so
 * tests can assert un-installation, not used at runtime).
 */
export function installFetchTracking(): void {
  if (installed) return;
  installed = true;
  const orig = globalThis.fetch.bind(globalThis);
  originalFetch = orig;
  globalThis.fetch = async function trackedFetch(input, init) {
    const method = (init?.method ?? "GET").toUpperCase();
    const route = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    try {
      const res = await orig(input as RequestInfo, init);
      if (!res.ok && !isExpectedClientError(res.status, method) &&
        !(route.includes("/api/errors") && method === "POST")
      ) {
        recordBrowserError({
          kind: "fetch",
          source: "browser",
          message: `${method} ${route} → ${res.status} ${res.statusText}`,
          route,
          method,
          status: res.status,
        });
      }
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      // Skip recording our own /api/errors POST failures (same reason).
      if (!(route.includes("/api/errors") && method === "POST")) {
        recordBrowserError({
          kind: "fetch",
          source: "browser",
          message: `${method} ${route} → ${msg}`,
          route,
          method,
          stack,
        });
      }
      throw err;
    }
  };
}

/** Install window.onerror + unhandledrejection listeners. Idempotent. */
let globalsInstalled = false;
export function installGlobalErrorHandlers(): void {
  if (globalsInstalled) return;
  globalsInstalled = true;
  globalThis.addEventListener("error", (evt) => {
    const e = (evt as ErrorEvent).error;
    recordBrowserError({
      kind: "uncaught",
      source: "browser",
      message: (evt as ErrorEvent).message || (e instanceof Error ? e.message : String(e)),
      stack: e instanceof Error ? e.stack : undefined,
      extra: {
        filename: (evt as ErrorEvent).filename,
        lineno: (evt as ErrorEvent).lineno,
        colno: (evt as ErrorEvent).colno,
      },
    });
  });
  globalThis.addEventListener("unhandledrejection", (evt) => {
    const reason = (evt as PromiseRejectionEvent).reason;
    recordBrowserError({
      kind: "rejection",
      source: "browser",
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

/** Hydrate from /api/errors. Best-effort. */
export async function hydrateFromServer(): Promise<void> {
  try {
    const res = await originalFetch("/api/errors");
    if (!res.ok) return;
    const list = (await res.json()) as FrontendErrorEntry[];
    if (Array.isArray(list)) setErrors(list);
  } catch {
    // ignore — daemon may not be up yet
  }
}

/** DELETE /api/errors then clear local state. */
export async function clearErrors(): Promise<void> {
  try {
    await originalFetch("/api/errors", { method: "DELETE" });
  } catch {
    // ignore; still clear locally so the popover empties
  }
  clearErrorsLocal();
}
