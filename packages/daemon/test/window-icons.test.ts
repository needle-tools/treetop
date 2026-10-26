import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { createWindowsWindowIcons, createWindowsCaptionStyle, trayImageSize } from "../../../src/electrobun/window-icons";
import nativeConfig from "../../../electrobun.config";

test.skipIf(process.platform !== "win32")("original caption styling succeeds on a native window and retains dragging and resizing", async () => {
  const { dlopen, ptr } = await import("bun:ffi");
  const user = dlopen("user32.dll", {
    CreateWindowExW: { args: ["u32", "u64", "u64", "u32", "i32", "i32", "i32", "i32", "u64", "u64", "u64", "u64"], returns: "u64" },
    DestroyWindow: { args: ["u64"], returns: "i32" },
    DefWindowProcW: { args: ["u64", "u32", "u64", "u64"], returns: "i64" },
    GetWindowLongW: { args: ["u64", "i32"], returns: "i32" },
  });
  const cls = Buffer.from("STATIC\0", "utf16le"), title = Buffer.from("caption test\0", "utf16le");
  const create = () => BigInt(user.symbols.CreateWindowExW(0, BigInt(ptr(cls)), BigInt(ptr(title)), 0x00cf0000, 100, 100, 800, 600, 0n, 0n, 0n, 0n));
  const window = create();
  const appearance = createWindowsCaptionStyle();
  try {
    expect(window).not.toBe(0n);
    // DWM accepts these attributes for setting but does not expose them through
    // DwmGetWindowAttribute. Assert real HRESULTs via the helper, not fake reads.
    expect(() => appearance.refresh(window)).not.toThrow();
    expect(() => appearance.refresh(0n)).toThrow("Native caption attribute");
    expect(user.symbols.GetWindowLongW(window, -16) & 0x00cf0000).toBe(0x00cf0000);
    // STATIC handles WM_NCHITTEST as HTTRANSPARENT; exercise the OS frame
    // handler directly rather than that control-specific client handler.
    const hit = (x: number, y: number) => Number(user.symbols.DefWindowProcW(window, 0x84, 0n, BigInt((y << 16) | x)));
    expect(hit(300, 120)).toBe(2); // HTCAPTION: OS dragging, not HTML.
    expect(hit(101, 300)).toBe(10); // HTLEFT: OS resizing.
  } finally {
    appearance.close(); user.symbols.DestroyWindow(window); user.close();
  }
});

test("Windows tray gets a large raster source while macOS keeps point-sized layout", () => {
  expect(trayImageSize("win32")).toEqual({ width: 256, height: 256 });
  expect(trayImageSize("darwin")).toEqual({ width: 24, height: 18 });
});

test("ICO contains directly rendered images for fractional Windows scale factors", async () => {
  const ico = readFileSync(resolve(import.meta.dir, "../../../icon.ico"));
  const sizes: number[] = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
    const info = await sharp(ico.subarray(offset, offset + length)).metadata();
    expect(info.width).toBe(size);
    expect(info.height).toBe(size);
    sizes.push(size);
  }
  expect(sizes).toEqual([16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 128, 256]);
});

test("macOS packages a Retina tray source and full-resolution Retina app icons", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const source = Object.entries(nativeConfig.build.copy).find(([, destination]) => destination === "tray.png")![0];
  const tray = await sharp(resolve(root, source)).metadata();
  expect(tray.width).toBeGreaterThanOrEqual(trayImageSize("darwin").width * 2);
  expect(tray.height).toBeGreaterThanOrEqual(trayImageSize("darwin").height * 2);
  const { data, info } = await sharp(resolve(root, source)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect(info.channels).toBe(4);
  expect(data[3]).toBe(0); // No app-icon background in the menu bar.
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    opaque++;
    expect(data[i]).toBe(0);
    expect(data[i + 1]).toBe(0);
    expect(data[i + 2]).toBe(0);
  }
  expect(opaque).toBeGreaterThan(info.width * info.height * 0.2);
  expect(opaque).toBeLessThan(info.width * info.height * 0.8);
  for (const size of [16, 32, 64, 128, 256, 512]) {
    const retina = await sharp(resolve(root, `icon.iconset/icon_${size}x${size}@2x.png`)).metadata();
    expect(retina.width).toBe(size * 2);
    expect(retina.height).toBe(size * 2);
  }
});

test.skipIf(process.platform !== "win32")("window installs distinct small and large icons, reuses them, and releases them on close", async () => {
  const { dlopen, ptr } = await import("bun:ffi");
  const user = dlopen("user32.dll", {
    CreateWindowExW: { args: ["u32", "u64", "u64", "u32", "i32", "i32", "i32", "i32", "u64", "u64", "u64", "u64"], returns: "u64" },
    DestroyWindow: { args: ["u64"], returns: "i32" },
    SendMessageW: { args: ["u64", "u32", "u64", "u64"], returns: "u64" },
    GetIconInfo: { args: ["u64", "u64"], returns: "i32" },
  });
  const cls = Buffer.from("STATIC\0", "utf16le");
  // A hidden test-owned HWND; never inspect or mutate the running app.
  const window = BigInt(user.symbols.CreateWindowExW(0, BigInt(ptr(cls)), 0n, 0, 0, 0, 100, 100, 0n, 0n, 0n, 0n));
  expect(window).not.toBe(0n);
  const icons = createWindowsWindowIcons(resolve(import.meta.dir, "../../../icon.ico"));
  let closed = false;
  try {
    icons.refresh(window);
    const small = BigInt(user.symbols.SendMessageW(window, 0x7f, 0n, 0n)); // WM_GETICON
    const large = BigInt(user.symbols.SendMessageW(window, 0x7f, 1n, 0n));
    expect(small).not.toBe(0n);
    expect(large).not.toBe(small);
    icons.refresh(window);
    expect(BigInt(user.symbols.SendMessageW(window, 0x7f, 0n, 0n))).toBe(small);
    icons.close(); closed = true;
    expect(BigInt(user.symbols.SendMessageW(window, 0x7f, 0n, 0n))).toBe(0n);
    expect(BigInt(user.symbols.SendMessageW(window, 0x7f, 1n, 0n))).toBe(0n);
    const info = Buffer.alloc(32);
    expect(user.symbols.GetIconInfo(small, BigInt(ptr(info)))).toBe(0);
    expect(user.symbols.GetIconInfo(large, BigInt(ptr(info)))).toBe(0);
  } finally {
    if (!closed) icons.close();
    user.symbols.DestroyWindow(window);
    user.close();
  }
});

test.skipIf(process.platform !== "win32")("real Windows icon handles preserve requested raster resolution", async () => {
  const { dlopen, ptr } = await import("bun:ffi");
  const user = dlopen("user32.dll", {
    GetIconInfo: { args: ["u64", "u64"], returns: "i32" },
  });
  const gdi = dlopen("gdi32.dll", {
    GetObjectW: { args: ["u64", "i32", "u64"], returns: "i32" },
    DeleteObject: { args: ["u64"], returns: "i32" },
  });
  const icons = createWindowsWindowIcons(resolve(import.meta.dir, "../../../icon.ico"));
  try {
    for (const size of [16, 20, 24, 28, 32, 40, 48, 64, 256]) {
      const handle = icons.load(size, size);
      try {
        const info = Buffer.alloc(32); // ICONINFO, x64
        expect(user.symbols.GetIconInfo(handle, BigInt(ptr(info)))).not.toBe(0);
        const mask = info.readBigUInt64LE(16), color = info.readBigUInt64LE(24);
        try {
          const bitmap = Buffer.alloc(32); // BITMAP, x64
          expect(gdi.symbols.GetObjectW(color, bitmap.length, BigInt(ptr(bitmap)))).toBeGreaterThan(0);
          expect(bitmap.readInt32LE(4)).toBe(size);
          expect(bitmap.readInt32LE(8)).toBe(size);
        } finally {
          if (mask) gdi.symbols.DeleteObject(mask);
          if (color) gdi.symbols.DeleteObject(color);
        }
      } finally { icons.destroy(handle); }
    }
  } finally { icons.close(); user.close(); gdi.close(); }
});
