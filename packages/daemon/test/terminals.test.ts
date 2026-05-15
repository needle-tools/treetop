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
import { mkdtemp, writeFile, readFile, mkdir, chmod, utimes, rm } from "node:fs/promises";
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
    "lastOutputAt advances when the PTY emits output, and equals createdAt before any output",
    async () => {
      const handle = await backend.spawn({
        // Wait a beat so `lastOutputAt` after the first byte is
        // measurably later than `createdAt`. 80ms is comfortably above
        // the helper/IPC round-trip jitter on macOS+Linux CI.
        cmd: ["bash", "-c", "sleep 0.08; echo first; sleep 0.08; echo second"],
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
      });

      // Record taken immediately after spawn (before any data event has
      // arrived) should still show lastOutputAt == createdAt.
      const beforeAny = backend.list().find((r) => r.id === handle.id);
      expect(beforeAny).toBeDefined();
      expect(beforeAny!.lastOutputAt).toBe(beforeAny!.createdAt);

      let firstChunkAt = 0;
      const exitWait = new Promise<void>((resolve) => {
        handle.subscribe({
          onData() {
            if (!firstChunkAt) firstChunkAt = Date.now();
          },
          onExit() { resolve(); },
        });
      });
      await exitWait;

      const after = backend.list().find((r) => r.id === handle.id);
      expect(after).toBeDefined();
      // Output happened, so lastOutputAt must have advanced past createdAt.
      expect(Date.parse(after!.lastOutputAt)).toBeGreaterThan(
        Date.parse(after!.createdAt),
      );
      // And the final lastOutputAt must be at or after the first chunk
      // we observed in the subscriber — both timestamps come from the
      // same data path.
      expect(Date.parse(after!.lastOutputAt)).toBeGreaterThanOrEqual(firstChunkAt - 50);
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

  // End-to-end check: when we spawn a zsh shell, the injected ZDOTDIR
  // makes `setopt INC_APPEND_HISTORY SHARE_HISTORY` active. Skipped
  // on machines without zsh (CI's Ubuntu image, primarily).
  const zshBin = Bun.which("zsh");
  test.skipIf(!zshBin)(
    "zsh shell gets INC_APPEND_HISTORY + SHARE_HISTORY active via injected ZDOTDIR",
    async () => {
      const handle = await backend.spawn({
        // -i forces an interactive shell so ZDOTDIR's .zshrc is sourced.
        // `setopt` with no args prints only the *enabled* options;
        // each is on its own line in lowercase with no underscores.
        // We run setopt, then exit, then assert the output contains
        // both flags. Using `setopt` (not `setopt | grep`) keeps the
        // command portable and avoids pipe-completion races.
        cmd: ["zsh", "-i", "-c", "setopt; exit"],
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
      });
      const out: string[] = [];
      const exitWait = new Promise<void>((resolve) => {
        handle.subscribe({
          onData(chunk) { out.push(new TextDecoder().decode(chunk)); },
          onExit() { resolve(); },
        });
      });
      await exitWait;
      const combined = out.join("");
      // zsh's `setopt` lists active options lowercase, no underscores:
      // INC_APPEND_HISTORY → "incappendhistory"
      expect(combined.toLowerCase()).toContain("incappendhistory");
      expect(combined.toLowerCase()).toContain("sharehistory");
    },
    15_000,
  );

  // Regression guard for the "last letter on a new line" prompt bug.
  // When ZDOTDIR is set, zsh sources $ZDOTDIR/.zshenv|.zshrc instead
  // of the $HOME/ versions. Our temp ZDOTDIR must contain stubs that
  // delegate back to $HOME, otherwise the user loses PATH/FPATH/
  // p10k-instant-prompt setup and the line editor renders nonsense.
  //
  // We can't assert on the user's real ~/.zshenv (machine-specific),
  // so we point HOME at a temp dir with a known marker, then verify
  // it reaches the PTY.
  test.skipIf(!zshBin)(
    "ZDOTDIR stub sources $HOME/.zshenv and $HOME/.zshrc",
    async () => {
      const fakeHome = await mkdtemp(join(tmpdir(), "supergit-fakehome-"));
      try {
        await writeFile(
          join(fakeHome, ".zshenv"),
          `export SUPERGIT_ZSHENV_MARKER="from-zshenv-ok"\n`,
          "utf-8",
        );
        await writeFile(
          join(fakeHome, ".zshrc"),
          `export SUPERGIT_ZSHRC_MARKER="from-zshrc-ok"\n`,
          "utf-8",
        );
        const handle = await backend.spawn({
          // -i so .zshrc is sourced. The two markers come from
          // different startup files; if EITHER is missing in output,
          // the corresponding stub is broken.
          cmd: [
            "zsh",
            "-i",
            "-c",
            'echo "::ENV::$SUPERGIT_ZSHENV_MARKER::"; echo "::RC::$SUPERGIT_ZSHRC_MARKER::"; exit',
          ],
          cwd: "/tmp",
          size: { cols: 80, rows: 24 },
          env: { HOME: fakeHome },
        });
        const out: string[] = [];
        const exitWait = new Promise<void>((resolve) => {
          handle.subscribe({
            onData(chunk) { out.push(new TextDecoder().decode(chunk)); },
            onExit() { resolve(); },
          });
        });
        await exitWait;
        const combined = out.join("");
        expect(combined).toContain("::ENV::from-zshenv-ok::");
        expect(combined).toContain("::RC::from-zshrc-ok::");
      } finally {
        await rm(fakeHome, { recursive: true, force: true });
      }
    },
    15_000,
  );

  // Resume invariant: when the user closes a Terminal column and then
  // re-opens one in the same worktree, the new zsh PTY must see every
  // command the previous PTYs typed via arrow-up history. This is the
  // "history is always additive, never lost" contract — a regression
  // in the snippet (e.g. accidentally enabling HIST_NO_STORE or
  // disabling INC_APPEND_HISTORY) would silently drop commands and
  // the user would only notice when they reach for arrow-up.
  //
  // We can't easily drive keystrokes through the PTY with reliable
  // timing in a test, so we use zsh's `print -s "<line>"` (adds to
  // the in-memory history list) + `fc -A` (appends new entries to
  // HISTFILE) — same effect on the histfile as an interactive Enter,
  // without depending on the line editor.
  test.skipIf(!zshBin)(
    "zsh history persists additively across multiple PTY spawns (resume invariant)",
    async () => {
      const fakeHome = await mkdtemp(join(tmpdir(), "supergit-fakehome-hist-"));
      try {
        // Empty .zshrc so the snippet's defaults apply (no user
        // override of HISTFILE / HISTSIZE / SAVEHIST). With an empty
        // file the snippet's `[[ -z "${HISTFILE-}" ]]` guard kicks
        // in and points HISTFILE at $HOME/.zsh_history.
        await writeFile(join(fakeHome, ".zshrc"), "", "utf-8");

        // CRITICAL: we deliberately do NOT pass HISTFILE in env. The
        // bug this test guards against is /etc/zshrc on macOS doing
        // `HISTFILE=\${ZDOTDIR:-$HOME}/.zsh_history` — i.e. pointing
        // HISTFILE inside the temp ZDOTDIR that supergit deletes on
        // PTY exit. The snippet must detect that and redirect HISTFILE
        // back to $HOME/.zsh_history, which is what we want to assert.
        const histPath = join(fakeHome, ".zsh_history");
        const runHistCmd = async (line: string) => {
          const handle = await backend.spawn({
            // -i so .zshrc + the supergit snippet are sourced. We
            // use `print -s` to push a line into the in-memory
            // history list and `fc -W` to write the full history
            // to HISTFILE; in production, INC_APPEND_HISTORY does
            // the equivalent on every Enter at the prompt.
            // `fc -A` appends only the new entries in this shell's
            // in-memory history to HISTFILE — it does NOT overwrite
            // the file with the current in-memory list, so prior
            // PTYs' entries stay put. In production this happens
            // automatically on every Enter via INC_APPEND_HISTORY.
            cmd: ["zsh", "-i", "-c", `print -s '${line}'; fc -A; exit`],
            cwd: "/tmp",
            size: { cols: 80, rows: 24 },
            env: { HOME: fakeHome },
          });
          await new Promise<void>((resolve) => {
            handle.subscribe({ onData() {}, onExit() { resolve(); } });
          });
        };

        // Three "open → type → close" cycles. The 2nd/3rd are the
        // user's "second resume" — the case that prompted this test.
        await runHistCmd("echo first");
        await runHistCmd("echo second");
        await runHistCmd("echo third");

        const hist = await readFile(histPath, "utf-8");
        // Each command must still be present after subsequent resumes.
        // Tolerate EXTENDED_HISTORY's ": <ts>:0;<cmd>" prefix by using
        // substring matches rather than line equality.
        expect(hist).toContain("echo first");
        expect(hist).toContain("echo second");
        expect(hist).toContain("echo third");
      } finally {
        await rm(fakeHome, { recursive: true, force: true });
      }
    },
    30_000,
  );

  // Regression for the worst bug in this saga: every shell PTY
  // supergit spawned was running in **sh emulation** because the
  // argv[0] rename ("supergit-tui-new-shell") doesn't contain "zsh",
  // and zsh's name-based mode detection falls back to sh when it
  // can't recognise itself. The symptom: prompt is "$ " (sh default)
  // instead of "%n@%m %1~ %#" (zsh's from /etc/zshrc), no ~/.zshrc
  // sourced, no zle line editor, history broken — and the cursor
  // ends up on an empty row below the $ because sh's primitive line
  // editor can't track the prompt width that xterm assumes.
  //
  // The fix is in server.ts: when wrapping a zsh cmd through
  // renameArgv, prepend "zsh-" to procName so the resulting argv[0]
  // ("zsh-supergit-tui-new-shell") still contains "zsh" → zsh's
  // name check accepts it as zsh → zsh emulation → /etc/zshrc gets
  // sourced. This test reproduces the failure mode end-to-end via
  // the real PTY backend.
  test.skipIf(!zshBin)(
    "zsh inside renameArgv wrapper starts in zsh mode (not sh emulation)",
    async () => {
      // Pose as a freshly-installed user with empty rc files so the
      // distinction is clean: in zsh mode, /etc/zshrc still runs
      // and sets PS1 to "%n@%m %1~ %# "; in sh mode, nothing runs
      // and PS1 stays at the "$ " default.
      const fakeHome = await mkdtemp(join(tmpdir(), "supergit-emul-"));
      try {
        await writeFile(join(fakeHome, ".zshrc"), "", "utf-8");
        await writeFile(join(fakeHome, ".zprofile"), "", "utf-8");

        // Mimic exactly what server.ts builds for a shell column,
        // including the "zsh-" prefix the fix adds.
        const procName = "zsh-supergit-tui-new-shell";
        const wrapped = [
          "bash",
          "-c",
          `exec -a '${procName}' '/bin/zsh' '-l' '-i' '-c' 'echo \"EMU=$(emulate)\"; echo \"ARGV0=$ZSH_NAME\"'`,
        ];

        const handle = await backend.spawn({
          cmd: wrapped,
          cwd: "/tmp",
          size: { cols: 80, rows: 24 },
          env: { HOME: fakeHome },
        });
        const out: string[] = [];
        await new Promise<void>((resolve) => {
          handle.subscribe({
            onData(chunk) { out.push(new TextDecoder().decode(chunk)); },
            onExit() { resolve(); },
          });
        });
        const combined = out.join("");
        // The smoking-gun assertion: emulation is "zsh", not "sh".
        // Anything else means the rename clobbered mode detection.
        expect(combined).toContain("EMU=zsh");
        expect(combined).not.toContain("EMU=sh\n");
        // And zsh sees the renamed argv[0] (cosmetic — confirms the
        // wrapper is what we think it is, not a bash leak).
        expect(combined).toContain(`ARGV0=${procName}`);
      } finally {
        await rm(fakeHome, { recursive: true, force: true });
      }
    },
    15_000,
  );

  // Regression for the "second resume prints 'Restored session: …'
  // and breaks zle line-editor positioning" bug. macOS sources
  // /etc/zshrc_Apple_Terminal when TERM_PROGRAM=Apple_Terminal. That
  // file installs a `zshexit` hook that writes a SHELL_SESSION_FILE
  // (`echo Restored session: <date>`) keyed by TERM_SESSION_ID, and
  // a startup block that sources + removes that file. Every supergit
  // PTY inherits the same TERM_SESSION_ID from the launching
  // Terminal.app, so subsequent spawns find the prior PTY's file,
  // print "Restored session: …" before the prompt, and the extra
  // line confuses zle's cursor math.
  //
  // helper.mjs sets SHELL_SESSIONS_DISABLE=1 in every spawned PTY's
  // env to skip Apple's session-restore block. Verify here that even
  // when we pose as Apple_Terminal with a fixed TERM_SESSION_ID and
  // a stale session file on disk, the second spawn does NOT print
  // the "Restored session:" line.
  test.skipIf(!zshBin || process.platform !== "darwin")(
    "macOS shell-session restore is disabled (no 'Restored session:' on resume)",
    async () => {
      const fakeHome = await mkdtemp(join(tmpdir(), "supergit-sess-"));
      try {
        await writeFile(join(fakeHome, ".zshrc"), "", "utf-8");
        // Plant a session file as if a previous PTY had just exited.
        // The save logic writes a one-line `echo Restored session: ...`
        // script; we plant a marker we can grep for so we know whether
        // the second spawn sourced it.
        const sessDir = join(fakeHome, ".zsh_sessions");
        await mkdir(sessDir, { recursive: true });
        const sid = "supergit-test-sid";
        await writeFile(
          join(sessDir, `${sid}.session`),
          `echo "::RESTORE_MARKER_SHOULD_NOT_APPEAR::"\n`,
          "utf-8",
        );

        const handle = await backend.spawn({
          cmd: ["zsh", "-l", "-i", "-c", "true"],
          cwd: "/tmp",
          size: { cols: 80, rows: 24 },
          env: {
            HOME: fakeHome,
            TERM_PROGRAM: "Apple_Terminal",
            TERM_SESSION_ID: sid,
          },
        });
        const out: string[] = [];
        await new Promise<void>((resolve) => {
          handle.subscribe({
            onData(chunk) { out.push(new TextDecoder().decode(chunk)); },
            onExit() { resolve(); },
          });
        });
        const combined = out.join("");
        // Apple's session-restore is disabled → our planted session
        // file is NOT sourced → marker never appears in PTY output.
        expect(combined).not.toContain("::RESTORE_MARKER_SHOULD_NOT_APPEAR::");
        // Belt-and-braces: the literal "Restored session:" string
        // from Apple's restore block also must not appear (in case
        // someone changes the marker format in the future).
        expect(combined).not.toContain("Restored session:");
      } finally {
        await rm(fakeHome, { recursive: true, force: true });
      }
    },
    15_000,
  );

  // Negative: spawning a non-zsh shell must NOT inject ZDOTDIR, or
  // bash startup files behave unexpectedly (it would just ignore
  // ZDOTDIR, but a future shell-init might key off it). Pin the
  // contract: bash sees an empty ZDOTDIR in its env.
  test(
    "non-zsh shell (bash) is spawned without a ZDOTDIR injected",
    async () => {
      const handle = await backend.spawn({
        // `printf` (not `echo -n`) to keep output free of trailing
        // newline ambiguity. Markers bracket the value so a stray
        // empty line in PTY output can't be confused with success.
        cmd: ["bash", "-c", 'printf "::ZDOTDIR::%s::\\n" "$ZDOTDIR"'],
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
      });
      const out: string[] = [];
      const exitWait = new Promise<void>((resolve) => {
        handle.subscribe({
          onData(chunk) { out.push(new TextDecoder().decode(chunk)); },
          onExit() { resolve(); },
        });
      });
      await exitWait;
      const combined = out.join("");
      expect(combined).toContain("::ZDOTDIR::::");
      // And specifically NOT a supergit-zsh-* temp dir leaking in.
      expect(combined).not.toMatch(/supergit-zsh-/);
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
