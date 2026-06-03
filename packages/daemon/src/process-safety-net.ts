/**
 * Last-resort crash guard for the daemon process.
 *
 * The daemon hosts EVERY TUI: each PTY is a child of the PTY helper, which
 * is itself a child of the daemon. So if the daemon process exits, the
 * helper gets stdin-EOF / SIGTERM and kills every PTY — every Claude/Codex
 * session the user is hosting (including the one they're watching from)
 * dies at once. A remote-daemon provision that errors, a peer hiccup, a
 * stream torn down mid-flight — none of those should ever be fatal to the
 * fleet.
 *
 * Node/Bun's DEFAULT behaviour for an unhandledRejection or uncaughtException
 * is to print and EXIT. Registering our own listeners suppresses that exit,
 * so a missed error becomes a logged blip instead of a fleet-wide outage.
 *
 * This is a boundary safety net, NOT licence to skip local error handling:
 * the real fix for anything that shows up in this log is to handle that
 * rejection where it happens. The guard just ensures a missed one doesn't
 * take down live sessions.
 */

type Listener = (...args: unknown[]) => void;

/** The slice of `process` (or any EventEmitter) we depend on — narrowed so
 *  tests can pass a plain EventEmitter instead of the real process. */
export interface ProcessLike {
  on(event: string, listener: Listener): unknown;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.stack ?? `${cause.name}: ${cause.message}`;
  return String(cause);
}

/**
 * Install top-level `unhandledRejection` + `uncaughtException` handlers that
 * log the cause and KEEP THE PROCESS RUNNING. `log` defaults to stderr.
 */
export function installCrashGuard(
  proc: ProcessLike,
  log: (line: string) => void = (line) => console.error(line),
): void {
  const handle = (kind: string) => (cause: unknown) => {
    // A broken log sink must not itself become the unhandled throw — the
    // guard's entire job is to never let the emit path crash the daemon.
    try {
      log(
        `[supergit] ${kind} (ignored — daemon stays up so hosted TUIs survive): ${describe(
          cause,
        )}`,
      );
    } catch {
      /* even logging failed; nothing we can safely do but stay alive */
    }
  };

  proc.on("unhandledRejection", handle("unhandledRejection") as Listener);
  proc.on("uncaughtException", handle("uncaughtException") as Listener);
}
