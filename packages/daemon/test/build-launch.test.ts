import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DAEMON_BUILD_EXTERNALS } from "../../../scripts/build-native-options";

test("daemon bundles SSH without requiring its optional native CPU detector", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "treetop-ssh-bundle-"));
  const entrypoint = resolve(directory, "entry.ts");
  await writeFile(entrypoint, `import { Client, Server } from ${JSON.stringify(require.resolve("ssh2"))}; export { Client, Server };`);
  const result = await Bun.build({ entrypoints: [entrypoint], outdir: directory, target: "bun", external: DAEMON_BUILD_EXTERNALS });
  expect(result.success).toBe(true);
  const bundled = await import(result.outputs[0]!.path);
  expect(typeof bundled.Client).toBe("function");
  expect(typeof bundled.Server).toBe("function");
});
import { restoreWindowState, captureWindowState, restoreWindowModeOnReady } from "../../../src/electrobun/window-state";

test("startup fullscreen waits for the inner webview and restores only once", () => {
  let ready: (() => void) | undefined;
  const actions: string[] = [];
  restoreWindowModeOnReady(
    restoreWindowState({ x: 10, y: 20, width: 1000, height: 800, fullscreen: true, maximized: true }),
    {
      onReady: (callback) => { ready = callback; },
      maximize: () => { actions.push("maximize"); },
      setFullScreen: (enabled) => { actions.push(`fullscreen:${enabled}`); },
    },
  );
  expect(actions).toEqual([]);
  expect(ready).toBeDefined();
  ready!();
  expect(actions).toEqual(["maximize", "fullscreen:true"]);
  ready!();
  expect(actions).toEqual(["maximize", "fullscreen:true"]);
});

test("window restoration keeps normal bounds through fullscreen, maximize and minimize", () => {
  const initial = restoreWindowState({ x: 10, y: 20, width: 1000, height: 800 });
  expect(initial.fullscreen).toBe(false);
  const fullscreen = captureWindowState(initial, { x: 0, y: 0, width: 1920, height: 1080 }, { fullscreen: true, maximized: false, minimized: false });
  expect(fullscreen.width).toBe(1000);
  expect(restoreWindowState(JSON.parse(JSON.stringify(fullscreen))).fullscreen).toBe(true);
  const minimized = captureWindowState(fullscreen, { x: -32000, y: -32000, width: 160, height: 39 }, { fullscreen: false, maximized: false, minimized: true });
  expect(minimized).toEqual(fullscreen);
  const maximized = captureWindowState(initial, { x: 0, y: 0, width: 1920, height: 1040 }, { fullscreen: false, maximized: true, minimized: false });
  expect(maximized.maximized).toBe(true);
  expect(maximized.width).toBe(1000);
  expect(restoreWindowState({ width: 0 }).width).toBe(1400);
});
import { moveCleanupBeforeWorker, addDpiAwarenessBeforeWorker } from "../../../scripts/patch-launcher";
import {
  DEFAULT_APP_BUNDLE_ID,
  DEFAULT_APP_NAME,
  defaultAppPathFor,
} from "../../../scripts/build-launch";
import { electrobunCliPreparationFor } from "../../../scripts/patch-launcher";

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
        SetThreadDpiAwarenessContext: (context: bigint) => { events.push("thread"); events.push(context); return -1n; },
      }, close: () => events.push("close") }) }),
      class { constructor() { events.push("worker"); } },
      { warn: () => events.push("warning") },
    );
    return [...events];
  };
  expect(run("win32")).toEqual([-4n, "thread", -4n, "close", "worker"]);
  expect(run("darwin")).toEqual(["worker"]);
  expect(run("linux")).toEqual(["worker"]);
  expect(run("win32", false)).toEqual([-4n, "warning", "thread", -4n, "close", "worker"]);
  expect(addDpiAwarenessBeforeWorker(fixed)).toBe(fixed);
});

for (const overrideThread of [false, true]) {
test.skipIf(process.platform !== "win32")(`launcher sets the real Windows DPI context to per-monitor v2${overrideThread ? " with a preexisting thread override" : ""}`, () => {
  const script = addDpiAwarenessBeforeWorker(`
    new Worker();
  `);
  const probe = `
    const __require = require;
    ${overrideThread ? `
      const initial = require("bun:ffi").dlopen("user32.dll", {
        SetThreadDpiAwarenessContext: { args: ["i64"], returns: "i64" },
      });
      initial.symbols.SetThreadDpiAwarenessContext(-1n);
      initial.close();
    ` : ""}
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
  const diagnostic = `DPI probe exit=${child.exitCode}; stdout=${child.stdout.toString()}; stderr=${child.stderr.toString()}`;
  expect(child.exitCode, diagnostic).toBe(0);
  expect(child.stdout.toString().trim(), diagnostic).toBe("1");
  expect(child.stderr.toString(), diagnostic).toBe("");
});
}

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

test("build preparation re-signs the cached Electrobun CLI on macOS", () => {
  expect(electrobunCliPreparationFor("darwin", "/repo")).toEqual({
    command: "codesign",
    args: [
      "--force",
      "--sign",
      "-",
      resolve("/repo/node_modules/electrobun/bin/electrobun"),
    ],
  });
  expect(electrobunCliPreparationFor("win32", "/repo")).toBeUndefined();
  expect(electrobunCliPreparationFor("linux", "/repo")).toBeUndefined();
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
