#!/usr/bin/env node
/*
 * supergit-supernode — the PTY helper.
 *
 * node-pty doesn't run cleanly under Bun (the PTY forks, but reading the
 * master fd via libuv streams returns ENXIO under Bun 1.2.x). So the Bun
 * daemon spawns this Node program as a child and talks to it over stdio
 * using NDJSON. One helper hosts many PTYs.
 *
 * Wire protocol — every line on stdin/stdout is a complete JSON object.
 *
 *   stdin (commands from daemon):
 *     { op: "spawn", id, cwd, cmd, env?, cols, rows }
 *     { op: "write", id, dataB64 }
 *     { op: "resize", id, cols, rows }
 *     { op: "kill", id, signal? }
 *
 *   stdout (events to daemon):
 *     { ev: "ready" }                       // sent once at startup
 *     { ev: "spawned", id, pid }
 *     { ev: "data", id, dataB64 }
 *     { ev: "exit", id, code, signal? }
 *     { ev: "error", id?, message }
 *
 * Bytes are base64-encoded so we don't have to worry about NDJSON framing
 * meeting arbitrary PTY bytes. For chat-volume PTY traffic this is fine.
 */

import { spawn as ptySpawn } from "node-pty";
import readline from "node:readline";

const terms = new Map(); // id → IPty

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function fail(message, id) {
  emit({ ev: "error", id, message });
}

emit({ ev: "ready" });

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    fail("invalid json: " + e.message);
    return;
  }

  switch (msg.op) {
    case "spawn": {
      const { id, cwd, cmd, env, cols, rows } = msg;
      if (!id || !Array.isArray(cmd) || cmd.length === 0) {
        fail("spawn needs id and cmd[]", id);
        return;
      }
      try {
        // Scrub portless-injected env vars before handing the env to a PTY.
        // When supergit runs under `bunx portless supergit …`, portless sets
        // PORT=<our port> + PORTLESS_URL + NODE_EXTRA_CA_CERTS in the daemon's
        // env. Those propagate to every spawned shell/agent via process.env
        // and silently break neighbouring dev servers — Vite reads
        // `process.env.PORT` and tries to bind supergit's port, which
        // strictPort then refuses. supergit's port choice should be its own
        // private concern; spawned terminals get a clean baseline.
        const cleaned = { ...process.env };
        delete cleaned.PORT;
        delete cleaned.PORTLESS_URL;
        delete cleaned.NODE_EXTRA_CA_CERTS;
        // Disable macOS's per-session shell-state restore. On macOS,
        // /etc/zshrc_Apple_Terminal hooks `zshexit` to write a
        // SHELL_SESSION_FILE (an `echo Restored session: <date>` line,
        // plus any registered user-state functions), keyed by
        // TERM_SESSION_ID. Every PTY supergit spawns inherits the
        // SAME TERM_SESSION_ID from the launching Terminal.app, so:
        //   1. close a Terminal column → first zsh writes the file
        //   2. resume → second zsh sources the file at startup,
        //      prints "Restored session: …" BEFORE the prompt, and
        //      `rm`s the file
        // The extra echo line scrolls the prompt down by one row and
        // confuses zle's cursor-position math — symptom: cursor on an
        // empty line below the $, only the last keypress renders.
        // supergit has its own history + transcript machinery; we
        // never want Apple's parallel session-restore on top.
        cleaned.SHELL_SESSIONS_DISABLE = "1";
        // SHELL_SESSIONS_DISABLE alone is not enough. With TERM_PROGRAM
        // and TERM_SESSION_ID still inherited from Terminal.app, anything
        // in the user's rc that branches on `$TERM_PROGRAM == Apple_Terminal`
        // (Apple's shell-integration in /etc/zshrc_Apple_Terminal, p10k's
        // Terminal-specific bits, iTerm2 shell-integration scripts) still
        // emits OSC sequences xterm.js doesn't fully implement -> zle redraws
        // the input line in the wrong column and each keystroke looks like
        // it clears the row. Delete both so the spawned shell starts with
        // no terminal-emulator identity beyond TERM=xterm-256color.
        delete cleaned.TERM_PROGRAM;
        delete cleaned.TERM_PROGRAM_VERSION;
        delete cleaned.TERM_SESSION_ID;
        const term = ptySpawn(cmd[0], cmd.slice(1), {
          name: "xterm-256color",
          cols: cols ?? 80,
          rows: rows ?? 24,
          cwd: cwd || process.cwd(),
          env: { ...cleaned, ...(env || {}) },
        });
        terms.set(id, term);
        emit({ ev: "spawned", id, pid: term.pid });
        // Debug-only snapshot of the env we actually handed to the
        // PTY. Surfaces what gets through after the scrub + injection
        // dance, so the daemon's /api/debug/pty-env endpoint can show
        // it without a second IPC round-trip. Cheap; ~50 strings per
        // spawn; never exposed externally without the explicit debug
        // route.
        const mergedEnv = { ...cleaned, ...(env || {}) };
        const envKeys = [
          "TERM_PROGRAM",
          "TERM_SESSION_ID",
          "SHELL_SESSIONS_DISABLE",
          "ZDOTDIR",
          "HISTFILE",
          "HISTSIZE",
          "SAVEHIST",
          "TERM",
          "HOME",
          "SHELL",
          "PATH",
        ];
        const envSnapshot = Object.fromEntries(
          envKeys.map((k) => [k, mergedEnv[k] ?? null]),
        );
        emit({ ev: "env-snapshot", id, env: envSnapshot });
        term.onData((d) => {
          emit({
            ev: "data",
            id,
            dataB64: Buffer.from(d, "utf-8").toString("base64"),
          });
        });
        term.onExit(({ exitCode, signal }) => {
          terms.delete(id);
          emit({
            ev: "exit",
            id,
            code: exitCode ?? 0,
            signal: signal ? String(signal) : undefined,
          });
        });
      } catch (e) {
        fail("spawn failed: " + (e?.message ?? e), id);
      }
      return;
    }

    case "write": {
      const term = terms.get(msg.id);
      if (!term) return;
      try {
        term.write(Buffer.from(msg.dataB64 || "", "base64").toString("utf-8"));
      } catch (e) {
        fail("write failed: " + e.message, msg.id);
      }
      return;
    }

    case "resize": {
      const term = terms.get(msg.id);
      if (!term) return;
      try {
        term.resize(msg.cols ?? 80, msg.rows ?? 24);
      } catch (e) {
        fail("resize failed: " + e.message, msg.id);
      }
      return;
    }

    case "kill": {
      const term = terms.get(msg.id);
      if (!term) return;
      try {
        term.kill(msg.signal || "SIGTERM");
      } catch (e) {
        fail("kill failed: " + e.message, msg.id);
      }
      return;
    }

    default:
      fail("unknown op: " + msg.op);
  }
});

rl.on("close", () => {
  for (const term of terms.values()) {
    try { term.kill("SIGTERM"); } catch {}
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const term of terms.values()) {
    try { term.kill("SIGTERM"); } catch {}
  }
  process.exit(0);
});
