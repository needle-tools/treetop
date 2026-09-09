import { describe, expect, test } from "bun:test";
import config from "../vite.config";

async function resolveConfig(mode = "production") {
  const exported = config as unknown as
    | Record<string, unknown>
    | ((env: { command: string; mode: string }) => unknown);
  const value =
    typeof exported === "function"
      ? exported({ command: "build", mode })
      : exported;
  return (await value) as {
    build?: {
      outDir?: string;
      sourcemap?: unknown;
      rollupOptions?: { input?: Record<string, string> };
    };
    base?: string;
    preview?: { proxy?: Record<string, unknown> };
    server?: { proxy?: Record<string, unknown> };
  };
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

  test("emits Replay Lab as a standalone static entry page", async () => {
    const resolved = await resolveConfig();
    expect(resolved.build?.rollupOptions?.input).toEqual({
      app: expect.stringContaining("/packages/ui/index.html"),
      replayLab: expect.stringContaining("/packages/ui/replay-lab.html"),
    });
  });

  test("builds the drop-only Replay Lab with relative assets and no dashboard entry", async () => {
    const resolved = await resolveConfig("replay-lab-static");
    expect(resolved.base).toBe("./");
    expect(resolved.build?.outDir).toBe("dist-replay-lab");
    expect(resolved.build?.rollupOptions?.input).toEqual({
      replayLab: expect.stringContaining("/packages/ui/replay-lab.html"),
    });
    expect(resolved.preview?.proxy).toEqual({});
    expect(resolved.server?.proxy).toEqual({});
  });
});
