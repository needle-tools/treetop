import { spawn as bunSpawn } from "bun";
import type { RemoteDaemon } from "./workspace";

/**
 * Owns the SSH tunnels to remote daemons (Phase 4b — a remote box shown as
 * a folder row). For each attached RemoteDaemon the local daemon runs
 *
 *   ssh -N -L <localPort>:localhost:<remotePort> [opts] [user@]host
 *
 * forwarding a local loopback port to the remote daemon's loopback. The
 * reverse-proxy routes (`/api/daemons/<id>/*`) then talk to
 * `127.0.0.1:<localPort>`, which lands on the remote daemon as a genuine
 * loopback request → full API. See plans/PLAN-REMOTE-DAEMON.md.
 *
 * The actual `Bun.spawn(ssh, …)` is the only system-boundary side effect;
 * it's injected so the manager's logic (arg building, port allocation,
 * lifecycle bookkeeping) is unit-testable without a real SSH server.
 */

/** Minimal child-process surface the manager needs — a subset of Bun's
 *  Subprocess, so the real spawner and a test fake both satisfy it. */
export interface TunnelProc {
  readonly pid: number;
  kill(signal?: number | NodeJS.Signals): void;
  readonly exited: Promise<number>;
  /** ssh's stderr, when the spawner piped it. Read on a failed open() so
   *  the timeout error carries ssh's actual complaint (auth, host key,
   *  permission) instead of a generic "did not come up". Optional so test
   *  fakes don't have to provide it. */
  readonly stderr?: ReadableStream<Uint8Array>;
}

export type TunnelSpawner = (argv: string[]) => TunnelProc;
export type PortAllocator = () => Promise<number>;
/** Resolves true once `localhost:port` accepts a TCP connection (the ssh
 *  `-L` listener is up), false if it didn't within the deadline. Injected
 *  so the readiness wait is unit-testable without a real ssh process. */
export type PortReadyCheck = (
  port: number,
  timeoutMs: number,
) => Promise<boolean>;

export interface Tunnel {
  /** The RemoteDaemon.id this tunnel serves. */
  id: string;
  /** Local loopback port the proxy talks to. */
  localPort: number;
  proc: TunnelProc;
}

export interface TunnelManagerOptions {
  spawn?: TunnelSpawner;
  allocatePort?: PortAllocator;
  waitForPort?: PortReadyCheck;
  /** How long open() waits for the tunnel's local listener to come up
   *  before giving up. Default 15000ms — a Windows box cold-connecting (ssh
   *  ConnectTimeout=10 + Defender/ConPTY latency + the listener bind) routinely
   *  needs >8s, and the budget must exceed ConnectTimeout or we'd kill ssh
   *  mid-connect. Override per-box pressure with SUPERGIT_TUNNEL_READY_MS. */
  readyTimeoutMs?: number;
  /** Test/loopback mode: skip ssh entirely and proxy straight at the
   *  remote daemon's `127.0.0.1:<daemon.port>`. Used by the two-daemon e2e
   *  harness, which runs both daemons on localhost so there's no real
   *  network hop to tunnel — the "remote" is reachable directly. Gated by
   *  `SUPERGIT_TUNNEL_DIRECT=1` in server.ts; NEVER on in production (a real
   *  remote isn't on the client's loopback). See plans/PLAN-REMOTE-DAEMON.md
   *  "Two-daemon integration tests". */
  direct?: boolean;
  /** Where to send lifecycle breadcrumbs (open / up / ssh-exit / close).
   *  Defaults to a no-op; server.ts wires `console.log` so they land in
   *  `<workspace>/daemon.log` — the trail for "the remote went offline after
   *  the laptop slept" (the ssh exits on wake; the next request reopens). */
  log?: (msg: string) => void;
}

/** A stand-in TunnelProc for direct mode — there's no ssh child, so kill()
 *  is a no-op and `exited` never resolves (nothing to reap). */
function noopTunnelProc(): TunnelProc {
  return { pid: -1, kill() {}, exited: new Promise<number>(() => {}) };
}

/** Default readiness check: poll-connect to 127.0.0.1:port until it
 *  accepts (or the deadline passes). `ssh -L` binds the local listener
 *  only AFTER it authenticates — ~hundreds of ms — so a probe fired the
 *  instant open() returns gets "connection refused". This closes that
 *  race: open() awaits the listener so the first proxied request lands on
 *  a ready tunnel. */
async function defaultWaitForPort(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const sock = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: { data() {}, open() {}, close() {}, error() {} },
      });
      sock.end();
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(150);
    }
  }
}

/**
 * Build the argv for the `ssh -L` tunnel (everything after the `ssh`
 * binary). Pure + exported so it can be asserted directly. Non-interactive
 * and fail-fast: BatchMode never prompts (fails instead of hanging in a
 * headless daemon), ExitOnForwardFailure exits if the local port can't
 * bind, and keepalives drop a dead connection promptly.
 *
 * The forward target is the literal `127.0.0.1`, NOT `localhost`: the
 * installer's forward-only key restricts `permitopen="127.0.0.1:<port>"`,
 * which sshd matches literally — a `localhost` target is refused
 * ("administratively prohibited"). And StrictHostKeyChecking=accept-new
 * lets the FIRST connection to a new box succeed under BatchMode (which
 * otherwise turns the host-key prompt into a hard failure) while still
 * rejecting a later CHANGED key.
 */
export function buildSshTunnelArgs(
  daemon: RemoteDaemon,
  localPort: number,
): string[] {
  const args: string[] = [
    "-N", // no remote command — just the forward
    "-L",
    `${localPort}:127.0.0.1:${daemon.port}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    // Fail fast when the box is unreachable (asleep / network down) instead of
    // sitting in the OS's multi-minute TCP connect retry — so a reopen attempt
    // to a sleeping box gives up promptly and the next request can retry.
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (daemon.sshPort != null) {
    args.push("-p", String(daemon.sshPort));
  }
  if (daemon.identityPath) {
    args.push("-i", daemon.identityPath);
  }
  args.push(daemon.user ? `${daemon.user}@${daemon.host}` : daemon.host);
  return args;
}

/** Default port allocator: ask the OS for an ephemeral free TCP port by
 *  binding to :0 on loopback, reading the assigned port, then releasing
 *  it. There's an inherent (small) race between release and ssh binding;
 *  ExitOnForwardFailure makes a collision fail loudly rather than silently
 *  forward the wrong port. */
async function allocateEphemeralPort(): Promise<number> {
  const srv = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {} },
  });
  const port = srv.port;
  srv.stop(true);
  return port;
}

/** Best-effort read of an ssh proc's stderr for diagnostics. Returns the
 *  last few non-empty lines (the actionable ones — "Permission denied",
 *  "Host key verification failed", "Connection refused"), trimmed. Never
 *  throws and never blocks: the stream is already closed/closing by the
 *  time we read it on a failed open(). Returns "" when unavailable.
 *
 *  Drops benign banners so they don't masquerade as the failure reason:
 *  the host-key-added notice, and OpenSSH's post-quantum advisory
 *  ("** WARNING: connection is not using a post-quantum key exchange…") that
 *  newer ssh prints when the server is older. The PQ banner means kex
 *  actually SUCCEEDED, so reporting it as the error sent users chasing a
 *  non-problem when the real cause was just a slow listener bind. */
async function readStderr(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
  if (!stream) return "";
  try {
    const text = await new Response(stream).text();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(
        (l) =>
          l.length > 0 &&
          !l.startsWith("Warning: Permanently") &&
          !l.startsWith("**"), // OpenSSH PQ advisory banner — benign
      );
    return lines.slice(-3).join("; ").slice(0, 300);
  } catch {
    return "";
  }
}

export class TunnelManager {
  private tunnels = new Map<string, Tunnel>();
  private readonly spawn: TunnelSpawner;
  private readonly allocatePort: PortAllocator;
  private readonly waitForPort: PortReadyCheck;
  private readonly readyTimeoutMs: number;
  private readonly direct: boolean;
  private readonly log: (msg: string) => void;

  constructor(opts: TunnelManagerOptions = {}) {
    this.spawn =
      opts.spawn ??
      ((argv) => bunSpawn(["ssh", ...argv], { stdout: "ignore", stderr: "pipe" }));
    this.allocatePort = opts.allocatePort ?? allocateEphemeralPort;
    this.waitForPort = opts.waitForPort ?? defaultWaitForPort;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 15000;
    this.direct = opts.direct ?? false;
    this.log = opts.log ?? (() => {});
  }

  /** Open (or return the existing) tunnel for a remote daemon. Idempotent
   *  per id so repeated attaches / reconnect attempts don't stack ssh
   *  processes. Resolves only once the local forward is actually accepting
   *  connections — `ssh -L` binds the listener a few hundred ms after
   *  spawn (post-auth), so returning eagerly made the first proxied
   *  request race the listener and fail with "connection refused". */
  async open(daemon: RemoteDaemon): Promise<Tunnel> {
    const existing = this.tunnels.get(daemon.id);
    if (existing) return existing;

    if (this.direct) {
      // No ssh: the remote daemon is reachable directly on
      // 127.0.0.1:<daemon.port> (both daemons on localhost). Still wait for
      // it to accept connections so a not-yet-booted remote fails the same
      // way a dead tunnel would, with a clear message.
      const ready = await this.waitForPort(daemon.port, this.readyTimeoutMs);
      if (!ready) {
        throw new Error(
          `direct tunnel target 127.0.0.1:${daemon.port} ` +
            `(${daemon.label || daemon.host}) not reachable within ${this.readyTimeoutMs}ms`,
        );
      }
      const tunnel: Tunnel = {
        id: daemon.id,
        localPort: daemon.port,
        proc: noopTunnelProc(),
      };
      this.tunnels.set(daemon.id, tunnel);
      return tunnel;
    }

    const who = daemon.label || daemon.host;
    const localPort = await this.allocatePort();
    this.log(`[tunnel] opening ${who} → ssh -L ${localPort}:127.0.0.1:${daemon.port}`);
    const proc = this.spawn(buildSshTunnelArgs(daemon, localPort));
    const tunnel: Tunnel = { id: daemon.id, localPort, proc };
    this.tunnels.set(daemon.id, tunnel);

    // If ssh exits (connection dropped, auth failed, forward couldn't
    // bind), stop tracking it so the next open() spawns a fresh one. Guard
    // on identity: a later open() may have replaced this tunnel. This is the
    // sleep/wake path: the laptop wakes, ssh's keepalive trips, the proc
    // exits here, and the next proxied request reopens a fresh tunnel.
    void proc.exited.then((code) => {
      if (this.tunnels.get(daemon.id) === tunnel) {
        this.tunnels.delete(daemon.id);
        this.log(
          `[tunnel] ssh for ${who} exited (code ${code}) — will reopen on next request`,
        );
      }
    });

    // Wait for the listener. If it never comes up (auth failed, host
    // unreachable, forward rejected), tear down + throw so the caller
    // surfaces a real error instead of handing back a dead tunnel that
    // every request will fail against.
    const ready = await this.waitForPort(localPort, this.readyTimeoutMs);
    if (!ready) {
      this.tunnels.delete(daemon.id);
      // Grab ssh's own complaint (auth, host key, permission denied, …)
      // before killing it — a generic "did not come up" sent us chasing
      // ghosts; ssh's stderr is the actual diagnosis.
      const sshErr = await readStderr(proc.stderr);
      try {
        proc.kill();
      } catch {
        // already dead
      }
      const detail = sshErr ? ` — ssh said: ${sshErr}` : "";
      this.log(`[tunnel] failed to open ${who}${detail}`);
      throw new Error(
        `tunnel to ${who} did not come up within ${this.readyTimeoutMs}ms${detail}`,
      );
    }

    this.log(`[tunnel] up: ${who} on :${localPort}`);
    return tunnel;
  }

  get(id: string): Tunnel | undefined {
    return this.tunnels.get(id);
  }

  list(): Tunnel[] {
    return [...this.tunnels.values()];
  }

  /** Close one tunnel: kill its ssh process and forget it. Returns false
   *  if no tunnel was tracked for that id. */
  async close(id: string): Promise<boolean> {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return false;
    this.tunnels.delete(id);
    try {
      tunnel.proc.kill();
    } catch (e) {
      // Usually "already dead" — benign, but leave a breadcrumb on the
      // existing log channel so an unexpected kill failure isn't silent.
      this.log(
        `[tunnel] kill ${id} threw (likely already dead): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.log(`[tunnel] closed ${id}`);
    return true;
  }

  /** Kill every tunnel. Called from the daemon's shutdown handler so no
   *  orphan ssh processes survive the daemon. */
  async closeAll(): Promise<void> {
    const ids = [...this.tunnels.keys()];
    for (const id of ids) await this.close(id);
  }
}
