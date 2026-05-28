/**
 * Smoke test: does node-pty work when imported directly under Bun?
 *
 * Background: `terminals/helper.mjs` exists because, under Bun 1.2.x,
 * node-pty's PTY master fd returned ENXIO when read through libuv
 * streams. The workaround is to host PTYs in a Node sidecar over NDJSON.
 *
 * If this test passes on the current Bun, the workaround is no longer
 * load-bearing and the helper subprocess can be deleted.
 *
 * The test:
 *   1. imports node-pty in-process (no helper),
 *   2. spawns a bash that echoes a known marker,
 *   3. asserts the marker bytes arrive via onData within a short window.
 *
 * Failure modes that mean "workaround still needed":
 *   - throws on import / spawn,
 *   - onData never fires (we time out),
 *   - read throws ENXIO.
 */

import { test, expect, describe } from "bun:test";

const isWin = process.platform === "win32";

describe.skipIf(isWin)("node-pty direct under Bun", () => {
  test.todo(
    "spawn → onData receives expected bytes without helper subprocess",
    async () => {
      const { spawn } = await import("node-pty");

      const marker = `pty-ok-${Date.now()}`;
      const pty = spawn("bash", ["-c", `echo ${marker}`], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: "/tmp",
        env: process.env as { [k: string]: string },
      });

      let buf = "";
      const got = new Promise<void>((resolve) => {
        pty.onData((d) => {
          buf += d;
          if (buf.includes(marker)) resolve();
        });
      });

      const timed = new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`no PTY data after 2s; buf=${JSON.stringify(buf)}`),
            ),
          2000,
        ),
      );

      try {
        await Promise.race([got, timed]);
        expect(buf).toContain(marker);
      } finally {
        try {
          pty.kill();
        } catch {}
      }
    },
    5000,
  );
});
