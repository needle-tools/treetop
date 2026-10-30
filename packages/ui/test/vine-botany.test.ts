import { test, expect } from "bun:test";
import { plantKind, cactusGeometry, botanicalFlowers, botanicalMarkup, botanicalLeaves, treeAppearance, treeLeafColor, treeTrunkWidth } from "../src/vines/vine-botany";

test("tree trunk thickness varies by seed with oak heavier than birch", () => {
  const widths = Array.from({length: 20}, (_, seed) => treeTrunkWidth(seed, "tree"));
  expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThan(3);
  expect(treeTrunkWidth(42, "tree")).toBe(treeTrunkWidth(42, "tree"));
  expect(treeTrunkWidth(42, "oak")).toBeGreaterThan(treeTrunkWidth(42, "birch"));
});

test("every tree species has a varied leaf palette", () => {
  for (const kind of ["tree", "oak", "birch"] as const) {
    expect(new Set([0, .3, .6, 1].map(value => treeLeafColor(kind, value))).size).toBe(4);
  }
});

test("beech oak and birch have distinct bark and leaves and keep their growing trunk", () => {
  const styles = ["tree", "oak", "birch"].map(kind => treeAppearance(kind as "tree" | "oak" | "birch"));
  expect(new Set(styles.map(s => s.bark)).size).toBe(3);
  expect(new Set(styles.map(s => s.leaf)).size).toBe(3);
  for (const kind of ["tree", "oak", "birch"] as const) {
    const young = cactusGeometry(42, .3, kind).stems[0]!.points;
    const mature = cactusGeometry(42, 1, kind).stems;
    expect(mature[0]!.points.slice(0, young.length - 1)).toEqual(young.slice(0, -1));
    expect(mature.length).toBeGreaterThan(4);
  }
});

test("monstera has spaced mixed leaves stable across growth", () => {
  let seed = 0;
  while (plantKind(seed) !== "monstera") seed++;
  const mature = botanicalLeaves({seed, length: 1}, 500);
  const young = botanicalLeaves({seed, length: .5}, 500);
  expect(mature.length).toBeLessThan(20);
  expect(new Set(mature.map(l => l.shape)).size).toBeGreaterThan(1);
  expect(new Set(mature.map(l => l.scale)).size).toBeGreaterThan(3);
  expect(young).toEqual(mature.slice(0, young.length));
});

test("plant varieties are stable and include all cactus and flowering families", () => {
  const kinds = new Set(Array.from({length: 1000}, (_, seed) => plantKind(seed)));
  for (const kind of ["ivory", "bells", "fern", "monstera", "rose", "daisy", "poppy", "star", "clover", "tall", "branching", "cluster", "pear"]) expect(kinds.has(kind)).toBe(true);
  expect(kinds.has("barrel")).toBe(false);
  expect(plantKind(123)).toBe(plantKind(123));
});

test("pear pads have gentle seeded lean that stays stable as they grow", () => {
  const mature = cactusGeometry(42, 1, "pear").pads;
  expect(mature.some(p => Math.abs(p.lean) > .03)).toBe(true);
  expect(new Set(mature.map(p => p.lean)).size).toBeGreaterThan(3);
  expect(cactusGeometry(43, 1, "pear").pads.map(p => p.lean)).not.toEqual(mature.map(p => p.lean));
  for (const [i, p] of cactusGeometry(42, .5, "pear").pads.entries()) {
    expect(p.lean).toBe(mature[i]!.lean);
    expect(Math.abs(p.lean)).toBeLessThanOrEqual(.14);
  }
});
test("cactus trunk extends without stretching old segments and arms appear later", () => {
  const young = cactusGeometry(42, .2, "branching");
  const mature = cactusGeometry(42, 1, "branching");
  expect(mature.stems[0]!.points.slice(0, young.stems[0]!.points.length - 1)).toEqual(young.stems[0]!.points.slice(0, -1));
  expect(young.stems).toHaveLength(1);
  expect(mature.stems.length).toBeGreaterThan(3);
  expect(mature.flowers.length).toBeGreaterThan(1);
  expect(mature.stems[0]!.points.at(-1)![1]).toBeLessThan(-240);
});
test("buds open in place and empty growth has no flowers", () => {
  expect(botanicalFlowers(7, 0, 500)).toEqual([]);
  const young = botanicalFlowers(7, .5, 500);
  const mature = botanicalFlowers(7, 1, 500);
  expect(young.length).toBeGreaterThan(0);
  for (const flower of young) expect(mature.some(other => other.x === flower.x && other.y === flower.y)).toBe(true);
});

test("all plant families render finite SVG through their growth stages", () => {
  const covered = new Set<string>();
  for (let seed = 0; seed < 1000; seed++) {
    const kind = plantKind(seed);
    if (covered.has(kind)) continue;
    covered.add(kind);
    for (const length of [0, .2, .5, .85, 1]) {
      const svg = botanicalMarkup({seed, length}, 500);
      expect(svg).not.toMatch(/NaN|Infinity|undefined/);
      if (length === 1) expect(svg.length).toBeGreaterThan(0);
    }
  }
  expect(covered.size).toBe(16);
});

test("prickly pear pads overlap their parent at every growth stage", () => {
  for (const length of [.2, .4, .65, .85, 1]) {
    const {pads} = cactusGeometry(42, length, "pear");
    expect(pads[0]!.y + pads[0]!.ry).toBe(0);
    for (let i = 1; i < pads.length; i++) {
      const parent = pads[i-1]!, pad = pads[i]!;
      expect(pad.y + pad.ry).toBeGreaterThan(parent.y - parent.ry);
      expect(Math.abs(pad.x - parent.x)).toBeLessThan(parent.rx);
    }
  }
});
