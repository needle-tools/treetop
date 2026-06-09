import { test, expect, describe } from "bun:test";
import {
  pairKey,
  hashSeed,
  rng,
  adjacentPairs,
  repoIntensities,
  accrue,
  growthOf,
  buildVines,
  stemPath,
  stemHeight,
  leaves,
  type Panel,
  type GrowthStore,
} from "../src/vines/vine-core";

function panel(
  source: string,
  cx: number,
  group?: string,
  repo: string = group ?? "r",
): Panel {
  return { source, repo, group, cx, left: cx - 50, right: cx + 50, top: 0, bottom: 300 };
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

describe("repoIntensities", () => {
  test("counts windows per repo, capped", () => {
    const panels = [
      panel("a", 1, "g1", "repoX"),
      panel("b", 2, "g1", "repoX"),
      panel("c", 3, "g2", "repoY"),
    ];
    const m = repoIntensities(panels, 4);
    expect(m.get("repoX")).toBe(2);
    expect(m.get("repoY")).toBe(1);
  });
  test("caps intensity", () => {
    const panels = Array.from({ length: 9 }, (_, i) => panel(`s${i}`, i, "g", "repoX"));
    expect(repoIntensities(panels, 4).get("repoX")).toBe(4);
  });
});

describe("accrue / growthOf", () => {
  const FULL = 1000;

  test("accrues weighted active time onto active repos", () => {
    const m = new Map([["repoX", 2]]);
    const store = accrue({}, m, 100);
    expect(store.repoX.activeMs).toBe(200); // 100ms * intensity 2
  });
  test("does not mutate the input store", () => {
    const before: GrowthStore = {};
    accrue(before, new Map([["r", 1]]), 50);
    expect(before).toEqual({});
  });
  test("only touches active repos; others retain their growth", () => {
    const store: GrowthStore = { idle: { activeMs: 500 }, busy: { activeMs: 0 } };
    const next = accrue(store, new Map([["busy", 1]]), 100);
    expect(next.idle.activeMs).toBe(500);
    expect(next.busy.activeMs).toBe(100);
  });
  test("growthOf maps activeMs over the full budget, clamped", () => {
    expect(growthOf({ r: { activeMs: 500 } }, "r", FULL)).toBe(0.5);
    expect(growthOf({ r: { activeMs: 5000 } }, "r", FULL)).toBe(1);
    expect(growthOf({}, "missing", FULL)).toBe(0);
  });
  test("a busy week beats an idle week", () => {
    // big budget so neither saturates — we're comparing accrual rates
    const BUDGET = 10_000;
    let busy: GrowthStore = {};
    let idle: GrowthStore = {};
    for (let i = 0; i < 10; i++) busy = accrue(busy, new Map([["r", 3]]), 100);
    for (let i = 0; i < 10; i++) idle = accrue(idle, new Map([["r", 1]]), 100);
    expect(growthOf(busy, "r", BUDGET)).toBeGreaterThan(growthOf(idle, "r", BUDGET));
  });
});

describe("buildVines", () => {
  test("one vine per gap, length = the repo's growth", () => {
    const panels = [
      panel("a", 100, "g", "repoX"),
      panel("b", 200, "g", "repoX"),
      panel("c", 300, "g", "repoX"),
    ];
    const store: GrowthStore = { repoX: { activeMs: 250 } };
    const vines = buildVines(panels, store, 1000);
    expect(vines).toHaveLength(2);
    expect(vines.map((v) => v.key).sort()).toEqual(
      [pairKey("a", "b"), pairKey("b", "c")].sort(),
    );
    for (const v of vines) {
      expect(v.repo).toBe("repoX");
      expect(v.length).toBe(0.25);
    }
  });

  test("no windows in a repo → no vines drawn, but growth persists in the store", () => {
    const store: GrowthStore = { repoX: { activeMs: 999 } };
    // repoX has no panels on screen right now
    const vines = buildVines([panel("z", 1, "g", "other")], store, 1000);
    expect(vines.find((v) => v.repo === "repoX")).toBeUndefined();
    // growth is untouched — reopening windows later shows it again
    expect(growthOf(store, "repoX", 1000)).toBe(0.999);
  });

  test("vine geometry spans the gap between the two windows", () => {
    const v = buildVines(
      [panel("a", 100, "g", "r"), panel("b", 300, "g", "r")],
      { r: { activeMs: 1000 } },
      1000,
    )[0];
    expect(v.ax).toBe(150); // a.right
    expect(v.bx).toBe(250); // b.left
    expect(v.baseY).toBe(300);
  });
});

describe("geometry", () => {
  const shape = (seed: number, length: number) => ({ seed, length });

  test("stemHeight scales with length", () => {
    expect(stemHeight(shape(1, 0), 200)).toBe(0);
    expect(stemHeight(shape(1, 0.5), 200)).toBe(100);
    expect(stemHeight(shape(1, 1), 200)).toBe(200);
  });

  test("stemPath is empty for a sprout and present once grown", () => {
    expect(stemPath(shape(7, 0), 200)).toBe("");
    expect(stemPath(shape(7, 1), 200)).toStartWith("M 0 0");
  });

  test("stemPath is deterministic per seed and differs across seeds", () => {
    expect(stemPath(shape(7, 1), 200)).toBe(stemPath(shape(7, 1), 200));
    expect(stemPath(shape(7, 1), 200)).not.toBe(stemPath(shape(42, 1), 200));
  });

  test("leaf count scales with growth and is capped", () => {
    expect(leaves(shape(7, 0), 200, 8)).toHaveLength(0);
    expect(leaves(shape(7, 1), 200, 8)).toHaveLength(8);
    expect(leaves(shape(7, 0.5), 200, 8).length).toBeLessThanOrEqual(8);
  });

  test("leaves are deterministic for a seed", () => {
    expect(leaves(shape(7, 1), 200)).toEqual(leaves(shape(7, 1), 200));
  });
});
