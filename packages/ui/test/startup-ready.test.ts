import { expect, test } from "bun:test";
import { waitForStartup } from "../src/startup-ready";

test("startup waits for both the minimum display time and project readiness", async () => {
  const ready = Promise.withResolvers<void>();
  const timer = Promise.withResolvers<void>();
  let visible = true;
  const done = waitForStartup(ready.promise, { now: () => 600, delay: ms => {
    expect(ms).toBe(1400);
    return timer.promise;
  } }).then(() => { visible = false; });
  ready.resolve();
  await Promise.resolve();
  expect(visible).toBe(true);
  timer.resolve(); await done;
  expect(visible).toBe(false);
});

test("slow projects keep the splash after the minimum duration", async () => {
  const ready = Promise.withResolvers<void>();
  let visible = true;
  const done = waitForStartup(ready.promise, { now: () => 3000, delay: async ms => {
    expect(ms).toBe(0);
  } }).then(() => { visible = false; });
  await Promise.resolve();
  expect(visible).toBe(true);
  ready.resolve(); await done;
  expect(visible).toBe(false);
});
