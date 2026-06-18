import { beforeEach, describe, expect, test } from "bun:test";
import {
  __resetCodexEventStreamsForTests,
  __setCodexEventSourceCtorForTests,
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

  test("shares one EventSource for multiple subscribers on the same daemon", () => {
    const a: CodexAppEvent[] = [];
    const b: CodexAppEvent[] = [];

    const offA = subscribeCodexEvents(undefined, { onEvent: (e) => a.push(e) });
    const offB = subscribeCodexEvents(undefined, { onEvent: (e) => b.push(e) });

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

  test("keeps separate shared streams per daemon", () => {
    subscribeCodexEvents(undefined, { onEvent: () => {} });
    subscribeCodexEvents("remote-1", { onEvent: () => {} });

    expect(FakeEventSource.instances.map((es) => es.url)).toEqual([
      "/api/codex-app/events",
      "/api/daemons/remote-1/codex-app/events",
    ]);
  });

  test("replays hub history to later subscribers", () => {
    const a: CodexAppEvent[] = [];
    const b: CodexAppEvent[] = [];

    subscribeCodexEvents(undefined, { onEvent: (e) => a.push(e) });
    FakeEventSource.instances[0]?.emit("codex", event("t1", 1));
    subscribeCodexEvents(undefined, { onEvent: (e) => b.push(e) });

    expect(a.map((e) => e.seq)).toEqual([1]);
    expect(b.map((e) => e.seq)).toEqual([1]);
  });

  test("reports connection state to each subscriber", () => {
    const states: CodexEventStreamState[] = [];

    subscribeCodexEvents(undefined, { onState: (s) => states.push(s) });
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
});
