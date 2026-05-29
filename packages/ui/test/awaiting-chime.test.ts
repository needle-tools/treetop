import { test, expect, describe } from "bun:test";
import {
  AWAITING_CHIME_MS,
  createAwaitingChimeState,
  syncAwaiting,
  dueForChime,
} from "../src/awaiting-chime";

describe("syncAwaiting", () => {
  test("stamps a newly-awaiting source with the current time", () => {
    const s = createAwaitingChimeState();
    syncAwaiting(s, ["a"], 1000);
    expect(s.since.get("a")).toBe(1000);
  });

  test("keeps the original stamp across repeated syncs (continuous episode)", () => {
    const s = createAwaitingChimeState();
    syncAwaiting(s, ["a"], 1000);
    syncAwaiting(s, ["a"], 5000);
    expect(s.since.get("a")).toBe(1000);
  });

  test("drops a source that stopped awaiting and clears its fired latch", () => {
    const s = createAwaitingChimeState();
    syncAwaiting(s, ["a"], 0);
    dueForChime(s, AWAITING_CHIME_MS); // latch it
    expect(s.fired.has("a")).toBe(true);
    syncAwaiting(s, [], AWAITING_CHIME_MS + 1);
    expect(s.since.has("a")).toBe(false);
    expect(s.fired.has("a")).toBe(false);
  });
});

describe("dueForChime", () => {
  test("does not fire before the grace period elapses", () => {
    const s = createAwaitingChimeState();
    syncAwaiting(s, ["a"], 0);
    expect(dueForChime(s, AWAITING_CHIME_MS - 1)).toEqual([]);
  });

  test("fires once the grace period elapses", () => {
    const s = createAwaitingChimeState();
    syncAwaiting(s, ["a"], 0);
    expect(dueForChime(s, AWAITING_CHIME_MS)).toEqual(["a"]);
  });

  test("latches: the same episode only chimes once", () => {
    const s = createAwaitingChimeState();
    syncAwaiting(s, ["a"], 0);
    expect(dueForChime(s, AWAITING_CHIME_MS)).toEqual(["a"]);
    expect(dueForChime(s, AWAITING_CHIME_MS + 5000)).toEqual([]);
  });

  test("a fresh awaiting episode after recovery chimes again", () => {
    const s = createAwaitingChimeState();
    syncAwaiting(s, ["a"], 0);
    dueForChime(s, AWAITING_CHIME_MS);
    // session replies / goes back to work, then stalls again
    syncAwaiting(s, [], AWAITING_CHIME_MS + 1);
    syncAwaiting(s, ["a"], 200_000);
    expect(dueForChime(s, 200_000 + AWAITING_CHIME_MS)).toEqual(["a"]);
  });

  test("reports every source that crossed the threshold this tick", () => {
    const s = createAwaitingChimeState();
    syncAwaiting(s, ["a", "b"], 0);
    expect(dueForChime(s, AWAITING_CHIME_MS).sort()).toEqual(["a", "b"]);
  });
});
