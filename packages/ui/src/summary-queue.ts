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
