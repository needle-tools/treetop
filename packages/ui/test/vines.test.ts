import { test, expect, describe } from "bun:test";
import {
  pairKey,
  hashSeed,
  rng,
  adjacentPairs,
  growthForAge,
  reconcile,
  stemPath,
  stemHeight,
  leaves,
  type Panel,
  type Vine,
} from "../src/vines/vine-core";

function panel(source: string, cx: number, group?: string): Panel {
  return { source, group, cx, left: cx - 50, right: cx + 50, top: 0, bottom: 300 };
}

describe("pairKey", () => {
  test("is order-independent", () => {
    expect(pairKey("a", "b")).toBe(pairKey("b", "a"));
  });
  test("distinguishes different pairs", () => {
    expect(pairKey("a", "b")).not.toBe(pairKey("a", "c"));
  });
});

describe("hashSeed / rng", () => {
  test("hashSeed is deterministic and non-negative", () => {
    expect(hashSeed("x/y/z")).toBe(hashSeed("x/y/z"));
    expect(hashSeed("x/y/z")).toBeGreaterThanOrEqual(0);
  });
  test("rng is deterministic for a seed and in [0,1)", () => {
    const a = rng(123);
    const b = rng(123);
    for (let i = 0; i < 5; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  test("different seeds diverge", () => {
    expect(rng(1)()).not.toBe(rng(2)());
  });
});

describe("adjacentPairs", () => {
  test("N panels yield N-1 consecutive pairs in x order", () => {
    const pairs = adjacentPairs([panel("c", 300), panel("a", 100), panel("b", 200)]);
    expect(pairs.map(([p, q]) => [p.source, q.source])).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
  });
  test("0 or 1 panels yield no pairs", () => {
    expect(adjacentPairs([])).toEqual([]);
    expect(adjacentPairs([panel("a", 1)])).toEqual([]);
  });
  test("never pairs panels from different row groups", () => {
    // two rows, two cols each; only same-group neighbours pair
    const pairs = adjacentPairs([
      panel("r1a", 100, "row1"),
      panel("r1b", 200, "row1"),
      panel("r2a", 120, "row2"),
      panel("r2b", 220, "row2"),
    ]);
    expect(pairs.map(([p, q]) => pairKey(p.source, q.source)).sort()).toEqual(
      [pairKey("r1a", "r1b"), pairKey("r2a", "r2b")].sort(),
    );
  });
});

describe("growthForAge", () => {
  test("is proportional to age over fullMs", () => {
    expect(growthForAge(0, 300, 600)).toBeCloseTo(0.5, 5);
  });
  test("clamps at 1 once older than fullMs, and 0 before birth", () => {
    expect(growthForAge(0, 10_000, 1000)).toBe(1);
    expect(growthForAge(1000, 500, 1000)).toBe(0); // now before bornAt
  });
  test("a vine born days ago comes back already grown (survives reloads)", () => {
    const week = 7 * 24 * 3600 * 1000;
    const now = 1_000_000_000_000;
    const bornThreeDaysAgo = now - 3 * 24 * 3600 * 1000;
    expect(growthForAge(bornThreeDaysAgo, now, week)).toBeCloseTo(3 / 7, 5);
  });
});

describe("reconcile", () => {
  const now = 1000;

  test("sprouts a vine between two adjacent panels", () => {
    const vines = reconcile([], [panel("a", 100), panel("b", 200)], now);
    expect(vines).toHaveLength(1);
    expect(vines[0].key).toBe(pairKey("a", "b"));
    expect(vines[0].length).toBe(0);
    expect(vines[0].bornAt).toBe(now);
  });

  test("three panels → two vines", () => {
    const vines = reconcile([], [panel("a", 100), panel("b", 200), panel("c", 300)], now);
    expect(vines.map((v) => v.key).sort()).toEqual(
      [pairKey("a", "b"), pairKey("b", "c")].sort(),
    );
  });

  test("does not duplicate an existing vine", () => {
    const panels = [panel("a", 100), panel("b", 200)];
    const first = reconcile([], panels, now);
    const second = reconcile(first, panels, now + 5000);
    expect(second).toHaveLength(1);
    // identity + bornAt preserved across reconciles
    expect(second[0].bornAt).toBe(now);
  });

  test("keeps a vine when ONE side's panel is removed (dangling)", () => {
    const born = reconcile([], [panel("a", 100), panel("b", 200)], now);
    const after = reconcile(born, [panel("a", 100)], now + 1000);
    expect(after).toHaveLength(1);
    expect(after[0].key).toBe(pairKey("a", "b"));
    // present side updates, absent side freezes its last-known x
    expect(after[0].ax).toBe(150); // a.right
    expect(after[0].bx).toBe(150); // frozen b.left from birth
  });

  test("removes a vine ONLY when BOTH sides are gone", () => {
    const born = reconcile([], [panel("a", 100), panel("b", 200)], now);
    const after = reconcile(born, [], now + 1000);
    expect(after).toHaveLength(0);
  });

  test("removing a middle panel sprouts a new vine between its neighbours, keeping the danglers", () => {
    const start = reconcile(
      [],
      [panel("a", 100), panel("b", 200), panel("c", 300)],
      now,
    );
    // remove b; a and c are now adjacent
    const after = reconcile(start, [panel("a", 100), panel("c", 300)], now + 1000);
    const keys = after.map((v) => v.key).sort();
    expect(keys).toEqual(
      [pairKey("a", "b"), pairKey("a", "c"), pairKey("b", "c")].sort(),
    );
    // the brand-new a|c vine starts at length 0, born now+1000
    const ac = after.find((v) => v.key === pairKey("a", "c"))!;
    expect(ac.length).toBe(0);
    expect(ac.bornAt).toBe(now + 1000);
  });
});

describe("geometry", () => {
  const vine = (over: Partial<Vine> = {}): Vine => ({
    key: "a b",
    a: "a",
    b: "b",
    seed: hashSeed("a b"),
    bornAt: 0,
    length: 1,
    ax: 150,
    bx: 250,
    baseY: 300,
    topY: 0,
    ...over,
  });

  test("stemHeight scales with length", () => {
    expect(stemHeight(vine({ length: 0 }), 200)).toBe(0);
    expect(stemHeight(vine({ length: 0.5 }), 200)).toBe(100);
    expect(stemHeight(vine({ length: 1 }), 200)).toBe(200);
  });

  test("stemPath is empty for a sprout and present once grown", () => {
    expect(stemPath(vine({ length: 0 }), 200)).toBe("");
    expect(stemPath(vine({ length: 1 }), 200)).toStartWith("M 0 0");
  });

  test("stemPath is deterministic per seed and differs across seeds", () => {
    expect(stemPath(vine(), 200)).toBe(stemPath(vine(), 200));
    expect(stemPath(vine(), 200)).not.toBe(stemPath(vine({ seed: 42 }), 200));
  });

  test("leaf count scales with growth and is capped", () => {
    expect(leaves(vine({ length: 0 }), 200, 8)).toHaveLength(0);
    expect(leaves(vine({ length: 1 }), 200, 8)).toHaveLength(8);
    expect(leaves(vine({ length: 0.5 }), 200, 8).length).toBeLessThanOrEqual(8);
  });

  test("leaves are deterministic for a seed", () => {
    expect(leaves(vine(), 200)).toEqual(leaves(vine(), 200));
  });
});
