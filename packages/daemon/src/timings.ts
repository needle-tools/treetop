/**
 * Rolling latency recorder for hot paths.
 *
 * Records the last N=256 samples per named span and reports percentiles.
 * Sync, cheap, zero external dependencies.
 *
 * Usage:
 *   import { record, time, timeAsync, snapshot, reset } from "./timings";
 *
 *   // Manual:
 *   const t = performance.now();
 *   doWork();
 *   record("my-span", performance.now() - t);
 *
 *   // Auto-wrapped:
 *   const result = time("my-span", () => doWork());
 *   const result = await timeAsync("my-span", () => doWorkAsync());
 *
 *   // Inspect:
 *   console.log(snapshot()); // { "my-span": { count, p50, p95, max, last } }
 */

/** Maximum retained samples per span (ring-buffer capacity). */
const N = 256;

interface SpanState {
  /** Retained samples (up to N most recent). */
  buf: number[];
  /** Write position in the ring buffer (next slot to overwrite). */
  head: number;
  /** Total number of samples recorded (unbounded). */
  count: number;
  /** Most recently recorded value. */
  last: number;
}

const spans = new Map<string, SpanState>();

/**
 * Record a latency sample for the named span.
 * Non-finite or negative values are silently ignored (system boundary guard).
 */
export function record(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;

  let state = spans.get(name);
  if (!state) {
    state = { buf: [], head: 0, count: 0, last: 0 };
    spans.set(name, state);
  }

  if (state.buf.length < N) {
    state.buf.push(ms);
  } else {
    state.buf[state.head] = ms;
    state.head = (state.head + 1) % N;
  }
  state.count++;
  state.last = ms;
}

/**
 * Synchronously time `fn`, record the elapsed ms under `name`, and return
 * fn's return value. Records even if fn throws (via try/finally), re-throwing.
 */
export function time<T>(name: string, fn: () => T): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    record(name, performance.now() - start);
  }
}

/**
 * Asynchronously time `fn`, record the elapsed ms under `name`, and return
 * fn's resolved value. Records even if fn rejects (via try/finally), re-throwing.
 */
export async function timeAsync<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(name, performance.now() - start);
  }
}

/** Compute the p-th percentile (0–1) of a sorted copy of samples. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return round3(sorted[lo]!);
  const frac = idx - lo;
  return round3(sorted[lo]! * (1 - frac) + sorted[hi]! * frac);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export type SpanSnapshot = {
  count: number;
  p50: number;
  p95: number;
  max: number;
  last: number;
};

/**
 * Return a snapshot of all recorded spans.
 * Percentiles are computed over the retained window (up to N samples).
 * `count` is the total number of samples ever recorded (unbounded).
 * Unrecorded spans are absent from the result.
 */
export function snapshot(): Record<string, SpanSnapshot> {
  const out: Record<string, SpanSnapshot> = {};
  for (const [name, state] of spans) {
    if (state.count === 0) continue;
    const sorted = state.buf.slice().sort((a, b) => a - b);
    out[name] = {
      count: state.count,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1]!,
      last: round3(state.last),
    };
  }
  return out;
}

/**
 * Clear all recorded state. Primarily a test hook.
 */
export function reset(): void {
  spans.clear();
}
