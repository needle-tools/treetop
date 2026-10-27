import { expect, test } from "bun:test";
import {
  restoreNativeWebviewFocus,
  createWindowsWebviewFocus,
  nativeWebviewFocusTarget,
  createWindowFocusReadiness,
} from "../../../src/electrobun/window-focus";
import { nativeWindowFocusScript } from "../../ui/src/window-focus-events";

test("native activation restores keyboard input to the WebView child across UI threads", () => {
  const calls: unknown[] = [];
  const api = {
    foreground: () => 1n,
    focused: () => calls.includes(2n) ? 2n : 1n,
    isChild: (parent: bigint, child: bigint) => parent === 1n && child === 2n,
    webviewChild: () => 2n,
    currentThread: () => 10,
    windowThread: () => 20,
    attach: (from: number, to: number, enabled: boolean) => {
      calls.push([from, to, enabled]);
      return true;
    },
    focus: (window: bigint) => {
      calls.push(window);
    },
  };
  expect(restoreNativeWebviewFocus(1n, api)).toBe(true);
  expect(calls).toEqual([[10, 20, true], 2n, [10, 20, false]]);
  calls.length = 0;
  expect(restoreNativeWebviewFocus(1n, { ...api, foreground: () => 9n })).toBe(
    false,
  );
  expect(calls).toEqual([]);
  expect(restoreNativeWebviewFocus(1n, {
    ...api,
    focused: () => calls.includes(2n) ? 2n : 3n,
    isChild: (parent, child) => parent === 1n && (child === 2n || child === 3n),
  })).toBe(true);
  expect(calls).toEqual([[10, 20, true], 2n, [10, 20, false]]);
  calls.length = 0;
  expect(restoreNativeWebviewFocus(1n, { ...api, focused: () => 1n })).toBe(false);
  calls.length = 0;
  expect(restoreNativeWebviewFocus(1n, { ...api, focused: () => 2n })).toBe(
    true,
  );
  expect(calls).toEqual([]);
  expect(restoreNativeWebviewFocus(1n, { ...api, attach: () => false })).toBe(
    false,
  );
  expect(calls).toEqual([]);
  expect(() =>
    restoreNativeWebviewFocus(1n, {
      ...api,
      focus: () => {
        throw new Error("focus failed");
      },
    }),
  ).toThrow("focus failed");
  expect(calls).toEqual([
    [10, 20, true],
    [10, 20, false],
  ]);
});

test("native activation and deactivation dispatch the frontend's real focus contract", () => {
  const delivered: unknown[] = [];
  class CustomEvent {
    constructor(
      public type: string,
      public options: unknown,
    ) {}
  }
  const window = { dispatchEvent: (event: unknown) => delivered.push(event) };
  for (const focused of [false, true]) {
    new Function("window", "CustomEvent", nativeWindowFocusScript(focused))(
      window,
      CustomEvent,
    );
  }
  expect(delivered).toEqual([
    new CustomEvent("treetop:native-window-focus", {
      detail: { focused: false },
    }),
    new CustomEvent("treetop:native-window-focus", {
      detail: { focused: true },
    }),
  ]);
});

test("native focus joins both the foreground host and the separate WebView input queue", () => {
  const attached = new Set<number>();
  const calls: unknown[] = [];
  let focused = 1n;
  const api = {
    foreground: () => 1n,
    focused: () => focused,
    isChild: () => false,
    webviewChild: () => 2n,
    currentThread: () => 10,
    windowThread: (window: bigint) => window === 1n ? 30 : 20,
    attach: (_from: number, to: number, enabled: boolean) => {
      calls.push([to, enabled]);
      if (enabled) attached.add(to); else attached.delete(to);
      return true;
    },
    focus: () => {
      if (attached.has(30) && attached.has(20)) focused = 2n;
    },
  };
  expect(restoreNativeWebviewFocus(1n, api)).toBe(true);
  expect(calls).toEqual([[30, true], [20, true], [20, false], [30, false]]);
  expect(attached.size).toBe(0);
  calls.length = 0;
  focused = 1n;
  expect(restoreNativeWebviewFocus(1n, {
    ...api,
    attach: (from, to, enabled) => {
      if (enabled && to === 20) { calls.push([to, enabled]); return false; }
      return api.attach(from, to, enabled);
    },
  })).toBe(false);
  expect(calls).toEqual([[30, true], [20, true], [30, false]]);
  expect(attached.size).toBe(0);
});

test.skipIf(process.platform !== "win32")(
  "Windows focus adapter loads real APIs and refuses to activate an absent window",
  () => {
    const focus = createWindowsWebviewFocus();
    try {
      expect(focus.restore(0n)).toBe(false);
    } finally {
      focus.close();
    }
  },
);

test("native activation targets WebView2's local controller host, not its focused renderer", () => {
  const windows = [
    { window: 2n, className: "Static", visible: true, processId: 10 },
    { window: 3n, className: "Chrome_WidgetWin_0", visible: true, processId: 10 },
    { window: 4n, className: "Chrome_WidgetWin_1", visible: true, processId: 20 },
    { window: 5n, className: "Chrome_RenderWidgetHostHWND", visible: true, processId: 20 },
  ];
  expect(nativeWebviewFocusTarget(windows, 10)).toBe(3n);
  expect(nativeWebviewFocusTarget(windows.slice(2), 10)).toBe(0n);
  expect(nativeWebviewFocusTarget([{ ...windows[1]!, visible: false }], 10)).toBe(0n);
  expect(nativeWebviewFocusTarget([{ ...windows[1]!, processId: 20 }], 10)).toBe(0n);
});


test("focus scripting waits for WebView readiness and stops after close", () => {
  const calls: string[] = [];
  const lifecycle = createWindowFocusReadiness({ focus: () => calls.push("focus"), blur: () => calls.push("blur"), cancel: () => calls.push("cancel") });
  lifecycle.focus();
  expect(calls).toEqual([]);
  lifecycle.ready();
  expect(calls).toEqual(["focus"]);
  lifecycle.blur();
  expect(calls).toEqual(["focus", "cancel", "blur"]);
  lifecycle.focus();
  lifecycle.close();
  const stopped = [...calls];
  lifecycle.ready(); lifecycle.focus(); lifecycle.blur();
  expect(calls).toEqual(stopped);
});
