/**
 * Global FIFO queue for repo-summary generations. The UI mounts a
 * `RepoRecentSummary` per repo on the dashboard; if each one fired
 * its own Ollama generation on mount, llama-3.2:3b spends 30s
 * sequentialising them anyway AND every visible row stalls because
 * Ollama serialises chat requests per model on a single GPU. So we
 * funnel them through one shared queue and only generate for rows
 * that are actually on screen.
 *
 * Each job is wrapped with a 3-minute timeout. The first auto-run
 * after Ollama loads a model into VRAM can take 60-120s (cold
 * start); 60s was cutting that off and surfacing as a misleading
 * "Stream interrupted" because some browsers throw TypeError instead
 * of AbortError when a stream reader is aborted mid-read. 180s gives
 * even a large model room to load without being aggressive enough
 * to mask a genuinely hung job.
 */

export type SummaryJob = (signal: AbortSignal) => Promise<void>;

interface QueueEntry {
  job: SummaryJob;
  cancelled: boolean;
  abort: () => void;
}

const queue: QueueEntry[] = [];
let running = false;

const JOB_TIMEOUT_MS = 180_000;

/**
 * Add a job to the back of the queue. Returns a cancel function:
 * - If the job hasn't started yet, it's marked cancelled and skipped.
 * - If it's already running, the wrapped AbortController is fired.
 *
 * Cheap to call: synchronously schedules a microtask to pump.
 */
export function enqueueSummary(job: SummaryJob): () => void {
  const entry: QueueEntry = {
    job,
    cancelled: false,
    abort: () => {},
  };
  queue.push(entry);
  queueMicrotask(() => void pump());
  return () => {
    entry.cancelled = true;
    entry.abort();
  };
}

export interface CachedSessionSummary {
  body?: string;
  frontmatter?: {
    model?: string;
    totalMessages?: number;
    title?: string;
  };
}

interface SessionSummaryResponse {
  summary?: CachedSessionSummary | null;
}

type SessionSummaryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const SESSION_SUMMARY_CONCURRENCY = 2;
const sessionSummaryCache = new Map<string, SessionSummaryResponse | null>();
const sessionSummaryInFlight = new Map<
  string,
  Promise<SessionSummaryResponse | null>
>();
const sessionSummaryQueue: (() => void)[] = [];
let activeSessionSummaryReads = 0;

function runSessionSummaryRead<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activeSessionSummaryReads += 1;
      job().then(resolve, reject).finally(() => {
        activeSessionSummaryReads = Math.max(0, activeSessionSummaryReads - 1);
        sessionSummaryQueue.shift()?.();
      });
    };
    if (activeSessionSummaryReads < SESSION_SUMMARY_CONCURRENCY) start();
    else sessionSummaryQueue.push(start);
  });
}

export function invalidateCachedSessionSummary(source: string): void {
  sessionSummaryCache.delete(source);
  sessionSummaryInFlight.delete(source);
}

export function __resetSessionSummaryLookupForTests(): void {
  sessionSummaryCache.clear();
  sessionSummaryInFlight.clear();
  sessionSummaryQueue.length = 0;
  activeSessionSummaryReads = 0;
}

export function loadCachedSessionSummary(
  source: string,
  url: string,
  fetchImpl: SessionSummaryFetch = globalThis.fetch.bind(globalThis),
): Promise<SessionSummaryResponse | null> {
  if (sessionSummaryCache.has(source)) {
    return Promise.resolve(sessionSummaryCache.get(source) ?? null);
  }
  const inFlight = sessionSummaryInFlight.get(source);
  if (inFlight) return inFlight;

  const promise = runSessionSummaryRead(async () => {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | SessionSummaryResponse
      | null;
    const result = body && typeof body === "object" ? body : null;
    sessionSummaryCache.set(source, result);
    return result;
  }).finally(() => {
    sessionSummaryInFlight.delete(source);
  });
  sessionSummaryInFlight.set(source, promise);
  return promise;
}

export function nextCachedSessionSummaryRequest(opts: {
  target: string | undefined | null;
  sessionLoaded: boolean;
  nearViewport: boolean;
  lastRequested: string | undefined;
}): string | null {
  const target = opts.target ?? "";
  if (!target) return opts.lastRequested !== "" ? "" : null;
  if (!opts.sessionLoaded || !opts.nearViewport) return null;
  return target !== opts.lastRequested ? target : null;
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.cancelled) continue;
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), JOB_TIMEOUT_MS);
      entry.abort = () => ac.abort();
      try {
        await entry.job(ac.signal);
      } catch {
        // The job is responsible for surfacing its own error;
        // swallowing here keeps a single failure from poisoning
        // the rest of the queue.
      } finally {
        clearTimeout(timeout);
      }
    }
  } finally {
    running = false;
  }
}
