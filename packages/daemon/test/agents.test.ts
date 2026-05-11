/**
 * Tests for the agent scanners. We build small fixture filesystems in temp
 * directories and call the scanners with explicit roots so we don't touch
 * the real ~/.claude / ~/.codex / VSCode storage.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentsForWorktree,
  readJsonlField,
  readClaudeSessionMeta,
  scanClaude,
  scanCodex,
  scanCopilot,
  type AgentSession,
} from "../src/agents";

async function tempDir(prefix = "supergit-agents-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("readJsonlField", () => {
  test("returns null when file is missing", async () => {
    expect(await readJsonlField("/no/such/file", "cwd")).toBeNull();
  });

  test("returns null when no line has the field", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(file, '{"type":"summary"}\n{"foo":"bar"}\n');
    expect(await readJsonlField(file, "cwd")).toBeNull();
  });

  test("returns the first string value of the field", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      '{"type":"summary"}\n{"cwd":"/Users/marcel/foo","other":1}\n{"cwd":"/other"}\n',
    );
    expect(await readJsonlField(file, "cwd")).toBe("/Users/marcel/foo");
  });

  test("skips non-JSON lines without throwing", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(file, "garbage\n{not json\n{\"cwd\":\"/ok\"}\n");
    expect(await readJsonlField(file, "cwd")).toBe("/ok");
  });
});

describe("readClaudeSessionMeta", () => {
  test("returns empty object when file is missing", async () => {
    expect(await readClaudeSessionMeta("/no/such/file")).toEqual({});
  });

  test("prefers an explicit summary over the first user message", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "summary", summary: "Fix auth bug" }),
        JSON.stringify({
          type: "user",
          cwd: "/proj",
          message: { role: "user", content: "long unrelated prompt" },
        }),
      ].join("\n"),
    );
    const r = await readClaudeSessionMeta(file);
    expect(r.title).toBe("Fix auth bug");
    expect(r.cwd).toBe("/proj");
  });

  test("falls back to the first user message text", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        cwd: "/proj",
        message: { role: "user", content: "Please update the README" },
      }),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe(
      "Please update the README",
    );
  });

  test("strips <ide_*> wrappers before using the user text as a title", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        cwd: "/proj",
        message: {
          role: "user",
          content:
            "<ide_opened_file>opened /a.ts</ide_opened_file>\nLet's refactor it",
        },
      }),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe("Let's refactor it");
  });

  test("handles array-style content blocks", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        cwd: "/proj",
        message: {
          role: "user",
          content: [{ type: "text", text: "Implement the feature" }],
        },
      }),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe(
      "Implement the feature",
    );
  });

  test("truncates titles longer than 120 chars with an ellipsis", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    const longPrompt = "x ".repeat(200).trim();
    await writeFile(
      file,
      JSON.stringify({
        type: "user",
        cwd: "/proj",
        message: { role: "user", content: longPrompt },
      }),
    );
    const r = await readClaudeSessionMeta(file);
    expect(r.title?.length).toBeLessThanOrEqual(120);
    expect(r.title?.endsWith("…")).toBe(true);
  });

  test("falls back to the last user message when the first is empty after stripping wrappers", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        // First user message: pure command wrapper that becomes empty after
        // cleanForTitle().
        JSON.stringify({
          type: "user",
          cwd: "/proj",
          message: {
            role: "user",
            content: "<command-name>/init</command-name>",
          },
        }),
        // Later user message with real text.
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "Make the dashboard live-update sessions",
          },
        }),
      ].join("\n"),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe(
      "Make the dashboard live-update sessions",
    );
  });

  test("returns the most recent user message in lastUserMessage", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "user",
          cwd: "/proj",
          message: { role: "user", content: "first ask" },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "follow-up question" },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "and one more thing" },
        }),
      ].join("\n"),
    );
    const meta = await readClaudeSessionMeta(file);
    expect(meta.lastUserMessage).toBe("and one more thing");
  });

  test("falls back to the first assistant text when no user text exists", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "user", cwd: "/proj", message: { role: "user", content: "<ide_opened_file>/a.ts</ide_opened_file>" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I'll read the file first." },
            ],
          },
        }),
      ].join("\n"),
    );
    expect((await readClaudeSessionMeta(file)).title).toBe(
      "I'll read the file first.",
    );
  });
});

describe("scanClaude", () => {
  test("returns empty when root does not exist", async () => {
    expect(await scanClaude("/no/such/claude/root")).toEqual([]);
  });

  test("returns empty when root exists but is empty", async () => {
    expect(await scanClaude(await tempDir())).toEqual([]);
  });

  test("picks up jsonl sessions with cwd metadata", async () => {
    const root = await tempDir();
    const proj = join(root, "-Users-marcel-git-supergit");
    await mkdir(proj, { recursive: true });
    await writeFile(
      join(proj, "abc-123.jsonl"),
      '{"type":"summary","summary":"x"}\n{"cwd":"/Users/marcel/git/supergit","type":"user"}\n',
    );

    const sessions = await scanClaude(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agent).toBe("claude");
    expect(sessions[0]?.cwd).toBe("/Users/marcel/git/supergit");
    expect(sessions[0]?.sessionId).toBe("abc-123");
  });

  test("skips files without a cwd field", async () => {
    const root = await tempDir();
    const proj = join(root, "-x");
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, "empty.jsonl"), '{"type":"summary"}\n');
    expect(await scanClaude(root)).toEqual([]);
  });
});

describe("scanCodex", () => {
  test("returns empty when no candidate root exists", async () => {
    expect(await scanCodex(["/no/such/root"])).toEqual([]);
  });

  test("returns sessions from the first root that exists", async () => {
    const a = await tempDir("supergit-codex-a-");
    const b = await tempDir("supergit-codex-b-");
    await writeFile(
      join(b, "session-1.jsonl"),
      '{"cwd":"/Users/marcel/codex/proj","type":"event"}\n',
    );
    const sessions = await scanCodex(["/missing", a, b]);
    // a exists but is empty -> not returned; b yields one
    expect(sessions).toHaveLength(0); // a is the first existing, but empty
    const sessions2 = await scanCodex([b]);
    expect(sessions2).toHaveLength(1);
    expect(sessions2[0]?.agent).toBe("codex");
    expect(sessions2[0]?.cwd).toBe("/Users/marcel/codex/proj");
  });
});

describe("scanCopilot", () => {
  test("returns empty when root does not exist", async () => {
    expect(await scanCopilot("/no/such/copilot/root")).toEqual([]);
  });

  test("picks up workspaces that have a copilot-chat directory", async () => {
    const root = await tempDir("supergit-copilot-");
    const wsA = join(root, "hash-a");
    const wsB = join(root, "hash-b");
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });
    await writeFile(
      join(wsA, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/marcel/with-copilot" }),
    );
    await mkdir(join(wsA, "github.copilot-chat"), { recursive: true });
    await writeFile(
      join(wsB, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/marcel/without-copilot" }),
    );

    const sessions = await scanCopilot(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.agent).toBe("copilot");
    expect(sessions[0]?.cwd).toBe("/Users/marcel/with-copilot");
  });

  test("decodes percent-encoded file:// URIs", async () => {
    const root = await tempDir("supergit-copilot-enc-");
    const ws = join(root, "hash-x");
    await mkdir(ws, { recursive: true });
    await writeFile(
      join(ws, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/marcel/has%20space" }),
    );
    await mkdir(join(ws, "github.copilot-chat"), { recursive: true });
    const sessions = await scanCopilot(root);
    expect(sessions[0]?.cwd).toBe("/Users/marcel/has space");
  });
});

describe("agentsForWorktree", () => {
  function s(
    cwd: string,
    agent: AgentSession["agent"] = "claude",
    lastActive = "2026-05-12T01:00:00Z",
  ): AgentSession {
    return { agent, cwd, lastActive, source: "" };
  }

  test("returns empty when no agent matches", () => {
    const sessions = [s("/elsewhere")];
    expect(agentsForWorktree("/repo", sessions)).toEqual([]);
  });

  test("matches an exact cwd", () => {
    const sessions = [s("/repo")];
    expect(agentsForWorktree("/repo", sessions)).toHaveLength(1);
  });

  test("matches a subdirectory of the worktree", () => {
    const sessions = [s("/repo/sub/dir")];
    expect(agentsForWorktree("/repo", sessions)).toHaveLength(1);
  });

  test("does not match a sibling path with the worktree as prefix", () => {
    const sessions = [s("/repo-sibling")];
    expect(agentsForWorktree("/repo", sessions)).toEqual([]);
  });

  test("sorts results newest-first", () => {
    const sessions = [
      s("/repo", "claude", "2026-05-12T01:00:00Z"),
      s("/repo", "codex", "2026-05-12T02:00:00Z"),
      s("/repo", "copilot", "2026-05-12T00:30:00Z"),
    ];
    const result = agentsForWorktree("/repo", sessions);
    expect(result.map((r) => r.agent)).toEqual(["codex", "claude", "copilot"]);
  });
});
