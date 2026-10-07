import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { moveCleanupBeforeWorker, addDpiAwarenessBeforeWorker } from "../../../scripts/patch-launcher";
import {
  DEFAULT_APP_BUNDLE_ID,
  DEFAULT_APP_NAME,
  defaultAppPathFor,
} from "../../../scripts/build-launch";

test("launcher enables per-monitor v2 DPI before starting the window worker, once", () => {
  const source = "new Worker();";
  const fixed = addDpiAwarenessBeforeWorker(source);
  const events: unknown[] = [];
  const run = (platform: string, success = true) => {
    events.length = 0;
    new Function("process", "__require", "Worker", "console", fixed)(
      { platform },
      () => ({ dlopen: () => ({ symbols: {
        SetProcessDpiAwarenessContext: (context: bigint) => { events.push(context); return success ? 1 : 0; },
      }, close: () => events.push("close") }) }),
      class { constructor() { events.push("worker"); } },
      { warn: () => events.push("warning") },
    );
    return [...events];
  };
  expect(run("win32")).toEqual([-4n, "close", "worker"]);
  expect(run("darwin")).toEqual(["worker"]);
  expect(run("linux")).toEqual(["worker"]);
  expect(run("win32", false)).toEqual([-4n, "warning", "close", "worker"]);
  expect(addDpiAwarenessBeforeWorker(fixed)).toBe(fixed);
});

test.skipIf(process.platform !== "win32")("launcher sets the real Windows DPI context to per-monitor v2", () => {
  const script = addDpiAwarenessBeforeWorker(`
    new Worker();
  `);
  const probe = `
    const __require = require;
    class Worker {
      constructor() {
        const { dlopen } = require("bun:ffi");
        const user32 = dlopen("user32.dll", {
          GetThreadDpiAwarenessContext: { args: [], returns: "i64" },
          AreDpiAwarenessContextsEqual: { args: ["i64", "i64"], returns: "i32" },
        });
        const context = user32.symbols.GetThreadDpiAwarenessContext();
        console.log(user32.symbols.AreDpiAwarenessContextsEqual(context, -4n));
        user32.close();
      }
    }
    ${script}
  `;
  const child = Bun.spawnSync([process.execPath, "-e", probe]);
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe("1");
  expect(child.stderr.toString()).toBe("");
});

test("build:launch defaults to the Treetop electrobun artifact names", () => {
  expect(DEFAULT_APP_NAME).toBe("Treetop");
  expect(DEFAULT_APP_BUNDLE_ID).toBe("tools.needle.supergit");
  expect(defaultAppPathFor("darwin", "arm64")).toBe(
    resolve("build/stable-macos-arm64/Treetop.app"),
  );
  expect(defaultAppPathFor("darwin", "x64")).toBe(
    resolve("build/stable-macos-x64/Treetop.app"),
  );
  expect(defaultAppPathFor("win32", "x64")).toBe(
    resolve("build/stable-win-x64/Treetop.exe"),
  );
  expect(defaultAppPathFor("linux", "x64")).toBe(
    resolve("build/stable-linux-x64/Treetop"),
  );
});

for (const entry of [
  "const runStatus = lib.symbols.electrobun_core_run_main_thread();",
  "lib.symbols.startEventLoop();",
]) {
  test(`launcher cleans up before the app can create WebView2: ${entry}`, () => {
    const source = `
      new Worker();
      /* SUPERGIT_LAUNCHER_PATCHED */
      cleanup();
      ${entry}
      closed();
    `;
    const run = (script: string) => {
      const events: string[] = [];
      let browserAlive = false;
      new Function("Worker", "cleanup", "lib", "closed", script)(
        class { constructor() { browserAlive = true; events.push("worker"); } },
        () => { browserAlive = false; events.push("cleanup"); },
        { symbols: {
          electrobun_core_run_main_thread: () => events.push("loop"),
          startEventLoop: () => events.push("loop"),
        } },
        () => events.push("closed"),
      );
      return { events, browserAlive };
    };
    expect(run(source).browserAlive).toBe(false);
    const fixed = moveCleanupBeforeWorker(source);
    expect(run(fixed)).toEqual({
      events: ["cleanup", "worker", "loop", "closed"], browserAlive: true,
    });
    expect(run(moveCleanupBeforeWorker(fixed))).toEqual(run(fixed));
  });
}
