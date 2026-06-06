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
import {
  findDivergence,
  mergeTranscripts,
} from "../src/session-share-divergence";

function mk(id: string, text = ""): string {
  return JSON.stringify({ uuid: id, msg: text });
}

/** uuids of a merged transcript, in order. */
function mergedIds(existing: string, incoming: string): string[] {
  return mergeTranscripts(existing, incoming)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l).uuid);
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

describe("mergeTranscripts", () => {
  test("genuine fork → shared prefix once, then existing tail, then incoming tail", () => {
    const existing = [mk("a"), mk("b"), mk("x"), mk("y")].join("\n");
    const incoming = [mk("a"), mk("b"), mk("p"), mk("q")].join("\n");
    expect(mergedIds(existing, incoming)).toEqual(["a", "b", "x", "y", "p", "q"]);
  });

  test("incoming is a superset → result equals incoming", () => {
    const existing = [mk("a"), mk("b")].join("\n");
    const incoming = [mk("a"), mk("b"), mk("c"), mk("d")].join("\n");
    expect(mergedIds(existing, incoming)).toEqual(["a", "b", "c", "d"]);
  });

  test("existing has more → keeps the existing tail", () => {
    const existing = [mk("a"), mk("b"), mk("c")].join("\n");
    const incoming = [mk("a"), mk("b")].join("\n");
    expect(mergedIds(existing, incoming)).toEqual(["a", "b", "c"]);
  });

  test("a line that landed on both tails is not duplicated", () => {
    const existing = [mk("a"), mk("b"), mk("x"), mk("z")].join("\n");
    const incoming = [mk("a"), mk("b"), mk("y"), mk("z")].join("\n");
    expect(mergedIds(existing, incoming)).toEqual(["a", "b", "x", "z", "y"]);
  });

  test("identical transcripts → unchanged", () => {
    const a = [mk("a"), mk("b"), mk("c")].join("\n");
    expect(mergeTranscripts(a, a).trim()).toBe(a);
  });

  test("empty existing → incoming verbatim", () => {
    const incoming = [mk("a"), mk("b")].join("\n");
    expect(mergeTranscripts("", incoming).trim()).toBe(incoming);
  });

  test("both empty → empty string", () => {
    expect(mergeTranscripts("", "")).toBe("");
  });

  test("preserves full line content verbatim, not just the uuid", () => {
    const root = JSON.stringify({ uuid: "a", parentUuid: null, text: "hi" });
    const child = JSON.stringify({ uuid: "b", parentUuid: "a", text: "yo" });
    const merged = mergeTranscripts(root, [root, child].join("\n"));
    expect(merged).toContain('"parentUuid":"a"');
    expect(merged).toContain('"text":"yo"');
  });

  test("dedups uuid-less lines by content hash", () => {
    const shared = JSON.stringify({ text: "shared" });
    const existing = [shared, JSON.stringify({ text: "mine" })].join("\n");
    const incoming = [shared, JSON.stringify({ text: "theirs" })].join("\n");
    const lines = mergeTranscripts(existing, incoming).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).text)).toEqual([
      "shared",
      "mine",
      "theirs",
    ]);
  });

  test("codex fork (no top-level uuid) merges via content-hash identity", () => {
    // Real codex lines have no top-level `uuid` — identity falls back
    // to a hash of the whole line, so a shared prefix must be
    // byte-identical and divergent turns differ by content.
    const codex = (type: string, text: string) =>
      JSON.stringify({
        timestamp: "2026-05-12T10:35:34.510Z",
        type,
        payload: { type: "message", role: "assistant", text },
      });
    const meta = JSON.stringify({ type: "session_meta", payload: { id: "s1" } });
    const existing = [meta, codex("response_item", "hello"), codex("response_item", "mine")].join("\n");
    const incoming = [
      meta,
      codex("response_item", "hello"),
      codex("response_item", "theirs-1"),
      codex("response_item", "theirs-2"),
    ].join("\n");
    const texts = mergeTranscripts(existing, incoming)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).payload?.text ?? "(meta)");
    expect(texts).toEqual(["(meta)", "hello", "mine", "theirs-1", "theirs-2"]);
  });
});
