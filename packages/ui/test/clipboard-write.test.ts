import { test, expect, describe } from "bun:test";
import { writeClipboard } from "../src/clipboard-write";

/**
 * Behavioral contract for the terminal clipboard-write decision.
 *
 * The bug these tests pin: in electrobun's WebView2 the async Clipboard
 * API (`navigator.clipboard.writeText`) *exists but rejects* under strict
 * clipboard permissions. The old code wrote async-first and only tried the
 * `execCommand("copy")` fallback inside the promise's `.catch` — which runs
 * in a later microtask, AFTER the user-gesture call stack has unwound, so
 * `execCommand` is denied too and Ctrl+C silently does nothing.
 *
 * The fix — and what these tests enforce — is that the synchronous,
 * in-gesture copy is attempted FIRST, so it runs while the trusted gesture
 * is still on the stack. The async API is only a fallback.
 */
describe("writeClipboard", () => {
  test("attempts the synchronous in-gesture copy first and stops on success", () => {
    const calls: string[] = [];
    writeClipboard("hello", {
      syncCopy: (t) => {
        calls.push(`sync:${t}`);
        return true;
      },
      asyncWrite: (t) => {
        calls.push(`async:${t}`);
        return Promise.resolve();
      },
    });
    // Sync path ran, succeeded, and short-circuited before the async API.
    expect(calls).toEqual(["sync:hello"]);
  });

  test("runs the synchronous copy on the gesture stack, not after an async reject", async () => {
    // Regression for the WebView2 bug: even when the async API is present and
    // will reject, the sync copy must already have been attempted by the time
    // writeClipboard returns (i.e. inside the gesture), not deferred to .catch.
    let syncCalledSynchronously = false;
    writeClipboard("payload", {
      syncCopy: () => {
        syncCalledSynchronously = true;
        return true;
      },
      asyncWrite: () => Promise.reject(new Error("WebView2 denied")),
    });
    expect(syncCalledSynchronously).toBe(true);
    // Let any rejected promise settle — must not throw unhandled.
    await Promise.resolve();
    await Promise.resolve();
  });

  test("falls back to the async Clipboard API when the sync copy fails", () => {
    const written: string[] = [];
    writeClipboard("from-async", {
      syncCopy: () => false,
      asyncWrite: (t) => {
        written.push(t);
        return Promise.resolve();
      },
    });
    expect(written).toEqual(["from-async"]);
  });

  test("warns when the sync copy fails and there is no async API", () => {
    const warnings: string[] = [];
    writeClipboard("nope", {
      syncCopy: () => false,
      asyncWrite: null,
      warn: (m) => warnings.push(m),
    });
    expect(warnings.length).toBe(1);
  });

  test("warns when the sync copy fails and the async write also rejects", async () => {
    const warnings: string[] = [];
    writeClipboard("nope", {
      syncCopy: () => false,
      asyncWrite: () => Promise.reject(new Error("denied")),
      warn: (m) => warnings.push(m),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(warnings.length).toBe(1);
  });

  test("empty text is a no-op — neither path is touched", () => {
    let touched = false;
    writeClipboard("", {
      syncCopy: () => {
        touched = true;
        return true;
      },
      asyncWrite: () => {
        touched = true;
        return Promise.resolve();
      },
    });
    expect(touched).toBe(false);
  });
});
