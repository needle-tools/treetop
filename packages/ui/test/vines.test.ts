import { test, expect, describe } from "bun:test";
import {
  pairKey,
  hashSeed,
  rng,
  adjacentPairs,
  growthFromMs,
  sessionGrowth,
  accrueAges,
  buildVines,
  stemPath,
  stemHeight,
  leaves,
  leafCountFor,
  type Panel,
  type SourceAges,
} from "../src/vines/vine-core";
import { mutationsAffectVinesLayout } from "../src/vines/vines-overlay";

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
});

describe("adjacentPairs", () => {
  test("N panels yield N-1 consecutive pairs in x order", () => {
    const pairs = adjacentPairs([panel("c", 300), panel("a", 100), panel("b", 200)]);
    expect(pairs.map(([p, q]) => [p.source, q.source])).toEqual([
      ["a", "b"],
      ["b", "c"],
    ]);
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

describe("session growth", () => {
  const FULL = 1000;

  test("growthFromMs is proportional and clamped", () => {
    expect(growthFromMs(500, FULL)).toBe(0.5);
    expect(growthFromMs(5000, FULL)).toBe(1);
    expect(growthFromMs(-5, FULL)).toBe(0);
  });
  test("sessionGrowth reads a source's age", () => {
    expect(sessionGrowth({ s: 250 }, "s", FULL)).toBe(0.25);
    expect(sessionGrowth({}, "missing", FULL)).toBe(0);
  });
  test("accrueAges adds dt to present sources, capped, immutable", () => {
    const before: SourceAges = { a: 100 };
    const next = accrueAges(before, ["a", "b"], 50, FULL);
    expect(before).toEqual({ a: 100 }); // unchanged
    expect(next.a).toBe(150);
    expect(next.b).toBe(50);
  });
  test("accrueAges caps at the full budget", () => {
    expect(accrueAges({ a: 990 }, ["a"], 1000, FULL).a).toBe(FULL);
  });
  test("absent sources keep their age", () => {
    const next = accrueAges({ idle: 700, busy: 0 }, ["busy"], 100, FULL);
    expect(next.idle).toBe(700);
    expect(next.busy).toBe(100);
  });
});

describe("buildVines", () => {
  const FULL = 1000;

  test("one vine per gap; length = average of the two sessions' growth", () => {
    const panels = [panel("a", 100), panel("b", 200), panel("c", 300)];
    const store: SourceAges = { a: 1000, b: 0, c: 500 }; // 1.0, 0, 0.5
    const vines = buildVines(panels, store, FULL);
    const ab = vines.find((v) => v.key === pairKey("a", "b"))!;
    const bc = vines.find((v) => v.key === pairKey("b", "c"))!;
    expect(ab.length).toBeCloseTo((1 + 0) / 2, 5);
    expect(bc.length).toBeCloseTo((0 + 0.5) / 2, 5);
    expect(ab.a).toBe("a");
    expect(ab.b).toBe("b");
  });

  test("reordering the windows does NOT change a vine's size", () => {
    const store: SourceAges = { a: 800, b: 200 };
    const before = buildVines([panel("a", 100), panel("b", 200)], store, FULL);
    // swap their x positions (a now to the right of b)
    const after = buildVines([panel("a", 300), panel("b", 100)], store, FULL);
    const v1 = before.find((v) => v.key === pairKey("a", "b"))!;
    const v2 = after.find((v) => v.key === pairKey("a", "b"))!;
    expect(v2.length).toBe(v1.length); // purely a function of the sessions
  });

  test("vine geometry spans the gap between the two windows", () => {
    const v = buildVines(
      [panel("a", 100), panel("b", 300)],
      { a: 1000, b: 1000 },
      FULL,
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
    expect(stemPath(shape(7, 1), 200)).toMatch(/^M /);
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

  test("taller stems get more leaves (constant density)", () => {
    expect(leaves(shape(7, 1), 100).length).toBeLessThan(
      leaves(shape(7, 1), 320).length,
    );
    expect(leafCountFor(100)).toBeLessThan(leafCountFor(320));
  });

  test("different seeds → different stem AND leaf arrangement", () => {
    expect(stemPath(shape(1, 1), 200)).not.toBe(stemPath(shape(2, 1), 200));
    expect(leaves(shape(1, 1), 200)).not.toEqual(leaves(shape(2, 1), 200));
  });

  test("leaf light is in [0,1] and deterministic", () => {
    const ls = leaves(shape(7, 1), 300);
    for (const l of ls) {
      expect(l.light).toBeGreaterThanOrEqual(0);
      expect(l.light).toBeLessThanOrEqual(1);
    }
    expect(leaves(shape(7, 1), 300)).toEqual(ls);
  });

  test("leaves trend brighter toward the top (depth)", () => {
    const ls = leaves(shape(7, 1), 300); // ~20 leaves
    const mid = Math.floor(ls.length / 2);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const lower = avg(ls.slice(0, mid).map((l) => l.light));
    const upper = avg(ls.slice(mid).map((l) => l.light));
    expect(upper).toBeGreaterThan(lower);
  });
});

describe("mutationsAffectVinesLayout", () => {
  const strip = {
    matches: (sel: string) => sel === ".sessions-strip",
    querySelector: () => null,
  };
  const sessionBody = {
    matches: () => false,
    querySelector: () => null,
  };
  const rowAddedWithStrip = {
    matches: () => false,
    querySelector: (sel: string) => (sel === ".sessions-strip" ? strip : null),
  };

  test("resyncs when a sessions strip itself changes children", () => {
    expect(
      mutationsAffectVinesLayout([{ target: strip, addedNodes: [], removedNodes: [] }]),
    ).toBe(true);
  });

  test("resyncs when a newly added subtree contains a sessions strip", () => {
    expect(
      mutationsAffectVinesLayout([
        { target: sessionBody, addedNodes: [rowAddedWithStrip], removedNodes: [] },
      ]),
    ).toBe(true);
  });

  test("ignores arbitrary deep session mutations", () => {
    expect(
      mutationsAffectVinesLayout([
        { target: sessionBody, addedNodes: [{}, {}], removedNodes: [] },
      ]),
    ).toBe(false);
  });
});
