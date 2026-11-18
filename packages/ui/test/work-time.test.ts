import { test, expect } from "bun:test";
import { WorkActivity, splitWorkDays, workHistory } from "../src/work-time";

test("one second of movement qualifies; deliberate input starts immediately", () => {
  const a = new WorkActivity();
  a.move("a", 1000);
  a.move("a", 1500);
  a.move("a", 2000);
  expect(a.active(2000)).toBe(true);
  a.input("b", 3000);
  expect(a.drain()).toEqual([{ repoId: "a", start: 2000, end: 3000 }]);
});

test("idle cutoff retains credited time, caps the gap and never double-counts", () => {
  const a = new WorkActivity();
  a.input("a", 1000);
  expect(a.drain(61000)).toEqual([{ repoId: "a", start: 1000, end: 61000 }]);
  expect(a.preview(61000)).toBe(0);
  expect(a.drain(601000)).toEqual([{ repoId: "a", start: 61000, end: 301000 }]);
  expect(a.active(601000)).toBe(false);
  expect(a.drain(602000)).toEqual([]);
  a.input("b", 700000);
  expect(a.drain()).toEqual([]);
  expect(a.drain(710000)).toEqual([
    { repoId: "b", start: 700000, end: 710000 },
  ]);
  a.reset();
  a.input("a", 900000);
  expect(a.drain()).toEqual([]);
});

test("input following a long gap retains the cutoff even without a timer flush", () => {
  const a = new WorkActivity();
  a.input("a", 1000);
  a.input("b", 601000);
  expect(a.drain()).toEqual([{ repoId: "a", start: 1000, end: 301000 }]);
});

test("day attribution splits at local midnight without rounding durations", () => {
  const start = new Date(2026, 10, 16, 23, 59, 40).getTime();
  const rows = splitWorkDays([{ repoId: "a", start, end: start + 40000 }]);
  expect(rows.map((r) => [r.day, r.end - r.start])).toEqual([
    ["2026-11-16", 20000],
    ["2026-11-17", 20000],
  ]);
});

test("history totals use inclusive local calendar windows and sum projects per day", () => {
  const h = workHistory(
    [
      { day: "2026-11-18", ms: 3600000 },
      { day: "2026-11-18", ms: 1800000 },
      { day: "2026-11-12", ms: 7200000 },
      { day: "2026-11-11", ms: 14400000 },
      { day: "2026-10-19", ms: 3600000 },
      { day: "2026-10-18", ms: 28800000 },
      { day: "2026-11-19", ms: 99999999 },
    ],
    "2026-11-18",
  );
  expect(h.last7Ms).toBe(3.5 * 3600000);
  expect(h.last31Ms).toBe(8.5 * 3600000);
  expect(h.days).toHaveLength(182);
  expect(h.days.find((d) => d.day === "2026-11-18")?.ms).toBe(5400000);
  expect(h.days.find((d) => d.day === "2026-11-19")?.future).toBe(true);
  expect(h.weekdays.reduce((sum, d) => sum + d.ms, 0)).toBe(h.last31Ms);
  expect(h.weekdays[2].ms).toBe(5.5 * 3600000);
});
