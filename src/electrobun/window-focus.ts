import { dlopen, JSCallback, ptr } from "bun:ffi";

interface NativeFocusApi {
  foreground(): bigint;
  focused(window: bigint): bigint;
  isChild(parent: bigint, child: bigint): boolean;
  webviewChild(window: bigint): bigint;
  currentThread(): number;
  windowThread(window: bigint): number;
  attach(from: number, to: number, enabled: boolean): boolean;
  focus(window: bigint): void;
}

/** Restore only this foreground window's WebView; never activate another app. */
export function restoreNativeWebviewFocus(
  window: bigint,
  api: NativeFocusApi,
): boolean {
  if (!window || api.foreground() !== window) return false;
  const focused = api.focused(window);
  if (focused && api.isChild(window, focused)) return true;
  const child = api.webviewChild(window);
  if (!child) return false;
  const from = api.currentThread(),
    to = api.windowThread(child);
  if (!to) return false;
  const attach = from !== to;
  if (attach && !api.attach(from, to, true)) return false;
  try {
    if (api.foreground() !== window) return false;
    api.focus(child);
    return true;
  } finally {
    if (attach) api.attach(from, to, false);
  }
}

/** Electrobun's Windows activation focuses its HWND, not WebView2's child HWND.
 * Attach only for the SetFocus call because this code runs on the Bun worker,
 * while the WebView owns a separate UI thread. */
export function createWindowsWebviewFocus() {
  const user = dlopen("user32.dll", {
    GetForegroundWindow: { args: [], returns: "u64" },
    GetWindowThreadProcessId: { args: ["u64", "u64"], returns: "u32" },
    GetGUIThreadInfo: { args: ["u32", "u64"], returns: "i32" },
    IsChild: { args: ["u64", "u64"], returns: "i32" },
    IsWindowVisible: { args: ["u64"], returns: "i32" },
    EnumChildWindows: { args: ["u64", "ptr", "u64"], returns: "i32" },
    GetClassNameW: { args: ["u64", "u64", "i32"], returns: "i32" },
    AttachThreadInput: { args: ["u32", "u32", "i32"], returns: "i32" },
    SetFocus: { args: ["u64"], returns: "u64" },
  });
  const kernel = dlopen("kernel32.dll", {
    GetCurrentThreadId: { args: [], returns: "u32" },
  });
  const api: NativeFocusApi = {
    foreground: () => BigInt(user.symbols.GetForegroundWindow()),
    focused: (window) => {
      const info = Buffer.alloc(72); // GUITHREADINFO, x64 ABI
      info.writeUInt32LE(info.length);
      const thread = user.symbols.GetWindowThreadProcessId(window, 0n);
      return user.symbols.GetGUIThreadInfo(thread, BigInt(ptr(info)))
        ? info.readBigUInt64LE(16)
        : 0n;
    },
    isChild: (parent, child) => !!user.symbols.IsChild(parent, child),
    webviewChild: (window) => {
      let selected = 0n,
        rank = 0;
      const callback = new JSCallback(
        (child: bigint) => {
          const name = Buffer.alloc(512);
          const length = user.symbols.GetClassNameW(
            child,
            BigInt(ptr(name)),
            256,
          );
          const cls = name.toString("utf16le", 0, length * 2);
          const priority = cls.startsWith("Chrome_RenderWidgetHostHWND")
            ? 2
            : cls.startsWith("Chrome_WidgetWin")
              ? 1
              : 0;
          if (priority > rank && user.symbols.IsWindowVisible(child)) {
            selected = BigInt(child);
            rank = priority;
          }
          return 1;
        },
        { args: ["u64", "u64"], returns: "i32" },
      );
      try {
        user.symbols.EnumChildWindows(window, callback.ptr, 0n);
      } finally {
        callback.close();
      }
      return selected;
    },
    currentThread: () => kernel.symbols.GetCurrentThreadId(),
    windowThread: (window) => user.symbols.GetWindowThreadProcessId(window, 0n),
    attach: (from, to, enabled) =>
      !!user.symbols.AttachThreadInput(from, to, enabled ? 1 : 0),
    focus: (window) => {
      user.symbols.SetFocus(window);
    },
  };
  return {
    restore: (window: bigint) => restoreNativeWebviewFocus(window, api),
    close: () => {
      user.close();
      kernel.close();
    },
  };
}
