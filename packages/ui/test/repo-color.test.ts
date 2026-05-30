import { test, expect, describe } from "bun:test";
import { repoChipFg } from "../src/repo-color";

describe("repoChipFg", () => {
  test("dark backgrounds get white text", () => {
    expect(repoChipFg("#000000")).toBe("#ffffff");
    expect(repoChipFg("#1d4ed8")).toBe("#ffffff"); // mid blue reads dark
    expect(repoChipFg("#7c3aed")).toBe("#ffffff"); // purple
  });

  test("light backgrounds get dark text", () => {
    expect(repoChipFg("#ffffff")).toBe("#1a1a1a");
    expect(repoChipFg("#fde047")).toBe("#1a1a1a"); // saturated yellow reads light
    expect(repoChipFg("#22d3ee")).toBe("#1a1a1a"); // cyan reads light
  });

  test("is case-insensitive on the hex", () => {
    expect(repoChipFg("#FDE047")).toBe(repoChipFg("#fde047"));
  });

  test("malformed input falls back to white", () => {
    expect(repoChipFg("")).toBe("#ffffff");
    expect(repoChipFg("red")).toBe("#ffffff");
    expect(repoChipFg("#fff")).toBe("#ffffff"); // 3-digit not supported
    expect(repoChipFg("#12345")).toBe("#ffffff");
  });
});
