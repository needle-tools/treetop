import { test, expect, describe } from "bun:test";
import { dedupAndCap, CAP } from "../src/mention-recents";
import type { PickItem } from "../src/mention-types";

function mk(
  value: string,
  providerId: PickItem["providerId"] = "sessions",
): PickItem {
  return {
    providerId,
    id: value,
    value,
    targetType: "session",
    label: value,
  };
}

describe("dedupAndCap", () => {
  test("inserts the new item at the front of an empty list", () => {
    const result = dedupAndCap(mk("a"), []);
    expect(result.map((r) => r.value)).toEqual(["a"]);
  });

  test("dedups an existing entry with the same value", () => {
    const before = [mk("a"), mk("b"), mk("c")];
    const after = dedupAndCap(mk("b"), before);
    // "b" moves to the front, no duplicate appears.
    expect(after.map((r) => r.value)).toEqual(["b", "a", "c"]);
  });

  test("preserves order of unrelated entries when promoting", () => {
    const before = [mk("a"), mk("b"), mk("c"), mk("d")];
    const after = dedupAndCap(mk("c"), before);
    expect(after.map((r) => r.value)).toEqual(["c", "a", "b", "d"]);
  });

  test("caps the result to CAP entries", () => {
    const before = Array.from({ length: CAP }, (_, i) => mk(`v${i}`));
    const after = dedupAndCap(mk("new"), before);
    expect(after.length).toBe(CAP);
    expect(after[0]!.value).toBe("new");
    // The oldest (last) entry got squeezed out.
    expect(after.map((r) => r.value).includes(`v${CAP - 1}`)).toBe(false);
  });

  test("dedup is by `value`, not `id` — different providers with the same id stay distinct in callers' state", () => {
    // The function itself only sees the per-provider list, so two
    // items with the same value but different ids would still dedup.
    // What matters: items with DIFFERENT values, same id (e.g. a
    // commit and a session that happen to share a 7-char hash),
    // co-exist.
    const a = { ...mk("session:abc1234"), id: "abc1234" };
    const b = { ...mk("commit:abc1234"), id: "abc1234" };
    const after = dedupAndCap(b, [a]);
    expect(after.map((r) => r.value)).toEqual([
      "commit:abc1234",
      "session:abc1234",
    ]);
  });
});
