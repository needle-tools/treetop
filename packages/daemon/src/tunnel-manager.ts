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
}

export type TunnelSpawner = (argv: string[]) => TunnelProc;
export type PortAllocator = () => Promise<number>;

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
}

/**
 * Build the argv for the `ssh -L` tunnel (everything after the `ssh`
 * binary). Pure + exported so it can be asserted directly. Non-interactive
 * and fail-fast: BatchMode never prompts (fails instead of hanging in a
 * headless daemon), ExitOnForwardFailure exits if the local port can't
 * bind, and keepalives drop a dead connection promptly.
 */
export function buildSshTunnelArgs(
  daemon: RemoteDaemon,
  localPort: number,
): string[] {
  const args: string[] = [
    "-N", // no remote command — just the forward
    "-L",
    `${localPort}:localhost:${daemon.port}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
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

export class TunnelManager {
  private tunnels = new Map<string, Tunnel>();
  private readonly spawn: TunnelSpawner;
  private readonly allocatePort: PortAllocator;

  constructor(opts: TunnelManagerOptions = {}) {
    this.spawn =
      opts.spawn ??
      ((argv) => bunSpawn(["ssh", ...argv], { stdout: "ignore", stderr: "ignore" }));
    this.allocatePort = opts.allocatePort ?? allocateEphemeralPort;
  }

  /** Open (or return the existing) tunnel for a remote daemon. Idempotent
   *  per id so repeated attaches / reconnect attempts don't stack ssh
   *  processes. */
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
