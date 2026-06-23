import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetCodexEventStreamsForTests,
  __setCodexEventSourceCtorForTests,
  codexLiveToolUseFromEvent,
  codexToolInputQuality,
  codexEventThreadIdForSession,
  subscribeCodexEvents,
  type CodexAppEvent,
  type CodexEventStreamState,
} from "../src/codex-event-stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, Array<(evt: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (evt: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function event(threadId: string, seq: number): CodexAppEvent {
  return {
    kind: "notification",
    method: "turn/status",
    params: { active: true },
    threadId,
    receivedAt: "2026-06-18T00:00:00.000Z",
    seq,
  };
}

describe("codex event stream hub", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    __resetCodexEventStreamsForTests();
    __setCodexEventSourceCtorForTests(FakeEventSource);
  });

  test("shares one EventSource for multiple subscribers on the same daemon and thread", () => {
    const a: CodexAppEvent[] = [];
    const b: CodexAppEvent[] = [];

    const offA = subscribeCodexEvents(undefined, "t1", {
      onEvent: (e) => a.push(e),
    });
    const offB = subscribeCodexEvents(undefined, "t1", {
      onEvent: (e) => b.push(e),
    });

    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/codex-app/events");

    FakeEventSource.instances[0]?.emit("codex", event("t1", 1));
    expect(a.map((e) => e.seq)).toEqual([1]);
    expect(b.map((e) => e.seq)).toEqual([1]);

    offA();
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
    offB();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });

  test("keeps one shared stream per daemon, not per thread", () => {
    subscribeCodexEvents(undefined, "t1", { onEvent: () => {} });
    subscribeCodexEvents(undefined, "t2", { onEvent: () => {} });
    subscribeCodexEvents("remote-1", "t1", { onEvent: () => {} });

    expect(FakeEventSource.instances.map((es) => es.url)).toEqual([
      "/api/codex-app/events",
      "/api/daemons/remote-1/codex-app/events",
    ]);
  });

  test("filters shared daemon events by subscriber thread", () => {
    const a: CodexAppEvent[] = [];
    const b: CodexAppEvent[] = [];

    subscribeCodexEvents(undefined, "t1", { onEvent: (e) => a.push(e) });
    subscribeCodexEvents(undefined, "t2", { onEvent: (e) => b.push(e) });

    expect(FakeEventSource.instances.length).toBe(1);
    FakeEventSource.instances[0]?.emit("codex", event("t1", 1));
    FakeEventSource.instances[0]?.emit("codex", event("t2", 2));
    FakeEventSource.instances[0]?.emit("codex", {
      kind: "notification",
      method: "mcpServer/startupStatus/updated",
      params: { name: "server", status: "starting" },
      receivedAt: "2026-06-18T00:00:00.000Z",
      seq: 3,
    });

    expect(a.map((e) => e.seq)).toEqual([1]);
    expect(b.map((e) => e.seq)).toEqual([2]);
  });

  test("replays hub history to later subscribers", () => {
    const a: CodexAppEvent[] = [];
    const b: CodexAppEvent[] = [];

    subscribeCodexEvents(undefined, "t1", { onEvent: (e) => a.push(e) });
    FakeEventSource.instances[0]?.emit("codex", event("t1", 1));
    FakeEventSource.instances[0]?.emit("codex", event("t2", 2));
    subscribeCodexEvents(undefined, "t1", { onEvent: (e) => b.push(e) });

    expect(a.map((e) => e.seq)).toEqual([1]);
    expect(b.map((e) => e.seq)).toEqual([1]);
  });

  test("reports connection state to each subscriber", () => {
    const states: CodexEventStreamState[] = [];

    subscribeCodexEvents(undefined, "t1", { onState: (s) => states.push(s) });
    FakeEventSource.instances[0]?.onopen?.();
    FakeEventSource.instances[0]?.onerror?.();

    expect(states).toEqual(["connecting", "live", "reconnecting"]);
  });

  test("opens app-server events only for live Codex app read sessions", () => {
    expect(
      codexEventThreadIdForSession({
        agent: "codex",
        mode: "read",
        sessionId: "thread-1",
        liveCodexApp: true,
      }),
    ).toBe("thread-1");
    expect(
      codexEventThreadIdForSession({
        agent: "codex",
        mode: "read",
        sessionId: "historical-codex-jsonl",
        liveCodexApp: false,
      }),
    ).toBeUndefined();
    expect(
      codexEventThreadIdForSession({
        agent: "codex",
        mode: "terminal",
        sessionId: "thread-1",
        liveCodexApp: true,
      }),
    ).toBeUndefined();
  });

  test("normalizes live command item events into paired tool-use rows", () => {
    const start: CodexAppEvent = {
      kind: "notification",
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          id: "call-1",
          command: "/bin/zsh -lc 'rg visual transcript packages/ui/src'",
          cwd: "/repo",
          processId: "123",
          status: "inProgress",
          aggregatedOutput: null,
        },
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };
    const output: CodexAppEvent = {
      kind: "notification",
      method: "item/commandExecution/outputDelta",
      params: { itemId: "call-1", delta: "stdout chunk" },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:01.000Z",
    };

    expect(codexLiveToolUseFromEvent(start)).toEqual({
      id: "codex-tool-call-1",
      toolName: "exec_command",
      toolInput: {
        command: "/bin/zsh -lc 'rg visual transcript packages/ui/src'",
        cwd: "/repo",
      },
      toolUseId: "call-1",
      inputQuality: 3,
    });
    expect(codexLiveToolUseFromEvent(output)).toEqual({
      id: "codex-tool-call-1",
      toolName: "exec_command",
      toolInput: undefined,
      toolUseId: "call-1",
      inputQuality: 0,
    });
    expect(
      codexToolInputQuality(codexLiveToolUseFromEvent(start)?.toolInput),
    ).toBeGreaterThan(
      codexToolInputQuality(codexLiveToolUseFromEvent(output)?.toolInput),
    );
  });

  test("normalizes command approval request payloads as command input", () => {
    const request: CodexAppEvent = {
      kind: "request",
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "call-2",
        command: "bun test",
        cwd: "/repo",
        threadId: "thread-1",
        turnId: "turn-1",
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };

    expect(codexLiveToolUseFromEvent(request)).toEqual({
      id: "codex-tool-call-2",
      toolName: "exec_command",
      toolInput: {
        command: "bun test",
        cwd: "/repo",
      },
      toolUseId: "call-2",
      inputQuality: 3,
    });
  });

  test("normalizes live file-change events without dropping the patch payload", () => {
    const event: CodexAppEvent = {
      kind: "notification",
      method: "item/fileChange/patchUpdated",
      params: {
        itemId: "patch-1",
        changes: [{ path: "packages/ui/src/SessionView.svelte" }],
      },
      turnId: "turn-1",
      receivedAt: "2026-06-22T10:00:00.000Z",
    };

    expect(codexLiveToolUseFromEvent(event)).toEqual({
      id: "codex-file-patch-1",
      toolName: "file change",
      toolInput: [{ path: "packages/ui/src/SessionView.svelte" }],
      toolUseId: "patch-1",
      inputQuality: 1,
    });
  });
});
