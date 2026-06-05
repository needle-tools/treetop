/**
 * Drives a provision job's lifecycle on the LOCAL daemon (it owns the ssh
 * connection to the box). Spawning and registration are injected so the state
 * machine is unit-tested without a real box; server.ts wires the real
 * tar|ssh spawner and the decode→writeKey→addRemoteDaemon→openTunnel
 * registration. The pure decisions (argv, token, version drift) live in
 * provision.ts.
 *
 * States: running → registering → done | error | aborted. The job survives
 * a dialog reload (it lives here, not in the browser); the dialog reconnects
 * by streaming the accumulated output. Abort kills the ssh, which SIGHUPs a
 * half-finished install — recoverable because install.sh --no-pull is
 * idempotent.
 */

import { extractConnectionToken, type ProvisionTarget } from "./provision";

export type ProvisionStatus =
  | "running"
  | "registering"
  | "done"
  | "error"
  | "aborted";

/** The spawned ship+install process, abstracted for injection/testing.
 *  `output` interleaves stdout+stderr as decoded text chunks. */
export interface ProvisionProc {
  output: AsyncIterable<string>;
  exited: Promise<number>;
  kill(): void;
}

export interface ProvisionStartOpts {
  payloadRoot: string;
  /** How to ship `payloadRoot` — gzip-tar a packaged bundle vs git-archive a
   *  dev checkout. Forwarded to the spawner (see buildShipCommand). */
  mode?: "packaged" | "dev";
  target: ProvisionTarget;
  label?: string;
  /** "provision" (default): ship + install, then register the printed token.
   *  "uninstall": run the uninstaller (no ship), then unregister `daemonId`. */
  kind?: "provision" | "uninstall";
  /** The daemon to unregister on a successful uninstall. */
  daemonId?: string;
}

export interface ProvisionJobView {
  id: string;
  host: string;
  label?: string;
  status: ProvisionStatus;
  output: string;
  error?: string;
  daemonId?: string;
}

export interface ProvisionManagerDeps {
  /** Spawn the ship+install process for a job. */
  spawn: (opts: ProvisionStartOpts) => ProvisionProc;
  /** Register a captured connection token; resolves with the new daemon id.
   *  `hostOverride` is the host the user provisioned through (reachable from
   *  here), which beats the box's self-detected IP inside the token. */
  register: (token: string, hostOverride?: string) => Promise<{ id: string }>;
  /** Unregister a daemon after a successful uninstall (close tunnel + forget). */
  unregister?: (daemonId: string) => Promise<void>;
  /** Fresh job id. */
  newId: () => string;
}

interface Job extends ProvisionJobView {
  proc: ProvisionProc;
  aborted: boolean;
  done: Promise<void>;
  subscribers: Set<(chunk: string) => void>;
  kind: "provision" | "uninstall";
  /** For uninstall: the daemon to forget on success. */
  targetDaemonId?: string;
}

export class ProvisionManager {
  private jobs = new Map<string, Job>();
  constructor(private deps: ProvisionManagerDeps) {}

  start(opts: ProvisionStartOpts): string {
    const id = this.deps.newId();
    const proc = this.deps.spawn(opts);
    const job: Job = {
      id,
      host: opts.target.host,
      label: opts.label,
      status: "running",
      output: "",
      proc,
      aborted: false,
      subscribers: new Set(),
      done: Promise.resolve(),
      kind: opts.kind ?? "provision",
      targetDaemonId: opts.daemonId,
    };
    this.jobs.set(id, job);
    job.done = this.run(job);
    return id;
  }

  /** Resolves when the job reaches a terminal state. run() never rejects. */
  wait(id: string): Promise<void> {
    return this.jobs.get(id)?.done ?? Promise.resolve();
  }

  get(id: string): ProvisionJobView | undefined {
    const j = this.jobs.get(id);
    return j ? this.view(j) : undefined;
  }

  list(): ProvisionJobView[] {
    return [...this.jobs.values()].map((j) => this.view(j));
  }

  /** Live-stream subsequent output chunks. Returns an unsubscribe fn. The
   *  caller should also send the already-accumulated `output` first. */
  subscribe(id: string, cb: (chunk: string) => void): () => void {
    const job = this.jobs.get(id);
    if (!job) return () => {};
    job.subscribers.add(cb);
    return () => job.subscribers.delete(cb);
  }

  abort(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.aborted = true;
    job.status = "aborted";
    try {
      job.proc.kill();
    } catch {
      /* already gone */
    }
  }

  private view(j: Job): ProvisionJobView {
    return {
      id: j.id,
      host: j.host,
      label: j.label,
      status: j.status,
      output: j.output,
      error: j.error,
      daemonId: j.daemonId,
    };
  }

  private emit(job: Job, chunk: string): void {
    job.output += chunk;
    for (const cb of job.subscribers) {
      try {
        cb(chunk);
      } catch {
        /* a dead subscriber must not break the stream */
      }
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      for await (const chunk of job.proc.output) {
        if (job.aborted) break;
        this.emit(job, chunk);
      }
      const code = await job.proc.exited;
      if (job.aborted) {
        job.status = "aborted";
        return;
      }
      if (code !== 0) {
        job.error = `${job.kind === "uninstall" ? "uninstaller" : "installer"} exited with code ${code}`;
        job.status = "error";
        return;
      }
      if (job.kind === "uninstall") {
        job.status = "registering"; // shared "finishing" phase label
        this.emit(job, "\n[supergit] uninstalled on the box — removing here…\n");
        if (this.deps.unregister && job.targetDaemonId) {
          await this.deps.unregister(job.targetDaemonId);
        }
        job.status = "done";
        this.emit(job, "[supergit] removed.\n");
        return;
      }
      const token = extractConnectionToken(job.output);
      if (!token) {
        // Distinguish "ran but didn't finish" from "produced nothing at all"
        // — the latter (common on the unverified Windows path) means the
        // installer never really executed or hung before any output.
        job.error = job.output.trim()
          ? "the installer finished but printed no connection token — it likely failed before the end (check the log above)"
          : 'the installer produced NO output and no token — it may not have run (on Windows, confirm you picked "Windows" and that install.ps1 ran without prompting for input)';
        this.emit(job, `\n[supergit] ${job.error}\n`);
        job.status = "error";
        return;
      }
      job.status = "registering";
      this.emit(job, "\n[supergit] installer finished — registering daemon…\n");
      // Register at the host the user provisioned through (job.host), not the
      // box's self-detected IP in the token — see ProvisionManagerDeps.register.
      const daemon = await this.deps.register(token, job.host);
      job.daemonId = daemon.id;
      job.status = "done";
      this.emit(job, "[supergit] daemon connected.\n");
    } catch (e) {
      if (job.aborted) {
        job.status = "aborted";
      } else {
        job.error = String(e instanceof Error ? e.message : e);
        job.status = "error";
      }
    }
  }
}
