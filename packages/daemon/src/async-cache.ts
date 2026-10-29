export interface StaleWhileRevalidateOptions<T> {
  ttlMs: number;
  load: () => Promise<T>;
  clock?: () => number;
  onRefreshError?: (error: unknown) => void;
  /** Telemetry can serve an empty snapshot while its first scan runs. */
  initialValue?: T;
}

export interface StaleWhileRevalidateCache<T> {
  get(): Promise<T>;
  clear(): void;
}

export function createStaleWhileRevalidateCache<T>({
  ttlMs,
  load,
  clock = Date.now,
  onRefreshError,
  initialValue,
}: StaleWhileRevalidateOptions<T>): StaleWhileRevalidateCache<T> {
  let cache: { at: number; value: T } | null =
    initialValue === undefined ? null : { at: -Infinity, value: initialValue };
  let inflight: Promise<T> | null = null;

  const refresh = (): Promise<T> => {
    if (inflight) return inflight;
    inflight = load()
      .then((value) => {
        cache = { at: clock(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  return {
    async get(): Promise<T> {
      const now = clock();
      if (cache && now - cache.at < ttlMs) {
        return cache.value;
      }
      if (cache) {
        if (!inflight) void refresh().catch((err) => onRefreshError?.(err));
        return cache.value;
      }
      return refresh();
    },
    clear(): void {
      cache = null;
    },
  };
}
