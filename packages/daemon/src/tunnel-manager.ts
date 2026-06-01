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
   *  before giving up. Default 8000ms. */
  readyTimeoutMs?: number;
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
 *  time we read it on a failed open(). Returns "" when unavailable. */
async function readStderr(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
  if (!stream) return "";
  try {
    const text = await new Response(stream).text();
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("Warning: Permanently"));
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

  constructor(opts: TunnelManagerOptions = {}) {
    this.spawn =
      opts.spawn ??
      ((argv) => bunSpawn(["ssh", ...argv], { stdout: "ignore", stderr: "pipe" }));
    this.allocatePort = opts.allocatePort ?? allocateEphemeralPort;
    this.waitForPort = opts.waitForPort ?? defaultWaitForPort;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 8000;
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

    const localPort = await this.allocatePort();
    const proc = this.spawn(buildSshTunnelArgs(daemon, localPort));
    const tunnel: Tunnel = { id: daemon.id, localPort, proc };
    this.tunnels.set(daemon.id, tunnel);

    // If ssh exits (connection dropped, auth failed, forward couldn't
    // bind), stop tracking it so the next open() spawns a fresh one. Guard
    // on identity: a later open() may have replaced this tunnel.
    void proc.exited.then(() => {
      if (this.tunnels.get(daemon.id) === tunnel) {
        this.tunnels.delete(daemon.id);
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
      throw new Error(
        `tunnel to ${daemon.label || daemon.host} did not come up within ${this.readyTimeoutMs}ms${detail}`,
      );
    }

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
    } catch {
      // already dead — nothing to do
    }
    return true;
  }

  /** Kill every tunnel. Called from the daemon's shutdown handler so no
   *  orphan ssh processes survive the daemon. */
  async closeAll(): Promise<void> {
    const ids = [...this.tunnels.keys()];
    for (const id of ids) await this.close(id);
  }
}
