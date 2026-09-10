import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { moveCleanupBeforeWorker } from "../../../scripts/patch-launcher";
import {
  DEFAULT_APP_BUNDLE_ID,
  DEFAULT_APP_NAME,
  defaultAppPathFor,
} from "../../../scripts/build-launch";

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
