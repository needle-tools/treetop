import { test, expect, describe } from "bun:test";
import {
  sampleCwds,
  discoverRepoProcesses,
  sampleProcs,
  normalizeCpuPercent,
  throttleAsync,
} from "../src/procs";

const isWin = process.platform === "win32";

describe("normalizeCpuPercent", () => {
  test("scales a summed-across-cores reading down to machine-relative %", () => {
    // 800% on an 8-core box = every core pegged = 100% of the whole machine.
    expect(normalizeCpuPercent(800, 8)).toBe(100);
    // two full cores out of eight = 25% of the machine.
    expect(normalizeCpuPercent(200, 8)).toBe(25);
    // ~a third of one core on a 16-thread box ≈ 2.25% of the machine.
    expect(normalizeCpuPercent(36, 16)).toBeCloseTo(2.25, 5);
  });

  test("a single-core machine is a no-op (per-core == machine)", () => {
    expect(normalizeCpuPercent(36, 1)).toBe(36);
  });

  test("clamps junk / idle readings to 0", () => {
    expect(normalizeCpuPercent(0, 8)).toBe(0);
    expect(normalizeCpuPercent(-5, 8)).toBe(0);
    expect(normalizeCpuPercent(NaN, 8)).toBe(0);
  });

  test("falls back to the raw value when the core count is bogus", () => {
    // Never divide by zero / negative — show the raw number instead.
    expect(normalizeCpuPercent(50, 0)).toBe(50);
    expect(normalizeCpuPercent(50, NaN)).toBe(50);
  });
});

describe("throttleAsync", () => {
  test("reuses the cached value for calls within the TTL window", async () => {
    let now = 1_000;
    let calls = 0;
    const get = throttleAsync(
      async () => ++calls,
      5_000,
      () => now,
    );
    expect(await get()).toBe(1);
    now = 2_000; // +1s, inside the 5s window
    expect(await get()).toBe(1);
    now = 5_999; // +4.999s, still inside
    expect(await get()).toBe(1);
    expect(calls).toBe(1);
  });

  test("re-runs the producer once the TTL has elapsed", async () => {
    let now = 0;
    let calls = 0;
    const get = throttleAsync(
      async () => ++calls,
      5_000,
      () => now,
    );
    expect(await get()).toBe(1);
    now = 5_001;
    expect(await get()).toBe(2);
    expect(calls).toBe(2);
  });

  test("concurrent callers share a single in-flight producer run", async () => {
    let now = 0;
    let calls = 0;
    let release!: (v: number) => void;
    const gate = new Promise<number>((r) => (release = r));
    const get = throttleAsync(
      async () => {
        calls++;
        return gate;
      },
      5_000,
      () => now,
    );
    const a = get();
    const b = get();
    release(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(calls).toBe(1);
  });

  test("a rejected run isn't cached — the next call retries", async () => {
    let now = 0;
    let calls = 0;
    const get = throttleAsync(
      async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return 42;
      },
      5_000,
      () => now,
    );
    await expect(get()).rejects.toThrow("boom");
    // same TTL window, but the failure cleared inflight and never cached
    expect(await get()).toBe(42);
    expect(calls).toBe(2);
  });
});

describe("sampleProcs", () => {
  test("reports this process within a machine-relative 0..100 band", async () => {
    const out = await sampleProcs([process.pid]);
    const s = out.get(process.pid);
    expect(s).toBeDefined();
    expect(s!.cpuPercent).toBeGreaterThanOrEqual(0);
    // Normalized: even a fully-pegged machine tops out near 100, not N*100.
    expect(s!.cpuPercent).toBeLessThanOrEqual(101);
    expect(s!.memBytes).toBeGreaterThan(0);
  });

  test("fills zeros for a pid that isn't running", async () => {
    const out = await sampleProcs([99999999]);
    expect(out.get(99999999)).toEqual({
      pid: 99999999,
      cpuPercent: 0,
      memBytes: 0,
    });
  });
});

describe("sampleCwds", () => {
  test("returns this process's own cwd when given its pid", async () => {
    // process.pid is guaranteed alive while the test runs — no race with
    // exit. Bun runs tests in this very process, so process.cwd() must
    // match what lsof reports for the same pid.
    // On Windows sampleCwds is unimplemented and returns an empty map.
    const cwds = await sampleCwds([process.pid]);
    if (isWin) {
      expect(cwds.size).toBe(0);
    } else {
      expect(cwds.has(process.pid)).toBe(true);
      expect(cwds.get(process.pid)).toBe(process.cwd());
    }
  });

  test("returns an empty map when given an empty pid list", async () => {
    const cwds = await sampleCwds([]);
    expect(cwds.size).toBe(0);
  });

  test("silently omits a pid that doesn't exist", async () => {
    // PIDs above 2^22 are essentially never assigned on modern systems.
    // lsof prints nothing for them; sampleCwds returns an empty map.
    const cwds = await sampleCwds([99999999]);
    expect(cwds.has(99999999)).toBe(false);
  });

  test("handles a mix of live + dead pids without crashing", async () => {
    const cwds = await sampleCwds([process.pid, 99999999]);
    if (isWin) {
      expect(cwds.size).toBe(0);
    } else {
      expect(cwds.get(process.pid)).toBe(process.cwd());
      expect(cwds.has(99999999)).toBe(false);
    }
  });
});

describe("discoverRepoProcesses", () => {
  test("discovers this process when its cwd is listed as a repo path", async () => {
    if (isWin) return;
    const cwd = process.cwd();
    const results = await discoverRepoProcesses([cwd], new Set());
    const self = results.find((r) => r.pid === process.pid);
    expect(self).toBeDefined();
    expect(self!.cwd).toBe(cwd);
    expect(self!.comm).toBeTruthy();
    expect(typeof self!.cpuPercent).toBe("number");
    expect(typeof self!.memBytes).toBe("number");
  });

  test("discovers processes in subfolders of repo paths", async () => {
    if (isWin) return;
    const cwd = process.cwd();
    const parent = cwd.split("/").slice(0, -1).join("/");
    if (!parent) return;
    const results = await discoverRepoProcesses([parent], new Set());
    const self = results.find((r) => r.pid === process.pid);
    expect(self).toBeDefined();
  });

  test("excludes pids in the exclude set", async () => {
    if (isWin) return;
    const cwd = process.cwd();
    const results = await discoverRepoProcesses([cwd], new Set([process.pid]));
    const self = results.find((r) => r.pid === process.pid);
    expect(self).toBeUndefined();
  });

  test("returns empty for unrelated paths", async () => {
    if (isWin) return;
    const results = await discoverRepoProcesses(
      ["/tmp/__nonexistent_repo_path_test__"],
      new Set(),
    );
    expect(results.length).toBe(0);
  });

  test("returns empty for empty repo paths", async () => {
    const results = await discoverRepoProcesses([], new Set());
    expect(results.length).toBe(0);
  });
});
