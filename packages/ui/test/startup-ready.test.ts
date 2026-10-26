import { expect, test } from "bun:test";
import { waitForStartup } from "../src/startup-ready";

test("startup waits for both the minimum display time and project readiness", async () => {
  const ready = Promise.withResolvers<void>();
  const timer = Promise.withResolvers<void>();
  let visible = true;
  const done = waitForStartup(ready.promise, { now: () => 600, delay: ms => {
    if (ms === 1400) return timer.promise;
    expect(ms).toBe(9400);
    return new Promise(() => {});
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
  const done = waitForStartup(ready.promise, { now: () => 3000, delay: ms => {
    if (ms === 0) return Promise.resolve();
    expect(ms).toBe(7000);
    return new Promise(() => {});
  } }).then(() => { visible = false; });
  await Promise.resolve();
  expect(visible).toBe(true);
  ready.resolve(); await done;
  expect(visible).toBe(false);
});

test("startup reveals after ten seconds even if the project list never arrives", async () => {
  const minimum = Promise.withResolvers<void>();
  const maximum = Promise.withResolvers<void>();
  let revealed = false;
  const done = waitForStartup(new Promise(() => {}), {
    now: () => 500,
    delay: ms => {
      if (ms === 1500) return minimum.promise;
      expect(ms).toBe(9500);
      return maximum.promise;
    },
  }).then(() => { revealed = true; });
  minimum.resolve();
  await Promise.resolve();
  expect(revealed).toBe(false);
  maximum.resolve();
  await done;
  expect(revealed).toBe(true);
});
