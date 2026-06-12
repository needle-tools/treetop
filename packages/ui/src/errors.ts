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

/**
 * Turn a WebSocket close `code` + `reason` into a human-readable, actionable
 * message for the terminal error overlay.
 *
 * The browser's WS `onerror` event carries NO detail by design (security) —
 * so a bare "WebSocket error" was the most the terminal column could ever
 * say. The close frame that always follows `onerror`, though, carries the
 * daemon's `code` + `reason` (e.g. 1011 "terminal not found" when the PTY
 * died before we attached, or 1011 "tunnel failed: …" for a remote daemon).
 * That reason is the only real signal about *why* a connection dropped, so
 * we map it to something the user can act on.
 */
export function describeWsClose(code: number, reason?: string): string {
  const r = (reason ?? "").trim();
  // "terminal not found" / "terminal exited code 1" / "terminal exited
  // signal SIGKILL" — the daemon sends these when the PTY is gone by the
  // time the socket attaches (what a failed `--resume` looks like). When a
  // code/signal is known, fold it into the message.
  if (r === "terminal not found" || r.startsWith("terminal exited ")) {
    const detail = r.startsWith("terminal exited ")
      ? ` (${r.slice("terminal exited ".length)})`
      : "";
    return `The terminal process exited before the connection attached${detail} — the resumed command likely failed to start. Press Retry, or open the session to check for an error.`;
  }
  if (r.startsWith("tunnel failed:")) {
    return `Remote daemon unreachable — ${r}`;
  }
  if (r === "remote ws error") {
    return "The remote daemon dropped the connection.";
  }
  if (r) {
    return `Connection closed (code ${code}): ${r}`;
  }
  if (code === 1006) {
    return "WebSocket closed abnormally (1006) — the connection to the daemon dropped with no reason. The daemon may have restarted or be unreachable.";
  }
  return `WebSocket closed (code ${code || "unknown"}).`;
}

export function terminalWsCloseRepresentsExit(opts: {
  sawExitFrame: boolean;
}): boolean {
  return opts.sawExitFrame;
}

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
   *  the deduping logic in `pushError` — the same `GET /api/repos →
   *  Failed to fetch` error firing 30 times collapses to one row with
   *  `count: 30` instead of flooding the popover. Absent / 1 means a
   *  single occurrence. */
  count?: number;
}

/** Hard backstop on distinct rows so a runaway loop emitting unique
 *  messages can't blow out the heap. The real bound is `MAX_AGE_MS`
 *  (below) — identical events dedup, so in practice we hold far fewer. */
const MAX_ENTRIES = 1000;
/** Drop entries older than this (24h). Keeps the popover scoped to
 *  "what went wrong recently" instead of growing without limit. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
 * Push an entry. Dedups by id, then by content. Most-recent-first.
 * Capped to MAX_ENTRIES so a runaway loop can't blow out the heap.
 *
 * Deduping: if the incoming entry's content (kind/source/route/method/
 * status/message — see `dedupKey`) matches an existing row *anywhere*
 * in the list, we fold into that row — bump its count, adopt the
 * latest occurrence's details, and float it to the top — instead of
 * pushing a new one. Unlike the old coalescer this has no time window:
 * a `GET /api/ssh/sessions → Failed to fetch` that recurs once a day
 * still collapses to one row whose count ticks up, rather than spamming
 * an identical row each time.
 */
export function pushError(entry: FrontendErrorEntry): void {
  if (seenIds.has(entry.id)) return;
  seenIds.add(entry.id);
  pruneOld(Date.now());
  const key = dedupKey(entry);
  const idx = entries.findIndex((e) => dedupKey(e) === key);
  if (idx === -1) {
    entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  } else {
    // Fold: keep the existing row's id (stable DOM / subscriber key) but
    // adopt the incoming occurrence's details — timestamp, stack, extra —
    // so "Copy" yields the most recent instance. Float it to the top so
    // the freshest activity leads.
    const existing = entries[idx];
    const merged: FrontendErrorEntry = {
      ...entry,
      id: existing.id,
      count: (existing.count ?? 1) + 1,
    };
    entries = [merged, ...entries.slice(0, idx), ...entries.slice(idx + 1)];
  }
  notify();
}

/** Content key for deduping — two entries collapse into one row iff they
 *  share this. Includes `message` so genuinely different errors (e.g.
 *  two distinct uncaught exceptions) keep their own rows even when their
 *  kind/source match. */
function dedupKey(e: FrontendErrorEntry): string {
  return [
    e.kind,
    e.source,
    e.method ?? "",
    e.route ?? "",
    e.status ?? "",
    e.message,
  ].join("|");
}

/** Drop entries older than MAX_AGE_MS, pruning their ids from `seenIds`
 *  too so it can't grow without bound. Mutates `entries`. */
function pruneOld(now: number): void {
  const cutoff = now - MAX_AGE_MS;
  let changed = false;
  const kept: FrontendErrorEntry[] = [];
  for (const e of entries) {
    const t = Date.parse(e.timestamp);
    if (Number.isFinite(t) && t < cutoff) {
      seenIds.delete(e.id);
      changed = true;
    } else {
      kept.push(e);
    }
  }
  if (changed) entries = kept;
}

/** Collapse a raw list into deduped rows (newest-first). Used on hydrate
 *  so a page reload shows the same folded view as the live session — the
 *  daemon stores each occurrence as its own line, so without this the
 *  popover would fill with duplicates again after every refresh. */
function dedupeList(list: FrontendErrorEntry[]): FrontendErrorEntry[] {
  const byKey = new Map<string, FrontendErrorEntry>();
  for (const e of list) {
    const key = dedupKey(e);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...e, count: e.count ?? 1 });
      continue;
    }
    const newer = Date.parse(e.timestamp) >= Date.parse(existing.timestamp);
    byKey.set(key, {
      ...(newer ? e : existing),
      id: existing.id,
      count: (existing.count ?? 1) + (e.count ?? 1),
    });
  }
  return [...byKey.values()].sort(
    (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
  );
}

/** Replace the list (used on initial hydrate from GET /api/errors).
 *  Prunes entries older than 24h and folds duplicates, so the hydrated
 *  view matches what the live push path would have produced. */
export function setErrors(list: FrontendErrorEntry[]): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  const recent = list.filter((e) => {
    const t = Date.parse(e.timestamp);
    return !Number.isFinite(t) || t >= cutoff;
  });
  entries = dedupeList(recent).slice(0, MAX_ENTRIES);
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
    const route =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    try {
      const res = await orig(input as RequestInfo, init);
      if (
        !res.ok &&
        res.status !== 304 &&
        !isExpectedClientError(res.status, method) &&
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
      message:
        (evt as ErrorEvent).message ||
        (e instanceof Error ? e.message : String(e)),
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
