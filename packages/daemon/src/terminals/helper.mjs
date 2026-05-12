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
        const term = ptySpawn(cmd[0], cmd.slice(1), {
          name: "xterm-256color",
          cols: cols ?? 80,
          rows: rows ?? 24,
          cwd: cwd || process.cwd(),
          env: { ...process.env, ...(env || {}) },
        });
        terms.set(id, term);
        emit({ ev: "spawned", id, pid: term.pid });
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
