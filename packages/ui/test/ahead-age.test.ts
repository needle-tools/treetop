import { describe, expect, test } from "bun:test";
import { aheadAged, BLINK_AHEAD_MINUTES } from "../src/ahead-age";

const ANCHOR = Date.parse("2026-05-14T12:00:00Z");
const minutes = (n: number) => n * 60_000;
const ago = (mins: number) =>
  new Date(ANCHOR - minutes(mins)).toISOString();

describe("aheadAged", () => {
  test("returns false when aheadOldestTime is missing", () => {
    expect(aheadAged({}, ANCHOR)).toBe(false);
    expect(aheadAged({ aheadOldestTime: undefined }, ANCHOR)).toBe(false);
    expect(aheadAged({ aheadOldestTime: null }, ANCHOR)).toBe(false);
  });

  test("false for a commit younger than the threshold", () => {
    expect(
      aheadAged({ aheadOldestTime: ago(BLINK_AHEAD_MINUTES - 1) }, ANCHOR),
    ).toBe(false);
    expect(aheadAged({ aheadOldestTime: ago(0) }, ANCHOR)).toBe(false);
  });

  test("true at the threshold (inclusive)", () => {
    expect(
      aheadAged({ aheadOldestTime: ago(BLINK_AHEAD_MINUTES) }, ANCHOR),
    ).toBe(true);
  });

  test("true for commits well past the threshold", () => {
    expect(
      aheadAged({ aheadOldestTime: ago(BLINK_AHEAD_MINUTES + 1) }, ANCHOR),
    ).toBe(true);
    // Days-old commits still age in (the helper has no upper bound).
    expect(
      aheadAged({ aheadOldestTime: ago(60 * 24 * 7) }, ANCHOR),
    ).toBe(true);
  });

  test("a commit timestamped in the future stays calm (negative age)", () => {
    const future = new Date(ANCHOR + minutes(5)).toISOString();
    expect(aheadAged({ aheadOldestTime: future }, ANCHOR)).toBe(false);
  });

  test("defaults nowMs to Date.now() when omitted", () => {
    // Pin the realtime clock to a known value via the optional arg by
    // comparing against a timestamp slightly before now.
    const justOldEnough = new Date(
      Date.now() - minutes(BLINK_AHEAD_MINUTES + 1),
    ).toISOString();
    expect(aheadAged({ aheadOldestTime: justOldEnough })).toBe(true);
  });
});
