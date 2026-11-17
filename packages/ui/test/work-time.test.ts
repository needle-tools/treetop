import { test, expect } from "bun:test";
import { WorkActivity, splitWorkDays } from "../src/work-time";

test("mouse requires sustained movement; deliberate input starts immediately", () => {
  const a = new WorkActivity();
  a.move("a", 1000);
  a.move("a", 2000);
  a.move("a", 6000);
  expect(a.preview(6000)).toBe(0); // a long gap resets the movement qualification
  for (let t = 6500; t <= 11000; t += 500) a.move("a", t);
  expect(a.active(11000)).toBe(true);
  expect(a.drain()).toEqual([]);
  a.input("a", 12000);
  expect(a.drain()).toEqual([{ repoId: "a", start: 11000, end: 12000 }]);
});

test("idle, pause, blur and sleep never credit their gap; switches credit the previous project", () => {
  const a = new WorkActivity();
  a.input("a", 1000);
  a.input("a", 31000);
  a.input("b", 61000);
  a.input("b", 71000);
  expect(a.drain()).toEqual([
    { repoId: "a", start: 1000, end: 61000 },
    { repoId: "b", start: 61000, end: 71000 },
  ]);
  expect(a.preview(72000)).toBe(1000);
  expect(a.preview(200000)).toBe(0);
  a.input("b", 210000);
  expect(a.drain()).toEqual([]);
  a.reset();
  a.input("a", 300000);
  expect(a.drain()).toEqual([]);
  a.reset();
  expect(a.active(310000)).toBe(false);
});

test("day attribution splits at local midnight without rounding durations", () => {
  const start = new Date(2026, 10, 16, 23, 59, 40).getTime();
  const rows = splitWorkDays([{ repoId: "a", start, end: start + 40000 }]);
  expect(rows.map((r) => [r.day, r.end - r.start])).toEqual([
    ["2026-11-16", 20000],
    ["2026-11-17", 20000],
  ]);
});
