/**
 * In-memory registry of agent subprocesses we've spawned but haven't
 * awaited (the `/api/session/send` path). Lets the UI see "N prompts
 * in flight" and cancel a runaway one.
 *
 * Lifetime: tied to the daemon process. A daemon restart wipes this
 * map; any orphaned child processes get re-parented to launchd/init
 * and continue running on their own. That's an acknowledged limitation
 * — the next step up is to persist PIDs and adopt on boot.
 */

export interface InflightProcess {
  pid: number;
  exited: Promise<unknown>;
  kill(signal?: string): void;
}

export interface InflightSendRecord {
  id: string;
  agent: string;
  sessionId: string;
  cwd: string;
  pid: number;
  /** First chars of the prompt — useful in a "what's running?" listing. */
  textPreview: string;
  startedAt: string;
}

interface Entry {
  record: InflightSendRecord;
  proc: InflightProcess;
}

const entries = new Map<string, Entry>();
let seq = 0;
/** Monotonic bump on every register/kill so callers can build cheap
 *  ETags ("revision:N") and short-circuit polls to 304 when nothing
 *  has changed since their last fetch. The UI polls this endpoint at
 *  ~22 Hz while a session is interactive; a stable revision makes
 *  those polls essentially free. */
let revision = 0;

export function getRevision(): number {
  return revision;
}

export function register(opts: {
  agent: string;
  sessionId: string;
  cwd: string;
  text: string;
  proc: InflightProcess;
}): InflightSendRecord {
  const id = `s_${Date.now().toString(36)}_${++seq}`;
  const record: InflightSendRecord = {
    id,
    agent: opts.agent,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    pid: opts.proc.pid,
    textPreview: opts.text.slice(0, 200),
    startedAt: new Date().toISOString(),
  };
  entries.set(id, { record, proc: opts.proc });
  revision++;
  // Auto-remove when the process exits on its own.
  void opts.proc.exited.then(
    () => {
      if (entries.delete(id)) revision++;
    },
    () => {
      if (entries.delete(id)) revision++;
    },
  );
  return record;
}

export function list(filter?: { sessionId?: string }): InflightSendRecord[] {
  let recs = [...entries.values()].map((e) => e.record);
  if (filter?.sessionId) {
    recs = recs.filter((r) => r.sessionId === filter.sessionId);
  }
  return recs;
}

export function kill(id: string): boolean {
  const entry = entries.get(id);
  if (!entry) return false;
  try {
    entry.proc.kill("SIGTERM");
  } catch {
    // already dead or unreachable
  }
  // SIGKILL fallback so a stuck child can't linger forever.
  setTimeout(() => {
    try {
      entry.proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 500);
  if (entries.delete(id)) revision++;
  return true;
}
