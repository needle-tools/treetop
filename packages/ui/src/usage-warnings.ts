export const USAGE_WARN_COOLDOWN_MS = 8 * 60 * 60 * 1000;

export type UsageWarnCondition = "pace" | "weekly90" | "session95";

const memoryWarnSlots = new Map<string, number>();

function warnSlotKey(agent: string, cond: UsageWarnCondition): string {
  return `supergit.usage-warn-last.${agent}.${cond}`;
}

export interface UsageWarnSlotOptions {
  now?: number;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

export function claimUsageWarnSlot(
  agent: string,
  cond: UsageWarnCondition,
  opts: UsageWarnSlotOptions = {},
): boolean {
  const now = opts.now ?? Date.now();
  const key = warnSlotKey(agent, cond);
  const memoryLast = memoryWarnSlots.get(key);
  if (
    memoryLast !== undefined &&
    now - memoryLast < USAGE_WARN_COOLDOWN_MS
  ) {
    return false;
  }

  const storage =
    opts.storage === undefined
      ? typeof localStorage === "undefined"
        ? null
        : localStorage
      : opts.storage;

  try {
    const storedLast = storage ? Number(storage.getItem(key)) || 0 : 0;
    if (now - storedLast < USAGE_WARN_COOLDOWN_MS) {
      memoryWarnSlots.set(key, storedLast);
      return false;
    }
    memoryWarnSlots.set(key, now);
    storage?.setItem(key, String(now));
  } catch {
    // Storage can be unavailable in native/webview contexts. Memory still
    // guarantees "once per cooldown" for the current app lifetime.
    memoryWarnSlots.set(key, now);
  }
  return true;
}

export function resetUsageWarnSlotsForTest(): void {
  memoryWarnSlots.clear();
}
