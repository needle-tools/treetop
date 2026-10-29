import { describe, expect, test } from "bun:test";
import electrobunConfig from "../../../electrobun.config";

describe("electrobun config", () => {
  test("native runtime includes the cross-thread FFI callback heap corruption fix", () => {
    // Electrobun 1.18.4 defaults to Bun 1.3.13, which crashes before DOM ready.
    // Bun's fix (oven-sh/bun#31332) shipped after 1.3.14.
    expect(Bun.semver.satisfies(electrobunConfig.build.bunVersion ?? "1.3.13", ">=1.4.0")).toBe(true);
  });
  test("mac native app keeps WebKit and declares microphone permission for voice", () => {
    expect(electrobunConfig.build.mac.bundleCEF).not.toBe(true);
    expect(electrobunConfig.build.mac.defaultRenderer ?? "native").toBe(
      "native",
    );
    expect(electrobunConfig.build.mac.entitlements).toMatchObject({
      "com.apple.security.device.audio-input":
        "Treetop uses the microphone for global voice mode.",
    });
  });
});

// Run against the actual distribution runtime, not the test runner's Bun.
// This uses native Windows threads without creating a window or contacting a daemon.
if (process.platform === "win32" && process.env.TREETOP_NATIVE_RUNTIME_TEST) {
  test("packaged runtime survives callbacks from foreign Windows threads", async () => {
    const child = Bun.spawn([process.env.TREETOP_NATIVE_RUNTIME_TEST!, "--eval", `
      const { dlopen, JSCallback } = require("bun:ffi");
      const kernel = dlopen("kernel32.dll", {
        CreateThread: { args: ["ptr", "u64", "ptr", "ptr", "u32", "ptr"], returns: "ptr" },
        CloseHandle: { args: ["ptr"], returns: "bool" },
      });
      let seen = 0;
      const callback = new JSCallback(() => { seen++; }, {
        args: ["ptr"], returns: "u32", threadsafe: true,
      });
      for (let batch = 0; batch < 100; batch++) {
        for (let i = 0; i < 100; i++) {
          const handle = kernel.symbols.CreateThread(null, 0, callback.ptr, null, 0, null);
          if (!handle) throw Error("CreateThread failed");
          kernel.symbols.CloseHandle(handle);
        }
        await Bun.sleep(10);
      }
      const deadline = Date.now() + 5000;
      while (seen < 10000 && Date.now() < deadline) await Bun.sleep(10);
      console.log(JSON.stringify({ seen }));
      process.exit(seen === 10000 ? 0 : 1);
    `], { windowsHide: true, stdout: "pipe", stderr: "pipe", timeout: 15000 });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout).seen).toBe(10000);
  }, 20000);
}
