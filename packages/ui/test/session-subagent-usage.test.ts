import { expect, test } from "bun:test";
import { createDaemonSubagentUsageLoader, createSubagentUsageTracker } from "../src/session-subagent-usage";
import type { SessionAgentUsage } from "@treetop/nicifier";

test("child usage discovers descendants once and never reloads its parent", async () => {
  const calls: string[] = [];
  let latest: ReadonlyMap<string, SessionAgentUsage> = new Map();
  const tracker = createSubagentUsageTracker(async id => {
    calls.push(id);
    return { childIds: id === "child" ? ["grandchild", "parent"] : ["child"], segments: [] };
  }, usage => { latest = usage; }, "parent");
  tracker.ensure(["child", "child"]);
  await Bun.sleep(10);
  expect(calls).toEqual(["child", "grandchild"]);
  expect([...latest.keys()]).toEqual(["child", "grandchild"]);
  tracker.stop();
});

test("stopping a source discards late child results", async () => {
  let resolve!: (value: SessionAgentUsage) => void;
  let updates = 0;
  const tracker = createSubagentUsageTracker(() => new Promise(done => { resolve = done; }), () => { updates++; });
  tracker.ensure(["child"]);
  tracker.stop();
  resolve({ segments: [], childIds: [] });
  await Bun.sleep(0);
  expect(updates).toBe(0);
});

test("a completion refresh queued during an in-flight read is not lost", async () => {
  let resolve!: (value: SessionAgentUsage) => void;
  let reads = 0;
  let latest: SessionAgentUsage | undefined;
  const tracker = createSubagentUsageTracker(async () => {
    reads++;
    if (reads === 1) return new Promise<SessionAgentUsage>(done => { resolve = done; });
    return { segments: [], childIds: [], complete: true };
  }, usage => { latest = usage.get("child"); });
  tracker.ensure(["child"]);
  tracker.ensure(["child"], true);
  resolve({ segments: [], childIds: [], complete: false });
  await Bun.sleep(10);
  expect(reads).toBe(2);
  expect(latest?.complete).toBe(true);
  tracker.stop();
});

test("live child usage reads only app-server and replaces corrected turn contents", async () => {
  let correction = false;
  const loader = createDaemonSubagentUsageLoader({ live: true, cwd: "/project", transport: {
    readThread: async ({ threadId }) => ({ thread: { id: threadId, createdAt: 1780000200, turns: [{ id: "turn", startedAt: 1780000201, items: [
      { id: correction ? "corrected" : "original", type: "tokenUsage", tokenUsage: { last: { inputTokens: correction ? 200 : 100, outputTokens: 10, totalTokens: correction ? 210 : 110 } } },
    ] }] }, nextCursor: null }),
  } as Parameters<typeof createDaemonSubagentUsageLoader>[0]["transport"] });
  expect((await loader("child")).segments.reduce((sum, s) => sum + s.usage.input, 0)).toBe(100);
  correction = true;
  expect((await loader("child")).segments.reduce((sum, s) => sum + s.usage.input, 0)).toBe(200);
});

test("live pagination establishes cumulative baselines across pages and preserves descendant identities", async () => {
  const calls: (string | null | undefined)[] = [];
  const loader = createDaemonSubagentUsageLoader({ live: true, cwd: "/project", transport: {
    readThread: async ({ threadId, cursor }) => {
      calls.push(cursor);
      const old = cursor === "older";
      return { thread: { id: threadId, turns: [{ id: old ? "old" : "new", startedAt: old ? 1780000201 : 1780000202, items: [
        { id: old ? "old-usage" : "new-usage", type: "tokenUsage", tokenUsage: { total: { inputTokens: old ? 100 : 300, outputTokens: 0, totalTokens: old ? 100 : 300 } } },
        ...(old ? [{ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "grandchild" }] : []),
      ] }] }, nextCursor: old ? null : "older" };
    },
  } as Parameters<typeof createDaemonSubagentUsageLoader>[0]["transport"] });
  const first = await loader("child");
  expect(first.segments.map(segment => segment.usage.input)).toEqual([100, 200]);
  expect(first.childIds).toEqual(["grandchild"]);
  expect(calls).toEqual([null, "older"]);
  calls.length = 0;
  expect(await loader("child")).toEqual(first);
  expect(calls).toEqual([null]);
});
