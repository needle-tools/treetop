import { expect, test } from "bun:test";
import { UiContextRegistry, UiActionRequests } from "../src/ui-context";
import { handleMcp } from "../src/mcp";
import { Workspace } from "../src/workspace";
import { EventLog } from "../src/events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const snapshot = (focused: boolean) => ({
  windowFocused: focused,
  visible: true,
  focusedSession: {
    source: "a.jsonl",
    sessionId: "a",
    agent: "codex",
    repoId: "project",
  },
  lastActiveSession: { source: "a.jsonl" },
  activeProject: { id: "project", name: "Project", path: "/project" },
  visibleProjects: [
    {
      id: "project",
      name: "Project",
      path: "/project",
      worktreePaths: ["/project"],
    },
  ],
  zenMode: false,
});

test("UI actions wait for the target window, reject wrong acknowledgements and time out explicitly", async () => {
  const requests = new UiActionRequests();
  let command: any;
  const result = requests.request(
    "one",
    { action: "set_zen_mode", enabled: false },
    (value) => {
      command = value;
    },
  );
  expect(() =>
    requests.complete({
      requestId: command.requestId,
      windowId: "other",
      ok: true,
    }),
  ).toThrow();
  requests.complete({
    requestId: command.requestId,
    windowId: "one",
    ok: true,
  });
  expect(await result).toMatchObject({ applied: true, windowId: "one" });
  await expect(
    requests.request(
      "one",
      { action: "set_zen_mode", enabled: false },
      () => {},
      5,
    ),
  ).rejects.toThrow("acknowledge");
  const failure = requests.request(
    "one",
    { action: "set_zen_mode", enabled: false },
    (value) => {
      command = value;
    },
  );
  requests.complete({
    requestId: command.requestId,
    windowId: "one",
    ok: false,
    error: "Project is missing",
  });
  await expect(failure).rejects.toThrow("Project is missing");
});

test("UI context selects the focused window, keeps focus distinct from last-active, rejects old reports and expires", () => {
  const registry = new UiContextRegistry();
  expect(registry.read(undefined, 1000)).toMatchObject({ available: false });
  registry.report(
    { windowId: "one", sequence: 1, snapshot: snapshot(true) },
    1000,
  );
  registry.report(
    { windowId: "two", sequence: 1, snapshot: snapshot(false) },
    1500,
  );
  expect(registry.read(undefined, 2000)).toMatchObject({
    available: true,
    windowId: "one",
    focusedSession: { sessionId: "a" },
    ageMs: 1000,
  });
  registry.report(
    { windowId: "one", sequence: 2, snapshot: snapshot(false) },
    2100,
  );
  const unfocused = registry.read("one", 2200);
  expect(unfocused).toMatchObject({
    focusedSession: null,
    lastActiveSession: { source: "a.jsonl" },
    windowFocused: false,
  });
  registry.report(
    { windowId: "one", sequence: 1, snapshot: snapshot(true) },
    2300,
  );
  expect(registry.read("one", 2400)).toMatchObject({
    windowFocused: false,
    ageMs: 300,
  });
  expect(registry.read("one", 20000)).toMatchObject({ available: false });
  expect(() =>
    registry.report({
      windowId: "bad",
      sequence: 1,
      snapshot: { ...snapshot(true), visibleProjects: ["wrong"] },
    }),
  ).toThrow();
  expect(() =>
    registry.report({
      windowId: "bad",
      sequence: -1,
      snapshot: snapshot(true),
    }),
  ).toThrow();
});

test("get_ui_context returns a compact snapshot and validates the selected window", async () => {
  const registry = new UiContextRegistry();
  registry.report({
    windowId: "focused",
    sequence: 1,
    snapshot: snapshot(true),
  });
  const workspace = await Workspace.open(
    await mkdtemp(join(tmpdir(), "treetop-ui-context-")),
  );
  const events = await EventLog.open(workspace.path);
  const call = (args: object) =>
    handleMcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_ui_context", arguments: args },
      },
      { workspace, events, uiContext: (id) => registry.read(id) },
    ) as Promise<any>;
  const result = await call({});
  expect(JSON.parse(result.result.content[0].text)).toMatchObject({
    available: true,
    windowId: "focused",
    focusedSession: { sessionId: "a" },
    visibleProjects: [{ id: "project" }],
  });
  expect(
    JSON.parse((await call({ window_id: "missing" })).result.content[0].text)
      .available,
  ).toBe(false);
  expect((await call({ window_id: 10 })).error).toBeDefined();
});

test("MCP focus and Zen controls validate exact project/session targets and forward window selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "treetop-ui-actions-"));
  const workspace = await Workspace.open(join(root, "workspace"));
  const events = await EventLog.open(workspace.path);
  const cwd = join(root, "project");
  expect(
    await Bun.spawn(["git", "init", cwd], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited,
  ).toBe(0);
  const repo = await workspace.addRepo(cwd);
  const commands: any[] = [];
  const ctx = {
    workspace,
    events,
    sessions: async () =>
      [
        {
          source: "session.jsonl",
          sessionId: "target",
          cwd,
          agent: "claude",
          lastActive: new Date().toISOString(),
        },
      ] as any,
    uiAction: async (action: any, windowId?: string) => {
      commands.push({ action, windowId });
      return { applied: true };
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
  expect(
    (await call("focus_project", { repo_id: repo.id, window_id: "chosen" }))
      .error,
  ).toBeUndefined();
  expect(
    (await call("focus_session", { source: "session.jsonl" })).error,
  ).toBeUndefined();
  expect(
    (await call("set_zen_mode", { enabled: true, repo_id: repo.id })).error,
  ).toBeUndefined();
  expect(
    (await call("set_zen_mode", { enabled: false })).error,
  ).toBeUndefined();
  expect(commands).toEqual([
    {
      action: { action: "focus_project", repoId: repo.id, cwd },
      windowId: "chosen",
    },
    {
      action: {
        action: "focus_session",
        source: "session.jsonl",
        sessionId: "target",
      },
      windowId: undefined,
    },
    {
      action: { action: "set_zen_mode", enabled: true, repoId: repo.id, cwd },
      windowId: undefined,
    },
    { action: { action: "set_zen_mode", enabled: false }, windowId: undefined },
  ]);
  for (const [name, args] of [
    ["focus_project", { repo_id: "unknown" }],
    ["focus_project", { repo_id: repo.id, cwd: root }],
    ["focus_session", { source: "unknown" }],
    ["set_zen_mode", { enabled: "true" }],
    ["set_zen_mode", { enabled: true }],
    ["focus_project", { repo_id: repo.id, window_id: 1 }],
  ] as const)
    expect((await call(name, args)).error).toBeDefined();
  expect(commands).toHaveLength(4);
  const spoken = await call("speak_message", { text: "Tests finished", window_id: "chosen" });
  expect(JSON.parse(spoken.result.content[0].text)).toMatchObject({ status: "played", microphone: false });
  expect(commands.at(-1)).toMatchObject({ action: { action: "voice_message", text: "Tests finished" }, windowId: "chosen" });
  await workspace.patchPrefs({ "supergit:settings": JSON.stringify({ "mcp.voiceMessage": false }) });
  expect((await call("speak_message", { text: "Should not play" })).error ?? (await call("speak_message", { text: "Should not play" })).result?.isError).toBeTruthy();
  expect(commands).toHaveLength(5);
  const catalog = async () => {
    const response = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx) as any;
    return response.result.tools.find((tool: any) => tool.name === "speak_message").description as string;
  };
  expect(await catalog()).toContain("disabled");
  await workspace.patchPrefs({ "supergit:settings": JSON.stringify({ "mcp.voiceMessageEagerness": "frequent" }) });
  expect(await catalog()).toContain("frequent");
  await workspace.patchPrefs({ "supergit:settings": JSON.stringify({ "mcp.voiceMessageEagerness": "on_request" }) });
  expect(await catalog()).toContain("only when the user explicitly asks");
  expect(await catalog()).not.toContain("Use frequent");
});
