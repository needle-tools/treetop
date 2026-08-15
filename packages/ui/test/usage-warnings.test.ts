import { describe, expect, test } from "bun:test";

import {
  claimUsageWarnSlot,
  resetUsageWarnSlotsForTest,
  USAGE_WARN_COOLDOWN_MS,
} from "../src/usage-warnings";

describe("claimUsageWarnSlot", () => {
  test("dedupes in memory when localStorage throws", () => {
    resetUsageWarnSlotsForTest();
    const storage = {
      getItem(): string | null {
        throw new Error("storage unavailable");
      },
      setItem(): void {
        throw new Error("storage unavailable");
      },
    };

    expect(
      claimUsageWarnSlot("codex", "pace", { now: 10_000, storage }),
    ).toBe(true);
    expect(
      claimUsageWarnSlot("codex", "pace", { now: 20_000, storage }),
    ).toBe(false);
    expect(
      claimUsageWarnSlot("codex", "weekly90", { now: 20_000, storage }),
    ).toBe(true);
  });

  test("honors persisted cooldown and refreshes memory from storage", () => {
    resetUsageWarnSlotsForTest();
    const data = new Map<string, string>();
    const storage = {
      getItem(key: string): string | null {
        return data.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        data.set(key, value);
      },
    };
    const key = "supergit.usage-warn-last.codex.pace";
    data.set(key, "1000");

    expect(
      claimUsageWarnSlot("codex", "pace", {
        now: 1000 + USAGE_WARN_COOLDOWN_MS - 1,
        storage,
      }),
    ).toBe(false);
    expect(
      claimUsageWarnSlot("codex", "pace", {
        now: 1000 + USAGE_WARN_COOLDOWN_MS + 1,
        storage,
      }),
    ).toBe(true);
  });
});
