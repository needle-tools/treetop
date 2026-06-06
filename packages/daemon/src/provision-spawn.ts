/**
 * The real ship+install process for a provision job. Two sequential ssh
 * phases (see buildProvisionPlan):
 *
 *   1. ship — package the source to a TEMP FILE (so we know its exact size),
 *      then stream it into ssh's stdin while reporting an upload %. The remote
 *      extracts it. No tty (a pty corrupts the binary stream).
 *   2. run  — run the installer over a tty (`-tt`) so its output streams
 *      line-by-line instead of block-buffering until exit.
 *
 * Both phases' output is surfaced as one text stream, prefixed with synthetic
 * "[supergit] …" lines so the dialog shows progress immediately.
 *
 * Cross-platform: the LOCAL daemon doing the upload may run on Windows,
 * macOS, or Linux, so this uses only portable APIs (os.tmpdir, Bun.file,
 * node:path/fs) — no `/tmp`, no shell. The packaging command itself
 * (git-archive / tar) is chosen per-mode in buildShipCommand and exists on
 * all three.
 *
 * This is the thin, impure edge — the decisions (which ship command, the ssh
 * argv, token parsing) are pure + tested in provision.ts. The lifecycle
 * around it is tested in provision-manager.test.ts via an injected
 * ProvisionProc, so the process plumbing here isn't unit-tested.
 */

import { buildProvisionPlan, buildShipCommand } from "./provision";
import type { ProvisionProc, ProvisionStartOpts } from "./provision-manager";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat, unlink } from "node:fs/promises";

/** Abort the upload if it makes NO progress for this long — a genuine stall
 *  (dropped/dead connection), NOT a slow-but-moving upload (which must be
 *  allowed to finish). Longer than ssh's ConnectTimeout (15s) so a
 *  firewall/connect failure reports with its own clearer message first. */
const STALL_MS = Number(process.env.SUPERGIT_PROVISION_STALL_MS) || 30_000;

/** After the upload finishes, bound the remote extraction so a wedged box
 *  can't hang the job forever. Extracting a few MB is normally seconds. */
const EXTRACT_TIMEOUT_MS =
  Number(process.env.SUPERGIT_PROVISION_EXTRACT_TIMEOUT_MS) || 90_000;

/** A single-consumer async queue of strings with an explicit close. */
class StringQueue implements AsyncIterable<string> {
  private items: string[] = [];
  private waiters: ((r: IteratorResult<string>) => void)[] = [];
  private closed = false;

  push(item: string): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let w: ((r: IteratorResult<string>) => void) | undefined;
    while ((w = this.waiters.shift()))
      w({ value: undefined as unknown as string, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<string>>((res) =>
        this.waiters.push(res),
      );
      if (r.done) return;
      yield r.value;
    }
  }
}

function resolveSsh(): string {
  const ssh = Bun.which("ssh");
  if (!ssh) throw new Error("ssh is not on PATH — cannot provision a box");
  return ssh;
}

/** Drain a (possibly undefined) byte stream into the queue as decoded text. */
async function pump(
  stream: ReadableStream<Uint8Array> | undefined | null,
  queue: StringQueue,
  dec: TextDecoder,
): Promise<void> {
  if (!stream) return;
  try {
    for await (const chunk of stream)
      queue.push(dec.decode(chunk, { stream: true }));
  } catch {
    // stream torn down on kill — expected on abort
  }
}

const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);

export function makeProvisionSpawner(): (
  opts: ProvisionStartOpts,
) => ProvisionProc {
  return (opts: ProvisionStartOpts): ProvisionProc => {
    const sshPath = resolveSsh();
    const shipCmd = buildShipCommand(opts.payloadRoot, opts.mode ?? "packaged");
    const plan = buildProvisionPlan(opts.target);
    const host = opts.target.host;

    const queue = new StringQueue();
    const dec = new TextDecoder();
    let active: { kill(sig?: number | string): void } | null = null;
    let killed = false;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((r) => (resolveExit = r));

    // Temp archive path — portable (Windows/macOS/Linux). Cleaned up at the end.
    const tmpArchive = join(
      tmpdir(),
      `supergit-provision-${crypto.randomUUID()}.tar.gz`,
    );

    (async () => {
      try {
        // ── Uninstall: no ship (the code's already on the box) — just run
        // the uninstaller over a tty and stream it. ──────────────────────
        if (opts.kind === "uninstall") {
          queue.push(`[supergit] uninstalling on ${host}…\n`);
          console.log(`provision ${host}: uninstall ssh ${plan.run.ssh.join(" ")}`);
          const run = Bun.spawn([sshPath, ...plan.run.ssh], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          active = run;
          const ro = pump(run.stdout as ReadableStream<Uint8Array>, queue, dec);
          const re = pump(run.stderr as ReadableStream<Uint8Array>, queue, dec);
          const code = await run.exited;
          await ro;
          await re;
          console.log(`provision ${host}: uninstaller exit ${code}`);
          resolveExit(killed ? 143 : code);
          queue.close();
          return;
        }

        // ── Phase 1a: package the source to a temp file (know its size) ──
        queue.push(`[supergit] packaging the installer…\n`);
        console.log(
          `provision ${host}: archive ${shipCmd.bin} ${shipCmd.args.join(" ")} → ${tmpArchive}`,
        );
        const archive = Bun.spawn([shipCmd.bin, ...shipCmd.args], {
          stdin: "ignore",
          stdout: Bun.file(tmpArchive),
          stderr: "pipe",
        });
        active = archive;
        const archiveErr = (await new Response(archive.stderr).text()).trim();
        const archiveCode = await archive.exited;
        if (killed) {
          resolveExit(143);
          queue.close();
          return;
        }
        if (archiveCode !== 0) {
          queue.push(
            `[supergit] could not package the local source (${shipCmd.bin} exit ${archiveCode})` +
              (archiveErr ? `: ${archiveErr}` : "") +
              "\n",
          );
          resolveExit(archiveCode || 1);
          queue.close();
          return;
        }
        const totalBytes = (await stat(tmpArchive)).size;

        // ── Phase 1b: stream the temp file to ssh stdin with an upload % ──
        queue.push(
          `[supergit] connecting to ${host} and uploading the installer (${mb(totalBytes)} MB)…\n`,
        );
        console.log(`provision ${host}: ship ssh ${plan.ship.ssh.join(" ")}`);
        const shipSsh = Bun.spawn([sshPath, ...plan.ship.ssh], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        active = shipSsh;

        let sent = 0;
        let lastProgress = Date.now();
        let stalled = false;
        let uploadDone = false;

        const heartbeat = setInterval(() => {
          if (uploadDone) return;
          const pct =
            totalBytes > 0
              ? Math.min(100, Math.round((sent / totalBytes) * 100))
              : 0;
          queue.push(
            `[supergit] …uploading to ${host}: ${pct}% (${mb(sent)}/${mb(totalBytes)} MB)\n`,
          );
        }, 4000);

        // Progress-aware stall guard: only fires if NO bytes move for STALL_MS
        // (dropped/dead link), so a slow-but-progressing upload is never killed.
        const stallWatch = setInterval(() => {
          if (uploadDone) return;
          if (Date.now() - lastProgress > STALL_MS) {
            stalled = true;
            clearInterval(stallWatch);
            try {
              shipSsh.kill();
            } catch {
              /* gone */
            }
          }
        }, 2000);

        // Stream the temp archive → ssh.stdin. Await each write so `sent`
        // tracks what ssh has actually accepted (backpressure), making the %
        // and the stall detection real rather than just buffer-fill.
        const writer = shipSsh.stdin;
        const feed = (async () => {
          try {
            const reader = (
              Bun.file(tmpArchive).stream() as ReadableStream<Uint8Array>
            ).getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const w = writer.write(value);
              if (w && typeof (w as { then?: unknown }).then === "function") {
                await w;
              }
              sent += value.byteLength;
              lastProgress = Date.now();
            }
          } catch {
            // ssh closed early (stall kill / error) — stop feeding
          } finally {
            try {
              writer.end();
            } catch {
              /* already closed */
            }
          }
        })();

        const shipErr = pump(
          shipSsh.stderr as ReadableStream<Uint8Array>,
          queue,
          dec,
        );

        await feed; // upload finished (or ssh was killed/failed)
        uploadDone = true;
        clearInterval(heartbeat);
        clearInterval(stallWatch);
        // NOTE: don't announce "upload complete" here — the ship ssh may have
        // failed (e.g. the connect timed out and `sent` is just buffered
        // bytes). Confirm success only after shipCode === 0, below.

        // Bound the remote extraction.
        let extractTimedOut = false;
        const extractTimer = setTimeout(() => {
          extractTimedOut = true;
          try {
            shipSsh.kill();
          } catch {
            /* gone */
          }
        }, EXTRACT_TIMEOUT_MS);
        const shipCode = await shipSsh.exited;
        clearTimeout(extractTimer);
        await shipErr;

        if (killed) {
          resolveExit(143);
          queue.close();
          return;
        }
        if (stalled) {
          queue.push(
            `[supergit] upload stalled — no progress for ${Math.round(
              STALL_MS / 1000,
            )}s at ${mb(sent)}/${mb(totalBytes)} MB. The connection to ${host} ` +
              `dropped or is too slow.\n`,
          );
          resolveExit(124);
          queue.close();
          return;
        }
        if (extractTimedOut) {
          queue.push(
            `[supergit] the box took too long to extract the source (>${Math.round(
              EXTRACT_TIMEOUT_MS / 1000,
            )}s) — aborting.\n`,
          );
          resolveExit(124);
          queue.close();
          return;
        }
        if (shipCode !== 0) {
          const dest = `${opts.target.user ? opts.target.user + "@" : ""}${host}`;
          const port = opts.target.sshPort ?? 22;
          // ssh exit 1 has two very different causes worth disambiguating:
          // an unreachable box (firewall) vs. a reachable box that rejected
          // the command. The latter is the classic "wrong OS" case — a
          // Windows box's cmd.exe answers a POSIX command with "The syntax
          // of the command is incorrect." Tailor the hints to the target OS.
          const isWindows = opts.target.os === "windows";
          const osHint = isWindows
            ? `  • This is a Windows target. Confirm it has the OpenSSH Server feature enabled, ` +
              `\`tar.exe\` on PATH (Windows 10/11 ship it), and PowerShell available.\n`
            : `  • If this is actually a Windows box, re-run and pick "Windows" — supergit was ` +
              `sending POSIX commands (a Windows cmd.exe replies "The syntax of the command is incorrect").\n`;
          queue.push(
            `[supergit] could not reach ${host} over SSH (ssh exit ${shipCode}).\n` +
              `  • Is the box reachable? A firewall dropping port ${port} looks exactly like this.\n` +
              osHint +
              `  • Can you run \`ssh ${dest}\` yourself with a key (no password prompt)?\n`,
          );
          resolveExit(shipCode);
          queue.close();
          return;
        }

        // Ship genuinely succeeded (connected, uploaded, extracted).
        queue.push(`[supergit] source uploaded + extracted on ${host}.\n`);

        // ── Phase 2: run the installer over a tty (live output) ─────────
        queue.push(`[supergit] running installer on ${host}…\n`);
        console.log(`provision ${host}: run ssh ${plan.run.ssh.join(" ")}`);
        const run = Bun.spawn([sshPath, ...plan.run.ssh], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        active = run;
        const runOut = pump(run.stdout as ReadableStream<Uint8Array>, queue, dec);
        const runErr = pump(run.stderr as ReadableStream<Uint8Array>, queue, dec);
        const runCode = await run.exited;
        await runOut;
        await runErr;
        console.log(`provision ${host}: installer exit ${runCode}`);
        resolveExit(killed ? 143 : runCode);
        queue.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        queue.push(`[supergit] provision error: ${msg}\n`);
        console.error(`provision ${host}: error ${msg}`);
        resolveExit(1);
        queue.close();
      } finally {
        // Clean up the temp archive (best-effort, portable).
        try {
          await unlink(tmpArchive);
        } catch {
          /* never created / already gone */
        }
      }
    })();

    return {
      output: queue,
      exited,
      kill() {
        killed = true;
        try {
          active?.kill();
        } catch {
          /* already gone */
        }
      },
    };
  };
}
