import type {
  CodexAppServerAdapter,
  CodexAppServerEvent,
} from "./codex-app-server";

type Transport = {
  request(method: string, args?: unknown): Promise<any>;
  onNative(listener: (value: any) => void): () => void;
};

/** App-server ownership stays in the broker; a daemon only forwards API/events. */
export class BrokerCodexAdapter {
  readonly agent = "codex" as const;
  private listeners = new Set<{
    threadId?: string;
    listener: (event: CodexAppServerEvent) => void;
  }>();
  private history: CodexAppServerEvent[] = [];
  private active = new Map<string, string>();
  private dispose: () => void;
  constructor(private transport: Transport) {
    this.dispose = transport.onNative((value) => {
      if (value.kind === "state") {
        const known = new Set(
          this.history.map(
            (event) => `${event.seq}:${event.receivedAt}:${event.method}`,
          ),
        );
        const recovered: CodexAppServerEvent[] = value.events ?? [];
        for (const event of recovered)
          if (!known.has(`${event.seq}:${event.receivedAt}:${event.method}`)) {
            for (const { threadId, listener } of this.listeners)
              if (!threadId || threadId === event.threadId) listener(event);
          }
        this.history = recovered;
        this.active = new Map(value.activeTurns ?? []);
        return;
      }
      if (value.kind !== "codex") return;
      const event = value.value as CodexAppServerEvent;
      if (event.threadId) {
        if (
          (event.method === "turn/started" ||
            (event.method === "turn/status" && event.params.active === true)) &&
          event.turnId
        )
          this.active.set(event.threadId, event.turnId);
        if (
          (event.method === "turn/completed" ||
            (event.method === "turn/status" &&
              event.params.active === false)) &&
          (!event.turnId || this.active.get(event.threadId) === event.turnId)
        )
          this.active.delete(event.threadId);
      }
      this.history.push(event);
      if (this.history.length > 300) this.history.shift();
      for (const { threadId, listener } of this.listeners)
        if (!threadId || threadId === event.threadId) listener(event);
    });
  }
  private invoke(method: string, args: any[]) {
    return this.transport.request("codex", { method, args });
  }
  startSession: CodexAppServerAdapter["startSession"] = (...args) =>
    this.invoke("startSession", args);
  startRealtimeVoice: CodexAppServerAdapter["startRealtimeVoice"] = (...args) =>
    this.invoke("startRealtimeVoice", args);
  appendRealtimeSpeech: CodexAppServerAdapter["appendRealtimeSpeech"] = (
    ...args
  ) => this.invoke("appendRealtimeSpeech", args);
  stopRealtimeVoice: CodexAppServerAdapter["stopRealtimeVoice"] = (...args) =>
    this.invoke("stopRealtimeVoice", args);
  steerTurn: CodexAppServerAdapter["steerTurn"] = (...args) =>
    this.invoke("steerTurn", args);
  listModels: CodexAppServerAdapter["listModels"] = (...args) =>
    this.invoke("listModels", args);
  interruptTurn: CodexAppServerAdapter["interruptTurn"] = (...args) =>
    this.invoke("interruptTurn", args);
  getGoal: CodexAppServerAdapter["getGoal"] = (...args) =>
    this.invoke("getGoal", args);
  setGoal: CodexAppServerAdapter["setGoal"] = (...args) =>
    this.invoke("setGoal", args);
  clearGoal: CodexAppServerAdapter["clearGoal"] = (...args) =>
    this.invoke("clearGoal", args);
  archiveThread: CodexAppServerAdapter["archiveThread"] = (...args) =>
    this.invoke("archiveThread", args);
  readThread: CodexAppServerAdapter["readThread"] = (...args) =>
    this.invoke("readThread", args);
  respondToRequest(
    ...args: Parameters<CodexAppServerAdapter["respondToRequest"]>
  ) {
    return this.invoke("respondToRequest", args);
  }
  startRecording() {
    return this.invoke("startRecording", []);
  }
  recordingSnapshot() {
    return this.invoke("recordingSnapshot", []);
  }
  stopRecording() {
    return this.invoke("stopRecording", []);
  }
  enforceRecordingRetention() {
    return this.invoke("enforceRecordingRetention", []);
  }
  activeTurn(threadId: string) {
    return this.active.get(threadId);
  }
  subscribe(
    threadId: string | undefined,
    listener: (event: CodexAppServerEvent) => void,
    options: { replay?: boolean } = {},
  ) {
    if (options.replay !== false)
      for (const event of this.history)
        if (!threadId || event.threadId === threadId) listener(event);
    const subscription = { threadId, listener };
    this.listeners.add(subscription);
    return () => {
      this.listeners.delete(subscription);
    };
  }
  startTurn: CodexAppServerAdapter["startTurn"] = async (...args) => {
    const turn = await this.invoke("startTurn", args);
    let unsubscribe = () => {};
    const completed = new Promise<void>((resolve) => {
      unsubscribe = this.subscribe(turn.threadId, (event) => {
        if (
          (event.method === "turn/completed" && event.turnId === turn.turnId) ||
          (event.method === "turn/status" &&
            event.params.active === false &&
            (!event.turnId || event.turnId === turn.turnId))
        ) {
          resolve();
          queueMicrotask(() => unsubscribe());
        }
      });
    });
    return { ...turn, completed };
  };
  sendTurn: CodexAppServerAdapter["sendTurn"] = (req) => {
    let turnId: string | undefined;
    const started = this.startTurn({
      threadId: req.sessionId,
      cwd: req.cwd,
      text: req.text,
    }).then((turn) => {
      turnId = turn.turnId;
      return turn;
    });
    return {
      pid: 0,
      exited: started.then((turn) => turn.completed),
      kill: () => {
        void started.then((turn) => this.interruptTurn(turn.threadId, turnId));
      },
    };
  };
  async close() {
    this.dispose();
    this.listeners.clear();
  }
}
