/**
 * Divergence detection between two JSONL session transcripts. Used
 * on accept when an imported file already exists for `(originMachine,
 * sid)` — the UI shows different copy depending on whether the new
 * offer is a strict superset ("an update from N to M messages") or
 * a genuine fork ("diverged at message K — keep both, replace, or
 * cancel").
 *
 * Pure function over the JSONL strings. Message identity is by
 * `uuid` (Claude's convention) when present, otherwise by a hash of
 * the raw line. Sufficient for the receiver-side "have I seen this
 * before?" question — we're not trying to do a 3-way merge.
 */

import { test, expect, describe } from "bun:test";
import { findDivergence } from "../src/session-share-divergence";

function mk(id: string, text = ""): string {
  return JSON.stringify({ uuid: id, msg: text });
}

describe("findDivergence", () => {
  test("identical transcripts → fully matched, no divergence", () => {
    const a = [mk("a"), mk("b"), mk("c")].join("\n");
    const r = findDivergence(a, a);
    expect(r.commonPrefix).toBe(3);
    expect(r.existingAfter).toBe(0);
    expect(r.incomingAfter).toBe(0);
    expect(r.supersetOfExisting).toBe(true);
    expect(r.diverged).toBe(false);
  });

  test("incoming extends existing → superset, update flow", () => {
    const existing = [mk("a"), mk("b")].join("\n");
    const incoming = [mk("a"), mk("b"), mk("c"), mk("d")].join("\n");
    const r = findDivergence(existing, incoming);
    expect(r.commonPrefix).toBe(2);
    expect(r.existingAfter).toBe(0);
    expect(r.incomingAfter).toBe(2);
    expect(r.supersetOfExisting).toBe(true);
    expect(r.diverged).toBe(false);
  });

  test("existing has messages incoming doesn't → diverged, not a superset", () => {
    const existing = [mk("a"), mk("b"), mk("c")].join("\n");
    const incoming = [mk("a"), mk("b")].join("\n");
    const r = findDivergence(existing, incoming);
    expect(r.commonPrefix).toBe(2);
    expect(r.existingAfter).toBe(1);
    expect(r.incomingAfter).toBe(0);
    expect(r.supersetOfExisting).toBe(false);
    expect(r.diverged).toBe(true);
  });

  test("genuine fork: common prefix then different ids", () => {
    const existing = [mk("a"), mk("b"), mk("x"), mk("y")].join("\n");
    const incoming = [mk("a"), mk("b"), mk("p"), mk("q"), mk("r")].join("\n");
    const r = findDivergence(existing, incoming);
    expect(r.commonPrefix).toBe(2);
    expect(r.existingAfter).toBe(2);
    expect(r.incomingAfter).toBe(3);
    expect(r.supersetOfExisting).toBe(false);
    expect(r.diverged).toBe(true);
  });

  test("falls back to content hash when uuid is missing", () => {
    const a = JSON.stringify({ text: "hello" });
    const b = JSON.stringify({ text: "hello" });
    const c = JSON.stringify({ text: "world" });
    const existing = [a, b].join("\n");
    const incoming = [a, c].join("\n");
    const r = findDivergence(existing, incoming);
    expect(r.commonPrefix).toBe(1);
    expect(r.existingAfter).toBe(1);
    expect(r.incomingAfter).toBe(1);
    expect(r.diverged).toBe(true);
  });

  test("empty existing → trivially a superset", () => {
    const r = findDivergence("", [mk("a"), mk("b")].join("\n"));
    expect(r.commonPrefix).toBe(0);
    expect(r.existingAfter).toBe(0);
    expect(r.incomingAfter).toBe(2);
    expect(r.supersetOfExisting).toBe(true);
    expect(r.diverged).toBe(false);
  });

  test("empty incoming → existing has more, diverged", () => {
    const r = findDivergence([mk("a")].join("\n"), "");
    expect(r.commonPrefix).toBe(0);
    expect(r.existingAfter).toBe(1);
    expect(r.incomingAfter).toBe(0);
    expect(r.supersetOfExisting).toBe(false);
    expect(r.diverged).toBe(true);
  });

  test("malformed lines pass through as content-keyed entries", () => {
    const existing = "not json\n" + mk("a");
    const incoming = "not json\n" + mk("a") + "\n" + mk("b");
    const r = findDivergence(existing, incoming);
    expect(r.commonPrefix).toBe(2);
    expect(r.incomingAfter).toBe(1);
    expect(r.diverged).toBe(false);
  });

  test("ignores trailing empty lines", () => {
    const existing = [mk("a"), mk("b")].join("\n") + "\n\n";
    const incoming = [mk("a"), mk("b")].join("\n");
    const r = findDivergence(existing, incoming);
    expect(r.commonPrefix).toBe(2);
    expect(r.existingAfter).toBe(0);
    expect(r.incomingAfter).toBe(0);
    expect(r.diverged).toBe(false);
  });
});
