import { describe, expect, test } from "bun:test";
import config from "../vite.config";

async function resolveConfig() {
  const exported = config as unknown as
    | Record<string, unknown>
    | ((env: { command: string; mode: string }) => unknown);
  const value =
    typeof exported === "function"
      ? exported({ command: "build", mode: "production" })
      : exported;
  return (await value) as { build?: { sourcemap?: unknown } };
}

describe("Vite config", () => {
  test("keeps production source maps off by default", async () => {
    delete process.env.TREETOP_BUILD_SOURCEMAPS;
    const resolved = await resolveConfig();
    expect(resolved.build?.sourcemap).toBe(false);
  });

  test("enables production source maps only for explicit perf builds", async () => {
    process.env.TREETOP_BUILD_SOURCEMAPS = "1";
    try {
      const resolved = await resolveConfig();
      expect(resolved.build?.sourcemap).toBe(true);
    } finally {
      delete process.env.TREETOP_BUILD_SOURCEMAPS;
    }
  });
});
