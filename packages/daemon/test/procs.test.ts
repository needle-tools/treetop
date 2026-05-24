import { test, expect, describe } from "bun:test";
import { sampleCwds, discoverRepoProcesses } from "../src/procs";

const isWin = process.platform === "win32";

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
    const results = await discoverRepoProcesses(
      [cwd],
      new Set([process.pid]),
    );
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
