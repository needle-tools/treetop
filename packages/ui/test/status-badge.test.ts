import { describe, expect, test } from "bun:test";
import { pickBadgeKind } from "../src/status-badge";

describe("pickBadgeKind", () => {
  test("returns null when all counts are zero", () => {
    expect(pickBadgeKind(0, 0, 0)).toBe(null);
  });

  test("picks ahead when only ahead is non-zero", () => {
    expect(pickBadgeKind(3, 0, 0)).toBe("ahead");
  });

  test("picks behind when only behind is non-zero", () => {
    expect(pickBadgeKind(0, 2, 0)).toBe("behind");
  });

  test("picks dirty when only dirty is non-zero", () => {
    expect(pickBadgeKind(0, 0, 5)).toBe("dirty");
  });

  test("ahead beats behind and dirty when all three are non-zero", () => {
    expect(pickBadgeKind(1, 1, 1)).toBe("ahead");
    expect(pickBadgeKind(1, 99, 99)).toBe("ahead");
  });

  test("behind beats dirty when ahead is zero", () => {
    expect(pickBadgeKind(0, 1, 1)).toBe("behind");
    expect(pickBadgeKind(0, 1, 99)).toBe("behind");
  });

  test("dirty wins only when ahead and behind are both zero", () => {
    expect(pickBadgeKind(0, 0, 1)).toBe("dirty");
  });

  test("negative counts behave like zero — guards against silly input", () => {
    expect(pickBadgeKind(-1, 0, 0)).toBe(null);
    expect(pickBadgeKind(-5, 2, 1)).toBe("behind");
    expect(pickBadgeKind(0, -3, 4)).toBe("dirty");
  });

  test("large counts don't change priority", () => {
    expect(pickBadgeKind(1, 1_000_000, 1_000_000)).toBe("ahead");
  });
});
