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

/** Focus the in-process WebView2 controller HWND. Directly focusing Chromium's
 * renderer HWND updates Win32 focus without activating the WebView document. */
export function nativeWebviewFocusTarget(
  windows: { window: bigint; className: string; visible: boolean; processId: number }[],
  processId: number,
): bigint {
  return windows.find(child => child.visible && child.processId === processId &&
    child.className === "Chrome_WidgetWin_0")?.window ?? 0n;
}

/** Restore only this foreground window's WebView; never activate another app. */
export function restoreNativeWebviewFocus(
  window: bigint,
  api: NativeFocusApi,
): boolean {
  if (!window || api.foreground() !== window) return false;
  const child = api.webviewChild(window);
  if (!child) return false;
  // Query the controller's host thread, not Chromium's renderer thread: the
  // latter can retain a stale focus HWND even after the document lost focus.
  const focused = api.focused(child);
  if (focused && (focused === child || api.isChild(child, focused))) return true;
  const from = api.currentThread();
  const host = api.windowThread(window), target = api.windowThread(child);
  if (!host || !target) return false;
  // The Bun worker, foreground host, and WebView renderer can all own
  // different queues. Joining only the renderer does not join the foreground
  // queue and can leave document.hasFocus() false despite GetGUIThreadInfo.
  const attached: number[] = [];
  try {
    for (const thread of new Set([host, target])) {
      if (thread === from) continue;
      if (!api.attach(from, thread, true)) return false;
      attached.push(thread);
    }
    if (api.foreground() !== window) return false;
    api.focus(child);
    const restored = api.focused(child);
    return restored === child || (!!restored && api.isChild(child, restored));
  } finally {
    for (const thread of attached.reverse()) api.attach(from, thread, false);
  }
}

/** Electrobun's Windows activation focuses its HWND, not WebView2's controller.
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
      const children: Parameters<typeof nativeWebviewFocusTarget>[0] = [];
      const callback = new JSCallback(
        (child: bigint) => {
          const name = Buffer.alloc(512);
          const length = user.symbols.GetClassNameW(
            child,
            BigInt(ptr(name)),
            256,
          );
          const cls = name.toString("utf16le", 0, length * 2);
          const owner = Buffer.alloc(4);
          user.symbols.GetWindowThreadProcessId(child, BigInt(ptr(owner)));
          children.push({window: BigInt(child), className: cls,
            visible: !!user.symbols.IsWindowVisible(child), processId: owner.readUInt32LE()});
          return 1;
        },
        { args: ["u64", "u64"], returns: "i32" },
      );
      try {
        user.symbols.EnumChildWindows(window, callback.ptr, 0n);
      } finally {
        callback.close();
      }
      return nativeWebviewFocusTarget(children, process.pid);
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
    snapshot: (window: bigint) => {
      const child = api.webviewChild(window);
      return {
        window: window.toString(),
        foreground: api.foreground().toString(),
        webview: child.toString(),
        focused: api.focused(child || window).toString(),
        workerThread: api.currentThread(),
        hostThread: api.windowThread(window),
        webviewThread: child ? api.windowThread(child) : 0,
      };
    },
    close: () => {
      user.close();
      kernel.close();
    },
  };
}


/** Native focus events can arrive before WebView2 has created its controller. */
export function createWindowFocusReadiness(actions: { focus: () => void; blur: () => void; cancel: () => void }) {
  let ready = false, focused = false, closed = false;
  return {
    focus() { if (closed) return; focused = true; if (ready) actions.focus(); },
    blur() { if (closed) return; focused = false; actions.cancel(); if (ready) actions.blur(); },
    ready() { if (closed) return; ready = true; if (focused) actions.focus(); },
    close() { if (closed) return; closed = true; actions.cancel(); },
  };
}
