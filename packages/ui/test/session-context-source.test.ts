import { describe, expect, test } from "bun:test";
import {
  contextViewOwnerSource,
  contextViewPanelSource,
  contextViewSessionSource,
  insertContextViewPanel,
  parseSessionContextBlob,
} from "../src/session-context-source";
import { sessionContextStateAtLine } from "@treetop/nicifier";

describe("session context source", () => {
  test("streams JSONL and keeps original line positions for replay", async () => {
    const blob = new Blob([
      '{"type":"session_meta","payload":{"base_instructions":"base"}}\n',
      'not json\n',
      '{"type":"response_item","payload":{"type":"message","role":"user","content":"hello"}}\n',
    ]);
    const parsed = await parseSessionContextBlob(blob);
    expect(parsed.lineCount).toBe(3);
    expect(parsed.invalidLineCount).toBe(1);
    expect(sessionContextStateAtLine(parsed.timeline, 2).items).toHaveLength(0);
    expect(sessionContextStateAtLine(parsed.timeline, 3).items).toHaveLength(1);

    const tail = await parseSessionContextBlob(
      new Blob(['{"type":"response_item","payload":{"type":"message","role":"assistant","content":"tail"}}\n']),
      undefined,
      parsed.lineCount,
    );
    expect(tail.timeline.events[0]?.sourceLine).toBe(4);
  });

  test("opens one context panel immediately left of its owning session", () => {
    const sessions = [
      { agent: "claude", source: "/sessions/one.jsonl" },
      { agent: "codex", source: "/sessions/two.jsonl" },
    ];
    const result = insertContextViewPanel(sessions, "/sessions/two.jsonl");
    expect(result.sessions.map((session) => session.source)).toEqual([
      "/sessions/one.jsonl",
      contextViewPanelSource("/sessions/two.jsonl"),
      "/sessions/two.jsonl",
    ]);
    expect(contextViewOwnerSource(contextViewPanelSource("/sessions/two.jsonl"))).toBe("/sessions/two.jsonl");
    expect(contextViewSessionSource(contextViewPanelSource("app://two", "/sessions/two.jsonl"))).toBe("/sessions/two.jsonl");
    expect(insertContextViewPanel(result.sessions, "/sessions/two.jsonl").inserted).toBe(false);
  });
});
