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
import {
  NodePtyBackend,
  detectAgentLabel,
  detectConfigError,
  nextStickyConfigError,
  terminalGoneReason,
  makeTerminalId,
} from "../src/terminals/node-pty-backend";
import {
  sampleProcs,
  shQuote,
  renameArgv,
  resolveAgentBinary,
  wrapWindowsCmd,
} from "../src/procs";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  chmod,
  utimes,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const isWin = process.platform === "win32";

describe.skipIf(isWin)("NodePtyBackend integration", () => {
  const backend = new NodePtyBackend();

  afterAll(async () => {
    // Always tear the helper down so the test run doesn't leak a
    // stray node process on the box.
    await backend.shutdown();
  });

  test("spawn → write → onData round-trip; pid is alive between spawn and exit", async () => {
    const handle = await backend.spawn({
      cmd: ["bash", "-c", "echo hello-pty; sleep 0.05; echo done"],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
    });
    expect(handle.pid).toBeGreaterThan(0);

    const seen: string[] = [];
    const exitWait = new Promise<{ code: number; signal?: string }>(
      (resolve) => {
        handle.subscribe({
          onData(chunk) {
            seen.push(new TextDecoder().decode(chunk));
          },
          onExit(info) {
            resolve(info);
          },
        });
      },
    );

    const info = await exitWait;
    const combined = seen.join("");
    expect(combined).toContain("hello-pty");
    expect(combined).toContain("done");
    expect(info.code).toBe(0);
  }, 10_000);

  test(
    "config-error pill state survives keystrokes and reaches late subscribers",
    async () => {
      const handle = await backend.spawn({
        // Print exactly what the detector matches, then block on `read`
        // so the PTY stays alive — mirrors Claude's modal config dialog,
        // which sits waiting for the user to choose an option.
        cmd: [
          "bash",
          "-c",
          'printf "Configuration Error\\n\\nThe configuration file at /home/u/.claude.json contains invalid JSON.\\n\\nChoose an option:\\n"; read x',
        ],
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
      });

      // First subscriber records every configError value it's told about.
      const seen: ({ file: string } | null | undefined)[] = [];
      handle.subscribe({
        onData() {},
        onExit() {},
        onState(s) {
          seen.push(s.configError);
        },
      });

      // Wait until the detector flips the error on.
      const deadline = Date.now() + 8000;
      while (
        !seen.some((c) => c?.file === "/home/u/.claude.json") &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const detectedAt = seen.findIndex(
        (c) => c?.file === "/home/u/.claude.json",
      );
      expect(detectedAt).toBeGreaterThanOrEqual(0);

      // A keystroke must NOT clear the pill — the write handler used to
      // null configError on any input, so clicking/typing in the TUI made
      // the Repair/Open buttons disappear while the config was still broken.
      handle.write("j");
      await new Promise((r) => setTimeout(r, 150));
      expect(seen.slice(detectedAt + 1).some((c) => c === null)).toBe(false);

      // A LATE subscriber (a second broken TUI, or a reload) must receive
      // the still-active configError in its attach snapshot — subscribe
      // used to omit it, so the pill never showed for late attachers.
      const lateErr = await new Promise<{ file: string } | null | undefined>(
        (resolve) => {
          const to = setTimeout(() => resolve(undefined), 2000);
          handle.subscribe({
            onData() {},
            onExit() {},
            onState(s) {
              clearTimeout(to);
              resolve(s.configError);
            },
          });
        },
      );
      expect(lateErr).toEqual({ file: "/home/u/.claude.json" });

      await handle.kill();
    },
    15_000,
  );

  test("spawned PTYs get a color-capable terminal env", async () => {
    const handle = await backend.spawn({
      cmd: [
        "bash",
        "-c",
        'printf "TERM=%s\\nCOLORTERM=%s\\nNO_COLOR=%s\\nCOLOR=%s\\n" "$TERM" "$COLORTERM" "${NO_COLOR-unset}" "${COLOR-unset}"',
      ],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
    });
    const out: string[] = [];
    await new Promise<void>((resolve) => {
      handle.subscribe({
        onData(chunk) {
          out.push(new TextDecoder().decode(chunk));
        },
        onExit() {
          resolve();
        },
      });
    });
    const combined = out.join("");
    expect(combined).toContain("TERM=xterm-256color");
    expect(combined).toContain("COLORTERM=truecolor");
    expect(combined).toContain("NO_COLOR=unset");
    expect(combined).toContain("COLOR=unset");
  }, 10_000);

  test("muted output is paused at the helper and delivered after unmute", async () => {
    const noisyBytes = 120_000;
    const noisyScript = `import sys; sys.stdout.write("A" * ${noisyBytes}); sys.stdout.write("DONE\\n"); sys.stdout.flush()`;
    const handle = await backend.spawn({
      cmd: [
        "bash",
        "-lc",
        `while IFS= read -r line; do [ "$line" = go ] && python3 -c ${shQuote(noisyScript)}; done`,
      ],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
    });
    expect(handle.setOutputMuted).toBeTypeOf("function");

    const chunks: Uint8Array[] = [];
    handle.subscribe({
      onData(chunk) {
        chunks.push(chunk);
      },
      onExit() {},
    });

    handle.setOutputMuted?.(true);
    handle.write("go\n");
    await new Promise((r) => setTimeout(r, 300));
    const mutedBytes = chunks.reduce((n, c) => n + c.byteLength, 0);
    expect(mutedBytes).toBeLessThan(1024);

    handle.setOutputMuted?.(false);
    const deadline = Date.now() + 5000;
    const decoder = new TextDecoder();
    while (
      !chunks.some((c) => decoder.decode(c).includes("DONE")) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const combined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const text = combined.toString("utf-8");
    expect(text).toContain("DONE");
    expect(text).not.toContain("skipped hidden terminal output");
    expect((text.match(/A/g) ?? []).length).toBeGreaterThanOrEqual(noisyBytes);
    await handle.kill();
  }, 15_000);

  test("agent terminal output is paused while muted and delivered after unmute", async () => {
    const handle = await backend.spawn({
      cmd: [
        "bash",
        "-lc",
        `while IFS= read -r line; do [ "$line" = go ] && printf 'agent-hidden-output\\n'; done`,
      ],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
      agent: "codex",
    });
    expect(handle.setOutputMuted).toBeTypeOf("function");

    const chunks: Uint8Array[] = [];
    handle.subscribe({
      onData(chunk) {
        chunks.push(chunk);
      },
      onExit() {},
    });

    handle.setOutputMuted?.(true);
    handle.write("go\n");
    await new Promise((r) => setTimeout(r, 300));
    let text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
      "utf-8",
    );
    expect(text).not.toContain("agent-hidden-output");

    handle.setOutputMuted?.(false);
    const deadline = Date.now() + 3000;
    while (!text.includes("agent-hidden-output") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
    }

    expect(text).toContain("agent-hidden-output");
    await handle.kill();
  }, 10_000);

  test("broadcasts working on the onState channel: true on output, false after idle", async () => {
    // The dock reads `working` off onState (same channel as awaitingInput) so a
    // hidden, output-muted terminal still shows activity. Pin both edges.
    const handle = await backend.spawn({
      cmd: [
        "bash",
        "-lc",
        `while IFS= read -r line; do [ "$line" = go ] && printf 'tick\\n'; done`,
      ],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
    });
    const working: boolean[] = [];
    handle.subscribe({
      onData() {},
      onExit() {},
      onState(s) {
        if (typeof s.working === "boolean") working.push(s.working);
      },
    });
    // Initial snapshot is idle.
    expect(working[0]).toBe(false);

    // Produce output → working flips true.
    handle.write("go\n");
    const tTrue = Date.now() + 3000;
    while (!working.includes(true) && Date.now() < tTrue) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(working).toContain(true);

    // Go quiet → working flips back to false after WORKING_IDLE_MS.
    const tFalse = Date.now() + 4000;
    while (working[working.length - 1] !== false && Date.now() < tFalse) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(working[working.length - 1]).toBe(false);
    await handle.kill();
  }, 12_000);

  test("kill() actually terminates a long-running process — no zombies", async () => {
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
    try {
      process.kill(pid, 0);
      alivePre = true;
    } catch {}
    expect(alivePre).toBe(true);

    const exitWait = new Promise<void>((resolve) => {
      handle.subscribe({
        onData() {},
        onExit() {
          resolve();
        },
      });
    });

    await handle.kill();
    // kill() does SIGTERM then SIGKILL after 500ms. Give it some slack
    // for the helper round-trip + signal delivery.
    await Promise.race([
      exitWait,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("did not exit")), 5_000),
      ),
    ]);

    // The process should now be reaped. `kill -0` raises ESRCH on a
    // dead pid; if it succeeds, we leaked.
    let stillAlive = false;
    try {
      process.kill(pid, 0);
      stillAlive = true;
    } catch {}
    expect(stillAlive).toBe(false);
  }, 10_000);

  test("lastOutputAt advances when the PTY emits output, and equals createdAt before any output", async () => {
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
        onExit() {
          resolve();
        },
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
    expect(Date.parse(after!.lastOutputAt)).toBeGreaterThanOrEqual(
      firstChunkAt - 50,
    );
  }, 10_000);

  test("list() drops terminals from the alive set once they exit", async () => {
    const handle = await backend.spawn({
      cmd: ["bash", "-c", "true"],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
    });
    const exitWait = new Promise<void>((resolve) => {
      handle.subscribe({
        onData() {},
        onExit() {
          resolve();
        },
      });
    });
    await exitWait;
    const stillAlive = backend
      .list()
      .filter((r) => r.id === handle.id && !r.exitedAt);
    expect(stillAlive).toEqual([]);
  }, 10_000);

  test("getExitInfo retains the exit code after a terminal is forgotten", async () => {
    const handle = await backend.spawn({
      cmd: ["bash", "-c", "exit 3"],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
    });
    const exitWait = new Promise<void>((resolve) => {
      handle.subscribe({ onData() {}, onExit: () => resolve() });
    });
    await exitWait;
    // Still in the live map (grace window) → get() resolves, no exit record.
    expect(backend.get(handle.id)).toBeDefined();
    expect(backend.getExitInfo(handle.id)).toBeUndefined();
    // Simulate the grace timer firing.
    backend.forget(handle.id);
    expect(backend.get(handle.id)).toBeUndefined();
    expect(backend.getExitInfo(handle.id)).toEqual({
      code: 3,
      signal: undefined,
      exitedAt: expect.any(String),
    });
  }, 10_000);

  test("getExitInfo is undefined for an id that never existed", () => {
    expect(backend.getExitInfo("does-not-exist")).toBeUndefined();
  });

  test("terminalGoneReason encodes the exit code / signal for the WS close", () => {
    expect(terminalGoneReason(undefined)).toBe("terminal not found");
    expect(
      terminalGoneReason({ code: 1, exitedAt: "2020-01-01T00:00:00Z" }),
    ).toBe("terminal exited code 1");
    expect(
      terminalGoneReason({ signal: "SIGKILL", exitedAt: "2020-01-01T00:00:00Z" }),
    ).toBe("terminal exited signal SIGKILL");
    // code wins over signal when both are present
    expect(
      terminalGoneReason({
        code: 0,
        signal: "SIGTERM",
        exitedAt: "2020-01-01T00:00:00Z",
      }),
    ).toBe("terminal exited code 0");
  });

  // End-to-end check: when we spawn a zsh shell, the injected ZDOTDIR
  // pins HISTFILE to "$ZDOTDIR/.histfile" (per-column scope) and
  // enables INC_APPEND_HISTORY so each Enter flushes immediately.
  // SHARE_HISTORY is deliberately OFF — supergit columns are isolated
  // from each other AND from the user's global ~/.zsh_history. Skipped
  // on machines without zsh (CI's Ubuntu image, primarily).
  const zshBin = Bun.which("zsh");
  test.skipIf(!zshBin)(
    "zsh shell gets INC_APPEND_HISTORY active + HISTFILE pinned per-column via ZDOTDIR",
    async () => {
      const handle = await backend.spawn({
        // -i forces an interactive shell so ZDOTDIR's .zshrc is sourced.
        // Combine setopt (lists enabled opts, lowercase no underscores)
        // with `print -- $HISTFILE` so we can assert the path is inside
        // the per-PTY ZDOTDIR (the marker `supergit-zsh-` is in our
        // mkdtemp prefix).
        cmd: [
          "zsh",
          "-i",
          "-c",
          'echo "::HISTFILE::${HISTFILE}::"; setopt; exit',
        ],
        cwd: "/tmp",
        size: { cols: 80, rows: 24 },
      });
      const out: string[] = [];
      const exitWait = new Promise<void>((resolve) => {
        handle.subscribe({
          onData(chunk) {
            out.push(new TextDecoder().decode(chunk));
          },
          onExit() {
            resolve();
          },
        });
      });
      await exitWait;
      const combined = out.join("");
      // zsh's `setopt` lists active options lowercase, no underscores:
      // INC_APPEND_HISTORY → "incappendhistory"
      expect(combined.toLowerCase()).toContain("incappendhistory");
      // SHARE_HISTORY is explicitly unsetopt'd by the snippet.
      expect(combined.toLowerCase()).not.toContain("sharehistory");
      // HISTFILE lives inside the per-PTY temp ZDOTDIR.
      expect(combined).toMatch(
        /::HISTFILE::.*supergit-zsh-[^/]+\/\.histfile::/,
      );
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
            onData(chunk) {
              out.push(new TextDecoder().decode(chunk));
            },
            onExit() {
              resolve();
            },
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

  // Resume invariant: the historyPreload lines reach the spawned zsh's
  // in-memory history buffer (so arrow-up surfaces them), AND the
  // user's global ~/.zsh_history is never touched (per-column scope).
  // This replaces an earlier test that asserted commands persisted into
  // $HOME/.zsh_history — that's the OPPOSITE of what we want now.
  test.skipIf(!zshBin)(
    "historyPreload reaches zsh's in-memory history; global ~/.zsh_history is NOT polluted",
    async () => {
      const fakeHome = await mkdtemp(join(tmpdir(), "supergit-fakehome-hist-"));
      try {
        await writeFile(join(fakeHome, ".zshrc"), "", "utf-8");

        const handle = await backend.spawn({
          // -i so the supergit snippet runs. `fc -l 1` lists every
          // entry in the in-memory history buffer; we then mark the
          // boundary so substring assertions can't pick up the
          // command literal itself.
          cmd: [
            "zsh",
            "-i",
            "-c",
            'echo "::HIST::START::"; fc -l 1; echo "::HIST::END::"; print -s freshly_typed; fc -A; exit',
          ],
          cwd: "/tmp",
          size: { cols: 80, rows: 24 },
          env: { HOME: fakeHome },
          historyPreload: ["echo from_prev_session", "ls -la"],
        });
        const out: string[] = [];
        await new Promise<void>((resolve) => {
          handle.subscribe({
            onData(c) {
              out.push(new TextDecoder().decode(c));
            },
            onExit() {
              resolve();
            },
          });
        });
        const combined = out.join("");

        // Both seeded lines must show up between the START/END markers.
        const histSection =
          combined.split("::HIST::START::")[1]?.split("::HIST::END::")[0] ?? "";
        expect(histSection).toContain("echo from_prev_session");
        expect(histSection).toContain("ls -la");

        // The user's GLOBAL ~/.zsh_history must remain untouched —
        // per-column scope is the whole point of the redesign.
        const globalHist = join(fakeHome, ".zsh_history");
        let globalExists = true;
        try {
          await readFile(globalHist, "utf-8");
        } catch {
          globalExists = false;
        }
        if (globalExists) {
          const globalContent = await readFile(globalHist, "utf-8");
          expect(globalContent).not.toContain("freshly_typed");
          expect(globalContent).not.toContain("from_prev_session");
        }
      } finally {
        await rm(fakeHome, { recursive: true, force: true });
      }
    },
    15_000,
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
            onData(chunk) {
              out.push(new TextDecoder().decode(chunk));
            },
            onExit() {
              resolve();
            },
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
            onData(chunk) {
              out.push(new TextDecoder().decode(chunk));
            },
            onExit() {
              resolve();
            },
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
  test("non-zsh shell (bash) is spawned without a ZDOTDIR injected", async () => {
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
        onData(chunk) {
          out.push(new TextDecoder().decode(chunk));
        },
        onExit() {
          resolve();
        },
      });
    });
    await exitWait;
    const combined = out.join("");
    expect(combined).toContain("::ZDOTDIR::::");
    // And specifically NOT a supergit-zsh-* temp dir leaking in.
    expect(combined).not.toMatch(/supergit-zsh-/);
  }, 10_000);
});

// gracefulShutdown is what the daemon calls on SIGTERM/SIGINT before it
// tears the helper down: soft-kill every live PTY (SIGTERM / ConPTY close
// on Windows), give them a grace window to flush + exit on their own, then
// force-kill (SIGKILL) any straggler. The point is to stop hard-killing
// Claude mid-write to .claude.json on every restart. Unix-only here (the
// integration suite is skipped on Windows); the Windows ConPTY-close path
// is exercised by hand.
describe.skipIf(isWin)("NodePtyBackend.gracefulShutdown", () => {
  test("soft-kills a SIGTERM-respecting PTY and resolves once it exits", async () => {
    const backend = new NodePtyBackend();
    // Exits cleanly on SIGTERM — the cooperative case we want the common
    // path to be. Long sleep so it would obviously still be alive if the
    // soft signal never reached it.
    const handle = await backend.spawn({
      cmd: ["bash", "-c", 'trap "exit 0" TERM; sleep 60'],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
    });
    const pid = handle.pid;
    expect(pid).toBeGreaterThan(0);

    const start = Date.now();
    await backend.gracefulShutdown(2000);
    const elapsed = Date.now() - start;

    // It exited on SIGTERM, so we should return well before the grace cap.
    expect(elapsed).toBeLessThan(1500);
    let stillAlive = false;
    try {
      process.kill(pid, 0);
      stillAlive = true;
    } catch {}
    expect(stillAlive).toBe(false);
  }, 10_000);

  test("force-kills a PTY that ignores SIGTERM once the grace window elapses", async () => {
    const backend = new NodePtyBackend();
    // Ignores SIGTERM entirely → only SIGKILL can stop it. gracefulShutdown
    // must wait out the (short) grace, then escalate to SIGKILL.
    const handle = await backend.spawn({
      cmd: ["bash", "-c", 'trap "" TERM; while :; do sleep 1; done'],
      cwd: "/tmp",
      size: { cols: 80, rows: 24 },
    });
    const pid = handle.pid;
    expect(pid).toBeGreaterThan(0);

    const start = Date.now();
    await backend.gracefulShutdown(300);
    const elapsed = Date.now() - start;

    // We must not return instantly (which would mean a synchronous hard-kill),
    // and we must not hang forever. The JS node-pty helper may close this
    // fixture on TERM before the full grace cap; the Go helper exercises
    // stricter POSIX signal semantics.
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1000);
    let stillAlive = false;
    try {
      process.kill(pid, 0);
      stillAlive = true;
    } catch {}
    expect(stillAlive).toBe(false);
  }, 10_000);

  test("is a no-op (resolves promptly) when there are no live terminals", async () => {
    const backend = new NodePtyBackend();
    const start = Date.now();
    await backend.gracefulShutdown(2000);
    expect(Date.now() - start).toBeLessThan(500);
  }, 10_000);
});

describe("makeTerminalId", () => {
  test("starts with the t_ prefix and a time+seq core", () => {
    expect(makeTerminalId(1)).toMatch(/^t_[a-z0-9]+_1_[0-9a-f]{8}$/);
  });

  test("two ids with the SAME sequence are still distinct (the cross-daemon fix)", () => {
    // Each daemon counts seq from 1, so without the random suffix two daemons
    // could mint t_<sameMs>_1 — colliding the UI's per-shell state.
    expect(makeTerminalId(1)).not.toBe(makeTerminalId(1));
  });

  test("a batch of ids is fully unique", () => {
    const ids = new Set(Array.from({ length: 2000 }, (_, i) => makeTerminalId(i)));
    expect(ids.size).toBe(2000);
  });
});

describe("renameArgv", () => {
  test("wraps cmd into bash -c 'exec -a NAME …'", () => {
    const out = renameArgv("supergit-tui-abc-claude", [
      "claude",
      "--resume",
      "x",
    ]);
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

  test("spawned PTY shows the renamed argv[0] in ps", async () => {
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
      const psOut = (
        await $`ps -o command= -p ${handle.pid}`.quiet().nothrow()
      ).stdout
        .toString()
        .trim();
      expect(psOut).toContain(procName);
    } finally {
      await handle.kill();
      await backend.shutdown();
    }
  }, 10_000);
});

describe("resolveAgentBinary", () => {
  test("returns null for an unknown binary", async () => {
    const r = await resolveAgentBinary("not-a-real-binary-asdfghjkl");
    expect(r).toBeNull();
  });

  test("returns SOMETHING for a universally installed binary", async () => {
    // bash on Unix, cmd on Windows — just verify we find *some* absolute path.
    const name = isWin ? "cmd" : "bash";
    const r = await resolveAgentBinary(name);
    expect(r).not.toBeNull();
    expect(r!.includes(sep)).toBe(true);
  });

  test("picks the newest mtime when multiple installs are present (via PATH)", async () => {
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
    //   - File extension: on Windows we MUST use ".cmd" (or ".exe")
    //     here because resolveAgentBinary excludes bare-extension
    //     candidates on Windows — CreateProcess can't spawn them,
    //     so picking one would just produce error 193 downstream.
    const agentName = `supergit-test-agent-${Date.now().toString(36)}`;
    const agent = agentName;
    const fileExt = isWin ? ".cmd" : "";
    const dirA = await mkdtemp(join(tmpdir(), "supergit-bin-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "supergit-bin-b-"));
    const pathA = join(dirA, agent + fileExt);
    const pathB = join(dirB, agent + fileExt);
    await writeFile(pathA, "#!/bin/sh\necho A\n");
    await writeFile(pathB, "#!/bin/sh\necho B\n");
    try {
      await chmod(pathA, 0o755);
    } catch {}
    try {
      await chmod(pathB, 0o755);
    } catch {}
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
  }, 10_000);
});

describe.skipIf(!isWin)("resolveAgentBinary on Windows", () => {
  test("prefers a spawnable .cmd over a bare bash script with equal mtime", async () => {
    // npm installs CLIs as a bash script + a .cmd + a .ps1, all
    // sharing one mtime. CreateProcess can't execute the bash
    // script (ERROR_BAD_EXE_FORMAT 193) — only .exe/.cmd/.bat/.ps1
    // are spawnable. The resolver must skip the bare script.
    const agent = `supergit-test-winagent-${Date.now().toString(36)}`;
    const dir = await mkdtemp(join(tmpdir(), "supergit-winbin-"));
    const bare = join(dir, agent);
    const cmdFile = join(dir, agent + ".cmd");
    await writeFile(bare, "#!/bin/sh\necho A\n");
    await writeFile(cmdFile, "@echo off\r\necho A\r\n");
    const same = new Date("2026-04-01T00:00:00Z");
    await utimes(bare, same, same);
    await utimes(cmdFile, same, same);
    const origPath = process.env.PATH ?? "";
    process.env.PATH = [dir, origPath].filter(Boolean).join(";");
    try {
      const r = await resolveAgentBinary(agent);
      expect(r).toBe(cmdFile);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10_000);
});

describe("wrapWindowsCmd", () => {
  const cmdExe = process.env.COMSPEC ?? "cmd.exe";

  test("wraps a .cmd file in cmd.exe /d /s /c", () => {
    expect(
      wrapWindowsCmd([
        "C:\\Users\\m\\AppData\\Roaming\\npm\\codex.cmd",
        "exec",
      ]),
    ).toEqual([
      cmdExe,
      "/d",
      "/s",
      "/c",
      "C:\\Users\\m\\AppData\\Roaming\\npm\\codex.cmd",
      "exec",
    ]);
  });

  test("wraps a .bat file the same way", () => {
    expect(wrapWindowsCmd(["foo.bat", "a", "b"])).toEqual([
      cmdExe,
      "/d",
      "/s",
      "/c",
      "foo.bat",
      "a",
      "b",
    ]);
  });

  test("wraps a .ps1 file in powershell -File", () => {
    expect(wrapWindowsCmd(["C:\\tools\\codex.ps1", "--help"])).toEqual([
      "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\tools\\codex.ps1",
      "--help",
    ]);
  });

  test("passes a .exe through unchanged", () => {
    expect(
      wrapWindowsCmd(["C:\\Windows\\System32\\cmd.exe", "/c", "dir"]),
    ).toEqual(["C:\\Windows\\System32\\cmd.exe", "/c", "dir"]);
  });

  test("passes an extensionless head through unchanged (caller decides)", () => {
    expect(wrapWindowsCmd(["bash", "-c", "echo hi"])).toEqual([
      "bash",
      "-c",
      "echo hi",
    ]);
  });

  test("handles an empty cmd defensively", () => {
    expect(wrapWindowsCmd([])).toEqual([]);
  });

  test("ext check is case-insensitive (.CMD treated as .cmd)", () => {
    expect(wrapWindowsCmd(["C:\\Tools\\AGENT.CMD"])).toEqual([
      cmdExe,
      "/d",
      "/s",
      "/c",
      "C:\\Tools\\AGENT.CMD",
    ]);
  });
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
    // Asserted on every platform including Windows: the Windows path used
    // `$pid` as a foreach loop variable, but `$PID` is a read-only
    // automatic variable in PowerShell, so the assignment threw and the
    // whole script emitted nothing — every pid fell back to zeros (no
    // CPU or memory in the UI). This assertion would have caught it.
    const map = await sampleProcs([process.pid]);
    const entry = map.get(process.pid);
    expect(entry).toBeDefined();
    expect(entry?.memBytes ?? 0).toBeGreaterThan(0);
  });

  test("returns an empty map for an empty pid list (no shell-out)", async () => {
    const map = await sampleProcs([]);
    expect(map.size).toBe(0);
  });
});

describe.skipIf(isWin)("/api/processes report shape (integration)", () => {
  // Exercises the same chain the /api/processes route uses end to end:
  // spawn a real PTY → list backend records → sample procs → combine.
  // The actual HTTP route is a 5-line wrapper around this; if the
  // building blocks line up here, the route does too.
  test("combines backend.list() with sampleProcs samples", async () => {
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
  }, 10_000);
});

// Platform-agnostic: detectAgentLabel is what gates the "this is a
// shell" branch in /api/terminals POST (writes the JSONL header,
// registers the termId for command-history capture). On Windows the
// default shell resolves to powershell.exe / pwsh.exe / cmd.exe, none
// of which the original Unix-only check matched — so columns flipped
// to ShellView on exit and showed "shell not found", and their
// command transcripts stayed empty.
describe("detectAgentLabel", () => {
  test("recognizes Unix shells", () => {
    expect(detectAgentLabel("bash")).toBe("shell");
    expect(detectAgentLabel("/bin/zsh")).toBe("shell");
    expect(detectAgentLabel("/usr/bin/sh")).toBe("shell");
    expect(detectAgentLabel("fish")).toBe("shell");
  });

  test("recognizes Windows shells (with or without .exe, any case)", () => {
    expect(detectAgentLabel("powershell.exe")).toBe("shell");
    expect(detectAgentLabel("PowerShell.exe")).toBe("shell");
    expect(
      detectAgentLabel(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
    ).toBe("shell");
    expect(detectAgentLabel("pwsh.exe")).toBe("shell");
    expect(detectAgentLabel("pwsh")).toBe("shell");
    expect(detectAgentLabel("cmd.exe")).toBe("shell");
    expect(detectAgentLabel("C:\\Windows\\System32\\cmd.exe")).toBe("shell");
  });

  test("recognizes AI agents", () => {
    expect(detectAgentLabel("claude")).toBe("claude");
    expect(detectAgentLabel("claude.exe")).toBe("claude");
    expect(detectAgentLabel("codex")).toBe("codex");
    expect(detectAgentLabel("ollama")).toBe("ollama");
  });

  test("returns undefined for unknown commands and empty input", () => {
    expect(detectAgentLabel(undefined)).toBeUndefined();
    expect(detectAgentLabel("")).toBeUndefined();
    expect(detectAgentLabel("vim")).toBeUndefined();
    expect(detectAgentLabel("git")).toBeUndefined();
  });
});

describe("detectConfigError", () => {
  function bufferFrom(text: string): [Uint8Array[], number] {
    const buf = new TextEncoder().encode(text);
    return [[buf], buf.byteLength];
  }

  test("detects Claude config error with file path", () => {
    const [buf, len] = bufferFrom(
      "Configuration Error\n\n" +
        "The configuration file at C:\\Users\\marce\\.claude.json contains invalid JSON.\n\n" +
        "JSON Parse error: Unable to parse JSON string\n\n" +
        "Choose an option:\n" +
        "❯ 1. Exit and fix manually\n" +
        "  2. Reset with default configuration\n\n" +
        "Enter to confirm · Esc to cancel",
    );
    const result = detectConfigError(buf, len);
    expect(result).not.toBeNull();
    expect(result!.file).toBe("C:\\Users\\marce\\.claude.json");
  });

  test("detects lowercase 'Configuration error' heading", () => {
    // Claude Code changed the heading from "Configuration Error" to
    // "Configuration error" (lowercase e) — the detector must be
    // case-insensitive or the Repair pill silently stops appearing.
    const [buf, len] = bufferFrom(
      "Configuration error\n\n" +
        "The configuration file at C:\\Users\\marce\\.claude.json contains invalid JSON.\n\n" +
        "JSON Parse error: Unable to parse JSON string\n\n" +
        "Choose an option:\n❯ 1. Exit and fix manually\n",
    );
    const result = detectConfigError(buf, len);
    expect(result).not.toBeNull();
    expect(result!.file).toBe("C:\\Users\\marce\\.claude.json");
  });

  test("detects Unix-style path", () => {
    const [buf, len] = bufferFrom(
      "Configuration Error\n" +
        "The configuration file at /home/user/.claude.json contains invalid JSON.\n" +
        "JSON Parse error: foo\nChoose an option:\n  1. Exit and fix manually\n",
    );
    const result = detectConfigError(buf, len);
    expect(result).not.toBeNull();
    expect(result!.file).toBe("/home/user/.claude.json");
  });

  test("ignores the error string when the interactive menu is absent", () => {
    // An agent merely PRINTING the modal text (prose, source, grep output —
    // e.g. a session working on supergit itself) must NOT latch the Repair
    // pill onto a healthy terminal. The genuine modal always renders a
    // choice menu; without one, this is just text flowing past.
    const [buf, len] = bufferFrom(
      "Here's the bug: Claude shows 'Configuration Error' when the " +
        "configuration file at C:\\Users\\marce\\.claude.json contains invalid JSON.\n" +
        "We detect that and offer a Repair button.\n",
    );
    expect(detectConfigError(buf, len)).toBeNull();
  });

  test("returns null for normal output", () => {
    const [buf, len] = bufferFrom("$ claude --help\nUsage: claude [options]\n");
    expect(detectConfigError(buf, len)).toBeNull();
  });

  test("returns null for empty buffer", () => {
    expect(detectConfigError([], 0)).toBeNull();
  });
});

describe("nextStickyConfigError", () => {
  const err = { file: "C:\\Users\\marce\\.claude.json" };

  test("a fresh detection wins when nothing was showing", () => {
    expect(nextStickyConfigError(err, null)).toBe(err);
  });

  test("holds the previous error when this frame didn't re-match", () => {
    // The modal repaint scrolled the text out of the scanned tail — but
    // the dialog is still on screen, so the pill must stay (no flicker).
    expect(nextStickyConfigError(null, err)).toBe(err);
  });

  test("a newly detected error for a different file replaces the old one", () => {
    const other = { file: "/home/user/.claude.json" };
    expect(nextStickyConfigError(other, err)).toBe(other);
  });

  test("stays null when there is nothing to show and nothing detected", () => {
    expect(nextStickyConfigError(null, null)).toBeNull();
  });
});
