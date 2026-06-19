import { describe, expect, test } from "bun:test";
import {
  hydrateWorkspacePreviewSession,
  parseWorkspacePreviewJsonl,
  transcriptLastUserMessage,
  transcriptPreviewText,
} from "../src/workspace-preview-jsonl";

describe("workspace preview jsonl", () => {
  test("parses normalized transcript records and hydrates preview sessions", () => {
    const messages = parseWorkspacePreviewJsonl(`
{"id":"m1","role":"user","timestamp":"2026-06-20T09:00:00.000Z","blocks":[{"type":"text","text":"Launch the product website with real reusable rows."}]}
{"id":"ignored","role":"assistant","timestamp":"2026-06-20T09:01:00.000Z","blocks":"not valid"}
{"id":"m2","role":"assistant","timestamp":"2026-06-20T09:02:00.000Z","blocks":[{"type":"thinking","text":"Need to check the shared layer."},{"type":"text","text":"I wired the public page through WorkspacePreview and kept the notes live."}]}
{"id":"m3","role":"tool","timestamp":"2026-06-20T09:03:00.000Z","blocks":[{"type":"tool_result","text":"svelte-check found 0 errors"}]}
`);

    expect(messages).toHaveLength(3);
    expect(transcriptLastUserMessage(messages)).toBe(
      "Launch the product website with real reusable rows.",
    );
    expect(transcriptPreviewText(messages)).toBe(
      "I wired the public page through WorkspacePreview and kept the notes live.",
    );

    const session = hydrateWorkspacePreviewSession(
      {
        agent: "claude",
        cwd: "~/wt/supergit/website",
        source: "session-site-launch",
        state: "working",
        lastActive: "2026-06-20T09:04:00.000Z",
      },
      messages,
    );

    expect(session.messageCount).toBe(2);
    expect(session.transcript).toBe(messages);
    expect(session.lastUserMessage).toContain("product website");
    expect(session.preview).toContain("WorkspacePreview");
  });
});
