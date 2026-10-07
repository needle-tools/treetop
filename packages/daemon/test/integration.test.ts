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

describe("MCP dashboard tools", () => {
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
