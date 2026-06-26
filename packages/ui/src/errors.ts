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

import {
  record as recordUiTiming,
  recentSlowSamples,
  snapshot as uiTimingSnapshot,
} from "./timings";

export type FrontendErrorKind =
  | "fetch"
  | "uncaught"
  | "rejection"
  | "server"
  | "diagnostic";
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
  const t = performance.now();
  try {
    for (const fn of subscribers) {
      try {
        fn(entries);
      } catch {
        // a subscriber bug should not crash other subscribers
      }
    }
  } finally {
    recordUiTiming("errors.notify", performance.now() - t);
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
  const t = performance.now();
  try {
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
  } finally {
    recordUiTiming("errors.push", performance.now() - t);
  }
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

const ERROR_POST_BATCH_MS = 50;
const ERROR_POST_BATCH_MAX = 100;
const ERROR_POST_QUEUE_MAX = 500;
const ERROR_POST_TIMEOUT_MS = 5_000;
let pendingErrorPosts: FrontendErrorEntry[] = [];
let errorPostTimer: ReturnType<typeof setTimeout> | null = null;
let errorPostInFlight: Promise<void> | null = null;
let errorPostFlushRequested = false;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return (
    AbortSignal as typeof AbortSignal & {
      timeout?: (milliseconds: number) => AbortSignal;
    }
  ).timeout?.(ms);
}

async function postEntries(entriesToPost: FrontendErrorEntry[]): Promise<void> {
  if (entriesToPost.length === 0) return;
  try {
    await originalFetch("/api/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: timeoutSignal(ERROR_POST_TIMEOUT_MS),
      body: JSON.stringify(
        entriesToPost.length === 1 ? entriesToPost[0] : entriesToPost,
      ),
    });
  } catch {
    // If we can't reach the daemon (the very condition that probably
    // produced this error), just keep it in memory. The user still
    // sees it in the popover.
  }
}

function schedulePostEntry(entry: FrontendErrorEntry): void {
  pendingErrorPosts.push(entry);
  if (pendingErrorPosts.length > ERROR_POST_QUEUE_MAX) {
    pendingErrorPosts.splice(
      0,
      pendingErrorPosts.length - ERROR_POST_QUEUE_MAX,
    );
  }
  if (pendingErrorPosts.length >= ERROR_POST_BATCH_MAX) {
    void flushPendingErrorPosts();
    return;
  }
  if (errorPostTimer !== null) return;
  errorPostTimer = setTimeout(() => {
    void flushPendingErrorPosts();
  }, ERROR_POST_BATCH_MS);
}

async function flushPendingErrorPosts(): Promise<void> {
  if (errorPostTimer !== null) {
    clearTimeout(errorPostTimer);
    errorPostTimer = null;
  }
  if (errorPostInFlight) {
    errorPostFlushRequested = true;
    await errorPostInFlight;
    return;
  }
  errorPostInFlight = (async () => {
    try {
      do {
        errorPostFlushRequested = false;
        const batch = pendingErrorPosts;
        pendingErrorPosts = [];
        await postEntries(batch);
      } while (pendingErrorPosts.length > 0 || errorPostFlushRequested);
    } finally {
      errorPostInFlight = null;
    }
  })();
  await errorPostInFlight;
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
  schedulePostEntry(entry);
  return entry;
}

export function recordBrowserDiagnostic(
  message: string,
  extra: Record<string, unknown> = {},
): FrontendErrorEntry {
  return recordBrowserError({
    kind: "diagnostic",
    source: "browser",
    message,
    extra,
  });
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
let apiFetchSeq = 0;
let apiFetchesInFlight = 0;
const activeApiFetches = new Map<
  string,
  {
    traceId: string;
    method: string;
    route: string;
    apiPath: string;
    daemonId?: string;
    startedAtMs: number;
  }
>();
let recentApiFetches: CompletedApiFetch[] = [];

const SLOW_API_MUTATION_MS = 250;
const SLOW_API_READ_MS = 1_000;
const LONG_TASK_MS = 250;
const EVENT_LOOP_STALL_INTERVAL_MS = 1_000;
const EVENT_LOOP_STALL_THRESHOLD_MS = 2_000;
const EVENT_LOOP_STALL_COOLDOWN_MS = 10_000;
const RECENT_API_FETCH_MAX = 40;
const RECENT_API_FETCH_WINDOW_MS = 2_000;

interface ParsedApiRoute {
  route: string;
  apiPath: string;
  daemonId?: string;
}

interface CompletedApiFetch {
  traceId: string;
  method: string;
  route: string;
  apiPath: string;
  daemonId?: string;
  startedAtMs: number;
  completedAtMs: number;
  fetchMs: number;
  status?: number;
  ok?: boolean;
}

function roundMs(n: number): number {
  return Math.round(n);
}

function routeFromFetchInput(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

function methodFromFetchInput(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  const requestMethod =
    typeof input === "object" && "method" in input ? input.method : undefined;
  return (init?.method ?? requestMethod ?? "GET").toUpperCase();
}

function parseApiRoute(route: string): ParsedApiRoute | null {
  let url: URL;
  try {
    url = new URL(route, "http://supergit.local");
  } catch {
    return route.startsWith("/api")
      ? { route, apiPath: route.split("#", 1)[0] ?? route }
      : null;
  }
  const fullPath = `${url.pathname}${url.search}`;
  if (!url.pathname.startsWith("/api")) return null;
  const remote = url.pathname.match(
    /^\/api\/daemons\/([^/]+)(\/api(?:\/.*)?|\/api)$/,
  );
  if (remote) {
    return {
      route: fullPath,
      apiPath: `${remote[2]}${url.search}`,
      daemonId: decodeURIComponent(remote[1] ?? ""),
    };
  }
  return { route: fullPath, apiPath: fullPath };
}

function shouldSkipSelfDiagnostic(route: string, method: string): boolean {
  return route.includes("/api/errors") && method === "POST";
}

function isExpectedFetchFailure(
  parsed: ParsedApiRoute | null,
  method: string,
  err: unknown,
): boolean {
  return (
    method === "GET" &&
    parsed?.apiPath === "/api/processes" &&
    (err as { name?: string })?.name === "AbortError"
  );
}

function slowFetchThreshold(method: string): number {
  return method === "GET" || method === "HEAD"
    ? SLOW_API_READ_MS
    : SLOW_API_MUTATION_MS;
}

function fetchExtra(opts: {
  traceId: string;
  parsed: ParsedApiRoute;
  method: string;
  status?: number;
  ok?: boolean;
  statusText?: string;
  fetchMs: number;
  startedAtMs: number;
  completedAtMs: number;
  inFlightAtStart: number;
  inFlightAtEnd: number;
  cache?: RequestCache;
  keepalive?: boolean;
  hasBody?: boolean;
}): Record<string, unknown> {
  return {
    traceId: opts.traceId,
    route: opts.parsed.route,
    apiPath: opts.parsed.apiPath,
    daemonId: opts.parsed.daemonId,
    method: opts.method,
    status: opts.status,
    ok: opts.ok,
    statusText: opts.statusText,
    fetchMs: roundMs(opts.fetchMs),
    startedAtMs: roundMs(opts.startedAtMs),
    completedAtMs: roundMs(opts.completedAtMs),
    inFlightAtStart: opts.inFlightAtStart,
    inFlightAtEnd: opts.inFlightAtEnd,
    cache: opts.cache,
    keepalive: opts.keepalive,
    hasBody: opts.hasBody,
    visibilityState: globalThis.document?.visibilityState,
  };
}

function maybeRecordSlowApiFetch(opts: {
  traceId: string;
  parsed: ParsedApiRoute | null;
  method: string;
  status: number;
  ok: boolean;
  statusText: string;
  fetchMs: number;
  startedAtMs: number;
  completedAtMs: number;
  inFlightAtStart: number;
  inFlightAtEnd: number;
  init?: RequestInit;
}): void {
  if (!opts.parsed) return;
  if (shouldSkipSelfDiagnostic(opts.parsed.route, opts.method)) return;
  if (opts.fetchMs < slowFetchThreshold(opts.method)) return;
  recordBrowserError({
    kind: "diagnostic",
    source: "browser",
    message: `api-fetch ${opts.method} ${opts.parsed.apiPath} fetchMs=${roundMs(
      opts.fetchMs,
    )} status=${opts.status}`,
    route: opts.parsed.route,
    method: opts.method,
    status: opts.status,
    extra: fetchExtra({
      traceId: opts.traceId,
      parsed: opts.parsed,
      method: opts.method,
      status: opts.status,
      ok: opts.ok,
      statusText: opts.statusText,
      fetchMs: opts.fetchMs,
      startedAtMs: opts.startedAtMs,
      completedAtMs: opts.completedAtMs,
      inFlightAtStart: opts.inFlightAtStart,
      inFlightAtEnd: opts.inFlightAtEnd,
      cache: opts.init?.cache,
      keepalive: opts.init?.keepalive,
      hasBody: opts.init?.body != null,
    }),
  });
}

function rememberCompletedApiFetch(opts: {
  traceId: string;
  parsed: ParsedApiRoute | null;
  method: string;
  startedAtMs: number;
  completedAtMs: number;
  fetchMs: number;
  status?: number;
  ok?: boolean;
}): void {
  if (!opts.parsed) return;
  if (shouldSkipSelfDiagnostic(opts.parsed.route, opts.method)) return;
  recentApiFetches.push({
    traceId: opts.traceId,
    method: opts.method,
    route: opts.parsed.route,
    apiPath: opts.parsed.apiPath,
    daemonId: opts.parsed.daemonId,
    startedAtMs: opts.startedAtMs,
    completedAtMs: opts.completedAtMs,
    fetchMs: opts.fetchMs,
    status: opts.status,
    ok: opts.ok,
  });
  if (recentApiFetches.length > RECENT_API_FETCH_MAX) {
    recentApiFetches.splice(
      0,
      recentApiFetches.length - RECENT_API_FETCH_MAX,
    );
  }
}

/** Test-only: re-set the install flag so a fresh `installFetchTracking`
 *  can capture a freshly-stubbed `globalThis.fetch` as its underlying
 *  fetch. Not exported for production callers — they should only call
 *  `installFetchTracking` once at startup. */
export function __resetFetchTrackingForTests(): void {
  installed = false;
  apiFetchSeq = 0;
  apiFetchesInFlight = 0;
  activeApiFetches.clear();
  recentApiFetches = [];
}

export async function __flushErrorPostsForTests(): Promise<void> {
  await flushPendingErrorPosts();
}

export function __resetErrorPostsForTests(): void {
  if (errorPostTimer !== null) {
    clearTimeout(errorPostTimer);
    errorPostTimer = null;
  }
  pendingErrorPosts = [];
  errorPostInFlight = null;
  errorPostFlushRequested = false;
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
    const method = methodFromFetchInput(input, init);
    const route = routeFromFetchInput(input);
    const parsed = parseApiRoute(route);
    const traceId = `fetch-${++apiFetchSeq}`;
    const startedAtMs = performance.now();
    const inFlightAtStart = ++apiFetchesInFlight;
    if (parsed && !shouldSkipSelfDiagnostic(parsed.route, method)) {
      activeApiFetches.set(traceId, {
        traceId,
        method,
        route: parsed.route,
        apiPath: parsed.apiPath,
        daemonId: parsed.daemonId,
        startedAtMs,
      });
    }
    try {
      const res = await orig(input as RequestInfo, init);
      const completedAtMs = performance.now();
      const fetchMs = completedAtMs - startedAtMs;
      const inFlightAtEnd = apiFetchesInFlight;
      rememberCompletedApiFetch({
        traceId,
        parsed,
        method,
        startedAtMs,
        completedAtMs,
        fetchMs,
        status: res.status,
        ok: res.ok,
      });
      maybeRecordSlowApiFetch({
        traceId,
        parsed,
        method,
        status: res.status,
        ok: res.ok,
        statusText: res.statusText,
        fetchMs,
        startedAtMs,
        completedAtMs,
        inFlightAtStart,
        inFlightAtEnd,
        init,
      });
      if (
        !res.ok &&
        res.status !== 304 &&
        !isExpectedClientError(res.status, method) &&
        !shouldSkipSelfDiagnostic(route, method)
      ) {
        recordBrowserError({
          kind: "fetch",
          source: "browser",
          message: `${method} ${route} → ${res.status} ${res.statusText}`,
          route,
          method,
          status: res.status,
          extra: parsed
            ? fetchExtra({
                traceId,
                parsed,
                method,
                status: res.status,
                ok: res.ok,
                statusText: res.statusText,
                fetchMs,
                startedAtMs,
                completedAtMs,
                inFlightAtStart,
                inFlightAtEnd,
                cache: init?.cache,
                keepalive: init?.keepalive,
                hasBody: init?.body != null,
              })
            : undefined,
        });
      }
      return res;
    } catch (err) {
      const completedAtMs = performance.now();
      const fetchMs = completedAtMs - startedAtMs;
      const inFlightAtEnd = apiFetchesInFlight;
      rememberCompletedApiFetch({
        traceId,
        parsed,
        method,
        startedAtMs,
        completedAtMs,
        fetchMs,
      });
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      // Skip recording our own /api/errors POST failures (same reason), and
      // expected aborts from bounded health polls.
      if (
        !shouldSkipSelfDiagnostic(route, method) &&
        !isExpectedFetchFailure(parsed, method, err)
      ) {
        recordBrowserError({
          kind: "fetch",
          source: "browser",
          message: `${method} ${route} → ${msg}`,
          route,
          method,
          stack,
          extra: parsed
            ? fetchExtra({
                traceId,
                parsed,
                method,
                fetchMs,
                startedAtMs,
                completedAtMs,
                inFlightAtStart,
                inFlightAtEnd,
                cache: init?.cache,
                keepalive: init?.keepalive,
                hasBody: init?.body != null,
              })
            : undefined,
        });
      }
      throw err;
    } finally {
      apiFetchesInFlight = Math.max(0, apiFetchesInFlight - 1);
      activeApiFetches.delete(traceId);
    }
  };
}

let browserResponsivenessInstalled = false;
let longTaskObserver: PerformanceObserver | null = null;
let eventLoopStallTimer: ReturnType<typeof setInterval> | null = null;
let lastEventLoopStallRecordedAtMs = -Infinity;

export function __resetBrowserResponsivenessTrackingForTests(): void {
  browserResponsivenessInstalled = false;
  longTaskObserver?.disconnect();
  longTaskObserver = null;
  if (eventLoopStallTimer) {
    clearInterval(eventLoopStallTimer);
    eventLoopStallTimer = null;
  }
  lastEventLoopStallRecordedAtMs = -Infinity;
}

export function eventLoopStallDiagnostic(opts: {
  expectedAtMs: number;
  observedAtMs: number;
  lastRecordedAtMs: number;
  thresholdMs?: number;
  cooldownMs?: number;
}): { message: string; extra: Record<string, unknown> } | null {
  const thresholdMs = opts.thresholdMs ?? EVENT_LOOP_STALL_THRESHOLD_MS;
  const cooldownMs = opts.cooldownMs ?? EVENT_LOOP_STALL_COOLDOWN_MS;
  const driftMs = opts.observedAtMs - opts.expectedAtMs;
  if (driftMs < thresholdMs) return null;
  if (opts.observedAtMs - opts.lastRecordedAtMs < cooldownMs) return null;
  const extra: Record<string, unknown> = {
    driftMs: roundMs(driftMs),
    expectedAtMs: roundMs(opts.expectedAtMs),
    observedAtMs: roundMs(opts.observedAtMs),
    inFlightFetches: apiFetchesInFlight,
    visibilityState: globalThis.document?.visibilityState,
  };
  const activeFetches = activeFetchDiagnostics(opts.observedAtMs);
  if (activeFetches.length > 0) extra.activeFetches = activeFetches;
  const uiTimings = uiTimingDiagnostics();
  if (uiTimings.length > 0) extra.uiTimings = uiTimings;
  const recentUiTimings = recentSlowSamples(12);
  if (recentUiTimings.length > 0) extra.recentUiTimings = recentUiTimings;
  return {
    message: `browser-event-loop-stall driftMs=${roundMs(driftMs)}`,
    extra,
  };
}

function activeFetchDiagnostics(nowMs: number): Record<string, unknown>[] {
  return [...activeApiFetches.values()]
    .sort((a, b) => a.startedAtMs - b.startedAtMs)
    .slice(0, 12)
    .map((fetch) => ({
      traceId: fetch.traceId,
      method: fetch.method,
      route: fetch.route,
      apiPath: fetch.apiPath,
      daemonId: fetch.daemonId,
      ageMs: roundMs(nowMs - fetch.startedAtMs),
    }));
}

function recentApiFetchDiagnostics(nowMs: number): Record<string, unknown>[] {
  return recentApiFetches
    .filter((fetch) => {
      const ageMs = nowMs - fetch.completedAtMs;
      return ageMs >= 0 && ageMs <= RECENT_API_FETCH_WINDOW_MS;
    })
    .sort((a, b) => b.completedAtMs - a.completedAtMs)
    .slice(0, 12)
    .map((fetch) => ({
      traceId: fetch.traceId,
      method: fetch.method,
      route: fetch.route,
      apiPath: fetch.apiPath,
      daemonId: fetch.daemonId,
      status: fetch.status,
      ok: fetch.ok,
      fetchMs: roundMs(fetch.fetchMs),
      ageMs: roundMs(nowMs - fetch.completedAtMs),
    }));
}

function uiTimingDiagnostics(): Record<string, unknown>[] {
  return Object.entries(uiTimingSnapshot())
    .filter(([, span]) => span.max >= 16 || span.last >= 16)
    .sort((a, b) => b[1].max - a[1].max)
    .slice(0, 12)
    .map(([name, span]) => ({
      name,
      count: span.count,
      p95: roundMs(span.p95),
      max: roundMs(span.max),
      last: roundMs(span.last),
    }));
}

function longTaskExtra(entry: PerformanceEntry): Record<string, unknown> {
  const endedAtMs = entry.startTime + entry.duration;
  const extra: Record<string, unknown> = {
    durationMs: roundMs(entry.duration),
    startTimeMs: roundMs(entry.startTime),
    name: entry.name,
    inFlightFetches: apiFetchesInFlight,
  };
  const activeFetches = activeFetchDiagnostics(endedAtMs);
  if (activeFetches.length > 0) extra.activeFetches = activeFetches;
  const recentApiFetches = recentApiFetchDiagnostics(endedAtMs);
  if (recentApiFetches.length > 0) extra.recentApiFetches = recentApiFetches;
  const uiTimings = uiTimingDiagnostics();
  if (uiTimings.length > 0) extra.uiTimings = uiTimings;
  const recentUiTimings = recentSlowSamples(12);
  if (recentUiTimings.length > 0) extra.recentUiTimings = recentUiTimings;
  return extra;
}

export function installBrowserResponsivenessTracking(): void {
  if (browserResponsivenessInstalled) return;
  browserResponsivenessInstalled = true;
  let expectedAtMs = performance.now() + EVENT_LOOP_STALL_INTERVAL_MS;
  eventLoopStallTimer = setInterval(() => {
    const observedAtMs = performance.now();
    const diagnostic = eventLoopStallDiagnostic({
      expectedAtMs,
      observedAtMs,
      lastRecordedAtMs: lastEventLoopStallRecordedAtMs,
    });
    expectedAtMs = observedAtMs + EVENT_LOOP_STALL_INTERVAL_MS;
    if (!diagnostic) return;
    lastEventLoopStallRecordedAtMs = observedAtMs;
    recordBrowserDiagnostic(diagnostic.message, diagnostic.extra);
  }, EVENT_LOOP_STALL_INTERVAL_MS);
  const Observer = globalThis.PerformanceObserver;
  if (!Observer?.supportedEntryTypes?.includes("longtask")) return;
  try {
    longTaskObserver = new Observer((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_MS) continue;
        recordBrowserDiagnostic(
          `browser-longtask durationMs=${roundMs(entry.duration)}`,
          longTaskExtra(entry),
        );
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    // PerformanceObserver longtask support varies by browser shell.
  }
}

/** Install window.onerror + unhandledrejection listeners. Idempotent. */
let globalsInstalled = false;
export function installGlobalErrorHandlers(): void {
  if (globalsInstalled) return;
  globalsInstalled = true;
  installBrowserResponsivenessTracking();
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
    const res = await originalFetch("/api/errors", {
      signal: timeoutSignal(ERROR_POST_TIMEOUT_MS),
    });
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
    await originalFetch("/api/errors", {
      method: "DELETE",
      signal: timeoutSignal(ERROR_POST_TIMEOUT_MS),
    });
  } catch {
    // ignore; still clear locally so the popover empties
  }
  clearErrorsLocal();
}
