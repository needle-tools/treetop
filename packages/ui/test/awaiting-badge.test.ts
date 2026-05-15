/**
 * The favicon-painting side of awaitingBadge.ts needs a browser canvas
 * we don't have in `bun test`, so we just unit-test the pure title
 * helper. The canvas path is exercised manually in the browser.
 */

import { test, expect, describe } from "bun:test";
import { titleForCount } from "../src/awaitingBadge";

describe("titleForCount", () => {
  test("returns the base title when no sessions are waiting", () => {
    expect(titleForCount("supergit", 0)).toBe("supergit");
  });

  test("treats negative counts as zero (defensive)", () => {
    expect(titleForCount("supergit", -1)).toBe("supergit");
  });

  test("prefixes the count when at least one session waits", () => {
    expect(titleForCount("supergit", 1)).toBe("(1) supergit");
    expect(titleForCount("supergit", 7)).toBe("(7) supergit");
  });

  test("preserves the base title verbatim (no trimming surprises)", () => {
    expect(titleForCount("custom — name", 2)).toBe("(2) custom — name");
  });
});
