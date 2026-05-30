import { test, expect, describe } from "bun:test";
import {
  ATTENTION_CHIME_MS,
  createAttentionChimeState,
  syncAttention,
  dueForChime,
  attentionSince,
} from "../src/attention-chime";

const awaiting = (source: string) => ({ source, awaiting: true });
const finished = (source: string, finishedAt: number) => ({
  source,
  awaiting: false,
  finishedAt,
});

describe("awaiting episodes", () => {
  test("stamps a newly-awaiting source and keeps the stamp across syncs", () => {
    const s = createAttentionChimeState();
    syncAttention(s, [awaiting("a")], 1000);
    syncAttention(s, [awaiting("a")], 5000);
    expect(s.awaitingSince.get("a")).toBe(1000);
    expect(attentionSince(s, awaiting("a"))).toBe(1000);
  });

  test("fires once the grace period elapses, then latches", () => {
    const s = createAttentionChimeState();
    syncAttention(s, [awaiting("a")], 0);
    expect(dueForChime(s, [awaiting("a")], ATTENTION_CHIME_MS - 1)).toEqual([]);
    expect(dueForChime(s, [awaiting("a")], ATTENTION_CHIME_MS)).toEqual(["a"]);
    expect(dueForChime(s, [awaiting("a")], ATTENTION_CHIME_MS + 9000)).toEqual(
      [],
    );
  });

  test("a fresh awaiting episode after recovery chimes again", () => {
    const s = createAttentionChimeState();
    syncAttention(s, [awaiting("a")], 0);
    dueForChime(s, [awaiting("a")], ATTENTION_CHIME_MS);
    // stops awaiting, then stalls again later
    syncAttention(s, [{ source: "a", awaiting: false }], ATTENTION_CHIME_MS + 1);
    syncAttention(s, [awaiting("a")], 200_000);
    expect(
      dueForChime(s, [awaiting("a")], 200_000 + ATTENTION_CHIME_MS),
    ).toEqual(["a"]);
  });
});

describe("finished (unread) episodes", () => {
  test("uses finishedAt directly as the episode start — no flicker tracking", () => {
    const s = createAttentionChimeState();
    const e = finished("a", 1000);
    expect(attentionSince(s, e)).toBe(1000);
    syncAttention(s, [e], 1000);
    expect(s.awaitingSince.has("a")).toBe(false);
  });

  test("fires once 60s after the turn finished, latched per finishedAt", () => {
    const s = createAttentionChimeState();
    const e = finished("a", 1000);
    syncAttention(s, [e], 1000);
    expect(dueForChime(s, [e], 1000 + ATTENTION_CHIME_MS - 1)).toEqual([]);
    expect(dueForChime(s, [e], 1000 + ATTENTION_CHIME_MS)).toEqual(["a"]);
    expect(dueForChime(s, [e], 1000 + ATTENTION_CHIME_MS + 5000)).toEqual([]);
  });

  test("a new turn (different finishedAt) chimes again", () => {
    const s = createAttentionChimeState();
    const e1 = finished("a", 1000);
    syncAttention(s, [e1], 1000);
    dueForChime(s, [e1], 1000 + ATTENTION_CHIME_MS);
    const e2 = finished("a", 500_000);
    syncAttention(s, [e2], 500_000);
    expect(dueForChime(s, [e2], 500_000 + ATTENTION_CHIME_MS)).toEqual(["a"]);
  });

  test("clears the latch when the source stops needing attention", () => {
    const s = createAttentionChimeState();
    const e = finished("a", 0);
    syncAttention(s, [e], 0);
    dueForChime(s, [e], ATTENTION_CHIME_MS);
    expect(s.fired.has("a")).toBe(true);
    // user focused it: finishedAt cleared, no longer awaiting
    syncAttention(s, [{ source: "a", awaiting: false }], ATTENTION_CHIME_MS + 1);
    expect(s.fired.has("a")).toBe(false);
  });
});

describe("priority + mixed sources", () => {
  test("finishedAt wins over awaiting when both are present", () => {
    const s = createAttentionChimeState();
    syncAttention(s, [awaiting("a")], 90_000); // awaiting run starts late
    const both = { source: "a", awaiting: true, finishedAt: 1000 };
    expect(attentionSince(s, both)).toBe(1000);
  });

  test("reports every source that crossed the threshold this tick", () => {
    const s = createAttentionChimeState();
    const entries = [awaiting("a"), finished("b", 0)];
    syncAttention(s, entries, 0);
    expect(dueForChime(s, entries, ATTENTION_CHIME_MS).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  test("forgets bookkeeping for sources that disappear", () => {
    const s = createAttentionChimeState();
    syncAttention(s, [awaiting("a")], 0);
    syncAttention(s, [], 1000);
    expect(s.awaitingSince.has("a")).toBe(false);
  });
});
