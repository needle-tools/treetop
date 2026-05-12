import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchWorktree } from "../src/worktree-watcher";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-watch-test-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Real fs.watch races are flaky if you slam events too fast; the
// generous 200ms gap (vs. the 30ms debounce we use in tests) gives
// the kernel time to dispatch and the debounce time to fire.
const DEBOUNCE_MS = 30;
const SETTLE_MS = 200;

describe("watchWorktree", () => {
  test("fires onChange after a file write (debounced)", async () => {
    const dir = await tempDir();
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await writeFile(join(dir, "a.txt"), "hello");
      await sleep(SETTLE_MS);
      expect(calls).toBe(1);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("collapses a burst of writes into a single onChange", async () => {
    const dir = await tempDir();
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      // 5 writes within the debounce window should collapse to 1 call.
      for (let i = 0; i < 5; i++) {
        await writeFile(join(dir, `f${i}.txt`), String(i));
      }
      await sleep(SETTLE_MS);
      expect(calls).toBe(1);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores changes inside node_modules/", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "node_modules", "foo"), { recursive: true });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await writeFile(join(dir, "node_modules", "foo", "index.js"), "x");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores changes inside .git/", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".git", "objects"), { recursive: true });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await writeFile(join(dir, ".git", "objects", "abc"), "obj");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Dogfooding case: supergit is its own workspace. The daemon writes
  // events.jsonl/attachments/terminal state into `.supergit/` inside
  // the watched worktree on every action. If the watcher fired on
  // those, every internal write would re-broadcast `change`, every
  // UI client would re-fetch /api/repos, and the resulting git
  // shell-outs would starve the diff endpoint. Confirm the ignore.
  test("ignores changes inside .supergit/", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".supergit"), { recursive: true });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await writeFile(join(dir, ".supergit", "events.jsonl"), "{}\n");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores changes inside dist/", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "dist"), { recursive: true });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await writeFile(join(dir, "dist", "bundle.js"), "x");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores changes inside .vite/", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".vite", "deps"), { recursive: true });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await writeFile(join(dir, ".vite", "deps", "chunk.js"), "x");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("still fires for a non-ignored file alongside ignored writes", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "node_modules"), { recursive: true });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await writeFile(join(dir, "node_modules", "junk"), "x");
      await writeFile(join(dir, "real.txt"), "y");
      await sleep(SETTLE_MS);
      expect(calls).toBe(1);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stop() prevents future onChange calls", async () => {
    const dir = await tempDir();
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      stop();
      await writeFile(join(dir, "a.txt"), "hello");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
