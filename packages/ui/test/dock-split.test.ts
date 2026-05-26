import { describe, expect, test } from "bun:test";
import { splitDockEntries, type SplittableDockEntry } from "../src/dock-split";

function entry(
  repoId: string,
  source: string,
  exited = false,
): SplittableDockEntry {
  return { repoId, source, exited };
}

describe("splitDockEntries", () => {
  test("empty list → empty top and bottom", () => {
    expect(splitDockEntries([], true)).toEqual({ top: [], bottom: [] });
  });

  test("single entry → goes to top", () => {
    const e = entry("r1", "s1");
    expect(splitDockEntries([e], true)).toEqual({ top: [e], bottom: [] });
  });

  test("two entries, different repos → one each side", () => {
    const a = entry("r1", "s1");
    const b = entry("r2", "s2");
    const result = splitDockEntries([a, b], true);
    expect(result.top).toEqual([a]);
    expect(result.bottom).toEqual([b]);
  });

  test("two entries, same repo → not split (all top)", () => {
    const a = entry("r1", "s1");
    const b = entry("r1", "s2");
    const result = splitDockEntries([a, b], true);
    // Can't split a single repo group, so all go to whichever
    // half keeps them together. Closer to even = top.
    expect(result.top).toEqual([a, b]);
    expect(result.bottom).toEqual([]);
  });

  test("4 entries: 2 repoA + 2 repoB → even split", () => {
    const a1 = entry("r1", "a1");
    const a2 = entry("r1", "a2");
    const b1 = entry("r2", "b1");
    const b2 = entry("r2", "b2");
    const result = splitDockEntries([a1, a2, b1, b2], true);
    expect(result.top).toEqual([a1, a2]);
    expect(result.bottom).toEqual([b1, b2]);
  });

  test("picks the split closest to the midpoint", () => {
    // 1 repoA + 4 repoB + 1 repoC = 6 entries, midpoint = 3
    // Split after repoA (1 top, 5 bottom) = imbalance 4
    // Split after repoB (5 top, 1 bottom) = imbalance 4
    // Both equally bad; pick the first that's >= midpoint.
    const a = entry("r1", "a");
    const b1 = entry("r2", "b1");
    const b2 = entry("r2", "b2");
    const b3 = entry("r2", "b3");
    const b4 = entry("r2", "b4");
    const c = entry("r3", "c");
    const result = splitDockEntries([a, b1, b2, b3, b4, c], true);
    // After repoA: top=1, bottom=5, diff=4
    // After repoB: top=5, bottom=1, diff=4
    // Tie — prefer the split closest to midpoint (3).
    // After repoA: top end = 1, distance from 3 = 2
    // After repoB: top end = 5, distance from 3 = 2
    // Same distance — prefer the first (smaller top).
    expect(result.top).toEqual([a]);
    expect(result.bottom).toEqual([b1, b2, b3, b4, c]);
  });

  test("preserves repo group order (same as input)", () => {
    const a = entry("r1", "a");
    const b = entry("r2", "b");
    const c = entry("r3", "c");
    const d = entry("r4", "d");
    const result = splitDockEntries([a, b, c, d], true);
    // 4 entries, midpoint = 2. Split after group 2 (r2).
    expect(result.top).toEqual([a, b]);
    expect(result.bottom).toEqual([c, d]);
  });

  test("showInactive=false filters out exited entries before splitting", () => {
    const a = entry("r1", "a", false);
    const b = entry("r1", "b", true); // exited
    const c = entry("r2", "c", false);
    const result = splitDockEntries([a, b, c], false);
    // After filtering: [a(r1), c(r2)] → one each side
    expect(result.top).toEqual([a]);
    expect(result.bottom).toEqual([c]);
  });

  test("showInactive=true keeps exited entries", () => {
    const a = entry("r1", "a", false);
    const b = entry("r1", "b", true);
    const c = entry("r2", "c", false);
    const result = splitDockEntries([a, b, c], true);
    // All 3: r1 group (2) + r2 group (1) = split after r1
    expect(result.top).toEqual([a, b]);
    expect(result.bottom).toEqual([c]);
  });

  test("all entries from one repo → no split possible", () => {
    const entries = [
      entry("r1", "s1"),
      entry("r1", "s2"),
      entry("r1", "s3"),
    ];
    const result = splitDockEntries(entries, true);
    expect(result.top).toEqual(entries);
    expect(result.bottom).toEqual([]);
  });

  test("all exited with showInactive=false → empty", () => {
    const entries = [
      entry("r1", "s1", true),
      entry("r2", "s2", true),
    ];
    const result = splitDockEntries(entries, false);
    expect(result.top).toEqual([]);
    expect(result.bottom).toEqual([]);
  });
});
