import { test, expect, describe } from "bun:test";
import {
  ProvisionManager,
  type ProvisionProc,
} from "../src/provision-manager";

/**
 * The provision job lifecycle: spawn the ship+install ssh, stream its output
 * live to subscribers, and on a clean exit capture the connection token and
 * register the daemon. Spawning and registration are injected, so the whole
 * state machine (running → registering → done / error / aborted) is tested
 * without a real box, ssh, or tunnel.
 */

/** A scripted process: yields the given chunks, then exits with `code`. */
function scriptedProc(chunks: string[], code: number): ProvisionProc {
  let killed = false;
  return {
    output: (async function* () {
      for (const c of chunks) yield c;
    })(),
    exited: Promise.resolve(code),
    kill() {
      killed = true;
    },
    get killed() {
      return killed;
    },
  } as ProvisionProc & { killed: boolean };
}

/** A process that never finishes until kill() is called (for abort tests). */
function killableProc(): ProvisionProc & { killed: boolean } {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => (resolveExit = r));
  let killed = false;
  return {
    output: (async function* () {
      /* yields nothing; the job sits at `await exited` until killed */
    })(),
    exited,
    kill() {
      killed = true;
      resolveExit(143); // 128 + SIGTERM
    },
    get killed() {
      return killed;
    },
  };
}

function manager(
  proc: ProvisionProc,
  register: (token: string) => Promise<{ id: string }>,
) {
  let n = 0;
  return new ProvisionManager({
    spawn: () => proc,
    register,
    newId: () => `job${++n}`,
  });
}

const target = { host: "1.2.3.4", user: "root" };

describe("ProvisionManager — happy path", () => {
  test("streams output, captures the token, registers, and ends 'done'", async () => {
    const registered: string[] = [];
    const mgr = manager(
      scriptedProc(["installing…\n", "supergit1:TOKEN123\n"], 0),
      async (t) => {
        registered.push(t);
        return { id: "daemon-9" };
      },
    );
    const id = mgr.start({ payloadRoot: "/p", target });
    await mgr.wait(id);

    const job = mgr.get(id)!;
    expect(job.status).toBe("done");
    expect(job.daemonId).toBe("daemon-9");
    expect(registered).toEqual(["supergit1:TOKEN123"]);
    expect(job.output).toContain("installing…");
  });

  test("live subscribers receive each chunk as it arrives", async () => {
    const mgr = manager(scriptedProc(["a", "b", "supergit1:T"], 0), async () => ({
      id: "d",
    }));
    const seen: string[] = [];
    const id = mgr.start({ payloadRoot: "/p", target });
    mgr.subscribe(id, (chunk) => seen.push(chunk));
    await mgr.wait(id);
    expect(seen.join("")).toContain("a");
    expect(seen.join("")).toContain("b");
  });
});

describe("ProvisionManager — failure modes", () => {
  test("non-zero installer exit → 'error', register NOT called", async () => {
    let called = false;
    const mgr = manager(scriptedProc(["boom\n"], 1), async () => {
      called = true;
      return { id: "x" };
    });
    const id = mgr.start({ payloadRoot: "/p", target });
    await mgr.wait(id);
    expect(mgr.get(id)!.status).toBe("error");
    expect(called).toBe(false);
  });

  test("clean exit but no token → 'error'", async () => {
    const mgr = manager(scriptedProc(["all done, no token\n"], 0), async () => ({
      id: "x",
    }));
    const id = mgr.start({ payloadRoot: "/p", target });
    await mgr.wait(id);
    const job = mgr.get(id)!;
    expect(job.status).toBe("error");
    expect(job.error).toMatch(/token/i);
  });

  test("registration throwing → 'error'", async () => {
    const mgr = manager(scriptedProc(["supergit1:T\n"], 0), async () => {
      throw new Error("decode failed");
    });
    const id = mgr.start({ payloadRoot: "/p", target });
    await mgr.wait(id);
    expect(mgr.get(id)!.status).toBe("error");
    expect(mgr.get(id)!.error).toMatch(/decode failed/);
  });
});

describe("ProvisionManager — abort", () => {
  test("abort kills the process and ends 'aborted' (not 'error')", async () => {
    const proc = killableProc();
    const mgr = manager(proc, async () => ({ id: "x" }));
    const id = mgr.start({ payloadRoot: "/p", target });
    mgr.abort(id);
    await mgr.wait(id);
    expect(proc.killed).toBe(true);
    expect(mgr.get(id)!.status).toBe("aborted");
  });
});

describe("ProvisionManager — views", () => {
  test("get/list expose the host + status; start returns a fresh id", async () => {
    const mgr = manager(scriptedProc(["supergit1:T"], 0), async () => ({
      id: "d",
    }));
    const id = mgr.start({ payloadRoot: "/p", target, label: "hetzner" });
    expect(id).toBe("job1");
    const job = mgr.get(id)!;
    expect(job.host).toBe("1.2.3.4");
    expect(job.label).toBe("hetzner");
    expect(mgr.list().map((j) => j.id)).toContain(id);
    await mgr.wait(id);
  });
});
