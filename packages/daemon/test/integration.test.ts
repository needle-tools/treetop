/**
 * Integration tests for the add/remove/rename + undo/redo state machine.
 *
 * These exercise Workspace + EventLog together using the exact payload
 * contracts the server routes write — they would have caught the
 * "redo says not found" bug we hit when --hot didn't reload the new redo
 * route. Treat each route's logic as a pure function from (workspace,
 * events, eventId, toggle) -> next state, and assert that round-trips
 * don't lose information.
 */

import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, type Repo } from "../src/workspace";
import { EventLog } from "../src/events";
import { handleMcp, handleMcpHttp, withTreetopMcp } from "../src/mcp";
import { remindersForWorkspace } from "../src/reminders";

describe("MCP dashboard tools", () => {
  test("command queries expose configured cwd, resolved project-default cwd and run mode", async () => {
    const ctx = await setup();
    const repo = await ctx.workspace.addRepo(await mkdtemp(join(tmpdir(), "mcp-command-settings-")));
    await ctx.workspace.addCustomLink(repo.id, { kind: "command", cmd: "npm run dev" });
    await ctx.workspace.addCustomLink(repo.id, { kind: "command", cmd: "bun test", cwd: "tools/tests", runMode: "external" });
    const commands = JSON.parse((await ctx.call("list_commands", { repo_id: repo.id })).result.content[0].text).saved;
    expect(commands[0]).toMatchObject({ cwd: null, defaultCwd: repo.path, runMode: "internal" });
    expect(commands[1]).toMatchObject({ cwd: "tools/tests", defaultCwd: join(repo.path, "tools/tests"), runMode: "external" });
  });
  test("queries recorded events newest first with actor, action, time and pagination filters", async () => {
    const ctx = await setup();
    const first = await ctx.events.append({ type: "custom_link_add", actor: "agent", payload: { id: "project", command: "bun test" } });
    const second = await ctx.events.append({ type: "custom_link_update", actor: "user", payload: { id: "project" } });
    const third = await ctx.events.append({ type: "custom_link_update", actor: "agent", payload: { id: "other" } });
    const all = JSON.parse((await ctx.call("list_events", { limit: 1 })).result.content[0].text);
    expect(all.events[0].id).toBe(third.id);
    expect(all.total).toBe(3);
    expect(all.nextOffset).toBe(1);
    const filtered = JSON.parse((await ctx.call("list_events", { actor: "agent", type: "custom_link_update", after: first.timestamp, before: third.timestamp })).result.content[0].text);
    expect(filtered.events.map((event: any) => event.id)).toEqual([third.id]);
    const page = JSON.parse((await ctx.call("list_events", { offset: 1, limit: 2 })).result.content[0].text);
    expect(page.events.map((event: any) => event.id)).toEqual([second.id, first.id]);
    expect(page.nextOffset).toBeNull();
    for (const args of [{ limit: 0 }, { actor: "unknown" }, { after: "invalid" }, { offset: -1 }, { type: 42 }])
      expect((await ctx.call("list_events", args)).error.code).toBe(-32602);
    expect(ctx.changes).toEqual([]);
  });
  test("edits saved commands in place, preserves omitted fields and rejects other links", async () => {
    const ctx = await setup();
    const repo = await ctx.workspace.addRepo(await mkdtemp(join(tmpdir(), "mcp-edit-command-")));
    const command = await ctx.workspace.addCustomLink(repo.id, { kind: "command", cmd: "bun test", name: "Tests", cwd: "packages/ui", runMode: "external" });
    const url = await ctx.workspace.addCustomLink(repo.id, { kind: "url", url: "https://example.com" });
    const updated = await ctx.call("edit_command", { repo_id: repo.id, command_id: command.id, command: "bun test --watch", name: "Watch" });
    expect(updated.error).toBeUndefined();
    expect(JSON.parse(updated.result.content[0].text).link).toMatchObject({ id: command.id, cmd: "bun test --watch", name: "Watch", cwd: "packages/ui", runMode: "external" });
    const cleared = await ctx.call("edit_command", { repo_id: repo.id, command_id: command.id, name: null, command_cwd: null, run_mode: "internal" });
    const link = JSON.parse(cleared.result.content[0].text).link;
    expect(link.name).toBeUndefined();
    expect(link.cwd).toBeUndefined();
    expect(link.cmd).toBe("bun test --watch");
    expect(link.runMode).toBe("internal");
    for (const args of [
      { command_id: url.id, command: "changed" },
      { command_id: "missing", command: "changed" },
      { command_id: command.id, command: "" },
      { command_id: command.id, run_mode: "invalid" },
      { command_id: command.id },
    ]) expect((await ctx.call("edit_command", { repo_id: repo.id, ...args })).error.code).toBe(-32602);
    const stored = (await ctx.workspace.listRepos())[0]!.customLinks!;
    expect(stored).toHaveLength(2);
    expect(stored.find(item => item.id === url.id)).toEqual(url);
    expect(ctx.changes.filter(change => change.kind === "custom_link_update")).toHaveLength(2);
    const history = JSON.parse((await ctx.call("list_events", { type: "custom_link_update", actor: "agent" })).result.content[0].text);
    expect(history.events).toHaveLength(2);
    expect(history.events[0].payload.link).toMatchObject({ id: command.id, cmd: "bun test --watch", runMode: "internal" });
  });
  test("reads and exports stored settings and project commands without changing workspace state", async () => {
    const ctx = await setup();
    const first = await ctx.workspace.addRepo(await mkdtemp(join(tmpdir(), "mcp-settings-")));
    const other = await ctx.workspace.addRepo(await mkdtemp(join(tmpdir(), "mcp-settings-other-")));
    await ctx.workspace.setRepoColor(first.id, "#ff0000");
    await ctx.workspace.addCustomLink(first.id, { kind: "command", cmd: "bun test", cwd: "packages/ui", name: "UI tests", runMode: "external" });
    await ctx.workspace.patchPrefs({
      "supergit:settings": JSON.stringify({ "terminal.fontSize": 16, "appearance.showGreeting": false }),
      "supergit:codexApp:turnSettings": JSON.stringify({ model: "gpt-6.1", effort: "high" }),
      "supergit:repoOrder": JSON.stringify([`repo:${other.id}`, `repo:${first.id}`]),
      "supergit:openSessions": JSON.stringify({ privateSession: "unrelated runtime state" }),
    });
    const before = await ctx.workspace.getPrefs();
    const read = await ctx.call("get_settings", { repo_id: first.id });
    expect(read.error).toBeUndefined();
    const settings = JSON.parse(read.result.content[0].text);
    expect(settings.settings).toEqual({ "terminal.fontSize": 16, "appearance.showGreeting": false });
    expect(settings.agentDefaults.codex).toEqual({ model: "gpt-6.1", effort: "high" });
    expect(settings.projects).toHaveLength(1);
    expect(settings.projects[0]).toMatchObject({ id: first.id, path: first.path, color: "#ff0000", customLinks: [{ kind: "command", cmd: "bun test", cwd: "packages/ui", name: "UI tests", runMode: "external" }] });
    expect(settings.preferences).toBeUndefined();
    const exported = JSON.parse((await ctx.call("export_settings", {})).result.content[0].text);
    expect(exported.schemaVersion).toBe(1);
    expect(Number.isFinite(Date.parse(exported.exportedAt))).toBe(true);
    expect(exported.projectOrder).toEqual([`repo:${other.id}`, `repo:${first.id}`]);
    expect(exported.projects).toHaveLength(2);
    expect(await ctx.workspace.getPrefs()).toEqual(before);
    expect(ctx.changes).toEqual([]);
    expect((await ctx.call("get_settings", { repo_id: "missing" })).error.code).toBe(-32602);
    expect((await ctx.call("export_settings", { repo_id: 42 })).error.code).toBe(-32602);
    await ctx.workspace.patchPrefs({ "supergit:settings": "broken JSON" });
    expect((await ctx.call("get_settings", {})).result.isError).toBe(true);
  });
  test("schedules, filters and cancels durable project/session reminders through MCP", async () => {
    const ctx = await setup();
    const repo = await ctx.workspace.addRepo(await tempDir());
    const result = await ctx.call("schedule_reminder", { title: "Cloud review", message: "Check logs", details: "More information", delay_seconds: 60, repo_id: repo.id, session_source: "session.jsonl" });
    const reminder = JSON.parse(result.result.content[0].text);
    expect(reminder.status).toBe("scheduled");
    expect(reminder.sessionSource).toBe("session.jsonl");
    const listed = JSON.parse((await ctx.call("list_reminders", { repo_id: repo.id, status: "scheduled" })).result.content[0].text);
    expect(listed.map((item: any) => item.id)).toEqual([reminder.id]);
    expect((await ctx.call("schedule_reminder", { title: "x", message: "x", delay_seconds: 1, repo_id: "missing" })).error.code).toBe(-32602);
    expect((await ctx.call("schedule_reminder", { title: "x", message: "x", delay_seconds: 0 })).error.code).toBe(-32602);
    expect((await ctx.call("schedule_reminder", { title: "x", message: "x", delay_seconds: 1, at: "2030-01-01T00:00:00Z" })).error.code).toBe(-32602);
    await ctx.call("cancel_reminder", { id: reminder.id });
    expect(await remindersForWorkspace(ctx.workspace.path).takeDue(Date.now() + 120000)).toEqual([]);
    expect(JSON.parse((await ctx.call("list_reminders", { status: "cancelled" })).result.content[0].text)[0].id).toBe(reminder.id);
    expect(ctx.changes.some(change => change.kind === "reminder_changed")).toBe(true);
  });
  test("lists and searches sessions across projects with filters and pagination", async () => {
    const workspace = await Workspace.open(await mkdtemp(join(tmpdir(), "mcp-session-query-")));
    const events = await EventLog.open(workspace.path);
    const makeRepo = async () => {
      const path = await tempDir();
      expect(await Bun.spawn(["git", "init", path], { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
      return workspace.addRepo(path);
    };
    const a = await makeRepo();
    const b = await makeRepo();
    const sessions = [
      { agent: "claude" as const, cwd: a.path, source: "a.jsonl", sessionId: "a", title: "Fix renderer", lastActive: "2026-10-07T12:00:00Z" },
      { agent: "codex" as const, cwd: b.path, source: "b.jsonl", sessionId: "b", lastUserMessage: "Investigate RENDERER crash", lastActive: "2026-10-07T13:00:00Z" },
      { agent: "copilot" as const, cwd: join(tmpdir(), "unregistered"), source: "outside", lastActive: "2026-10-07T14:00:00Z" },
    ];
    await workspace.setSessionTitle("a.jsonl", "Graphics bug");
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { workspace, events, sessions: async () => sessions }) as any;
      return response.error ? response : JSON.parse(response.result.content[0].text);
    };
    const found = await call("search_sessions", { query: "renderer", limit: 1 });
    expect(found.total).toBe(2);
    expect(found.sessions[0].repoId).toBe(b.id);
    expect(found.nextOffset).toBe(1);
    expect((await call("search_sessions", { query: "graphics" })).sessions[0].sessionId).toBe("a");
    expect((await call("list_sessions", { repo_id: a.id, agent: "claude", cwd: a.path })).total).toBe(1);
    expect((await call("list_sessions", { after: "2026-10-07T12:30:00Z", before: "2026-10-07T13:30:00Z" })).total).toBe(1);
    expect((await call("list_sessions", { include_unregistered: true })).total).toBe(3);
    expect((await call("search_sessions", { query: "renderer", offset: 1 })).sessions[0].repoId).toBe(a.id);
    for (const args of [{ limit: -1 }, { offset: 0.5 }, { after: "bad" }, { agent: "bad" }, { cwd: "relative" }, { repo_id: "unknown" }]) {
      expect((await call("list_sessions", args)).error.code).toBe(-32602);
    }
    expect((await call("search_sessions", { query: " " })).error.code).toBe(-32602);
  });
  async function setup() {
    const workspace = await Workspace.open(
      await mkdtemp(join(tmpdir(), "treetop-mcp-")),
    );
    const events = await EventLog.open(workspace.path);
    const changes: Record<string, unknown>[] = [];
    const ctx = {
      workspace,
      events,
      changed: (change: Record<string, unknown>) => changes.push(change),
    };
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await handleMcp(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
        ctx,
      )) as any;
    return { ...ctx, changes, call };
  }

  test("discovers tools and handles MCP lifecycle messages", async () => {
    const ctx = await setup();
    const listed = (await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      ctx,
    )) as any;
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining([
        "list_repos",
        "add_repo",
        "remove_repo",
        "reorder_repos",
        "set_repo_color",
        "open_session",
        "list_sessions",
        "search_sessions",
        "schedule_reminder",
        "list_reminders",
        "cancel_reminder",
        "dismiss_reminder",
        "get_settings",
        "export_settings",
        "list_commands",
        "add_command",
        "edit_command",
        "list_events",
      ]),
    );
    const initialized = (await handleMcp(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      },
      ctx,
    )) as any;
    expect(initialized.result.protocolVersion).toBe("2025-11-25");
    expect(
      await handleMcp(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        ctx,
      ),
    ).toBeNull();
    expect(
      await handleMcp({ jsonrpc: "2.0", id: 3, method: "ping" }, ctx),
    ).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  test("HTTP accepts initialization notifications and rejects unsupported SSE", async () => {
    const ctx = await setup();
    const post = (body: unknown) =>
      handleMcpHttp(
        new Request("http://localhost/mcp", {
          method: "POST",
          body: JSON.stringify(body),
        }),
        ctx,
      );
    const response = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    const invalid = await post({ jsonrpc: "2.0", method: "ping", id: {} });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as any).error.code).toBe(-32600);
    expect(
      (
        await handleMcpHttp(
          new Request("http://localhost/mcp", {
            headers: { Accept: "text/event-stream" },
          }),
          ctx,
        )
      ).status,
    ).toBe(405);
    const ping = await post({ jsonrpc: "2.0", id: "ping", method: "ping" });
    expect(await ping.json()).toEqual({
      jsonrpc: "2.0",
      id: "ping",
      result: {},
    });
  });

  test("startup connects Claude and Codex to Treetop with session cwd, preserving existing arguments", () => {
    const endpoint = "http://127.0.0.1:50001/mcp";
    const cwd = "C:\\project with spaces";
    const codex = withTreetopMcp(["codex", "resume", "thread"], endpoint, cwd);
    expect(codex.slice(-2)).toEqual(["resume", "thread"]);
    const config = codex[codex.indexOf("-c") + 1]!;
    const url = new URL(JSON.parse(config.slice(config.indexOf("=") + 1)));
    expect(url.searchParams.get("cwd")).toBe(cwd);
    const claude = withTreetopMcp(
      ["claude", "--resume", "session"],
      endpoint,
      cwd,
    );
    expect(claude.slice(-2)).toEqual(["--resume", "session"]);
    expect(
      JSON.parse(claude[claude.indexOf("--mcp-config") + 1]!).mcpServers
        .treetop,
    ).toEqual({ type: "http", url: url.toString() });
    expect(claude[claude.indexOf("--append-system-prompt") + 1]).toContain(
      "add_command",
    );
    const copilot = withTreetopMcp(
      ["copilot", "--resume", "session"],
      endpoint,
      cwd,
    );
    expect(
      JSON.parse(copilot[copilot.indexOf("--additional-mcp-config") + 1]!)
        .mcpServers.treetop,
    ).toEqual({ type: "http", url: url.toString(), tools: ["*"] });
    expect(copilot.slice(-2)).toEqual(["--resume", "session"]);
    const shell = ["powershell.exe"];
    expect(withTreetopMcp(shell, endpoint, cwd)).toBe(shell);
  });

  test("adds a command to the caller's project via the session MCP URL", async () => {
    const ctx = await setup();
    const repo = await ctx.workspace.addRepo(
      await mkdtemp(join(tmpdir(), "mcp-command-")),
    );
    const initialized = await handleMcpHttp(
      new Request(`http://localhost/mcp?cwd=${encodeURIComponent(repo.path)}`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
      }),
      ctx,
    );
    const instructions = ((await initialized.json()) as any).result.instructions;
    expect(instructions).toContain("add_command");
    expect(instructions).toContain(JSON.stringify(repo.path));
    const response = await handleMcpHttp(
      new Request(`http://localhost/mcp?cwd=${encodeURIComponent(repo.path)}`, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "add_command",
            arguments: { command: "bun test", name: "Tests" },
          },
        }),
      }),
      ctx,
    );
    const result = (await response.json()) as any;
    expect(result.error).toBeUndefined();
    const saved = (await ctx.workspace.listRepos())[0]!.customLinks!;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      kind: "command",
      cmd: "bun test",
      name: "Tests",
      runMode: "internal",
    });
    expect(ctx.changes.at(-1)?.kind).toBe("custom_link_add");
    const withoutContext = await ctx.call("add_command", {
      command: "bun test",
    });
    expect(withoutContext.error ?? withoutContext.result?.isError).toBeTruthy();
    expect((await ctx.workspace.listRepos())[0]!.customLinks).toHaveLength(1);
  });

  test("queries project commands, app links, and notes with filters", async () => {
    const ctx = await setup();
    const repo = await ctx.workspace.addRepo(
      await mkdtemp(join(tmpdir(), "mcp-query-")),
    );
    const command = await ctx.workspace.addCustomLink(repo.id, {
      kind: "command",
      cmd: "bun test",
      runMode: "internal",
      name: "Tests",
    });
    await ctx.workspace.addCustomLink(repo.id, {
      url: "https://example.com",
      name: "Dashboard",
    });
    const notes = await NotesStore.open(ctx.workspace.path);
    const note = await notes.create({
      body: "Project notes",
      anchors: [`worktree:${repo.path}`],
      tags: ["project"],
    });
    await notes.create({ body: "Other notes", anchors: ["session:elsewhere"] });
    const commands = JSON.parse(
      (await ctx.call("list_commands", { repo_id: repo.id })).result.content[0]
        .text,
    );
    expect(commands.saved).toHaveLength(1);
    expect(commands.saved[0]).toMatchObject({
      repoId: repo.id,
      id: command.id,
      cmd: "bun test",
    });
    const apps = JSON.parse(
      (await ctx.call("list_connected_apps", { repo_id: repo.id })).result
        .content[0].text,
    );
    expect(Array.isArray(apps.editors)).toBe(true);
    expect(apps.projectLinks).toHaveLength(1);
    expect(apps.projectLinks[0]).toMatchObject({
      repoId: repo.id,
      url: "https://example.com",
    });
    const foundNotes = JSON.parse(
      (await ctx.call("list_notes", { anchor_prefix: `worktree:${repo.path}` }))
        .result.content[0].text,
    );
    expect(foundNotes).toEqual([note]);
    const unknown = await ctx.call("list_commands", { repo_id: "missing" });
    expect(unknown.error ?? unknown.result?.isError).toBeTruthy();
  });

  test("adds, reorders, colors and removes projects with live dashboard changes", async () => {
    const ctx = await setup();
    const first = JSON.parse(
      (
        await ctx.call("add_repo", {
          path: await mkdtemp(join(tmpdir(), "mcp-repo-")),
        })
      ).result.content[0].text,
    );
    const second = await ctx.workspace.addRepo(
      await mkdtemp(join(tmpdir(), "mcp-repo-")),
    );
    await ctx.workspace.patchPrefs({
      "supergit:repoOrder": JSON.stringify([
        `local\0${first.id}`,
        "remote\0project",
        `local\0${second.id}`,
      ]),
    });
    expect(
      (await ctx.call("reorder_repos", { order: [second.id, first.id] })).error,
    ).toBeUndefined();
    expect((await ctx.workspace.listRepos()).map((repo) => repo.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(
      JSON.parse((await ctx.workspace.getPrefs())["supergit:repoOrder"]!),
    ).toEqual([`local\0${second.id}`, "remote\0project", `local\0${first.id}`]);
    expect(
      (await ctx.call("set_repo_color", { id: first.id, color: "#ABCDEF" }))
        .error,
    ).toBeUndefined();
    expect((await ctx.workspace.listRepos())[1]!.color).toBe("#abcdef");
    await ctx.call("set_repo_color", { id: first.id, color: null });
    expect((await ctx.workspace.listRepos())[1]!.color).toBeUndefined();
    const before = ctx.changes.length;
    await ctx.call("set_repo_color", { id: first.id, color: null });
    expect(ctx.changes).toHaveLength(before);
    const invalid = await ctx.call("reorder_repos", {
      order: [first.id, first.id],
    });
    expect(invalid.error ?? invalid.result?.isError).toBeTruthy();
    await ctx.call("remove_repo", { id: first.id });
    expect(ctx.changes.map((change) => change.kind)).toEqual([
      "add_repo",
      "repos_reorder",
      "repo_color",
      "repo_color",
      "remove_repo",
    ]);
    const actions = await ctx.events.list();
    await undoAction(
      ctx.workspace,
      ctx.events,
      actions[actions.length - 1]!.id,
    );
    expect(
      (await ctx.workspace.listRepos()).some((repo) => repo.id === first.id),
    ).toBe(true);
  });

  test("opens a Claude session durably in the selected project without losing other columns", async () => {
    const ctx = await setup();
    const repo = await ctx.workspace.addRepo(
      await mkdtemp(join(tmpdir(), "mcp-session-")),
    );
    const previous = { agent: "codex", source: "__new__:codex:existing" };
    await ctx.workspace.patchPrefs({
      "supergit:openSessions": JSON.stringify({ [repo.path]: [previous] }),
      "supergit:foldedRows": JSON.stringify([
        `${repo.id}|${repo.path}`,
        "other-row",
      ]),
      "supergit:visibleWorktrees": JSON.stringify({ [repo.id]: [] }),
    });
    const result = await ctx.call("open_session", {
      repo_id: repo.id,
      agent: "claude",
    });
    expect(result.error).toBeUndefined();
    const opened = JSON.parse(result.result.content[0].text);
    expect(opened.cwd).toBe(repo.path);
    expect(opened.session.source).toStartWith("__new__:claude:");
    expect(opened.session.preassignedSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const prefs = await ctx.workspace.getPrefs();
    expect(JSON.parse(prefs["supergit:openSessions"]!)[repo.path]).toEqual([
      opened.session,
      previous,
    ]);
    expect(JSON.parse(prefs["supergit:foldedRows"]!)).toEqual(["other-row"]);
    expect(JSON.parse(prefs["supergit:visibleWorktrees"]!)[repo.id]).toEqual([
      repo.path,
    ]);
    expect(ctx.changes.at(-1)).toEqual({ kind: "mcp_open_session", ...opened });
    const invalid = await ctx.call("open_session", {
      repo_id: repo.id,
      agent: "claude",
      cwd: tmpdir(),
    });
    expect(invalid.error ?? invalid.result?.isError).toBeTruthy();
    expect(await ctx.workspace.getPrefs()).toEqual(prefs);
  });

  test("concurrent MCP session opens preserve both columns and model/resume options", async () => {
    const ctx = await setup();
    const repo = await ctx.workspace.addRepo(
      await mkdtemp(join(tmpdir(), "mcp-concurrent-")),
    );
    await Promise.all([
      ctx.call("open_session", {
        repo_id: repo.id,
        agent: "codex",
        resume_session_id: "existing-thread",
        model: "chosen-model",
      }),
      ctx.call("open_session", { repo_id: repo.id, agent: "shell" }),
    ]);
    const sessions = JSON.parse(
      (await ctx.workspace.getPrefs())["supergit:openSessions"]!,
    )[repo.path];
    expect(sessions).toHaveLength(2);
    expect(sessions[0].agent).toBe("shell");
    expect(sessions[1]).toMatchObject({
      agent: "codex",
      resumeSessionId: "existing-thread",
      codexModel: "chosen-model",
    });
  });

  test("opening in a secondary worktree reveals it even without a saved visibility preference", async () => {
    const ctx = await setup();
    const folder = await mkdtemp(join(tmpdir(), "mcp-worktrees-"));
    const primary = join(folder, "main");
    const secondary = join(folder, "feature");
    await mkdir(primary);
    for (const args of [
      ["init"],
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      ["worktree", "add", "-b", "feature", secondary],
    ]) {
      const result = Bun.spawnSync(["git", "-C", primary, ...args]);
      expect(result.exitCode).toBe(0);
    }
    const repo = await ctx.workspace.addRepo(primary);
    const opened = await ctx.call("open_session", {
      repo_id: repo.id,
      agent: "codex",
      cwd: secondary,
    });
    expect(opened.error).toBeUndefined();
    const returned = JSON.parse(opened.result.content[0].text);
    const visible = JSON.parse(
      (await ctx.workspace.getPrefs())["supergit:visibleWorktrees"]!,
    )[repo.id];
    expect(visible).toHaveLength(2);
    expect(visible).toContain(returned.cwd);
  });
});
import { NotesStore } from "../src/notes";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-integration-"));
}

// Mirror of the server's undo handler for add_repo / remove_repo / rename_repo
// and create_note / remove_note. The notes-store dep is optional so existing
// repo-only tests don't have to thread an empty notes object through.
async function undoAction(
  ws: Workspace,
  events: EventLog,
  eventId: string,
  notes?: NotesStore,
): Promise<void> {
  const ev = await events.findById(eventId);
  if (!ev) throw new Error("event not found");
  if (!ev.reversible || ev.inverse === undefined)
    throw new Error("not reversible");
  if (ev.undone) throw new Error("already undone");

  if (ev.type === "add_repo") {
    const inv = ev.inverse as { repo: { id: string } };
    const removed = await ws.removeRepo(inv.repo.id);
    if (!removed) throw new Error("inverse failed: repo no longer exists");
  } else if (ev.type === "remove_repo") {
    const inv = ev.inverse as { repo: Repo };
    await ws.restoreRepo(inv.repo);
  } else if (ev.type === "rename_repo") {
    const inv = ev.inverse as { id: string; oldName: string };
    await ws.renameRepo(inv.id, inv.oldName);
  } else if (ev.type === "create_note") {
    if (!notes) throw new Error("notes store required for create_note undo");
    const inv = ev.inverse as { note: { id: string } };
    await notes.remove(inv.note.id);
  } else if (ev.type === "remove_note") {
    if (!notes) throw new Error("notes store required for remove_note undo");
    const inv = ev.inverse as {
      note: { id: string; body: string; anchors: string[]; tags: string[] };
    };
    await notes.create({
      id: inv.note.id,
      body: inv.note.body,
      anchors: inv.note.anchors,
      tags: inv.note.tags,
    });
  } else {
    throw new Error(`no inverse handler for ${ev.type}`);
  }
  await events.append({
    type: "undo",
    actor: "user",
    payload: { eventId },
  });
}

async function redoAction(
  ws: Workspace,
  events: EventLog,
  eventId: string,
  notes?: NotesStore,
): Promise<void> {
  const ev = await events.findById(eventId);
  if (!ev) throw new Error("event not found");
  if (!ev.reversible || ev.inverse === undefined)
    throw new Error("not reversible");
  if (!ev.undone) throw new Error("nothing to redo");

  if (ev.type === "add_repo") {
    const inv = ev.inverse as { repo: Repo };
    await ws.restoreRepo(inv.repo);
  } else if (ev.type === "remove_repo") {
    const inv = ev.inverse as { repo: { id: string } };
    const removed = await ws.removeRepo(inv.repo.id);
    if (!removed) throw new Error("redo failed: repo no longer exists");
  } else if (ev.type === "rename_repo") {
    const p = ev.payload as { id: string; newName: string };
    await ws.renameRepo(p.id, p.newName);
  } else if (ev.type === "create_note") {
    if (!notes) throw new Error("notes store required for create_note redo");
    const inv = ev.inverse as {
      note: { id: string; body: string; anchors: string[]; tags: string[] };
    };
    await notes.create({
      id: inv.note.id,
      body: inv.note.body,
      anchors: inv.note.anchors,
      tags: inv.note.tags,
    });
  } else if (ev.type === "remove_note") {
    if (!notes) throw new Error("notes store required for remove_note redo");
    const inv = ev.inverse as { note: { id: string } };
    await notes.remove(inv.note.id);
  } else {
    throw new Error(`no redo handler for ${ev.type}`);
  }
  await events.append({
    type: "redo",
    actor: "user",
    payload: { eventId },
  });
}

describe("add → undo → redo round-trip", () => {
  test("restores the same repo with the same id and metadata", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    const addEv = await events.append({
      type: "add_repo",
      actor: "user",
      payload: { path: "/tmp/foo" },
      inverse: { repo },
    });

    expect(await ws.listRepos()).toHaveLength(1);

    await undoAction(ws, events, addEv.id);
    expect(await ws.listRepos()).toHaveLength(0);
    expect((await events.findById(addEv.id))?.undone).toBe(true);
    expect((await events.findById(addEv.id))?.redoable).toBe(true);

    await redoAction(ws, events, addEv.id);
    const after = await ws.listRepos();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(repo.id);
    expect(after[0]?.addedAt).toBe(repo.addedAt);
    expect((await events.findById(addEv.id))?.undone).toBe(false);
  });

  test("undo → redo → undo flips correctly through the chain", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    const addEv = await events.append({
      type: "add_repo",
      actor: "user",
      payload: { path: "/tmp/foo" },
      inverse: { repo },
    });

    await undoAction(ws, events, addEv.id);
    await redoAction(ws, events, addEv.id);
    await undoAction(ws, events, addEv.id);

    expect(await ws.listRepos()).toEqual([]);
    expect((await events.findById(addEv.id))?.undone).toBe(true);
  });
});

describe("remove → undo → redo round-trip", () => {
  test("restores the removed repo on undo, removes it again on redo", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    await ws.removeRepo(repo.id);
    const removeEv = await events.append({
      type: "remove_repo",
      actor: "user",
      payload: { id: repo.id },
      inverse: { repo },
    });

    expect(await ws.listRepos()).toEqual([]);

    await undoAction(ws, events, removeEv.id);
    expect((await ws.listRepos())[0]?.id).toBe(repo.id);

    await redoAction(ws, events, removeEv.id);
    expect(await ws.listRepos()).toEqual([]);
  });
});

describe("rename works correctly regardless of how many worktrees the repo has", () => {
  test("renameRepo updates the single shared repo entry; listRepos reflects it once", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const repo = await ws.addRepo("/Users/me/multi-wt-repo");
    // Simulating "this repo has multiple worktrees" — the workspace stores
    // ONE Repo entry per repo, regardless of git worktree count. The UI
    // renders one row per worktree but they all share the same Repo id.
    // Renaming via id must succeed without depending on row identity.
    const result = await ws.renameRepo(repo.id, "MultiWtRenamed");
    expect(result).toEqual({
      oldName: "multi-wt-repo",
      newName: "MultiWtRenamed",
    });
    const after = await ws.listRepos();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(repo.id);
    expect(after[0]?.name).toBe("MultiWtRenamed");
  });
});

describe("rename → undo → redo round-trip", () => {
  test("restores the old name on undo and reapplies the new one on redo", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);

    const repo = await ws.addRepo("/tmp/foo");
    const { oldName, newName } = await ws.renameRepo(repo.id, "FancyName");
    const ev = await events.append({
      type: "rename_repo",
      actor: "user",
      payload: { id: repo.id, newName },
      inverse: { id: repo.id, oldName },
    });

    expect((await ws.listRepos())[0]?.name).toBe("FancyName");

    await undoAction(ws, events, ev.id);
    expect((await ws.listRepos())[0]?.name).toBe("foo");

    await redoAction(ws, events, ev.id);
    expect((await ws.listRepos())[0]?.name).toBe("FancyName");
  });
});

// Note-create / note-remove flow exactly as the server's POST/DELETE
// routes write it: every mutation appends an event with the full note
// in `inverse` so the toggle handler can recreate or re-delete by id.
// Anchored with this contract because Ctrl+Z in the UI calls into
// /api/events/:id/undo on the latest reversible event — drift between
// route writes and toggle reads would silently break "undo my delete".
describe("create_note / remove_note → undo → redo round-trips", () => {
  test("undoing a create_note removes the note; redo restores same content", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);
    const notes = await NotesStore.open(dir);

    const note = await notes.create({
      id: "n-1",
      body: "hello",
      anchors: ["worktree:/tmp/wt-a"],
      tags: ["bug"],
    });
    const ev = await events.append({
      type: "create_note",
      actor: "user",
      payload: { note },
      inverse: { note },
    });

    expect(await notes.list()).toHaveLength(1);

    await undoAction(ws, events, ev.id, notes);
    expect(await notes.list()).toHaveLength(0);
    expect((await events.findById(ev.id))?.undone).toBe(true);
    expect((await events.findById(ev.id))?.redoable).toBe(true);

    await redoAction(ws, events, ev.id, notes);
    const after = await notes.list();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe("n-1");
    expect(after[0]?.body).toBe("hello");
    expect(after[0]?.anchors).toEqual(["worktree:/tmp/wt-a"]);
    expect(after[0]?.tags).toEqual(["bug"]);
    expect((await events.findById(ev.id))?.undone).toBe(false);
  });

  test("undoing a remove_note restores the same note (id + content + anchors + tags)", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);
    const notes = await NotesStore.open(dir);

    const note = await notes.create({
      id: "n-keep",
      body: "**important**",
      anchors: ["worktree:/tmp/wt-a", "commit:abc123"],
      tags: ["followup", "xr"],
    });

    // Server route writes the full note into inverse so the undo
    // handler can recreate it exactly.
    const removed = await notes.remove(note.id);
    expect(removed).toBe(true);
    const ev = await events.append({
      type: "remove_note",
      actor: "user",
      payload: { id: note.id },
      inverse: { note },
    });

    expect(await notes.list()).toHaveLength(0);

    await undoAction(ws, events, ev.id, notes);
    const restored = await notes.get(note.id);
    expect(restored).not.toBeNull();
    expect(restored?.body).toBe("**important**");
    expect(restored?.anchors).toEqual(["worktree:/tmp/wt-a", "commit:abc123"]);
    expect(restored?.tags).toEqual(["followup", "xr"]);

    await redoAction(ws, events, ev.id, notes);
    expect(await notes.get(note.id)).toBeNull();
  });

  test("create → delete → undo-delete brings the note back; second undo (the create) removes it again", async () => {
    const dir = await tempDir();
    const ws = await Workspace.open(dir);
    const events = await EventLog.open(dir);
    const notes = await NotesStore.open(dir);

    // Mimic POST /api/notes: create + emit event.
    const note = await notes.create({ id: "n-2", body: "first" });
    const createEv = await events.append({
      type: "create_note",
      actor: "user",
      payload: { note },
      inverse: { note },
    });

    // Mimic DELETE /api/notes/:id: capture existing, remove, emit event.
    const existing = await notes.get(note.id);
    expect(existing).not.toBeNull();
    await notes.remove(note.id);
    const removeEv = await events.append({
      type: "remove_note",
      actor: "user",
      payload: { id: note.id },
      inverse: { note: existing! },
    });

    expect(await notes.list()).toHaveLength(0);

    // Ctrl+Z target #1: the most recent reversible event is the
    // remove_note — undo it, note comes back.
    await undoAction(ws, events, removeEv.id, notes);
    expect(await notes.list()).toHaveLength(1);

    // Ctrl+Z target #2: now the latest not-undone reversible is the
    // create_note — undo that too and the note is gone for real.
    await undoAction(ws, events, createEv.id, notes);
    expect(await notes.list()).toHaveLength(0);
  });
});
