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
 */
export function singleFlight<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
): (...args: Args) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return (...args: Args) => {
    if (inFlight) return inFlight;
    const p = fn(...args);
    inFlight = p;
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
