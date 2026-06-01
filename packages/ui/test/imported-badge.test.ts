import { test, expect, describe } from "bun:test";
import { importedTooltip } from "../src/imported-badge";

describe("importedTooltip", () => {
  test("returns null for a native (non-imported) session", () => {
    expect(importedTooltip({})).toBeNull();
    expect(importedTooltip({ importedAt: "2026-05-30T12:00:00.000Z" })).toBeNull();
  });

  test("from only, no timestamp", () => {
    expect(importedTooltip({ importedFrom: "Marcel's MBP" })).toBe(
      "Imported from Marcel's MBP",
    );
  });

  test("from + timestamp renders 'Imported from X at <date>'", () => {
    const tip = importedTooltip({
      importedFrom: "marcel@DESKTOP-Marwi",
      importedAt: "2026-05-30T12:00:00.000Z",
    });
    // Locale/timezone-independent assertions: structure + the year. The
    // exact month/day string depends on the test runner's locale, so we
    // don't pin it.
    expect(tip?.startsWith("Imported from marcel@DESKTOP-Marwi at ")).toBe(true);
    expect(tip).toContain("2026");
  });

  test("unparseable timestamp falls back to from-only (no 'at')", () => {
    expect(
      importedTooltip({ importedFrom: "host", importedAt: "not-a-date" }),
    ).toBe("Imported from host");
  });
});
