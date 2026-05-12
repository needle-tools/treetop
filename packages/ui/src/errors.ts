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
}

const MAX_ENTRIES = 200;

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
 */
export function pushError(entry: FrontendErrorEntry): void {
  if (seenIds.has(entry.id)) return;
  seenIds.add(entry.id);
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  notify();
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

let originalFetch: typeof fetch = globalThis.fetch?.bind(globalThis);
let installed = false;

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
      if (!res.ok) {
        // Skip recording our own /api/errors POSTs — recording an error
        // about the error endpoint would be circular noise.
        if (!(route.includes("/api/errors") && method === "POST")) {
          recordBrowserError({
            kind: "fetch",
            source: "browser",
            message: `${method} ${route} → ${res.status} ${res.statusText}`,
            route,
            method,
            status: res.status,
          });
        }
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
