import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DAEMON_BUILD_EXTERNALS, NATIVE_BACKGROUND_COMPILE_ARGS, setWindowsGuiSubsystem } from "../../../scripts/build-native-options";
import nativeConfig from "../../../electrobun.config";

test("native packaging keeps the tray owner alive after the last window closes", () => {
  // Electrobun serializes the top-level runtime into Resources/build.json.
  // A setting under build.runtime is silently omitted from the installed app.
  const packaged = JSON.parse(JSON.stringify({ runtime: nativeConfig.runtime ?? {} }));
  expect(packaged.runtime.exitOnLastWindowClosed ?? true).toBe(false);
});

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
import { nativeTitleBarStyle, restoreWindowState, captureWindowState, restoreWindowModeOnReady } from "../../../src/electrobun/window-state";

test("Windows uses a captionless resizable window without changing macOS chrome", () => {
  expect(nativeTitleBarStyle("win32")).toBe("hiddenInset");
  expect(nativeTitleBarStyle("darwin")).toBe("default");
  expect(nativeTitleBarStyle("linux")).toBe("default");
});

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
  expect(child.stderr.toString().trim(), diagnostic).toMatch(
    /^(?:|\[LAUNCHER\] Could not enable per-monitor DPI awareness \(process default may already be set\))$/,
  );
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


if (process.platform === "win32") test("compiled background processes have no Windows console even when launched detached", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "treetop-hidden-background-"));
  const entrypoint = resolve(directory, "entry.ts");
  const binary = resolve(directory, "background.exe");
  const report = resolve(directory, "console.json");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await writeFile(entrypoint, `import {dlopen} from 'bun:ffi'; const api=dlopen('kernel32.dll',{GetConsoleWindow:{args:[],returns:'u64'}}); await Bun.write(process.env.TREETOP_CONSOLE_TEST_REPORT!,JSON.stringify({console:Number(api.symbols.GetConsoleWindow()),pid:process.pid}));setInterval(()=>{},1000);`);
    const compile = Bun.spawn([process.execPath,"build","--compile",entrypoint,"--outfile",binary,...NATIVE_BACKGROUND_COMPILE_ARGS],{stdout:"ignore",stderr:"pipe"});
    const errors = await new Response(compile.stderr).text();
    expect(await compile.exited,errors).toBe(0);
    await setWindowsGuiSubsystem(binary);
    const pe = await readFile(binary);
    // Fail before launch if the build would create the unwanted visible window.
    expect(pe.readUInt16LE(pe.readUInt32LE(0x3c)+4+20+68)).toBe(2);
    child = Bun.spawn([binary], {detached:true,windowsHide:true,stdin:"ignore",stdout:"ignore",stderr:"ignore",env:{...process.env,TREETOP_CONSOLE_TEST_REPORT:report}});
    let result: any;
    for(let i=0;i<100;i++){try{result=JSON.parse(await readFile(report,"utf8"));break;}catch{await Bun.sleep(30);}}
    expect(result).toMatchObject({console:0,pid:child.pid});
  } finally {
    if(child && child.exitCode===null){child.kill("SIGKILL");await child.exited;}
    if (!directory.startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/"))) throw new Error("Unexpected fixture directory");
    await rm(directory,{recursive:true,force:true});
  }
},30_000);

if (process.platform === "win32") test("packaged process checks do not allocate a visible console", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "treetop-hidden-poll-"));
  const binary = resolve(directory, "poll.exe");
  const entrypoint = resolve(directory, "poll.ts");
  const locatorEntry = resolve(directory, "where.ts");
  const locatorBinary = resolve(directory, "where.exe");
  const probe = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class WindowProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window); }'; [WindowProbe]::IsWindowVisible([WindowProbe]::GetConsoleWindow()); Write-Error 'stderr captured'; exit 7`;
  try {
    // A real console-subsystem locator lets the real editor discovery code
    // report its window visibility without depending on installed editors.
    await writeFile(locatorEntry, `import {dlopen} from 'bun:ffi'; const k=dlopen('kernel32.dll',{GetConsoleWindow:{args:[],returns:'u64'}}); const u=dlopen('user32.dll',{IsWindowVisible:{args:['u64'],returns:'i32'}}); await Bun.write(${JSON.stringify(directory)}+'/'+process.pid+'.visibility.json',JSON.stringify({visible:!!u.symbols.IsWindowVisible(k.symbols.GetConsoleWindow())}));process.exit(1);`);
    const locatorCompile = Bun.spawn([process.execPath,"build","--compile",locatorEntry,"--outfile",locatorBinary],{windowsHide:true,stdout:"ignore",stderr:"pipe"});
    const locatorErrors = await new Response(locatorCompile.stderr).text();
    expect(await locatorCompile.exited,locatorErrors).toBe(0);
    const locatorPe = await readFile(locatorBinary);
    expect(locatorPe.readUInt16LE(locatorPe.readUInt32LE(0x3c)+4+20+68)).toBe(3);
    await writeFile(entrypoint, `import {runWindowsPowerShell} from ${JSON.stringify(resolve(import.meta.dir,"../src/procs.ts"))}; import {detectEditors} from ${JSON.stringify(resolve(import.meta.dir,"../src/open.ts"))}; await detectEditors(); const result=await runWindowsPowerShell(${JSON.stringify(probe)}); console.log(JSON.stringify({stdout:result.stdout.toString().trim(),stderr:result.stderr.toString(),exitCode:result.exitCode}));`);
    const compile = Bun.spawn([process.execPath,"build","--compile",entrypoint,"--outfile",binary],{stdout:"ignore",stderr:"pipe"});
    const errors = await new Response(compile.stderr).text();
    expect(await compile.exited,errors).toBe(0);
    await setWindowsGuiSubsystem(binary);
    const child = Bun.spawn([binary],{windowsHide:true,stdin:"ignore",stdout:"pipe",stderr:"pipe",env:{...process.env,PATH:directory+';'+process.env.PATH}});
    const output = await new Response(child.stdout).text();
    const diagnostic = await new Response(child.stderr).text();
    expect(await child.exited,diagnostic).toBe(0);
    const result=JSON.parse(output);
    expect(result.stdout).toBe("False");
    expect(result.stderr).toContain("stderr captured");
    expect(result.exitCode).toBe(7);
    const reports = (await readdir(directory)).filter(path=>path.endsWith('.visibility.json'));
    expect(reports.length).toBeGreaterThan(1);
    for (const report of reports) expect(JSON.parse(await readFile(resolve(directory,report),'utf8')).visible).toBe(false);
  } finally {
    if (!directory.startsWith(resolve(tmpdir())+"\\")) throw new Error("Unexpected fixture directory");
    await rm(directory,{recursive:true,force:true});
  }
},30_000);
