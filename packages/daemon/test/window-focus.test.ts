import { expect, test } from "bun:test";
import {
  restoreNativeWebviewFocus,
  createWindowsWebviewFocus,
} from "../../../src/electrobun/window-focus";
import { nativeWindowFocusScript } from "../../ui/src/window-focus-events";

test("native activation restores keyboard input to the WebView child across UI threads", () => {
  const calls: unknown[] = [];
  const api = {
    foreground: () => 1n,
    focused: () => 1n,
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
