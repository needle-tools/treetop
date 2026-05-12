/**
 * Tests for the PTY-backend integration: spawn a real bash subprocess
 * via the supernode helper, sample cpu/mem via `procs.ts`, and verify
 * that kill() actually leaves no zombies behind.
 *
 * No mocks: we exec real processes, same as the rest of the daemon
 * suite. Tests are tagged with timeouts because the helper subprocess
 * is launched lazily and PTY spawn has macOS-quirky latency on first
 * invocation.
 */

import { test, expect, describe, afterAll } from "bun:test";
import { $ } from "bun";
import { NodePtyBackend } from "../src/terminals/node-pty-backend";
import { sampleProcs, shQuote, renameArgv, resolveAgentBinary } from "../src/procs";
import { mkdtemp, writeFile, chmod, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("NodePtyBackend integration", () => {
  const backend = new NodePtyBackend();

  afterAll(async () => {
    // Always tear the helper down so the test run doesn't leak a
    // stray node process on the box.
    await backend.shutdown();
  });

  test(
    "spawn → write → onData round-trip; pid is alive between spawn and exit",
    async () => {
      const handle = await backend.spawn({
        cmd: ["bash", "-c", "echo hello-pty; sleep 0.05; echo done"],
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
      });
      expect(handle.pid).toBeGreaterThan(0);

      const seen: string[] = [];
      const exitWait = new Promise<{ code: number; signal?: string }>((resolve) => {
        handle.subscribe({
          onData(chunk) {
            seen.push(new TextDecoder().decode(chunk));
          },
          onExit(info) {
            resolve(info);
          },
        });
      });

      const info = await exitWait;
      const combined = seen.join("");
      expect(combined).toContain("hello-pty");
      expect(combined).toContain("done");
      expect(info.code).toBe(0);
    },
    10_000,
  );

  test(
    "kill() actually terminates a long-running process — no zombies",
    async () => {
      const handle = await backend.spawn({
        // 60s sleep that ignores SIGTERM until SIGKILL falls back. We
        // pick something noisy so a leaked process would obviously
        // linger past test exit.
        cmd: ["bash", "-c", 'trap "" TERM; sleep 60'],
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
      });
      const pid = handle.pid;
      expect(pid).toBeGreaterThan(0);

      // Confirm it's actually running.
      let alivePre = false;
      try { process.kill(pid, 0); alivePre = true; } catch {}
      expect(alivePre).toBe(true);

      const exitWait = new Promise<void>((resolve) => {
        handle.subscribe({
          onData() {},
          onExit() { resolve(); },
        });
      });

      await handle.kill();
      // kill() does SIGTERM then SIGKILL after 500ms. Give it some slack
      // for the helper round-trip + signal delivery.
      await Promise.race([
        exitWait,
        new Promise((_, rej) => setTimeout(() => rej(new Error("did not exit")), 5_000)),
      ]);

      // The process should now be reaped. `kill -0` raises ESRCH on a
      // dead pid; if it succeeds, we leaked.
      let stillAlive = false;
      try { process.kill(pid, 0); stillAlive = true; } catch {}
      expect(stillAlive).toBe(false);
    },
    10_000,
  );

  test(
    "list() drops terminals from the alive set once they exit",
    async () => {
      const handle = await backend.spawn({
        cmd: ["bash", "-c", "true"],
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
      });
      const exitWait = new Promise<void>((resolve) => {
        handle.subscribe({ onData() {}, onExit() { resolve(); } });
      });
      await exitWait;
      const stillAlive = backend.list().filter((r) => r.id === handle.id && !r.exitedAt);
      expect(stillAlive).toEqual([]);
    },
    10_000,
  );
});

describe("renameArgv", () => {
  test("wraps cmd into bash -c 'exec -a NAME …'", () => {
    const out = renameArgv("supergit-tui-abc-claude", ["claude", "--resume", "x"]);
    expect(out[0]).toBe("bash");
    expect(out[1]).toBe("-c");
    expect(out[2]).toContain("exec -a 'supergit-tui-abc-claude'");
    expect(out[2]).toContain("'claude'");
    expect(out[2]).toContain("'--resume'");
    expect(out[2]).toContain("'x'");
  });

  test("survives args with single quotes", () => {
    const out = renameArgv("don't-care", ["echo", "it's a trap"]);
    // Just make sure round-tripping through a shell yields the original
    // string. We don't lock down exact bytes — bash's quoting rules can
    // produce equivalent variants.
    const wrapped = out[2]!;
    expect(wrapped.startsWith("exec -a 'don'\\''t-care'")).toBe(true);
    expect(wrapped).toContain(`'it'\\''s a trap'`);
  });

  test("returns the input unchanged when cmd is empty", () => {
    expect(renameArgv("name", [])).toEqual([]);
  });

  test(
    "spawned PTY shows the renamed argv[0] in ps",
    async () => {
      // Skip on Windows (no bash by default; renameArgv is unix-only).
      if (process.platform === "win32") return;
      const backend = new NodePtyBackend();
      const procName = `supergit-tui-test-${Date.now().toString(36)}`;
      // Wrap a leaf command (not another shell) so the renamed argv[0]
      // sticks — bash rewrites its own process title on exec, which
      // would hide the rename if we'd wrapped `bash -c sleep`.
      const cmd = renameArgv(procName, ["sleep", "5"]);
      const handle = await backend.spawn({
        cmd,
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
      });
      try {
        // Give the kernel a moment to commit the rename.
        await new Promise((r) => setTimeout(r, 100));
        const psOut = (await $`ps -o command= -p ${handle.pid}`.quiet().nothrow()).stdout.toString().trim();
        expect(psOut).toContain(procName);
      } finally {
        await handle.kill();
        await backend.shutdown();
      }
    },
    10_000,
  );
});

describe("resolveAgentBinary", () => {
  test("returns null for an unknown binary", async () => {
    const r = await resolveAgentBinary("not-a-real-binary-asdfghjkl");
    expect(r).toBeNull();
  });

  test("returns SOMETHING for `bash` (universally installed)", async () => {
    // Doesn't matter where — just that we found *some* absolute path.
    const r = await resolveAgentBinary("bash");
    expect(r).not.toBeNull();
    expect(r!.startsWith("/")).toBe(true);
  });

  test(
    "picks the newest mtime when multiple installs are present (via PATH)",
    async () => {
      // Build two fake "agent" files in temp dirs, prepend both to
      // PATH, set distinct mtimes so the newer one wins regardless of
      // path order. Uses a deliberately unusual name so it doesn't
      // shadow any real binary on disk.
      //
      // Cross-platform notes:
      //   - chmod is a no-op on Windows (filesystem permissions are
      //     ACLs there). We still call it for parity but `stat` works
      //     regardless of the executable bit, which is what
      //     resolveAgentBinary cares about.
      //   - PATH separator is ":" on Unix and ";" on Windows.
      //   - File extension: on Windows, executables typically need a
      //     ".exe" / ".cmd" suffix. We don't add one; resolveAgentBinary
      //     uses bare filenames just like `bun install -g` does on
      //     Windows (it puts a .cmd shim there). This test passes on
      //     Windows because we're not actually executing the file —
      //     we just check `stat()` finds it.
      const agent = `supergit-test-agent-${Date.now().toString(36)}`;
      const dirA = await mkdtemp(join(tmpdir(), "supergit-bin-a-"));
      const dirB = await mkdtemp(join(tmpdir(), "supergit-bin-b-"));
      const pathA = join(dirA, agent);
      const pathB = join(dirB, agent);
      await writeFile(pathA, "#!/bin/sh\necho A\n");
      await writeFile(pathB, "#!/bin/sh\necho B\n");
      try { await chmod(pathA, 0o755); } catch {}
      try { await chmod(pathB, 0o755); } catch {}
      const older = new Date("2026-01-01T00:00:00Z");
      const newer = new Date("2026-06-01T00:00:00Z");
      await utimes(pathA, older, older);
      await utimes(pathB, newer, newer);
      const sep = process.platform === "win32" ? ";" : ":";
      const origPath = process.env.PATH ?? "";
      process.env.PATH = [dirA, dirB, origPath].filter(Boolean).join(sep);
      try {
        const r = await resolveAgentBinary(agent);
        expect(r).toBe(pathB);
      } finally {
        process.env.PATH = origPath;
      }
    },
    10_000,
  );
});

describe("shQuote", () => {
  test("wraps a plain string in single quotes", () => {
    expect(shQuote("hello")).toBe("'hello'");
  });
  test("escapes embedded single quotes the canonical way", () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("sampleProcs", () => {
  test("returns zeros for unknown pids", async () => {
    const map = await sampleProcs([999999]);
    const entry = map.get(999999);
    expect(entry).toBeDefined();
    expect(entry?.cpuPercent).toBe(0);
    expect(entry?.memBytes).toBe(0);
  });

  test("returns plausible memory for the current process", async () => {
    // The test runner's own pid is a known-live process; rss must be > 0.
    const map = await sampleProcs([process.pid]);
    const entry = map.get(process.pid);
    expect(entry).toBeDefined();
    if (process.platform !== "win32") {
      expect(entry?.memBytes ?? 0).toBeGreaterThan(0);
    }
  });

  test("returns an empty map for an empty pid list (no shell-out)", async () => {
    const map = await sampleProcs([]);
    expect(map.size).toBe(0);
  });
});

describe("/api/processes report shape (integration)", () => {
  // Exercises the same chain the /api/processes route uses end to end:
  // spawn a real PTY → list backend records → sample procs → combine.
  // The actual HTTP route is a 5-line wrapper around this; if the
  // building blocks line up here, the route does too.
  test(
    "combines backend.list() with sampleProcs samples",
    async () => {
      const backend = new NodePtyBackend();
      const handle = await backend.spawn({
        cmd: ["bash", "-c", "sleep 5"],
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
        ownerId: "test-owner",
      });
      try {
        const records = backend.list().filter((r) => !r.exitedAt);
        expect(records).toHaveLength(1);
        const samples = await sampleProcs(records.map((r) => r.pid));
        const report = records.map((r) => {
          const s = samples.get(r.pid);
          return {
            id: r.id,
            pid: r.pid,
            ownerId: r.ownerId,
            agent: r.agent,
            cmd: r.cmd,
            cwd: r.cwd,
            createdAt: r.createdAt,
            cpuPercent: s?.cpuPercent ?? 0,
            memBytes: s?.memBytes ?? 0,
          };
        });
        expect(report[0]?.id).toBe(handle.id);
        expect(report[0]?.pid).toBe(handle.pid);
        expect(report[0]?.ownerId).toBe("test-owner");
        if (process.platform !== "win32") {
          // Real sleep child should report > 0 RSS.
          expect(report[0]?.memBytes).toBeGreaterThan(0);
        }
      } finally {
        await handle.kill();
        await backend.shutdown();
      }
    },
    10_000,
  );
});
