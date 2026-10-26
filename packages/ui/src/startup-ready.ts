/** Hold the splash until the initial workspace settles and its minimum time elapses. */
export async function waitForStartup(
  ready: Promise<unknown>,
  options: { startedAt?: number; now?: () => number; delay?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  await Promise.all([ready, delay(Math.max(0, 2000 - (now() - (options.startedAt ?? 0))))]);
}
