/**
 * Shared session poller — Lever 1 of the renderer-CPU fix
 * (plans/performance.md "per-column session-poll storm").
 *
 * Before: every mounted `SessionView` ran its own `setInterval(2 s)` firing
 * `GET /api/session` + `GET /api/active-sends`. With ~27 columns open that's
 * ~27 timers and ~54 requests every 2 s, each with its own promise chain and
 * reactive flush — the dominant cost behind the 55 % renderer CPU.
 *
 * After: one timer for the whole dashboard. Each tick issues, per daemon, a
 * single `POST /api/sessions/batch` for every registered source and a single
 * `GET /api/active-sends` (no `sessionId`), then fans the results back out to
 * the columns. A source's body is dispatched only when it actually changes;
 * a column's active-sends slice only when its contents change — so unchanged
 * sessions cost nothing downstream.
 *
 * `createSessionPoller` is timer-free and dependency-injected so it can be
 * unit-tested by driving `tick()` directly; the module-level singleton wires
 * the real fetch + idle gate + a 2 s interval (see the bottom of this file).
 */

import { apiUrl } from "./api";
import { isUiIdle, onResume } from "./ui-idle";

export interface InflightRec {
  id: string;
  sessionId: string;
  [k: string]: unknown;
}

export interface SessionPollReg {
  /** Absolute JSONL path identifying the session (the `?source=` value). */
  source: string;
  /** Remote daemon id, or undefined for the local daemon. */
  daemonId?: string;
  /** This column's current sessionId, for slicing the global active-sends
   *  list. May be undefined before the session has loaded. */
  getSessionId: () => string | undefined;
  /** Return false to skip this column's transcript body on a tick while still
   *  keeping active-sends state live. Used by app-server sessions while their
   *  SSE stream is already carrying the active turn. */
  shouldPollSession?: () => boolean;
  /** Minimum number of recent messages this column wants. Defaults to the
   *  daemon's normal lightweight tail; scroll-back can increase this for one
   *  column without widening every open session. */
  getMinMessages?: () => number | undefined;
  /** Called with the session JSON text whenever it changes (never for an
   *  unchanged 304), plus the ETag the daemon returned. */
  onSession: (bodyText: string, etag: string | null) => void;
  /** Called when the daemon can express a changed session as a tail
   *  replacement. Components that hold parsed session state can apply this
   *  without parsing/stringifying the previous full body. */
  onSessionPatch?: (patch: BatchSessionPatch, etag: string | null) => void;
  /** Called with this column's active-sends records whenever the slice
   *  changes (including transitions to/from empty). */
  onInflight: (list: InflightRec[]) => void;
}

export interface BatchSessionPatch {
  session: Record<string, unknown>;
  patch: {
    oldStart: number;
    oldEnd: number;
    messages: unknown[];
  };
}

interface MessageCursorEntry {
  index: number;
  hash: string;
}

type BatchResult =
  | {
      source: string;
      status: 200;
      etag: string;
      body: string;
      messageHashes?: string[];
    }
  | {
      source: string;
      status: 206;
      etag: string;
      session: Record<string, unknown>;
      patch: {
        oldStart: number;
        oldEnd: number;
        messages: unknown[];
      };
      messageHashes: string[];
    }
  | { source: string; status: 304; etag: string }
  | { source: string; status: 403 };

interface RegState {
  reg: SessionPollReg;
  /** Last ETag we hold for this source — sent as the batch `etag` so the
   *  daemon can 304 us. */
  etag?: string;
  /** Last body text dispatched, to suppress duplicate onSession calls. */
  lastBody?: string;
  /** Hashes supplied by the daemon for the currently cached message array. */
  messageHashes?: string[];
  /** JSON of the last active-sends slice dispatched, for change detection. */
  lastInflightKey?: string;
}

interface CachedSessionBody {
  etag: string | null;
  body: string;
  messageHashes?: string[];
}

export interface SessionPollerDeps {
  fetchImpl: typeof fetch;
  isIdle: () => boolean;
}

export interface SessionPoller {
  register: (reg: SessionPollReg) => () => void;
  /** Run one poll cycle now. Resolves when all daemons' requests settle. */
  tick: () => Promise<void>;
  /** Number of registered sources (for the singleton's timer lifecycle). */
  size: () => number;
}

const MAX_SESSION_CACHE_CHARS = 32 * 1024 * 1024;

function sessionCacheKey(daemonId: string | undefined, source: string): string {
  return `${daemonId ?? ""}\0${source}`;
}

export function createSessionPoller(deps: SessionPollerDeps): SessionPoller {
  const regs = new Map<symbol, RegState>();
  const sessionCache = new Map<string, CachedSessionBody>();
  let sessionCacheChars = 0;
  // Per-daemon active-sends cache so a 304 (nothing in flight) still lets us
  // recompute slices for newly-registered columns without a re-fetch.
  const activeSendsEtag = new Map<string | undefined, string>();
  const activeSendsList = new Map<string | undefined, InflightRec[]>();
  let runningTick: Promise<void> | null = null;
  let rerunRequested = false;

  function cachedSession(key: string): CachedSessionBody | undefined {
    const cached = sessionCache.get(key);
    if (!cached) return undefined;
    // Map insertion order is our LRU list.
    sessionCache.delete(key);
    sessionCache.set(key, cached);
    return cached;
  }

  function rememberSessionBody(
    key: string,
    body: string,
    etag: string | null,
    messageHashes?: string[],
  ): void {
    const prev = sessionCache.get(key);
    if (prev) sessionCacheChars -= prev.body.length;
    sessionCache.delete(key);
    sessionCache.set(key, { body, etag, messageHashes });
    sessionCacheChars += body.length;
    while (
      sessionCacheChars > MAX_SESSION_CACHE_CHARS &&
      sessionCache.size > 1
    ) {
      const oldest = sessionCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = sessionCache.get(oldest);
      if (evicted) sessionCacheChars -= evicted.body.length;
      sessionCache.delete(oldest);
    }
  }

  function forgetSessionBody(key: string): void {
    const prev = sessionCache.get(key);
    if (!prev) return;
    sessionCacheChars -= prev.body.length;
    sessionCache.delete(key);
  }

  function register(reg: SessionPollReg): () => void {
    const key = Symbol(reg.source);
    const cacheKey = sessionCacheKey(reg.daemonId, reg.source);
    const cached = cachedSession(cacheKey);
    regs.set(key, {
      reg,
      etag: cached?.etag ?? undefined,
      lastBody: cached?.body,
      messageHashes: cached?.messageHashes,
    });
    if (cached) {
      queueMicrotask(() => {
        if (regs.has(key)) reg.onSession(cached.body, cached.etag);
      });
    }
    return () => {
      regs.delete(key);
    };
  }

  function messageCursor(g: RegState): MessageCursorEntry[] | undefined {
    const hashes = g.messageHashes;
    if (!hashes || hashes.length === 0) return undefined;
    const out: MessageCursorEntry[] = [];
    const start = Math.max(0, hashes.length - 12);
    for (let index = hashes.length - 1; index >= start; index--) {
      const hash = hashes[index];
      if (hash) out.push({ index, hash });
    }
    return out;
  }

  function minMessages(g: RegState): number | undefined {
    const value = g.reg.getMinMessages?.();
    return Number.isInteger(value) && value && value > 0 ? value : undefined;
  }

  function applyPatchToBody(
    body: string | undefined,
    result: Extract<BatchResult, { status: 206 }>,
  ): string | null {
    if (!body) return null;
    try {
      const parsed = JSON.parse(body) as { messages?: unknown[] };
      const prevMessages = Array.isArray(parsed.messages)
        ? parsed.messages
        : [];
      parsed.messages = prevMessages
        .slice(result.patch.oldStart, result.patch.oldEnd)
        .concat(result.patch.messages);
      Object.assign(parsed, result.session);
      return JSON.stringify(parsed);
    } catch {
      return null;
    }
  }

  async function pollDaemon(daemonId: string | undefined, group: RegState[]) {
    // 1) One batched session request for every source on this daemon.
    const sessionGroup = group.filter(
      (g) => g.reg.shouldPollSession?.() !== false,
    );
    if (sessionGroup.length > 0) {
      try {
        const res = await deps.fetchImpl(
          apiUrl("/api/sessions/batch", daemonId),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sources: sessionGroup.map((g) => ({
                source: g.reg.source,
                etag: g.etag,
                messageCursor: messageCursor(g),
                minMessages: minMessages(g),
              })),
            }),
          },
        );
        if (res.ok) {
          const { results } = (await res.json()) as { results: BatchResult[] };
          const bySource = new Map(sessionGroup.map((g) => [g.reg.source, g]));
          for (const result of results) {
            const g = bySource.get(result.source);
            if (!g) continue;
            if (result.status === 200) {
              g.etag = result.etag;
              g.messageHashes = result.messageHashes;
              rememberSessionBody(
                sessionCacheKey(daemonId, result.source),
                result.body,
                result.etag,
                result.messageHashes,
              );
              if (result.body !== g.lastBody) {
                g.lastBody = result.body;
                g.reg.onSession(result.body, result.etag);
              }
            } else if (result.status === 206) {
              g.etag = result.etag;
              g.messageHashes = result.messageHashes;
              const cacheKey = sessionCacheKey(daemonId, result.source);
              if (g.reg.onSessionPatch) {
                g.lastBody = undefined;
                forgetSessionBody(cacheKey);
                g.reg.onSessionPatch(
                  { session: result.session, patch: result.patch },
                  result.etag,
                );
              } else {
                const patchedBody = applyPatchToBody(g.lastBody, result);
                if (patchedBody) {
                  g.lastBody = patchedBody;
                  rememberSessionBody(
                    cacheKey,
                    patchedBody,
                    result.etag,
                    result.messageHashes,
                  );
                  g.reg.onSession(patchedBody, result.etag);
                } else {
                  g.messageHashes = undefined;
                }
              }
            } else if (result.status === 304) {
              g.etag = result.etag;
            }
            // 403: source no longer allowed — leave the column's last state.
          }
        }
      } catch {
        // Network blip — keep cached state, try again next tick.
      }
    }

    // 2) One global active-sends poll for this daemon, sliced per column.
    let list = activeSendsList.get(daemonId) ?? [];
    try {
      const headers: Record<string, string> = {};
      const prev = activeSendsEtag.get(daemonId);
      if (prev) headers["If-None-Match"] = prev;
      const res = await deps.fetchImpl(apiUrl("/api/active-sends", daemonId), {
        headers,
      });
      if (res.status !== 304 && res.ok) {
        const etag = res.headers.get("ETag");
        if (etag) activeSendsEtag.set(daemonId, etag);
        list = (await res.json()) as InflightRec[];
        activeSendsList.set(daemonId, list);
      }
    } catch {
      // Best-effort indicator; keep the cached list.
    }
    for (const g of group) {
      const sid = g.reg.getSessionId();
      const slice = sid ? list.filter((r) => r.sessionId === sid) : [];
      const key = JSON.stringify(slice);
      if (key !== g.lastInflightKey) {
        g.lastInflightKey = key;
        g.reg.onInflight(slice);
      }
    }
  }

  async function runTick(): Promise<void> {
    if (deps.isIdle()) return;
    if (regs.size === 0) return;
    const byDaemon = new Map<string | undefined, RegState[]>();
    for (const g of regs.values()) {
      const arr = byDaemon.get(g.reg.daemonId);
      if (arr) arr.push(g);
      else byDaemon.set(g.reg.daemonId, [g]);
    }
    await Promise.all(
      [...byDaemon].map(([daemonId, group]) => pollDaemon(daemonId, group)),
    );
  }

  function tick(): Promise<void> {
    if (runningTick) {
      rerunRequested = true;
      return runningTick;
    }
    runningTick = (async () => {
      try {
        do {
          rerunRequested = false;
          await runTick();
        } while (rerunRequested);
      } finally {
        runningTick = null;
      }
    })();
    return runningTick;
  }

  return { register, tick, size: () => regs.size };
}

// --- Module singleton: real fetch + idle gate + a single 2 s interval -------

const POLL_INTERVAL_MS = 2_000;
const INITIAL_TICK_GRACE_MS = 50;

const singleton = createSessionPoller({
  fetchImpl: (...args) => fetch(...args),
  isIdle: isUiIdle,
});

let timer: ReturnType<typeof setInterval> | null = null;
let resumeOff: (() => void) | null = null;
let immediateTickTimer: ReturnType<typeof setTimeout> | null = null;

function ensureTimer() {
  if (timer !== null) return;
  timer = setInterval(() => void singleton.tick(), POLL_INTERVAL_MS);
  // One immediate catch-up when the user returns after an idle stretch.
  resumeOff = onResume(() => void singleton.tick());
}

function maybeStopTimer() {
  if (singleton.size() > 0) return;
  if (immediateTickTimer !== null) {
    clearTimeout(immediateTickTimer);
    immediateTickTimer = null;
  }
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (resumeOff) {
    resumeOff();
    resumeOff = null;
  }
}

function queueImmediateTick() {
  if (immediateTickTimer !== null) return;
  immediateTickTimer = setTimeout(() => {
    immediateTickTimer = null;
    void singleton.tick();
  }, INITIAL_TICK_GRACE_MS);
}

export function requestSessionPollNow(): Promise<void> {
  if (singleton.size() === 0) return Promise.resolve();
  return singleton.tick();
}

/**
 * Register a SessionView with the shared poller. Returns an unregister fn that
 * the caller MUST invoke on destroy. The 2 s timer starts on the first
 * registration and stops when the last column unregisters.
 */
export function registerSessionPoll(reg: SessionPollReg): () => void {
  const off = singleton.register(reg);
  ensureTimer();
  queueImmediateTick();
  return () => {
    off();
    maybeStopTimer();
  };
}
