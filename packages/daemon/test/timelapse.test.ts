import { test, expect } from "bun:test";
import nativeConfig from "../../../electrobun.config";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TimelapseStore,
  findTimelapseEncoder,
  encodeTimelapse,
} from "../src/timelapse";
import { TimelapseWindows, captureWindowsJpeg } from "../src/timelapse-capture";

test("capture registration rejects invalid handles; native helper skips missing windows without taking a screenshot", async () => {
  const windows = new TimelapseWindows();
  expect(windows.register("0", process.pid)).toBe(false);
  expect(windows.register("1; Get-Process", process.pid)).toBe(false);
  expect(windows.register("123", -1)).toBe(false);
  if (process.platform === "win32")
    expect(
      await captureWindowsJpeg({ hwnd: "0", pid: process.pid, at: Date.now() }),
    ).toBeNull();
  else await expect(windows.capture()).rejects.toThrow("Windows native app");
});

test("recording is opt-in, throttled across windows, and survives reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-timelapse-"));
  let enabled = false,
    captures = 0;
  const start = new Date(2026, 10, 17, 12).getTime();
  let now = start;
  const options = {
    enabled: async () => enabled,
    now: () => now,
    capture: async () => {
      captures++;
      return new Uint8Array([255, 216, 255, 217]);
    },
  };
  try {
    const store = new TimelapseStore(root, options);
    expect((await store.capture()).captured).toBe(false);
    expect(captures).toBe(0);
    expect(await readdir(root)).toEqual([]);
    enabled = true;
    expect((await store.capture()).captured).toBe(true);
    expect((await store.capture()).captured).toBe(false);
    now += 10_000;
    await store.capture();
    const reopened = new TimelapseStore(root, options);
    const days = await reopened.list();
    expect(days).toHaveLength(1);
    expect(days[0].frames).toHaveLength(2);
    expect(captures).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("8-hour exports resume after restart; failed exports retain every JPEG", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-timelapse-"));
  let now = new Date(2026, 10, 17, 18).getTime();
  let attempts = 0;
  const options = {
    enabled: async () => true,
    now: () => now,
    capture: async () => new Uint8Array([255, 216, 255, 217]),
    encode: async () => {
      attempts++;
      throw new Error("encoder failed");
    },
  };
  try {
    const store = new TimelapseStore(root, options);
    await store.capture();
    await store.finalize();
    expect(attempts).toBe(0);
    now += 3600_000;
    await store.capture();
    now += 7 * 3600_000;
    await store.finalize();
    expect(attempts).toBe(0); // wait eight hours from the latest screenshot
    now += 3600_000;
    await new TimelapseStore(root, options).finalize();
    expect(attempts).toBe(1);
    const [day] = await store.list();
    expect(day.error).toContain("encoder failed");
    expect(
      (await readdir(join(root, day.day))).filter((f) => f.endsWith(".jpg")),
    ).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real encoder creates crisp and blended MP4s before removing JPEG sources", async () => {
  const encoder = findTimelapseEncoder();
  expect(encoder).toBeTruthy();
  const root = await mkdtemp(join(tmpdir(), "treetop-timelapse-video-"));
  let now = new Date(2026, 10, 17, 18).getTime();
  let index = 0;
  try {
    const fixtures: string[] = [];
    for (const color of ["red", "green", "blue"]) {
      const path = join(root, color + ".jpg");
      const p = Bun.spawn(
        [
          encoder!,
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          `color=c=${color}:s=320x180`,
          "-frames:v",
          "1",
          path,
        ],
        { windowsHide: true, stdout: "ignore", stderr: "pipe" },
      );
      const error = await new Response(p.stderr).text();
      expect(await p.exited, error).toBe(0);
      fixtures.push(path);
    }
    const store = new TimelapseStore(root, {
      enabled: async () => true,
      now: () => now,
      capture: async () => new Uint8Array(await readFile(fixtures[index++])),
      encode: encodeTimelapse,
    });
    for (let i = 0; i < 3; i++) {
      await store.capture();
      now += 10_000;
    }
    now += 8 * 3600_000;
    await store.finalize();
    const [day] = await store.list();
    expect(day.complete).toBe(true);
    for (const name of ["crisp.mp4", "motion-blur.mp4"]) {
      const path = join(root, day.day, name);
      expect((await stat(path)).size).toBeGreaterThan(100);
      expect((await readFile(path)).subarray(4, 8).toString()).toBe("ftyp");
    }
    expect(
      (await readdir(join(root, day.day))).filter((f) => f.endsWith(".jpg")),
    ).toHaveLength(0);
    expect(await readFile(join(root, day.day, "crisp.mp4"))).not.toEqual(
      await readFile(join(root, day.day, "motion-blur.mp4")),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("native installer excludes the optional encoder", () => {
  const copy = nativeConfig.build.copy as Record<string, string>;
  expect(
    Object.values(copy).filter((value) => value.startsWith("ffmpeg")),
  ).toEqual([]);
});

test("optional encoder installs once, verifies downloads, and preserves retry after failure", async () => {
  const { TimelapseEncoderInstaller } = await import("../src/timelapse");
  const { gzipSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "treetop-encoder-"));
  const data = gzipSync(Buffer.from("synthetic encoder fixture"));
  let calls = 0,
    corrupt = true;
  const installer = new TimelapseEncoderInstaller(root, {
    asset: {
      target: "win32-x64",
      sha256: createHash("sha256").update(data).digest("hex"),
      size: data.length,
    },
    download: async (url: string) => {
      calls++;
      return new Response(
        url.endsWith(".gz")
          ? corrupt
            ? Buffer.from("broken")
            : data
          : "License and source notices",
      );
    },
  });
  try {
    expect(await readdir(root)).toEqual([]);
    await expect(installer.install()).rejects.toThrow("checksum");
    expect(installer.status().state).toBe("error");
    expect(await Bun.file(installer.path).exists()).toBe(false);
    corrupt = false;
    const [a, b] = await Promise.all([
      installer.install(),
      installer.install(),
    ]);
    expect(a).toBe(b);
    expect(await readFile(a, "utf8")).toBe("synthetic encoder fixture");
    expect(installer.status().state).toBe("ready");
    expect(
      await readFile(join(root, "ffmpeg-b6.1.1-win32-x64.LICENSE"), "utf8"),
    ).toContain("License");
    const before = calls;
    const reopened = new TimelapseEncoderInstaller(root, {
      asset: installer.asset,
      download: async () => {
        throw new Error("must use cache");
      },
    });
    expect(await reopened.install()).toBe(a);
    expect(calls).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit cancellation aborts an encoder download and leaves no usable partial install", async () => {
  const { TimelapseEncoderInstaller } = await import("../src/timelapse");
  const root = await mkdtemp(join(tmpdir(), "treetop-encoder-cancel-"));
  let aborted = false;
  const installer = new TimelapseEncoderInstaller(root, {
    download: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init!.signal!.reason);
          },
          { once: true },
        );
      }),
  });
  try {
    const result = installer.install().catch((error) => error);
    expect(installer.status().state).toBe("downloading");
    await installer.cancel();
    await result;
    expect(aborted).toBe(true);
    expect(installer.status().state).toBe("cancelled");
    expect(await Bun.file(installer.path).exists()).toBe(false);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
