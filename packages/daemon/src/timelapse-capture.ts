export interface TimelapseWindow {
  hwnd: string;
  pid: number;
  at: number;
}

/** The native shell registers its exact SDK HWND. Never select a window by title. */
export class TimelapseWindows {
  private windows = new Map<number, TimelapseWindow>();
  register(hwnd: unknown, pid: unknown, now = Date.now()): boolean {
    if (
      typeof hwnd !== "string" ||
      !/^\d{1,19}$/.test(hwnd) ||
      BigInt(hwnd) <= 0n ||
      BigInt(hwnd) > 0x7fffffffffffffffn ||
      !Number.isSafeInteger(pid) ||
      (pid as number) <= 0
    )
      return false;
    this.windows.set(pid as number, { hwnd, pid: pid as number, at: now });
    return true;
  }
  async capture(now = Date.now()): Promise<Uint8Array | null> {
    if (process.platform !== "win32")
      throw new Error(
        "Timelapse capture currently requires the Windows native app",
      );
    for (const [pid, window] of this.windows) {
      if (now - window.at > 15_000) {
        this.windows.delete(pid);
        continue;
      }
      const jpeg = await captureWindowsJpeg(window);
      if (jpeg) return jpeg;
    }
    return null;
  }
}

export async function captureWindowsJpeg(
  window: TimelapseWindow,
): Promise<Uint8Array | null> {
  if (process.platform !== "win32")
    throw new Error("Windows capture is unavailable");
  if (!/^\d{1,19}$/.test(window.hwnd) || !Number.isSafeInteger(window.pid))
    throw new Error("Invalid capture window");
  const { dlopen, ptr } = await import("bun:ffi");
  const user = dlopen("user32.dll", {
    GetForegroundWindow: { args: [], returns: "u64" },
    IsWindow: { args: ["u64"], returns: "i32" },
    IsIconic: { args: ["u64"], returns: "i32" },
    GetWindowThreadProcessId: { args: ["u64", "u64"], returns: "u32" },
    GetDC: { args: ["u64"], returns: "u64" },
    ReleaseDC: { args: ["u64", "u64"], returns: "i32" },
    GetSystemMetrics: { args: ["i32"], returns: "i32" },
    SetThreadDpiAwarenessContext: { args: ["i64"], returns: "i64" },
  });
  const dwm = dlopen("dwmapi.dll", {
    DwmGetWindowAttribute: {
      args: ["u64", "u32", "u64", "u32"],
      returns: "i32",
    },
  });
  const gdi = dlopen("gdi32.dll", {
    CreateCompatibleDC: { args: ["u64"], returns: "u64" },
    CreateCompatibleBitmap: { args: ["u64", "i32", "i32"], returns: "u64" },
    SelectObject: { args: ["u64", "u64"], returns: "u64" },
    DeleteObject: { args: ["u64"], returns: "i32" },
    DeleteDC: { args: ["u64"], returns: "i32" },
    BitBlt: {
      args: ["u64", "i32", "i32", "i32", "i32", "u64", "i32", "i32", "u32"],
      returns: "i32",
    },
    GetDIBits: {
      args: ["u64", "u64", "u32", "u32", "u64", "u64", "u32"],
      returns: "i32",
    },
  });
  let desktop = 0n,
    memory = 0n,
    bitmap = 0n,
    previous = 0n,
    oldDpi = 0n;
  let pixels: Buffer | undefined,
    width = 0,
    height = 0;
  try {
    const hwnd = BigInt(window.hwnd);
    if (
      !user.symbols.IsWindow(hwnd) ||
      user.symbols.IsIconic(hwnd) ||
      BigInt(user.symbols.GetForegroundWindow()) !== hwnd
    )
      return null;
    const owner = new Uint32Array(1);
    user.symbols.GetWindowThreadProcessId(hwnd, BigInt(ptr(owner)));
    if (owner[0] !== window.pid) return null;
    oldDpi = BigInt(user.symbols.SetThreadDpiAwarenessContext(-4n));
    const rect = new Int32Array(4);
    if (dwm.symbols.DwmGetWindowAttribute(hwnd, 9, BigInt(ptr(rect)), 16) !== 0)
      throw new Error("Could not read Treetop window bounds");
    const [left, top, right, bottom] = rect;
    const x = user.symbols.GetSystemMetrics(76),
      y = user.symbols.GetSystemMetrics(77);
    if (
      left < x ||
      top < y ||
      right > x + user.symbols.GetSystemMetrics(78) ||
      bottom > y + user.symbols.GetSystemMetrics(79)
    )
      return null;
    width = right - left;
    height = bottom - top;
    if (width <= 0 || height <= 0 || width * height > 64_000_000) return null;
    desktop = BigInt(user.symbols.GetDC(0n));
    memory = BigInt(gdi.symbols.CreateCompatibleDC(desktop));
    bitmap = BigInt(gdi.symbols.CreateCompatibleBitmap(desktop, width, height));
    if (!desktop || !memory || !bitmap)
      throw new Error("Could not allocate a window capture bitmap");
    previous = BigInt(gdi.symbols.SelectObject(memory, bitmap));
    if (
      !gdi.symbols.BitBlt(
        memory,
        0,
        0,
        width,
        height,
        desktop,
        left,
        top,
        0x00cc0020,
      )
    )
      throw new Error("Could not capture Treetop window pixels");
    const after = new Int32Array(4);
    if (
      BigInt(user.symbols.GetForegroundWindow()) !== hwnd ||
      dwm.symbols.DwmGetWindowAttribute(hwnd, 9, BigInt(ptr(after)), 16) !==
        0 ||
      after.some((value, index) => value !== rect[index])
    )
      return null;
    gdi.symbols.SelectObject(memory, previous);
    previous = 0n;
    pixels = Buffer.alloc(width * height * 4);
    const info = Buffer.alloc(40);
    info.writeUInt32LE(40, 0);
    info.writeInt32LE(width, 4);
    info.writeInt32LE(-height, 8);
    info.writeUInt16LE(1, 12);
    info.writeUInt16LE(32, 14);
    info.writeUInt32LE(pixels.length, 20);
    if (
      gdi.symbols.GetDIBits(
        desktop,
        bitmap,
        0,
        height,
        BigInt(ptr(pixels)),
        BigInt(ptr(info)),
        0,
      ) !== height
    )
      throw new Error("Could not read Treetop window pixels");
  } finally {
    if (previous && memory) gdi.symbols.SelectObject(memory, previous);
    if (bitmap) gdi.symbols.DeleteObject(bitmap);
    if (memory) gdi.symbols.DeleteDC(memory);
    if (desktop) user.symbols.ReleaseDC(0n, desktop);
    if (oldDpi) user.symbols.SetThreadDpiAwarenessContext(oldDpi);
    gdi.close();
    dwm.close();
    user.close();
  }
  const { findTimelapseEncoder } = await import("./timelapse");
  const encoder = findTimelapseEncoder();
  if (!encoder) throw new Error("FFmpeg is unavailable for JPEG capture");
  const p = Bun.spawn(
    [
      encoder,
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "rawvideo",
      "-pixel_format",
      "bgra",
      "-video_size",
      `${width}x${height}`,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-c:v",
      "mjpeg",
      "-threads",
      "1",
      "-q:v",
      "3",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    { windowsHide: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => p.kill(), 8000);
  try {
    p.stdin.write(pixels!);
    p.stdin.end();
    const [out, error] = await Promise.all([
      new Response(p.stdout).arrayBuffer(),
      new Response(p.stderr).text(),
    ]);
    if ((await p.exited) !== 0)
      throw new Error(`JPEG capture failed: ${error.slice(-1000)}`);
    return new Uint8Array(out);
  } finally {
    clearTimeout(timeout);
  }
}
