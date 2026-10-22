import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace";
import { EventLog } from "../src/events";
import { handleMcp } from "../src/mcp";
import {
  recentSessionMessages,
  sendTerminalSessionMessage,
  openCodexMessageTarget,
} from "../src/session-tools";

test("native sends require one open, non-stopped Codex column and retain its execution settings", () => {
  const session = {
    agent: "codex",
    sessionId: "target",
    source: "target.jsonl",
  } as any;
  const entry = {
    agent: "codex",
    source: "__codex_app__:target",
    codexApproval: "on-request",
    codexSandbox: "workspaceWrite",
    codexModel: "chosen-model",
  };
  const prefs = (entries: object[]) => ({
    "supergit:openSessions": JSON.stringify({ project: entries }),
  });
  expect(openCodexMessageTarget(prefs([entry]), session)).toEqual(entry);
  expect(() => openCodexMessageTarget(prefs([]), session)).toThrow("open");
  expect(() => openCodexMessageTarget(prefs([entry, entry]), session)).toThrow(
    "exactly one",
  );
  expect(() =>
    openCodexMessageTarget(
      prefs([{ ...entry, visualAppStopped: true }]),
      session,
    ),
  ).toThrow();
  expect(() =>
    openCodexMessageTarget(prefs([{ ...entry, mode: "terminal" }]), session),
  ).toThrow();
  expect(() =>
    openCodexMessageTarget(prefs([{ ...entry, agent: "claude" }]), session),
  ).toThrow();
});

test("recent messages are compact, chronological, paginated and bounded; verbose adds tool summaries", () => {
  const messages = [
    { role: "user", blocks: [{ type: "text", text: "first" }] },
    {
      role: "assistant",
      blocks: [
        { type: "thinking", text: "private reasoning" },
        {
          type: "tool_use",
          toolName: "exec",
          input: { huge: "x".repeat(1000) },
        },
      ],
    },
    { role: "assistant", blocks: [{ type: "text", text: "last response" }] },
    { role: "user", blocks: [{ type: "text", text: "next request" }] },
  ] as any;
  const compact = recentSessionMessages(messages, {
    limit: 2,
    offset: 0,
    maxChars: 100,
    verbose: false,
  });
  expect(compact.messages.map((m) => m.text)).toEqual([
    "last response",
    "next request",
  ]);
  expect(compact.hasMore).toBe(true);
  expect(
    recentSessionMessages(messages, {
      limit: 2,
      offset: 2,
      maxChars: 100,
      verbose: false,
    }).messages.map((m) => m.text),
  ).toEqual(["first"]);
  const verbose = recentSessionMessages(messages, {
    limit: 4,
    offset: 0,
    maxChars: 20,
    verbose: true,
  });
  expect(
    verbose.messages.reduce((n, m) => n + m.text.length, 0),
  ).toBeLessThanOrEqual(20);
  expect(verbose.truncated).toBe(true);
  expect(JSON.stringify(verbose)).not.toContain("private reasoning");
  const details = recentSessionMessages(messages, {
    limit: 4,
    offset: 0,
    maxChars: 500,
    verbose: true,
  });
  expect(details.messages.some((m) => m.text.includes("exec"))).toBe(true);
});

test("MCP reads a discovered transcript and sends only to an explicit registered session", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-session-tools-"));
  const workspace = await Workspace.open(join(root, "workspace"));
  const events = await EventLog.open(workspace.path);
  const project = join(root, "project");
  expect(
    await Bun.spawn(["git", "init", project], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited,
  ).toBe(0);
  const repo = await workspace.addRepo(project);
  const source = join(root, "session.jsonl");
  await writeFile(
    source,
    [
      {
        type: "user",
        sessionId: "target",
        cwd: project,
        message: { role: "user", content: "hello" },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "world" }],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n"),
  );
  const session = {
    agent: "claude" as const,
    sessionId: "target",
    source,
    cwd: project,
    lastActive: new Date().toISOString(),
  };
  const sent: unknown[] = [];
  const ctx = {
    workspace,
    events,
    sessions: async () => [session],
    sendSessionMessage: async (target: unknown, text: string) => {
      sent.push({ target, text });
      return { delivery: "terminal" };
    },
  };
  const call = async (name: string, args: object) =>
    (await handleMcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      ctx,
    )) as any;
  const read = await call("read_session_messages", {
    session_id: "target",
    repo_id: repo.id,
  });
  expect(read.error).toBeUndefined();
  expect(
    JSON.parse(read.result.content[0].text).messages.map((m: any) => m.text),
  ).toEqual(["hello", "world"]);
  const send = await call("send_session_message", {
    source,
    text: "Check the tests",
  });
  expect(send.error).toBeUndefined();
  expect(sent).toEqual([{ target: session, text: "Check the tests" }]);
  expect(JSON.parse(send.result.content[0].text)).toMatchObject({
    delivery: "terminal",
    sessionId: "target",
  });
  for (const args of [
    {},
    { source, text: " " },
    { source: "unknown", text: "hello" },
    { source, text: "\u001b[A" },
  ]) {
    expect((await call("send_session_message", args)).error).toBeDefined();
  }
  for (const args of [
    { source, limit: 0 },
    { source, max_chars: 999999 },
    { source, verbosity: "invalid" },
    { source: join(root, "secret") },
  ]) {
    expect((await call("read_session_messages", args)).error).toBeDefined();
  }
  expect(sent).toHaveLength(1);
  expect(
    (
      await call("send_session_message", {
        source,
        session_id: "other",
        text: "hello",
      })
    ).error,
  ).toBeDefined();
  ctx.sessions = async () => [session, { ...session, source: "other.jsonl" }];
  expect(
    (
      await call("send_session_message", {
        session_id: "target",
        text: "hello",
      })
    ).error,
  ).toBeDefined();
  ctx.sessions = async () => [{ ...session, cwd: root }];
  expect(
    (await call("send_session_message", { source, text: "hello" })).error,
  ).toBeDefined();
  expect(sent).toHaveLength(1);
});

test("terminal delivery pastes into the identified live agent and never writes to shells, busy or ambiguous targets", async () => {
  const writes: string[] = [];
  const record = {
    id: "pty",
    ownerId: "target",
    cwd: "project",
    agent: "claude",
  } as any;
  let working = false;
  const backend = {
    list: () => [record],
    get: () => ({
      isAlive: () => true,
      write: (s: string) => writes.push(s),
      subscribe: (sub: any) => {
        sub.onData(new TextEncoder().encode("\u001b[?2004h"));
        sub.onState?.({ working, awaitingInput: false });
        return () => {};
      },
    }),
  };
  const target = {
    sessionId: "target",
    agent: "claude",
    cwd: "project",
  } as any;
  await sendTerminalSessionMessage(backend as any, target, "one\ntwo");
  expect(writes).toEqual(["\u001b[200~one\ntwo\u001b[201~", "\r"]);
  working = true;
  await expect(
    sendTerminalSessionMessage(backend as any, target, "hello"),
  ).rejects.toThrow("busy");
  working = false;
  record.agent = "shell";
  expect(
    await sendTerminalSessionMessage(backend as any, target, "hello"),
  ).toBeUndefined();
  record.agent = "claude";
  backend.list = () => [record, { ...record, id: "second" }];
  await expect(
    sendTerminalSessionMessage(backend as any, target, "hello"),
  ).rejects.toThrow("multiple");
  expect(writes).toHaveLength(2);
});
