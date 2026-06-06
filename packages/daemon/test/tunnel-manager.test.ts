import { test, expect, describe } from "bun:test";
import { buildSshTunnelArgs, TunnelManager } from "../src/tunnel-manager";
import type { RemoteDaemon } from "../src/workspace";

function daemon(over: Partial<RemoteDaemon> = {}): RemoteDaemon {
  return {
    id: "d1",
    label: "hetzner",
    host: "203.0.113.4",
    port: 7777,
    addedAt: "2026-05-30T00:00:00.000Z",
    ...over,
  };
}

// A fake child process standing in for `ssh -L …`. Records kill signals
// and lets the test resolve `exited` to simulate the tunnel dying. The
// real Bun.spawn is the only thing NOT exercised here (system boundary).
function fakeProc() {
  let resolveExit: (code: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  return {
    pid: 4242,
    signals: [] as string[],
    kill(sig?: number | NodeJS.Signals) {
      this.signals.push(String(sig ?? "SIGTERM"));
    },
    exited,
    die(code = 0) {
      resolveExit(code);
    },
  };
}

describe("buildSshTunnelArgs", () => {
  test("forwards localPort → remote loopback:port, non-interactive, -N", () => {
    const args = buildSshTunnelArgs(daemon(), 7801);
    // -N: no remote command, just the forward.
    expect(args).toContain("-N");
    // The local-forward spec: localPort:127.0.0.1:remotePort. MUST use the
    // literal 127.0.0.1, NOT "localhost" — the forward-only authorized_keys
    // restriction is `permitopen="127.0.0.1:<port>"`, matched literally, so
    // a `localhost` target is rejected ("administratively prohibited").
    expect(args).toContain("-L");
    expect(args).toContain("7801:127.0.0.1:7777");
    expect(args).not.toContain("7801:localhost:7777");
    // Destination is the bare host when no user is set.
    expect(args[args.length - 1]).toBe("203.0.113.4");
  });

  test("accepts a new host key non-interactively (no first-connect hang/fail)", () => {
    // BatchMode disables prompts, so on a never-seen host the default
    // StrictHostKeyChecking=ask would make ssh FAIL instead of connecting.
    // accept-new trusts a first-seen host but still rejects a CHANGED key
    // (MITM protection), which is the right default for an automated tunnel.
    const args = buildSshTunnelArgs(daemon(), 7801).join(" ");
    expect(args).toContain("StrictHostKeyChecking=accept-new");
  });

  test("prefixes user@host when a user is set", () => {
    const args = buildSshTunnelArgs(daemon({ user: "supergit" }), 7801);
    expect(args[args.length - 1]).toBe("supergit@203.0.113.4");
  });

  test("passes -p for a custom ssh port and -i for an identity", () => {
    const args = buildSshTunnelArgs(
      daemon({ sshPort: 2222, identityPath: "/keys/id_ed25519" }),
      7801,
    );
    const p = args.indexOf("-p");
    expect(p).toBeGreaterThan(-1);
    expect(args[p + 1]).toBe("2222");
    const i = args.indexOf("-i");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("/keys/id_ed25519");
  });

  test("uses non-interactive, fail-fast options (no hang on prompts)", () => {
    const args = buildSshTunnelArgs(daemon(), 7801).join(" ");
    // BatchMode: never prompt for a password (fail instead of hanging).
    expect(args).toContain("BatchMode=yes");
    // ExitOnForwardFailure: if the forward can't bind, ssh exits rather
    // than sitting there with a useless connection.
    expect(args).toContain("ExitOnForwardFailure=yes");
  });
});

describe("TunnelManager", () => {
  // `ready` controls the injected port-readiness check: true ⇒ the tunnel's
  // listener "came up" immediately, false ⇒ it never did (auth/host fail).
  function mk(ready = true) {
    const procs: ReturnType<typeof fakeProc>[] = [];
    const spawned: string[][] = [];
    let nextPort = 7801;
    const mgr = new TunnelManager({
      spawn: (argv) => {
        spawned.push(argv);
        const p = fakeProc();
        procs.push(p);
        return p;
      },
      allocatePort: async () => nextPort++,
      waitForPort: async () => ready,
      readyTimeoutMs: 50,
    });
    return { mgr, procs, spawned };
  }

  test("open() allocates a local port, spawns ssh, tracks the tunnel", async () => {
    const { mgr, procs, spawned } = mk();
    const t = await mgr.open(daemon());
    expect(t.localPort).toBe(7801);
    expect(spawned).toHaveLength(1);
    // The spawned argv must carry the allocated port's forward spec.
    expect(spawned[0]!.join(" ")).toContain("7801:127.0.0.1:7777");
    expect(procs).toHaveLength(1);
    expect(mgr.get("d1")?.localPort).toBe(7801);
  });

  test("open() waits for the listener and only returns once it's ready", async () => {
    // The readiness check must be consulted before open() resolves — that's
    // what closes the startup race (ssh binds -L a few hundred ms post-auth).
    let checkedPort: number | null = null;
    const mgr = new TunnelManager({
      spawn: () => fakeProc(),
      allocatePort: async () => 7900,
      waitForPort: async (port) => {
        checkedPort = port;
        return true;
      },
      readyTimeoutMs: 50,
    });
    const t = await mgr.open(daemon());
    expect(checkedPort).toBe(7900);
    expect(t.localPort).toBe(7900);
  });

  test("open() throws + tears down when the listener never comes up", async () => {
    const { mgr, procs } = mk(false); // readiness check resolves false
    await expect(mgr.open(daemon())).rejects.toThrow(/did not come up/);
    // the dead tunnel must NOT be tracked, and its ssh proc is killed
    expect(mgr.get("d1")).toBeUndefined();
    expect(procs[0]!.signals.length).toBeGreaterThan(0);
  });

  test("open() is idempotent per id: re-open returns the existing tunnel", async () => {
    const { mgr, spawned } = mk();
    const a = await mgr.open(daemon());
    const b = await mgr.open(daemon());
    expect(b.localPort).toBe(a.localPort);
    expect(spawned).toHaveLength(1); // not re-spawned
  });

  test("close() kills the ssh process and forgets the tunnel", async () => {
    const { mgr, procs } = mk();
    await mgr.open(daemon());
    expect(await mgr.close("d1")).toBe(true);
    expect(procs[0]!.signals.length).toBeGreaterThan(0);
    expect(mgr.get("d1")).toBeUndefined();
  });

  test("close() of an unknown id returns false", async () => {
    const { mgr } = mk();
    expect(await mgr.close("nope")).toBe(false);
  });

  test("a tunnel whose ssh process dies is dropped from tracking", async () => {
    const { mgr, procs } = mk();
    await mgr.open(daemon());
    procs[0]!.die(255); // ssh exited (e.g. connection dropped)
    await Promise.resolve(); // let the exited handler run
    expect(mgr.get("d1")).toBeUndefined();
  });

  test("close() then open() spawns a FRESH ssh (the reconnect path)", async () => {
    // The "Reconnect" button + the sleep/wake auto-heal both do close→open.
    // After close, open() must NOT hand back the dead tunnel — it spawns a
    // brand-new ssh on a new local port.
    const { mgr, spawned } = mk();
    const a = await mgr.open(daemon());
    await mgr.close("d1");
    const b = await mgr.open(daemon());
    expect(spawned).toHaveLength(2); // re-spawned, not reused
    expect(b.localPort).not.toBe(a.localPort);
    expect(mgr.get("d1")?.localPort).toBe(b.localPort);
  });

  test("emits log breadcrumbs for open / up / close (daemon.log trail)", async () => {
    const logs: string[] = [];
    const mgr = new TunnelManager({
      spawn: () => fakeProc(),
      allocatePort: async () => 7801,
      waitForPort: async () => true,
      readyTimeoutMs: 50,
      log: (m) => logs.push(m),
    });
    await mgr.open(daemon());
    await mgr.close("d1");
    const joined = logs.join("\n");
    expect(joined).toContain("[tunnel] opening hetzner");
    expect(joined).toContain("[tunnel] up: hetzner on :7801");
    expect(joined).toContain("[tunnel] closed d1");
  });

  test("logs when ssh exits on its own (the sleep/wake breadcrumb)", async () => {
    const logs: string[] = [];
    const procs: ReturnType<typeof fakeProc>[] = [];
    const mgr = new TunnelManager({
      spawn: () => {
        const p = fakeProc();
        procs.push(p);
        return p;
      },
      allocatePort: async () => 7801,
      waitForPort: async () => true,
      readyTimeoutMs: 50,
      log: (m) => logs.push(m),
    });
    await mgr.open(daemon());
    procs[0]!.die(255);
    await Promise.resolve();
    expect(logs.join("\n")).toMatch(/ssh for hetzner exited \(code 255\)/);
  });

  test("closeAll() kills every tracked tunnel (shutdown cleanup)", async () => {
    const { mgr, procs } = mk();
    await mgr.open(daemon({ id: "d1" }));
    await mgr.open(daemon({ id: "d2", host: "h2" }));
    await mgr.closeAll();
    expect(procs.every((p) => p.signals.length > 0)).toBe(true);
    expect(mgr.list()).toHaveLength(0);
  });
});

describe("TunnelManager — direct mode (two-daemon e2e seam)", () => {
  test("open() returns the remote's own port and spawns NO ssh", async () => {
    let spawned = 0;
    const mgr = new TunnelManager({
      direct: true,
      spawn: () => {
        spawned++;
        return fakeProc();
      },
      // allocatePort must NOT be consulted in direct mode — the local port
      // IS the remote's port (both daemons on loopback, no forward needed).
      allocatePort: async () => {
        throw new Error("allocatePort must not be called in direct mode");
      },
      waitForPort: async () => true,
      readyTimeoutMs: 50,
    });
    const t = await mgr.open(daemon({ port: 7790 }));
    expect(t.localPort).toBe(7790);
    expect(spawned).toBe(0);
    expect(mgr.get("d1")?.localPort).toBe(7790);
  });

  test("open() still waits for the remote port and throws if unreachable", async () => {
    let checkedPort: number | null = null;
    const mgr = new TunnelManager({
      direct: true,
      waitForPort: async (port) => {
        checkedPort = port;
        return false; // remote not up
      },
      readyTimeoutMs: 50,
    });
    await expect(mgr.open(daemon({ port: 7791 }))).rejects.toThrow(
      /not reachable/,
    );
    expect(checkedPort).toBe(7791);
    expect(mgr.get("d1")).toBeUndefined();
  });

  test("close() forgets a direct tunnel (no ssh proc to kill)", async () => {
    const mgr = new TunnelManager({ direct: true, waitForPort: async () => true });
    await mgr.open(daemon({ port: 7792 }));
    expect(await mgr.close("d1")).toBe(true);
    expect(mgr.get("d1")).toBeUndefined();
  });
});
