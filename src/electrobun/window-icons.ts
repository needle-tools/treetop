import { dlopen, ptr } from "bun:ffi";

/** Windows interprets these as source bitmap pixels, not tray layout dimensions.
 * Give Explorer a source it can downsample at any normal display scale. macOS
 * interprets the same options as points; its bundled PNG supplies Retina pixels. */
export function trayImageSize(platform: string) {
  const size = platform === "win32" ? 256 : 16;
  return { width: size, height: size };
}

/** Own window icon handles separately from the framework's tray icon. */
export function createWindowsWindowIcons(path: string) {
  const user = dlopen("user32.dll", {
    GetDpiForWindow: { args: ["u64"], returns: "u32" },
    GetSystemMetricsForDpi: { args: ["i32", "u32"], returns: "i32" },
    LoadImageW: { args: ["u64", "u64", "u32", "i32", "i32", "u32"], returns: "u64" },
    SendMessageW: { args: ["u64", "u32", "u64", "u64"], returns: "u64" },
    IsWindow: { args: ["u64"], returns: "i32" },
    DestroyIcon: { args: ["u64"], returns: "i32" },
  });
  const filename = Buffer.from(`${path}\0`, "utf16le");
  let window = 0n, small = 0n, large = 0n, dpi = 0;
  function load(width: number, height: number): bigint {
    // Explicit dimensions: LR_DEFAULTSIZE silently chooses a single low-res
    // image, even when the ICO includes a complete set of high-DPI frames.
    const icon = BigInt(user.symbols.LoadImageW(0n, BigInt(ptr(filename)), 1, width, height, 0x10));
    if (!icon) throw new Error(`Could not load ${width}x${height} window icon: ${path}`);
    return icon;
  }
  function destroy(icon: bigint) {
    if (icon) user.symbols.DestroyIcon(icon);
  }
  function refresh(hwnd: bigint) {
    const nextDpi = user.symbols.GetDpiForWindow(hwnd);
    if (!nextDpi || (hwnd === window && nextDpi === dpi)) return;
    const width = user.symbols.GetSystemMetricsForDpi(49, nextDpi); // SM_CXSMICON
    const height = user.symbols.GetSystemMetricsForDpi(50, nextDpi); // SM_CYSMICON
    const nextSmall = load(width, height);
    let nextLarge: bigint;
    try {
      // Explorer/Alt+Tab can request larger sizes than SM_CXICON. Keep the
      // original 256px source so the shell downsamples instead of upscaling.
      nextLarge = large || load(256, 256);
    } catch (error) { destroy(nextSmall); throw error; }
    user.symbols.SendMessageW(hwnd, 0x80, 0n, nextSmall); // WM_SETICON, ICON_SMALL
    user.symbols.SendMessageW(hwnd, 0x80, 1n, nextLarge); // ICON_BIG
    destroy(small);
    small = nextSmall; large = nextLarge; dpi = nextDpi; window = hwnd;
  }
  function close() {
    if (window && user.symbols.IsWindow(window)) {
      user.symbols.SendMessageW(window, 0x80, 0n, 0n);
      user.symbols.SendMessageW(window, 0x80, 1n, 0n);
    }
    destroy(small); destroy(large);
    small = large = window = 0n;
    user.close();
  }
  return { load, destroy, refresh, close };
}
