/** Show the project list after at least two seconds; stop waiting after ten. */
export async function waitForStartup(
  ready: Promise<unknown>,
  options: { startedAt?: number; now?: () => number; delay?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const elapsed = now() - (options.startedAt ?? 0);
  await Promise.race([
    Promise.all([ready, delay(Math.max(0, 2000 - elapsed))]),
    delay(Math.max(0, 10000 - elapsed)),
  ]);
}
