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
  function mk() {
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

  test("closeAll() kills every tracked tunnel (shutdown cleanup)", async () => {
    const { mgr, procs } = mk();
    await mgr.open(daemon({ id: "d1" }));
    await mgr.open(daemon({ id: "d2", host: "h2" }));
    await mgr.closeAll();
    expect(procs.every((p) => p.signals.length > 0)).toBe(true);
    expect(mgr.list()).toHaveLength(0);
  });
});
