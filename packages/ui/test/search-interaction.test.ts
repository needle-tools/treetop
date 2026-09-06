import { describe, expect, test } from "bun:test";
import { shouldAdoptPointerSearchSelection } from "../src/search-interaction";

describe("search panel pointer selection", () => {
  test("does not let a stationary pointer steal keyboard selection", () => {
    const stationary = { x: 120, y: 240 };

    expect(shouldAdoptPointerSearchSelection(stationary, stationary)).toBe(
      false,
    );
  });

  test("lets actual pointer movement move the active search row", () => {
    expect(
      shouldAdoptPointerSearchSelection(
        { x: 120, y: 240 },
        { x: 121, y: 240 },
      ),
    ).toBe(true);
    expect(shouldAdoptPointerSearchSelection(null, { x: 120, y: 240 })).toBe(
      true,
    );
  });
});
