import { describe, expect, test } from "bun:test";
import {
  clampClipToViewport,
  defaultOutName,
  parseViewportArg,
  sanitizeSegment,
} from "../../../scripts/ui-snapshot.mjs";

describe("ui snapshot helper parsing", () => {
  test("parses viewport width, height, and optional dpr", () => {
    expect(parseViewportArg("1440x900")).toEqual({
      width: 1440,
      height: 900,
      dpr: 1,
    });
    expect(parseViewportArg("1600x1000@2")).toEqual({
      width: 1600,
      height: 1000,
      dpr: 2,
    });
  });

  test("sanitizes selectors and labels for filenames", () => {
    expect(sanitizeSegment('.sticky[data-kind="note"]')).toBe(
      "sticky-data-kind-note",
    );
    expect(sanitizeSegment("left sidebar #3")).toBe("left-sidebar-3");
  });

  test("clamps padded element clips to the viewport", () => {
    expect(
      clampClipToViewport(
        { left: -4, top: 10, width: 40, height: 20 },
        { width: 100, height: 50 },
        8,
      ),
    ).toEqual({ x: 0, y: 2, width: 44, height: 36, scale: 1 });
  });

  test("builds deterministic output names for multi-captures", () => {
    expect(defaultOutName("dock", 2, "needle-engine active")).toBe(
      "dock-002-needle-engine-active.png",
    );
  });
});
