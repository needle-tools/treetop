import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSupergitCliScript,
  buildSupergitSessions,
  openSessionRefsFromPrefs,
  parseSupergitMessageRequest,
  resolveSupergitMessageSender,
  resolveSupergitCallerSession,
  resolveSupergitSelfSession,
  resolveSupergitSession,
  senderForSession,
  supergitSelfResolutionError,
} from "../src/supergit-cli";

async function runGeneratedCli(args: string[], opts: {
  defaultDaemonUrl?: string;
} = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const dir = await mkdtemp(join(tmpdir(), "treetop-cli-test-"));
  const scriptPath = join(dir, "treetop");
  try {
    await writeFile(scriptPath, buildSupergitCliScript({
      defaultDaemonUrl: opts.defaultDaemonUrl ?? "http://127.0.0.1:1",
    }));
    const proc = Bun.spawn([process.execPath, scriptPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function captureGeneratedCliRequest(args: string[]): Promise<{
  request: { path: string; body: unknown };
  result: { stdout: string; stderr: string; exitCode: number };
}> {
  let request: { path: string; body: unknown } | undefined;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      request = {
        path: new URL(req.url).pathname,
        body: await req.json(),
      };
      return Response.json({ ok: true });
    },
  });
  try {
    const result = await runGeneratedCli(args, {
      defaultDaemonUrl: `http://127.0.0.1:${server.port}`,
    });
    if (!request) throw new Error("generated CLI did not make a request");
    return { request, result };
  } finally {
    server.stop(true);
  }
}

describe("supergit terminal CLI helpers", () => {
  test("buildSupergitSessions derives live state from terminal activity", () => {
    const now = Date.parse("2026-05-27T10:00:05.000Z");
    const sessions = buildSupergitSessions({
      nowMs: now,
      terminals: [
        {
          id: "t_run",
          ownerId: "ses-run",
          cmd: ["codex"],
          cwd: "/repo",
          agent: "codex",
          pid: 10,
          size: { cols: 80, rows: 24 },
          createdAt: "2026-05-27T10:00:00.000Z",
          lastOutputAt: "2026-05-27T10:00:04.400Z",
        },
        {
          id: "t_idle",
          cmd: ["claude"],
          cwd: "/repo",
          agent: "claude",
          pid: 11,
          size: { cols: 80, rows: 24 },
          createdAt: "2026-05-27T09:59:00.000Z",
          lastOutputAt: "2026-05-27T10:00:00.000Z",
        },
        {
          id: "t_wait",
          cmd: ["claude"],
          cwd: "/repo",
          agent: "claude",
          pid: 12,
          size: { cols: 80, rows: 24 },
          createdAt: "2026-05-27T09:59:00.000Z",
          lastOutputAt: "2026-05-27T10:00:00.000Z",
          awaitingInput: true,
        },
      ],
      agents: [
        {
          agent: "codex",
          cwd: "/repo",
          source: "/sessions/ses-run.jsonl",
          sessionId: "ses-run",
          lastActive: "2026-05-27T10:00:04.500Z",
          title: "Running session",
        },
        {
          agent: "claude",
          cwd: "/repo",
          source: "/sessions/stopped.jsonl",
          sessionId: "stopped",
          lastActive: "2026-05-27T09:00:00.000Z",
          title: "Stopped session",
        },
      ],
    });

    expect(sessions.map((s) => [s.id, s.state])).toEqual([
      ["ses-run", "running"],
      ["t_idle", "idle"],
      ["t_wait", "awaiting_input"],
      ["stopped", "stopped"],
    ]);
    expect(sessions[0]?.terminalId).toBe("t_run");
    expect(sessions[0]?.name).toBe("Running session");
  });

  test("buildSupergitSessions defaults to open UI sessions when refs are provided", () => {
    const sessions = buildSupergitSessions({
      nowMs: Date.parse("2026-05-27T10:00:05.000Z"),
      openSessionRefs: {
        sources: new Set(["/sessions/open.jsonl", "__attached__:shell:t_shell"]),
        sessionIds: new Set(["open-sid"]),
      },
      terminals: [
        {
          id: "t_open",
          ownerId: "open-sid",
          cmd: ["codex"],
          cwd: "/repo",
          agent: "codex",
          pid: 10,
          size: { cols: 80, rows: 24 },
          createdAt: "2026-05-27T10:00:00.000Z",
          lastOutputAt: "2026-05-27T10:00:04.400Z",
        },
        {
          id: "t_shell",
          cmd: ["zsh"],
          cwd: "/repo",
          agent: "shell",
          pid: 11,
          size: { cols: 80, rows: 24 },
          createdAt: "2026-05-27T10:00:00.000Z",
          lastOutputAt: "2026-05-27T10:00:00.000Z",
        },
      ],
      agents: [
        {
          agent: "codex",
          cwd: "/repo",
          source: "/sessions/open.jsonl",
          sessionId: "open-sid",
          lastActive: "2026-05-27T10:00:04.500Z",
          title: "Open title",
        },
        {
          agent: "claude",
          cwd: "/repo",
          source: "/sessions/history.jsonl",
          sessionId: "history-sid",
          lastActive: "2026-05-27T09:00:00.000Z",
          title: "Historical session",
        },
      ],
    });

    expect(sessions.map((s) => s.id)).toEqual(["open-sid", "t_shell"]);
  });

  test("buildSupergitSessions matches live terminals through an open source", () => {
    const sessions = buildSupergitSessions({
      nowMs: Date.parse("2026-05-27T10:00:05.000Z"),
      openSessionRefs: {
        sources: new Set(["/sessions/open.jsonl"]),
        sessionIds: new Set(),
      },
      terminals: [{
        id: "t_open",
        ownerId: "open-sid",
        cmd: ["codex"],
        cwd: "/repo",
        agent: "codex",
        pid: 10,
        size: { cols: 80, rows: 24 },
        createdAt: "2026-05-27T10:00:00.000Z",
        lastOutputAt: "2026-05-27T10:00:04.400Z",
      }],
      agents: [{
        agent: "codex",
        cwd: "/repo",
        source: "/sessions/open.jsonl",
        sessionId: "open-sid",
        lastActive: "2026-05-27T10:00:04.500Z",
        title: "Open title",
      }],
    });

    expect(sessions.map((s) => [s.id, s.state, s.terminalId])).toEqual([
      ["open-sid", "running", "t_open"],
    ]);
  });

  test("buildSupergitSessions falls back to live terminals when open prefs are empty", () => {
    const sessions = buildSupergitSessions({
      nowMs: Date.parse("2026-05-27T10:00:05.000Z"),
      openSessionRefs: {
        sources: new Set(),
        sessionIds: new Set(),
      },
      terminals: [{
        id: "t_live",
        ownerId: "live-sid",
        cmd: ["codex"],
        cwd: "/repo",
        agent: "codex",
        pid: 10,
        size: { cols: 80, rows: 24 },
        createdAt: "2026-05-27T10:00:00.000Z",
        lastOutputAt: "2026-05-27T10:00:04.400Z",
      }],
      agents: [
        {
          agent: "codex",
          cwd: "/repo",
          source: "/sessions/live.jsonl",
          sessionId: "live-sid",
          lastActive: "2026-05-27T10:00:04.500Z",
          title: "Live title",
        },
        {
          agent: "claude",
          cwd: "/repo",
          source: "/sessions/history.jsonl",
          sessionId: "history-sid",
          lastActive: "2026-05-27T09:00:00.000Z",
          title: "Historical session",
        },
      ],
    });

    expect(sessions.map((s) => [s.id, s.state])).toEqual([
      ["live-sid", "running"],
    ]);
  });

  test("buildSupergitSessions keeps all historical sessions with includeAll", () => {
    const sessions = buildSupergitSessions({
      includeAll: true,
      nowMs: 0,
      openSessionRefs: {
        sources: new Set(["/sessions/open.jsonl"]),
        sessionIds: new Set(["open-sid"]),
      },
      terminals: [],
      agents: [
        {
          agent: "codex",
          cwd: "/repo",
          source: "/sessions/open.jsonl",
          sessionId: "open-sid",
          lastActive: "1970-01-01T00:00:00.000Z",
          title: "Open title",
        },
        {
          agent: "claude",
          cwd: "/repo",
          source: "/sessions/history.jsonl",
          sessionId: "history-sid",
          lastActive: "1970-01-01T00:00:00.000Z",
          title: "Historical session",
        },
      ],
    });

    expect(sessions.map((s) => s.id)).toEqual(["open-sid", "history-sid"]);
  });

  test("session names prefer saved titles and stop at line breaks", () => {
    const sessions = buildSupergitSessions({
      nowMs: 0,
      sessionTitles: {
        "/sessions/open.jsonl": "Saved name\nsecret second line",
        "__attached__:shell:t_shell": "Shell title\r\nextra",
      },
      terminals: [
        {
          id: "t_shell",
          cmd: ["zsh"],
          cwd: "/repo",
          agent: "shell",
          pid: 11,
          size: { cols: 80, rows: 24 },
          createdAt: "1970-01-01T00:00:00.000Z",
          lastOutputAt: "1970-01-01T00:00:00.000Z",
        },
      ],
      agents: [
        {
          agent: "codex",
          cwd: "/repo",
          source: "/sessions/open.jsonl",
          sessionId: "open-sid",
          lastActive: "1970-01-01T00:00:00.000Z",
          title: "Auto title",
          lastUserMessage: "Last prompt",
        },
      ],
    });

    expect(sessions.map((s) => s.name)).toEqual(["Shell title", "Saved name"]);
  });

  test("openSessionRefsFromPrefs reads open UI columns", () => {
    const refs = openSessionRefsFromPrefs({
      "supergit:openSessions": JSON.stringify({
        "/repo": [
          { agent: "codex", source: "/sessions/open.jsonl", resumeSessionId: "open-sid" },
          { agent: "shell", source: "__attached__:shell:t_shell" },
          { agent: "files", source: "__files__:/repo" },
        ],
      }),
    });

    expect([...refs.sources].sort()).toEqual([
      "/sessions/open.jsonl",
      "__attached__:shell:t_shell",
    ]);
    expect([...refs.sessionIds]).toEqual(["open-sid"]);
  });

  test("resolveSupergitSession accepts session id, terminal id, or source", () => {
    const sessions = buildSupergitSessions({
      nowMs: 0,
      terminals: [{
        id: "t_1",
        ownerId: "ses-1",
        cmd: ["codex"],
        cwd: "/repo",
        agent: "codex",
        pid: 1,
        size: { cols: 80, rows: 24 },
        createdAt: "1970-01-01T00:00:00.000Z",
        lastOutputAt: "1970-01-01T00:00:00.000Z",
      }],
      agents: [{
        agent: "codex",
        cwd: "/repo",
        source: "/sessions/ses-1.jsonl",
        sessionId: "ses-1",
        lastActive: "1970-01-01T00:00:00.000Z",
      }],
    });

    expect(resolveSupergitSession(sessions, "ses-1")?.terminalId).toBe("t_1");
    expect(resolveSupergitSession(sessions, "t_1")?.id).toBe("ses-1");
    expect(resolveSupergitSession(sessions, "/sessions/ses-1.jsonl")?.id).toBe("ses-1");
  });

  test("senderForSession preserves addressable session metadata", () => {
    expect(senderForSession({
      id: "ses-1",
      name: "Current session",
      state: "idle",
      agent: "codex",
      cwd: "/repo",
      source: "/sessions/ses-1.jsonl",
      terminalId: "t_1",
    })).toEqual({
      kind: "session",
      id: "ses-1",
      label: "Current session",
      agent: "codex",
      source: "/sessions/ses-1.jsonl",
      terminalId: "t_1",
    });
  });

  test("message sender resolution lets inbox notes fall back to peer identity outside Treetop", () => {
    expect(resolveSupergitMessageSender({
      senderMode: "auto",
      target: { kind: "inbox" },
      peerIdentity: { id: "peer-1", label: "Me" },
    })).toEqual({
      kind: "peer",
      id: "peer-1",
      label: "Me",
    });
  });

  test("resolveSupergitCallerSession maps the CLI parent pid to its owning session", () => {
    const terminals = [{
      id: "t_1",
      ownerId: "ses-1",
      cmd: ["codex"],
      cwd: "/repo",
      agent: "codex",
      pid: 4242,
      size: { cols: 80, rows: 24 },
      createdAt: "1970-01-01T00:00:00.000Z",
      lastOutputAt: "1970-01-01T00:00:00.000Z",
    }];
    const sessions = buildSupergitSessions({
      nowMs: 0,
      terminals,
      agents: [{
        agent: "codex",
        cwd: "/repo",
        source: "/sessions/ses-1.jsonl",
        sessionId: "ses-1",
        lastActive: "1970-01-01T00:00:00.000Z",
      }],
    });

    expect(resolveSupergitCallerSession(sessions, terminals, 4242)?.id).toBe("ses-1");
    expect(resolveSupergitCallerSession(sessions, terminals, 99)).toBeUndefined();
  });

  test("resolveSupergitCallerSession maps descendant shell commands to their terminal session", () => {
    const terminals = [{
      id: "t_1",
      ownerId: "ses-1",
      cmd: ["codex"],
      cwd: "/repo",
      agent: "codex",
      pid: 4242,
      size: { cols: 80, rows: 24 },
      createdAt: "1970-01-01T00:00:00.000Z",
      lastOutputAt: "1970-01-01T00:00:00.000Z",
    }];
    const sessions = buildSupergitSessions({
      nowMs: 0,
      terminals,
      agents: [{
        agent: "codex",
        cwd: "/repo",
        source: "/sessions/ses-1.jsonl",
        sessionId: "ses-1",
        lastActive: "1970-01-01T00:00:00.000Z",
      }],
    });

    expect(resolveSupergitCallerSession(
      sessions,
      terminals,
      7001,
      [7000, 4242, 1],
    )?.id).toBe("ses-1");
  });

  test("resolveSupergitSelfSession falls back to the only live session in the caller cwd", () => {
    const sessions = [
      {
        id: "ses-1",
        name: "current",
        state: "idle" as const,
        agent: "codex",
        cwd: "/repo",
        terminalId: "t_1",
        lastActive: "2026-05-27T10:00:00.000Z",
      },
      {
        id: "ses-old",
        name: "old",
        state: "stopped" as const,
        agent: "codex",
        cwd: "/repo",
        lastActive: "2026-05-27T09:00:00.000Z",
      },
    ];

    expect(resolveSupergitSelfSession(sessions, [], {
      callerPid: 999,
      callerCwd: "/repo",
    })?.id).toBe("ses-1");
  });

  test("resolveSupergitSelfSession does not guess between multiple live sessions in one cwd", () => {
    const sessions = [
      {
        id: "ses-1",
        name: "one",
        state: "idle" as const,
        cwd: "/repo",
        terminalId: "t_1",
      },
      {
        id: "ses-2",
        name: "two",
        state: "idle" as const,
        cwd: "/repo",
        terminalId: "t_2",
      },
    ];

    expect(resolveSupergitSelfSession(sessions, [], {
      callerPid: 999,
      callerCwd: "/repo",
    })).toBeUndefined();
  });

  test("self resolution failure message gives actionable recovery commands", () => {
    expect(supergitSelfResolutionError()).toContain("Could not resolve current session");
    expect(supergitSelfResolutionError()).toContain("treetop session list --all --json");
    expect(supergitSelfResolutionError()).toContain("treetop message <sessionId>");
    expect(supergitSelfResolutionError()).toContain("Use `treetop message me ...` only when you want an inbox note.");
  });

  test("message request parser accepts the daemon-domain payload", () => {
    expect(parseSupergitMessageRequest({
      body: "hello",
      target: { kind: "session", id: "ses-1" },
      sender: { mode: "me" },
      caller: { pid: 123, cwd: "/repo" },
    })).toEqual({
      ok: true,
      value: {
        body: "hello",
        target: { kind: "session", id: "ses-1" },
        senderMode: "me",
        callerPid: 123,
        callerCwd: "/repo",
      },
    });
  });

  test("message request parser defaults to auto sender and optional target", () => {
    expect(parseSupergitMessageRequest({ body: "unaddressed note" })).toEqual({
      ok: true,
      value: {
        body: "unaddressed note",
        senderMode: "auto",
      },
    });
  });

  test("message request parser rejects legacy CLI-shaped payloads", () => {
    expect(parseSupergitMessageRequest({
      sessionId: "ses-1",
      content: "hello",
      args: ["there"],
      from: "auto",
      callerPid: 123,
      callerCwd: "/repo",
    })).toEqual({
      ok: false,
      status: 400,
      error: "body is required",
    });
  });

  test("generated CLI help exposes only session list and message", () => {
    const script = buildSupergitCliScript({
      defaultDaemonUrl: "http://127.0.0.1:7777",
    });
    expect(script).toContain("treetop session list");
    expect(script).toContain("treetop list [--all] [--json]");
    expect(script).toContain("treetop session list [--all] [--json]");
    expect(script).toContain("treetop message [--from auto|me] [sessionId|self|me] <content...>");
    expect(script).toContain("--from auto  Use the Treetop session running this command (default).");
    expect(script).toContain("Omitting the target is the same as self");
    expect(script).toContain("Use self for the session running this command");
    expect(script).toContain("Use me only when you explicitly want an inbox note");
    expect(script).toContain("caller: { pid: process.ppid, cwd: process.cwd() }");
    expect(script).not.toContain("SUPERGIT_DAEMON_URL");
    expect(script).not.toContain("SUPERGIT_WORKSPACE");
    expect(script).not.toContain("SUPERGIT_TERM_ID");
    expect(script).not.toContain("worktrees list");
  });

  test("generated message help exits before creating a note", async () => {
    const long = await runGeneratedCli(["message", "--help"]);
    expect(long.exitCode).toBe(0);
    expect(long.stdout).toContain("treetop message [--from auto|me] [sessionId|self|me] <content...>");
    expect(long.stdout).toContain("Omitting the target is the same as self");
    expect(long.stdout).toContain("Only use this for explicit inbox notes.");
    expect(long.stdout).toContain("--from me    Use this machine's peer identity as sender.");
    expect(long.stderr).toBe("");

    const short = await runGeneratedCli(["message", "-h"]);
    expect(short.exitCode).toBe(0);
    expect(short.stdout).toContain("treetop message [--from auto|me] [sessionId|self|me] <content...>");
    expect(short.stderr).toBe("");

    const word = await runGeneratedCli(["message", "help"]);
    expect(word.exitCode).toBe(0);
    expect(word.stdout).toContain("treetop message [--from auto|me] [sessionId|self|me] <content...>");
    expect(word.stderr).toBe("");
  });

  test("generated session help is subcommand-specific", async () => {
    const help = await runGeneratedCli(["session", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("treetop session list [--all] [--json]");
    expect(help.stderr).toBe("");

    const listHelp = await runGeneratedCli(["session", "list", "--help"]);
    expect(listHelp.exitCode).toBe(0);
    expect(listHelp.stdout).toContain("treetop session list [--all] [--json]");
    expect(listHelp.stderr).toBe("");

    const missing = await runGeneratedCli(["session"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toContain("treetop session list [--all] [--json]");
    expect(missing.stderr).toContain("session requires a subcommand");
  });

  test("generated CLI sends message payloads in daemon-domain shape", async () => {
    const { request, result } = await captureGeneratedCliRequest([
      "message",
      "--from",
      "auto",
      "ses-1",
      "--content",
      "hello",
      "image.png",
    ]);

    expect(result.exitCode).toBe(0);
    expect(request.path).toBe("/api/supergit/messages");
    expect(request.body).toEqual({
      body: "hello\n\nimage.png",
      target: { kind: "session", id: "ses-1" },
      sender: { mode: "auto" },
      caller: {
        pid: expect.any(Number),
        cwd: expect.any(String),
      },
    });
  });

  test("generated CLI maps self and me to explicit message target kinds", async () => {
    const omitted = await captureGeneratedCliRequest(["message", "ping"]);
    expect(omitted.request.body).toMatchObject({
      body: "ping",
      target: { kind: "self" },
    });

    const session = await captureGeneratedCliRequest(["message", "--to", "ses-1", "ping"]);
    expect(session.request.body).toMatchObject({
      body: "ping",
      target: { kind: "session", id: "ses-1" },
    });

    const self = await captureGeneratedCliRequest(["message", "self", "ping"]);
    expect(self.request.body).toMatchObject({
      body: "ping",
      target: { kind: "self" },
    });

    const inbox = await captureGeneratedCliRequest(["message", "me", "ping"]);
    expect(inbox.request.body).toMatchObject({
      body: "ping",
      target: { kind: "inbox" },
    });
  });
});
