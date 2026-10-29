import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import config, { replayLabDevRoutePlugin } from "../vite.config";

test("standalone Replay Lab routes root and index to its entry, preserving queries", () => {
  function rewrite(url: string, standalone: boolean) {
    let middleware: any;
    const plugin = replayLabDevRoutePlugin(standalone);
    (plugin.configureServer as Function)({ middlewares: { use(fn: any) { middleware = fn; } } });
    const req = { url };
    let continued = false;
    middleware(req, {}, () => { continued = true; });
    expect(continued).toBe(true);
    return req.url;
  }
  expect(rewrite("/", true)).toBe("/replay-lab.html");
  expect(rewrite("/?example=1", true)).toBe("/replay-lab.html?example=1");
  expect(rewrite("/index.html", true)).toBe("/replay-lab.html");
  expect(rewrite("/", false)).toBe("/");
  expect(rewrite("/src/main.ts", true)).toBe("/src/main.ts");
  expect(rewrite("/replay-lab?example=1", false)).toBe("/replay-lab.html?example=1");
});

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
      app: resolve(import.meta.dir, "../index.html"),
      replayLab: resolve(import.meta.dir, "../replay-lab.html"),
    });
  });

  test("builds the drop-only Replay Lab with relative assets and no dashboard entry", async () => {
    const resolved = await resolveConfig("replay-lab-static");
    expect(resolved.base).toBe("./");
    expect(resolved.build?.outDir).toBe("dist-replay-lab");
    expect(resolved.build?.rollupOptions?.input).toEqual({
      replayLab: resolve(import.meta.dir, "../replay-lab.html"),
    });
    expect(resolved.preview?.proxy).toEqual({});
    expect(resolved.server?.proxy).toEqual({});
  });
});
