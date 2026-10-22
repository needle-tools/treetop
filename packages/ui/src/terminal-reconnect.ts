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
