/**
 * The real ship+install process for a provision job. Two sequential ssh
 * phases (see buildProvisionPlan):
 *
 *   1. ship — pipe the local archive (git-archive in dev / gzip-tar for a
 *      packaged bundle) into ssh's stdin; the remote extracts it. No tty.
 *   2. run  — run the installer over a tty (`-tt`) so its output streams
 *      line-by-line instead of block-buffering until exit.
 *
 * Both phases' output is surfaced as one text stream, prefixed with synthetic
 * "[supergit] …" lines so the dialog shows progress immediately rather than a
 * silent "waiting for the installer…".
 *
 * This is the thin, impure edge — the decisions (which ship command, the ssh
 * argv, token parsing) are pure + tested in provision.ts. The lifecycle
 * around it is tested in provision-manager.test.ts via an injected
 * ProvisionProc, so the process plumbing here isn't unit-tested.
 */

import {
  buildProvisionPlan,
  buildShipCommand,
} from "./provision";
import type { ProvisionProc, ProvisionStartOpts } from "./provision-manager";

/** Hard backstop for the connect/ship phase. Longer than ssh's
 *  ConnectTimeout (15s) so ssh's own timeout reports first on a clean drop;
 *  this only fires if ssh wedges, and is generous enough not to kill a slow
 *  archive transfer. Overridable for testing / slow links. */
const SHIP_TIMEOUT_MS = Number(process.env.SUPERGIT_PROVISION_SHIP_TIMEOUT_MS) || 45_000;

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
    for await (const chunk of stream) queue.push(dec.decode(chunk, { stream: true }));
  } catch {
    // stream torn down on kill — expected on abort
  }
}

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

    (async () => {
      try {
        // ── Phase 1: ship the source (archive | ssh stdin) ──────────────
        queue.push(`[supergit] connecting to ${host} over SSH…\n`);
        console.log(
          `provision ${host}: ship via ${shipCmd.bin} | ssh ${plan.ship.ssh.join(" ")}`,
        );
        const archive = Bun.spawn([shipCmd.bin, ...shipCmd.args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const shipSsh = Bun.spawn([sshPath, ...plan.ship.ssh], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        active = shipSsh;

        // Heartbeat so the connect wait is visibly alive (a firewall drop
        // looks like a freeze otherwise — ssh is silent until ConnectTimeout).
        const startedAt = Date.now();
        const heartbeat = setInterval(() => {
          queue.push(
            `[supergit] …still waiting for ${host} (${Math.round(
              (Date.now() - startedAt) / 1000,
            )}s)\n`,
          );
        }, 5000);

        // Hard backstop: ssh's own ConnectTimeout (15s) should fire first on a
        // dropped connection, but if it wedges (DNS, half-open) this guarantees
        // the connect/ship phase ALWAYS ends — never an infinite silent wait.
        let timedOut = false;
        const shipWatchdog = setTimeout(() => {
          timedOut = true;
          try {
            shipSsh.kill();
          } catch {
            /* gone */
          }
          try {
            archive.kill();
          } catch {
            /* gone */
          }
        }, SHIP_TIMEOUT_MS);

        // Manually pump archive → ssh.stdin (more robust than handing Bun a
        // subprocess stream as stdin) and close stdin so the remote `tar`
        // sees EOF and finishes extracting.
        const writer = shipSsh.stdin;
        const feed = (async () => {
          try {
            for await (const chunk of archive.stdout as ReadableStream<Uint8Array>)
              writer.write(chunk);
          } catch {
            // ssh closed early (error/kill) — stop feeding
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
        const shipCode = await shipSsh.exited;
        clearInterval(heartbeat);
        clearTimeout(shipWatchdog);
        await feed;
        await shipErr;
        const archiveErr = (await new Response(archive.stderr).text()).trim();
        const archiveCode = await archive.exited;

        if (killed) {
          resolveExit(143);
          queue.close();
          return;
        }
        if (timedOut) {
          queue.push(
            `[supergit] no response from ${host} after ${Math.round(
              SHIP_TIMEOUT_MS / 1000,
            )}s — aborting. The box is unreachable (a firewall dropping the ` +
              `connection looks exactly like this).\n`,
          );
          resolveExit(124); // conventional "timed out" exit code
          queue.close();
          return;
        }
        if (archiveCode !== 0) {
          queue.push(
            `[supergit] could not read the local source (${shipCmd.bin} exit ${archiveCode})` +
              (archiveErr ? `: ${archiveErr}` : "") +
              "\n",
          );
          resolveExit(archiveCode || 1);
          queue.close();
          return;
        }
        if (shipCode !== 0) {
          const dest = `${opts.target.user ? opts.target.user + "@" : ""}${host}`;
          const port = opts.target.sshPort ?? 22;
          queue.push(
            `[supergit] could not reach ${host} over SSH (ssh exit ${shipCode}).\n` +
              `  • Is the box reachable? A firewall dropping port ${port} looks exactly like this.\n` +
              `  • Can you run \`ssh ${dest}\` yourself with a key (no password prompt)?\n`,
          );
          resolveExit(shipCode);
          queue.close();
          return;
        }

        // ── Phase 2: run the installer over a tty (live output) ─────────
        queue.push(`[supergit] running installer on ${host}…\n`);
        console.log(`provision ${host}: run ssh ${plan.run.ssh.join(" ")}`);
        const run = Bun.spawn([sshPath, ...plan.run.ssh], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        active = run;
        const runOut = pump(
          run.stdout as ReadableStream<Uint8Array>,
          queue,
          dec,
        );
        const runErr = pump(
          run.stderr as ReadableStream<Uint8Array>,
          queue,
          dec,
        );
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
