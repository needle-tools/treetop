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
  /** Called with the session JSON text whenever it changes (never for an
   *  unchanged 304), plus the ETag the daemon returned. */
  onSession: (bodyText: string, etag: string | null) => void;
  /** Called with this column's active-sends records whenever the slice
   *  changes (including transitions to/from empty). */
  onInflight: (list: InflightRec[]) => void;
}

type BatchResult =
  | { source: string; status: 200; etag: string; body: string }
  | { source: string; status: 304; etag: string }
  | { source: string; status: 403 };

interface RegState {
  reg: SessionPollReg;
  /** Last ETag we hold for this source — sent as the batch `etag` so the
   *  daemon can 304 us. */
  etag?: string;
  /** Last body text dispatched, to suppress duplicate onSession calls. */
  lastBody?: string;
  /** JSON of the last active-sends slice dispatched, for change detection. */
  lastInflightKey?: string;
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

export function createSessionPoller(deps: SessionPollerDeps): SessionPoller {
  const regs = new Map<symbol, RegState>();
  // Per-daemon active-sends cache so a 304 (nothing in flight) still lets us
  // recompute slices for newly-registered columns without a re-fetch.
  const activeSendsEtag = new Map<string | undefined, string>();
  const activeSendsList = new Map<string | undefined, InflightRec[]>();

  function register(reg: SessionPollReg): () => void {
    const key = Symbol(reg.source);
    regs.set(key, { reg });
    return () => {
      regs.delete(key);
    };
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
              if (result.body !== g.lastBody) {
                g.lastBody = result.body;
                g.reg.onSession(result.body, result.etag);
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

  async function tick(): Promise<void> {
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

  return { register, tick, size: () => regs.size };
}

// --- Module singleton: real fetch + idle gate + a single 2 s interval -------

const POLL_INTERVAL_MS = 2_000;

const singleton = createSessionPoller({
  fetchImpl: (...args) => fetch(...args),
  isIdle: isUiIdle,
});

let timer: ReturnType<typeof setInterval> | null = null;
let resumeOff: (() => void) | null = null;

function ensureTimer() {
  if (timer !== null) return;
  timer = setInterval(() => void singleton.tick(), POLL_INTERVAL_MS);
  // One immediate catch-up when the user returns after an idle stretch.
  resumeOff = onResume(() => void singleton.tick());
}

function maybeStopTimer() {
  if (singleton.size() > 0) return;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (resumeOff) {
    resumeOff();
    resumeOff = null;
  }
}

/**
 * Register a SessionView with the shared poller. Returns an unregister fn that
 * the caller MUST invoke on destroy. The 2 s timer starts on the first
 * registration and stops when the last column unregisters.
 */
export function registerSessionPoll(reg: SessionPollReg): () => void {
  const off = singleton.register(reg);
  ensureTimer();
  return () => {
    off();
    maybeStopTimer();
  };
}
