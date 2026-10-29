import { expect, test } from "bun:test";
import { installUiContextPublisher } from "../src/ui-context-publisher";
import { applyUiAction } from "../src/ui-context-publisher";

test("slow presence requests coalesce changes without delaying window withdrawal", async () => {
  const win = new EventTarget(), doc = new EventTarget();
  const reports: any[] = [];
  let release!: () => void;
  let focused = true;
  const dispose = installUiContextPublisher(() => ({
    windowFocused: focused, visible: true, zenMode: false,
    focusedSession: null, lastActiveSession: null, activeProject: null, visibleProjects: [],
  }), {
    window: win as any, document: doc as any,
    publish: async report => {
      reports.push(report);
      if (reports.length === 1) await new Promise<void>(resolve => { release = resolve; });
    },
  });
  try {
    focused = false;
    win.dispatchEvent(new Event("blur"));
    await Bun.sleep(140);
    win.dispatchEvent(new Event("resize"));
    await Bun.sleep(140);
    expect(reports).toHaveLength(1);
    release();
    await Bun.sleep(10);
    expect(reports).toHaveLength(2);
    expect(reports[1].snapshot.windowFocused).toBe(false);
  } finally {
    dispose();
    release();
  }
  expect(reports.at(-1).snapshot.visible).toBe(false);
});

test("UI actions affect only their chosen window and acknowledge application failures", async () => {
  const calls: unknown[] = [],
    results: any[] = [];
  const adapter = {
    focusSession: async (source: string) => {
      calls.push(source);
    },
    focusProject: async (repoId: string, cwd: string) => {
      calls.push([repoId, cwd]);
    },
    setZenMode: async (enabled: boolean) => {
      calls.push(enabled);
    },
  };
  const acknowledge = async (result: any) => {
    results.push(result);
  };
  const command = {
    windowId: "one",
    requestId: "request",
    action: "focus_session" as const,
    source: "session",
  };
  await applyUiAction(command, "other", adapter, acknowledge);
  expect(calls).toEqual([]);
  expect(results).toEqual([]);
  await applyUiAction(command, "one", adapter, acknowledge);
  await applyUiAction(
    { ...command, action: "focus_project", repoId: "repo", cwd: "/project" },
    "one",
    adapter,
    acknowledge,
  );
  await applyUiAction(
    { ...command, action: "set_zen_mode", enabled: false },
    "one",
    adapter,
    acknowledge,
  );
  expect(calls).toEqual(["session", ["repo", "/project"], false]);
  expect(results.every((result) => result.ok)).toBe(true);
  adapter.focusSession = async () => {
    throw new Error("Session missing");
  };
  await applyUiAction(command, "one", adapter, acknowledge);
  expect(results.at(-1)).toMatchObject({
    ok: false,
    error: "Session missing",
    requestId: "request",
  });
});

test("UI presence publishes focus changes with one window ID and withdraws on cleanup", async () => {
  const win = new EventTarget(),
    doc = new EventTarget();
  const reports: any[] = [];
  let focused = true;
  const dispose = installUiContextPublisher(
    () => ({
      windowFocused: focused,
      visible: true,
      zenMode: false,
      focusedSession: focused ? { source: "target" } : null,
      lastActiveSession: { source: "target" },
      activeProject: null,
      visibleProjects: [],
    }),
    {
      window: win as any,
      document: doc as any,
      publish: async (report) => {
        reports.push(report);
      },
    },
  );
  try {
    expect(reports[0].snapshot.focusedSession.source).toBe("target");
    focused = false;
    win.dispatchEvent(new Event("blur"));
    await Bun.sleep(140);
    expect(reports.at(-1).snapshot.focusedSession).toBeNull();
    expect(reports.at(-1).snapshot.lastActiveSession.source).toBe("target");
  } finally {
    dispose();
  }
  expect(new Set(reports.map((report) => report.windowId)).size).toBe(1);
  expect(reports.map((report) => report.sequence)).toEqual([1, 2, 3]);
  expect(reports.at(-1).snapshot.visible).toBe(false);
});


test("session input acknowledgements return data without focus or Zen actions", async () => {
  let acknowledgement: any;
  const forbidden = async () => { throw new Error("Must not move focus or Zen mode"); };
  await applyUiAction({ action: "session_input", operation: "inspect", source: "target", requestId: "r", windowId: "w" }, "w", {
    focusSession: forbidden, focusProject: forbidden, setZenMode: forbidden,
    sessionInput: async () => ({ inputState: "draft", draft: { text: "user text" } }),
  }, async result => { acknowledgement = result; });
  expect(acknowledgement).toMatchObject({ ok: true, result: { inputState: "draft", draft: { text: "user text" } } });
});
