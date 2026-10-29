import { test, expect } from "bun:test";
import { plantKind, cactusGeometry, botanicalFlowers, botanicalMarkup } from "../src/vines/vine-botany";

test("plant varieties are stable and include all cactus and flowering families", () => {
  const kinds = new Set(Array.from({length: 1000}, (_, seed) => plantKind(seed)));
  for (const kind of ["ivory", "bells", "fern", "monstera", "rose", "daisy", "poppy", "star", "clover", "tall", "branching", "cluster", "pear"]) expect(kinds.has(kind)).toBe(true);
  expect(kinds.has("barrel")).toBe(false);
  expect(plantKind(123)).toBe(plantKind(123));
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
  expect(covered.size).toBe(13);
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
