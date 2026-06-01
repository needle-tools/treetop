import { test, expect, describe } from "bun:test";
import {
  buildDiagnostics,
  type DaemonSelfInfo,
  type RemoteDaemonProbeInput,
  type Probe,
} from "../src/diagnostics";

/**
 * `/api/diagnose` decision logic. The probe (the only I/O) is injected, so
 * these run with no tunnels / ssh / second daemon. Pins the contract an
 * operator or agent relies on: warnings for misconfig, per-remote
 * reachability, and an overall ok flag.
 */

function self(over: Partial<DaemonSelfInfo> = {}): DaemonSelfInfo {
  return {
    bind: "127.0.0.1",
    port: 7777,
    workspace: "/var/lib/supergit/workspace",
    version: "0.1.0",
    loopbackOnly: true,
    peerModeEnabled: false,
    sshPath: "/usr/bin/ssh",
    ...over,
  };
}

function daemon(over: Partial<RemoteDaemonProbeInput> = {}): RemoteDaemonProbeInput {
  return {
    id: "d1",
    label: "hetzner",
    host: "1.2.3.4",
    port: 7777,
    tunnelOpen: true,
    localPort: 17777,
    ...over,
  };
}

const okProbe: Probe = async () => ({ ok: true, status: "ok", version: "0.1.0" });
const failProbe: Probe = async () => ({ ok: false, error: "connection refused" });
const throwProbe: Probe = async () => {
  throw new Error("boom");
};

describe("buildDiagnostics — local daemon, no remotes", () => {
  test("ok with an empty registry", async () => {
    const r = await buildDiagnostics({
      self: self(),
      role: "local",
      daemons: [],
      probe: okProbe,
    });
    expect(r.ok).toBe(true);
    expect(r.role).toBe("local");
    expect(r.daemons).toEqual([]);
    expect(r.summary).toMatch(/no remote daemons registered/);
  });

  test("does NOT warn about missing ssh when there are no remotes to reach", async () => {
    const r = await buildDiagnostics({
      self: self({ sshPath: null }),
      role: "local",
      daemons: [],
      probe: okProbe,
    });
    expect(r.self.warnings).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("buildDiagnostics — remote daemons probed via tunnel", () => {
  test("a reachable remote is ok with version in its summary", async () => {
    const r = await buildDiagnostics({
      self: self(),
      role: "local",
      daemons: [daemon()],
      probe: okProbe,
    });
    expect(r.ok).toBe(true);
    expect(r.daemons[0]!.reachable).toBe(true);
    expect(r.daemons[0]!.summary).toMatch(/online via tunnel on :17777/);
    expect(r.summary).toMatch(/1\/1 remote daemon\(s\) reachable/);
  });

  test("a daemon with no tunnel is unreachable, probe not attempted", async () => {
    let probed = false;
    const spy: Probe = async () => {
      probed = true;
      return { ok: true };
    };
    const r = await buildDiagnostics({
      self: self(),
      role: "local",
      daemons: [daemon({ tunnelOpen: false, localPort: null })],
      probe: spy,
    });
    expect(probed).toBe(false);
    expect(r.daemons[0]!.reachable).toBe(false);
    expect(r.daemons[0]!.summary).toMatch(/no tunnel open/);
    expect(r.ok).toBe(false);
  });

  test("tunnel open but health fails is reported distinctly", async () => {
    const r = await buildDiagnostics({
      self: self(),
      role: "local",
      daemons: [daemon()],
      probe: failProbe,
    });
    expect(r.daemons[0]!.reachable).toBe(false);
    expect(r.daemons[0]!.summary).toMatch(
      /tunnel open on :17777 but health probe failed — connection refused/,
    );
    expect(r.ok).toBe(false);
  });

  test("a probe that throws is caught and reported, not propagated", async () => {
    const r = await buildDiagnostics({
      self: self(),
      role: "local",
      daemons: [daemon()],
      probe: throwProbe,
    });
    expect(r.daemons[0]!.reachable).toBe(false);
    expect(r.daemons[0]!.probe?.error).toBe("boom");
  });

  test("mixed reachability: ok=false, count reflects only the reachable", async () => {
    const mixed: Probe = async (port) =>
      port === 17777 ? { ok: true, version: "0.1.0" } : { ok: false, error: "down" };
    const r = await buildDiagnostics({
      self: self(),
      role: "local",
      daemons: [
        daemon({ id: "a", localPort: 17777 }),
        daemon({ id: "b", label: "box2", localPort: 17778 }),
      ],
      probe: mixed,
    });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/1\/2 remote daemon\(s\) reachable/);
  });

  test("warns + not-ok when ssh is missing AND remotes are registered", async () => {
    const r = await buildDiagnostics({
      self: self({ sshPath: null }),
      role: "local",
      daemons: [daemon({ tunnelOpen: false, localPort: null })],
      probe: okProbe,
    });
    expect(r.self.warnings.some((w) => /ssh is not on PATH/.test(w))).toBe(true);
    expect(r.ok).toBe(false);
  });
});

describe("buildDiagnostics — remote role (this daemon diagnosed as someone's remote)", () => {
  test("loopback-only remote is clean", async () => {
    const r = await buildDiagnostics({
      self: self({ loopbackOnly: true }),
      role: "remote",
      daemons: [],
      probe: okProbe,
    });
    expect(r.ok).toBe(true);
    expect(r.role).toBe("remote");
    expect(r.summary).toMatch(/remote daemon v0\.1\.0 on :7777 \(loopback-only\)/);
  });

  test("warns when a remote daemon is bound to all interfaces", async () => {
    const r = await buildDiagnostics({
      self: self({ loopbackOnly: false, bind: "0.0.0.0" }),
      role: "remote",
      daemons: [],
      probe: okProbe,
    });
    expect(r.self.warnings.some((w) => /SUPERGIT_BIND=127\.0\.0\.1/.test(w))).toBe(
      true,
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/all interfaces/);
  });
});
