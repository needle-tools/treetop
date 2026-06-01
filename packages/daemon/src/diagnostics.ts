/**
 * Self-diagnostics for the supergit daemon (`/api/diagnose`).
 *
 * Answers "why isn't this working?" in one call — for a human, for Claude,
 * or for an agent triaging a remote-daemon connection. It works in both
 * roles:
 *   - On the LOCAL daemon: reports self-config (bind/port/workspace/ssh)
 *     AND probes each registered remote daemon through its tunnel.
 *   - On a REMOTE daemon (reached via the proxy): reports that daemon's
 *     self-config; it has no remotes of its own, so `daemons` is empty.
 *
 * The probing is injected (`probe(localPort)`), so the decision logic is a
 * PURE function unit-tested without real tunnels, ssh, or a second daemon.
 * `server.ts` wires the real workspace + TunnelManager + a real fetch probe
 * into it. See plans/PLAN-REMOTE-DAEMON.md.
 */

/** Self-config the daemon knows about itself, gathered at the route. */
export interface DaemonSelfInfo {
  /** Interface the daemon is bound to (`SUPERGIT_BIND`). */
  bind: string;
  port: number;
  workspace: string;
  version: string;
  /** True when bound to loopback only — the safe posture for a tunnelled
   *  deploy (unreachable except via the tunnel). False ⇒ bound to all
   *  interfaces; fine locally, a misconfig for a public remote box. */
  loopbackOnly: boolean;
  /** Whether LAN peer mode (session-share) is enabled. */
  peerModeEnabled: boolean;
  /** Absolute path to the `ssh` binary, or null if not on PATH. Null on a
   *  LOCAL daemon means it can't open tunnels to remote daemons at all. */
  sshPath: string | null;
}

/** One registered remote daemon, plus its live tunnel state at probe time. */
export interface RemoteDaemonProbeInput {
  id: string;
  label: string;
  host: string;
  port: number;
  /** Whether a tunnel is currently open for this daemon. */
  tunnelOpen: boolean;
  /** The local loopback port the tunnel forwards to, or null if no tunnel. */
  localPort: number | null;
}

/** Result of probing a remote daemon's `/api/health` through its tunnel. */
export interface ProbeResult {
  ok: boolean;
  /** Round-trip status, when reachable. */
  status?: string;
  /** The remote's reported version, when reachable. */
  version?: string;
  /** Error message when the probe failed (tunnel down, daemon not up, …). */
  error?: string;
}

export type Probe = (localPort: number) => Promise<ProbeResult>;

export interface RemoteDaemonDiagnostic extends RemoteDaemonProbeInput {
  /** Whether the remote daemon answered a health probe. */
  reachable: boolean;
  probe: ProbeResult | null;
  /** Human/agent-readable summary of this daemon's state. */
  summary: string;
}

export interface DiagnosticsReport {
  ok: boolean;
  role: "local" | "remote";
  self: DaemonSelfInfo & { warnings: string[] };
  daemons: RemoteDaemonDiagnostic[];
  /** Top-level human/agent-readable summary. */
  summary: string;
}

/** Per-daemon warnings about the SELF config that an operator/agent should
 *  act on. Pure — no I/O. */
function selfWarnings(self: DaemonSelfInfo, role: "local" | "remote"): string[] {
  const w: string[] = [];
  // A remote box bound to 0.0.0.0 exposes the (auth-less) daemon to the
  // network — the tunnel posture wants loopback-only. (The ssh-on-PATH
  // warning is added by the caller, which knows whether any remotes are
  // actually registered to reach.)
  if (role === "remote" && !self.loopbackOnly) {
    w.push(
      "bound to a non-loopback interface — a tunnelled remote daemon should set SUPERGIT_BIND=127.0.0.1",
    );
  }
  return w;
}

/**
 * Build the full diagnostics report. Pure: all I/O (tunnel state, the
 * health probe) is resolved by the caller and passed in / injected.
 *
 * `role` is "local" when this daemon has its own registered remotes to
 * probe; "remote" when it's being diagnosed as someone else's remote (no
 * remotes of its own). The caller decides — simplest rule: role is
 * "remote" when `daemons` is empty AND the request arrived via the proxy,
 * but since the report is identical either way we let the caller pass it.
 */
export async function buildDiagnostics(opts: {
  self: DaemonSelfInfo;
  role: "local" | "remote";
  daemons: RemoteDaemonProbeInput[];
  probe: Probe;
}): Promise<DiagnosticsReport> {
  const { self, role, daemons, probe } = opts;

  const warnings = selfWarnings(self, role);
  // ssh matters only if there are remotes to reach.
  if (self.sshPath === null && daemons.length > 0) {
    warnings.push(
      "ssh is not on PATH — tunnels to remote daemons cannot be opened",
    );
  }

  const results: RemoteDaemonDiagnostic[] = [];
  for (const d of daemons) {
    if (!d.tunnelOpen || d.localPort === null) {
      results.push({
        ...d,
        reachable: false,
        probe: null,
        summary: `${d.label} (${d.host}:${d.port}): no tunnel open`,
      });
      continue;
    }
    let result: ProbeResult;
    try {
      result = await probe(d.localPort);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    results.push({
      ...d,
      reachable: result.ok,
      probe: result,
      summary: result.ok
        ? `${d.label} (${d.host}:${d.port}): online via tunnel on :${d.localPort}` +
          (result.version ? ` (v${result.version})` : "")
        : `${d.label} (${d.host}:${d.port}): tunnel open on :${d.localPort} but health probe failed — ${result.error ?? "no response"}`,
    });
  }

  const unreachable = results.filter((r) => !r.reachable);
  const ok = warnings.length === 0 && unreachable.length === 0;

  let summary: string;
  if (role === "remote") {
    summary = `remote daemon v${self.version} on :${self.port} (${self.loopbackOnly ? "loopback-only" : "all interfaces"})`;
  } else if (daemons.length === 0) {
    summary = `local daemon v${self.version} on :${self.port}; no remote daemons registered`;
  } else {
    const okCount = results.length - unreachable.length;
    summary = `local daemon v${self.version}; ${okCount}/${results.length} remote daemon(s) reachable`;
  }
  if (warnings.length > 0) {
    summary += `; ${warnings.length} self warning(s)`;
  }

  return { ok, role, self: { ...self, warnings }, daemons: results, summary };
}
