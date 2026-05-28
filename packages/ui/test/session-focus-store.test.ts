/**
 * Tests for the "focus this session in the row strip" channel. The whole
 * point of the store is that re-requesting the SAME source must still
 * fire App.svelte's reactive handler — so the value carries a monotonic
 * timestamp and is set as a fresh object each time. If a future cleanup
 * "optimised" requestSessionFocus to skip identical sources, re-clicking
 * a saved sticky-link chip would silently stop scrolling the column into
 * view. These tests pin that contract.
 */

import {
  test,
  expect,
  describe,
  beforeEach,
  afterEach,
  setSystemTime,
} from "bun:test";
import { get } from "svelte/store";
import {
  sessionFocusRequest,
  requestSessionFocus,
} from "../src/session-focus-store";

beforeEach(() => sessionFocusRequest.set(null));
afterEach(() => setSystemTime());

test("starts null (no pending focus request)", () => {
  expect(get(sessionFocusRequest)).toBeNull();
});

test("requestSessionFocus stamps the source and a timestamp", () => {
  setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
  requestSessionFocus("/agents/claude.jsonl");
  const req = get(sessionFocusRequest);
  expect(req?.source).toBe("/agents/claude.jsonl");
  expect(req?.ts).toBe(Date.parse("2026-05-28T12:00:00.000Z"));
});

test("re-requesting the same source emits a new value (reactivity must re-fire)", () => {
  const seen: Array<{ source: string; ts: number } | null> = [];
  const unsub = sessionFocusRequest.subscribe((v) => seen.push(v));

  setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
  requestSessionFocus("/x.jsonl");
  setSystemTime(new Date("2026-05-28T12:00:01.000Z"));
  requestSessionFocus("/x.jsonl"); // same source, later moment
  unsub();

  // Initial null + two requests = three emissions; the two requests
  // differ by ts so a store consumer sees a distinct value each time.
  expect(seen.length).toBe(3);
  expect(seen[1]).toEqual({
    source: "/x.jsonl",
    ts: Date.parse("2026-05-28T12:00:00.000Z"),
  });
  expect(seen[2]).toEqual({
    source: "/x.jsonl",
    ts: Date.parse("2026-05-28T12:00:01.000Z"),
  });
});

test("each request is a fresh object reference", () => {
  requestSessionFocus("/a");
  const first = get(sessionFocusRequest);
  requestSessionFocus("/a");
  const second = get(sessionFocusRequest);
  expect(second).not.toBe(first);
});
