import { test, expect, describe } from "bun:test";
import { sampleCwds } from "../src/procs";

describe("sampleCwds", () => {
  test("returns this process's own cwd when given its pid", async () => {
    // process.pid is guaranteed alive while the test runs — no race with
    // exit. Bun runs tests in this very process, so process.cwd() must
    // match what lsof reports for the same pid.
    const cwds = await sampleCwds([process.pid]);
    expect(cwds.has(process.pid)).toBe(true);
    expect(cwds.get(process.pid)).toBe(process.cwd());
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
    expect(cwds.get(process.pid)).toBe(process.cwd());
    expect(cwds.has(99999999)).toBe(false);
  });
});
