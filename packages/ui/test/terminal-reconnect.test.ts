import { expect, test } from "bun:test";
import { createTerminalReconnect } from "../src/terminal-reconnect";

test("retries with capped backoff, wakes immediately, and cancels on recovery or disposal", () => {
  let pending: (() => void) | undefined;
  const delays: number[] = [];
  let attempts = 0;
  const reconnect = createTerminalReconnect(() => attempts++, {
    schedule: (fn, ms) => {
      pending = fn;
      delays.push(ms);
      return 1;
    },
    cancel: () => {
      pending = undefined;
    },
  });
  reconnect.schedule();
  reconnect.schedule();
  expect(delays).toEqual([1000]);
  for (let i = 0; i < 7; i++) {
    const fn = pending!;
    pending = undefined;
    fn();
    reconnect.schedule();
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  reconnect.wake();
  expect(attempts).toBe(8);
  expect(pending).toBeUndefined();
  reconnect.reset();
  reconnect.schedule();
  expect(delays.at(-1)).toBe(1000);
  reconnect.reset();
  expect(pending).toBeUndefined();
  reconnect.wake();
  expect(attempts).toBe(8);
  reconnect.schedule();
  reconnect.dispose();
  reconnect.schedule();
  reconnect.wake();
  expect(pending).toBeUndefined();
  expect(attempts).toBe(8);
});
