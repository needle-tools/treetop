/**
 * Wrap an idempotent async function so concurrent callers share the
 * same in-flight promise.
 *
 * Used by `load()` in App.svelte to coalesce the dashboard's many
 * `/api/repos` refreshes (initial mount + every SSE change/error + the
 * new-session poll timer + refreshes after every mutation). Without
 * this, an SSE burst can fan out two or three concurrent NDJSON
 * streams that all do the same git fan-out and race each other writing
 * into `repos`.
 *
 * Semantics:
 *  - While a call is in flight, every other call receives the same
 *    promise.
 *  - Once the in-flight call settles (resolve OR reject), the cache is
 *    cleared and the *next* call starts a fresh run.
 *  - A rejection does not poison the wrapper — a one-time failure
 *    must not wedge every future call into the same rejected promise.
 *  - `maxPendingMs` (optional) bounds how long a still-pending call may
 *    be shared. A `fetch()` that stalls while the machine sleeps never
 *    settles, so without this bound every later caller would receive the
 *    same dead promise and the dashboard would never refresh until a full
 *    page reload (observed as "dirty/ahead badges frozen until reload
 *    after sleep/lock"). When set, a caller arriving after the in-flight
 *    call has outlived the bound abandons it and starts a fresh run; the
 *    abandoned promise's late settlement is ignored (the `inFlight === p`
 *    guards no longer match it).
 */
export function singleFlight<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
  opts: { maxPendingMs?: number; clock?: () => number } = {},
): (...args: Args) => Promise<T> {
  const { maxPendingMs, clock = Date.now } = opts;
  let inFlight: Promise<T> | null = null;
  let startedAt = 0;
  return (...args: Args) => {
    if (
      inFlight &&
      (maxPendingMs === undefined || clock() - startedAt <= maxPendingMs)
    ) {
      return inFlight;
    }
    const p = fn(...args);
    inFlight = p;
    startedAt = clock();
    p.then(
      () => {
        if (inFlight === p) inFlight = null;
      },
      () => {
        if (inFlight === p) inFlight = null;
      },
    );
    return p;
  };
}
