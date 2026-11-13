import type { KVStore } from "./storage";

function standaloneKey(sessionId: string, daemonId = ""): string {
  return `supergit:codexStandalone:${JSON.stringify([daemonId,sessionId])}`;
}

export function rememberCodexStandalone(storage: KVStore, sessionId: string, daemonId?: string): void {
  storage.setItem(standaloneKey(sessionId,daemonId),"true");
}

export function codexResumeCommand(cmd: string[], storage: KVStore, sessionId: string, daemonId?: string): string[] {
  if (!cmd.includes("resume") || storage.getItem(standaloneKey(sessionId,daemonId)) !== "true") return cmd;
  const args = cmd.filter((arg,index) => arg !== "--no-daemon" && arg !== "--remote" &&
    !arg.startsWith("--remote=") && !(index > 0 && cmd[index-1] === "--remote"));
  return [args[0],"--no-daemon",...args.slice(1)];
}

/** Screen text, not arbitrary output silence, identifies a pending CLI resume. */
export function createSlowResumeWatch() {
  let since: number | undefined;
  return {
    reset() { since = undefined; },
    observe(screen: string, now: number): boolean {
      if (!screen.split("\n").some(line => /^[\s◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏·•*]*Resuming(?:\s+(?:session|conversation|thread))?(?:\s*[.…]+)?\s*$/i.test(line))) {
        since = undefined;
        return false;
      }
      since ??= now;
      return now-since >= 20_000;
    },
  };
}

/** Only an explicit user action calls this; never race two copies of a thread. */
export async function retryCodexStandalone(actions: {
  stop: () => Promise<void>; remember: () => void; start: () => Promise<void>;
}): Promise<void> {
  await actions.stop();
  actions.remember();
  await actions.start();
}

/** Retry transport failures without creating a replacement PTY. */
export function createTerminalReconnect(
  reconnect: () => void,
  timers = {
    schedule: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    cancel: (handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
) {
  let handle: unknown = null;
  let attempts = 0;
  let disposed = false;
  function clear() {
    if (handle !== null) timers.cancel(handle);
    handle = null;
  }
  return {
    schedule() {
      if (disposed || handle !== null) return;
      handle = timers.schedule(
        () => {
          handle = null;
          if (!disposed) reconnect();
        },
        Math.min(1000 * 2 ** Math.min(attempts++, 5), 30_000),
      );
    },
    wake() {
      if (disposed || handle === null) return;
      clear();
      reconnect();
    },
    reset() {
      clear();
      attempts = 0;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
