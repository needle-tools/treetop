import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dir, "../src/SessionView.svelte"),
  "utf-8",
);

describe("SessionView Codex visual composer", () => {
  test("keeps queue and steer as distinct actions", () => {
    expect(SOURCE).toContain("function queueCodexMessage()");
    expect(SOURCE).toContain("function steerCodexMessage()");
    expect(SOURCE).toContain("steer: opts.steer");
    expect(SOURCE).not.toContain("steer: !!codexActiveTurnId");
    expect(SOURCE).toContain("Queue Codex message");
    expect(SOURCE).toContain("Steer Codex");
  });

  test("queued Codex messages are visible and editable", () => {
    expect(SOURCE).toContain("codexQueuedMessages");
    expect(SOURCE).toContain('aria-label="Queued Codex messages"');
    expect(SOURCE).toContain("beginEditCodexQueuedMessage");
    expect(SOURCE).toContain("saveCodexQueuedMessage");
    expect(SOURCE).toContain("removeCodexQueuedMessage");
    expect(SOURCE).toContain("runCodexQueuedMessage");
    expect(SOURCE).toContain("supergit:codexApp:queue:");
    expect(SOURCE).toContain("persistCodexQueue");
  });

  test("Codex app-server reconnect noise is not user-facing state", () => {
    expect(SOURCE).not.toContain("stream reconnecting");
    expect(SOURCE).not.toContain("Codex event stream disconnected");
    expect(SOURCE).not.toContain("Codex is still running; use Stop");
    expect(SOURCE).toContain("turn/status");
    expect(SOURCE).toContain("effectiveLastActivityIso");
  });
});
