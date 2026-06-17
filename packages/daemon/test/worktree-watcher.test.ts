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

// Real fs.watch delivery is paced by the OS. Keep the test debounce close
// enough to production (300ms) that awaited writes are genuinely a burst,
// then wait long enough for the debounced callback to settle.
const DEBOUNCE_MS = 120;
const SETTLE_MS = 450;

describe("watchWorktree", () => {
  test("fires onChange after a file write (debounced)", async () => {
    const dir = await tempDir();
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await sleep(50);
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
      await sleep(50);
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
      await sleep(50);
      await writeFile(join(dir, "node_modules", "foo", "index.js"), "x");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Unity asset imports rewrite Library/, Temp/ and Logs/ continuously,
  // sometimes thousands of files per minute. Letting those through means
  // every burst triggers a fs_change SSE + a full /api/repos refresh +
  // git fan-out across every worktree — the user-observed "daemon
  // idles at 20% CPU" symptom. Pair with the .next/.nuxt/.turbo/target
  // case below.
  test("ignores changes inside Unity build caches (Library, Temp, Logs)", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "Library", "Needle"), { recursive: true });
    await mkdir(join(dir, "Temp"), { recursive: true });
    await mkdir(join(dir, "Logs"), { recursive: true });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await sleep(50);
      await writeFile(join(dir, "Library", "Needle", "asset.meta"), "x");
      await writeFile(join(dir, "Temp", "scratch"), "x");
      await writeFile(join(dir, "Logs", "build.log"), "x");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores changes inside framework build caches (.next, .nuxt, .turbo, target)", async () => {
    const dir = await tempDir();
    for (const seg of [".next", ".nuxt", ".turbo", "target"]) {
      await mkdir(join(dir, seg), { recursive: true });
    }
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await sleep(50);
      await writeFile(join(dir, ".next", "build-manifest.json"), "{}");
      await writeFile(join(dir, ".nuxt", "dist.js"), "x");
      await writeFile(join(dir, ".turbo", "cache.bin"), "x");
      await writeFile(join(dir, "target", "debug.bin"), "x");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores chatty writes inside .git/ (objects, logs, lock files)", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".git", "objects", "ab"), { recursive: true });
    await mkdir(join(dir, ".git", "logs", "refs", "heads"), {
      recursive: true,
    });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await sleep(50);
      await writeFile(join(dir, ".git", "objects", "ab", "cdef"), "obj");
      await writeFile(join(dir, ".git", "logs", "HEAD"), "reflog line");
      await writeFile(join(dir, ".git", "logs", "refs", "heads", "main"), "x");
      await writeFile(join(dir, ".git", "index.lock"), "lock");
      await writeFile(join(dir, ".git", "HEAD.lock"), "lock");
      await writeFile(join(dir, ".git", "COMMIT_EDITMSG"), "wip");
      await sleep(SETTLE_MS);
      expect(calls).toBe(0);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // After `git commit`, git writes .git/HEAD, .git/refs/heads/<branch>,
  // and .git/index — all of which mean fileStatus/lastCommit just
  // changed in the worktree. The watcher must let these through so the
  // dashboard can re-fetch /api/repos and clear the stale "Unstaged 1"
  // count it had before the commit.
  test("fires for HEAD / refs/ / index writes inside .git/", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".git", "refs", "heads"), { recursive: true });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await sleep(50);
      await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(dir, ".git", "index"), "fake-index");
      await writeFile(join(dir, ".git", "refs", "heads", "main"), "deadbeef\n");
      await sleep(SETTLE_MS);
      expect(calls).toBe(1);
    } finally {
      stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fires for packed-refs and FETCH_HEAD writes inside .git/", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, ".git"), { recursive: true });
    let calls = 0;
    const stop = watchWorktree(dir, () => calls++, { debounceMs: DEBOUNCE_MS });
    try {
      await sleep(50);
      await writeFile(join(dir, ".git", "packed-refs"), "# pack-refs\n");
      await writeFile(
        join(dir, ".git", "FETCH_HEAD"),
        "abc123\trefs/heads/main\n",
      );
      await sleep(SETTLE_MS);
      expect(calls).toBe(1);
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
      await sleep(50);
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
      await sleep(50);
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
      await sleep(50);
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
      await sleep(50);
      await writeFile(join(dir, "node_modules", "junk"), "x");
      await sleep(100);
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
