import type {
  NativeAgentAdapter,
  NativeAgentRun,
  NativeAgentStartedSession,
  NativeAgentStartRequest,
  NativeAgentTurnRequest,
} from "./native-agent-adapters";

export interface CodexAppServerProcess {
  pid: number;
  stdin: { write(chunk: string): unknown };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<unknown>;
  kill(signal?: string): void;
}

export interface CodexClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface CodexAppServerAdapterOptions {
  spawn?: (cwd: string) => CodexAppServerProcess;
  clientInfo?: CodexClientInfo;
}

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve(value: JsonObject): void;
  reject(err: Error): void;
}

export type CodexAppServerEvent =
  | {
      kind: "notification";
      method: string;
      params: JsonObject;
      threadId?: string;
      turnId?: string;
      receivedAt: string;
      seq: number;
    }
  | {
      kind: "request";
      id: string | number;
      method: string;
      params: JsonObject;
      threadId?: string;
      turnId?: string;
      receivedAt: string;
      seq: number;
    };

export type CodexAppServerListener = (event: CodexAppServerEvent) => void;

export interface CodexTurnStart {
  threadId: string;
  turnId: string;
  completed: Promise<void>;
}

export interface CodexAppServerRequestResponse {
  result?: JsonObject;
  error?: { code?: number; message: string; data?: unknown };
}

export interface CodexModelInfo {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export interface CodexTurnOverrides {
  model?: string;
  approvalPolicy?: unknown;
  sandboxPolicy?: JsonObject;
  effort?: string;
  summary?: string;
}

function defaultSpawn(cwd: string): CodexAppServerProcess {
  const proc = Bun.spawn({
    cmd: ["codex", "app-server"],
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    pid: proc.pid,
    stdin: proc.stdin,
    stdout: proc.stdout,
    exited: proc.exited,
    kill: (signal?: string) =>
      proc.kill(signal as Parameters<typeof proc.kill>[0]),
  };
}

export class CodexAppServerAdapter implements NativeAgentAdapter {
  readonly agent = "codex" as const;

  private readonly spawnProc: (cwd: string) => CodexAppServerProcess;
  private readonly clientInfo: CodexClientInfo;
  private proc: CodexAppServerProcess | null = null;
  private rpc: CodexAppServerRpc | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly loadedThreads = new Set<string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly listeners = new Set<CodexAppServerListener>();
  private readonly history = new Map<string, CodexAppServerEvent[]>();
  private readonly globalHistory: CodexAppServerEvent[] = [];
  private readonly historyLimit = 300;

  constructor(opts: CodexAppServerAdapterOptions = {}) {
    this.spawnProc = opts.spawn ?? defaultSpawn;
    this.clientInfo = opts.clientInfo ?? {
      name: "supergit",
      title: "supergit",
      version: "0.0.0",
    };
  }

  async startSession(
    req: NativeAgentStartRequest,
  ): Promise<NativeAgentStartedSession> {
    const rpc = await this.ensureRpc(req.cwd);
    const result = await rpc.request("thread/start", {
      cwd: req.cwd,
      serviceName: "supergit",
    });
    const sessionId =
      nestedString(result, ["thread", "id"]) ??
      nestedString(result, ["thread", "sessionId"]);
    if (!sessionId) throw new Error("codex app-server did not return thread.id");
    this.loadedThreads.add(sessionId);
    return {
      agent: "codex",
      sessionId,
      cwd: nestedString(result, ["thread", "cwd"]) ?? req.cwd,
      source: nestedString(result, ["thread", "path"]),
      model:
        nestedString(result, ["model"]) ??
        nestedString(result, ["thread", "settings", "model"]),
    };
  }

  sendTurn(req: NativeAgentTurnRequest): NativeAgentRun {
    const started = this.startTurn({
      threadId: req.sessionId,
      cwd: req.cwd,
      text: req.text,
    });
    let turnId: string | undefined;
    const exited = started.then((turn) => {
      turnId = turn.turnId;
      return turn.completed;
    });
    return {
      pid: this.proc?.pid ?? 0,
      exited,
      kill: () => {
        const sid = req.sessionId;
        if (sid && turnId) {
          void this.interruptTurn(sid, turnId);
        } else {
          void started.then((turn) =>
            this.interruptTurn(turn.threadId, turn.turnId),
          );
        }
      },
    };
  }

  async startTurn(req: {
    threadId?: string;
    cwd: string;
    text?: string;
    input?: JsonObject[];
    overrides?: CodexTurnOverrides;
  }): Promise<CodexTurnStart> {
    const rpc = await this.ensureRpc(req.cwd);
    const threadId = req.threadId
      ? await this.ensureThreadLoaded(rpc, req.threadId, req.cwd)
      : await this.startThread(rpc, req.cwd);
    const turn = await rpc.request("turn/start", cleanObject({
      threadId,
      cwd: req.cwd,
      input: req.input ?? textInput(req.text ?? ""),
      model: cleanString(req.overrides?.model),
      approvalPolicy: req.overrides?.approvalPolicy,
      sandboxPolicy: req.overrides?.sandboxPolicy,
      effort: cleanString(req.overrides?.effort),
      summary: cleanString(req.overrides?.summary),
    }));
    const turnId = nestedString(turn, ["turn", "id"]);
    if (!turnId) throw new Error("codex app-server did not return turn.id");
    this.activeTurns.set(threadId, turnId);
    this.emit({
      kind: "notification",
      method: "turn/started",
      params: { threadId, turnId, turn: { id: turnId } },
      threadId,
      turnId,
      receivedAt: new Date().toISOString(),
    });
    const completed = rpc.waitForTurnCompleted(turnId).finally(() => {
      if (this.activeTurns.get(threadId) === turnId) {
        this.activeTurns.delete(threadId);
      }
    });
    return { threadId, turnId, completed };
  }

  async steerTurn(req: {
    threadId: string;
    text?: string;
    input?: JsonObject[];
  }): Promise<{ turnId?: string }> {
    const rpc = await this.ensureRpc(process.cwd());
    const result = await rpc.request("turn/steer", {
      threadId: req.threadId,
      input: req.input ?? textInput(req.text ?? ""),
    });
    return { turnId: nestedString(result, ["turnId"]) };
  }

  async listModels(cwd: string): Promise<CodexModelInfo[]> {
    const rpc = await this.ensureRpc(cwd);
    const models: CodexModelInfo[] = [];
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 10; page++) {
      const result = await rpc.request(
        "model/list",
        cleanObject({ cursor, limit: 100 }),
      );
      const data = Array.isArray(result.data) ? result.data : [];
      for (const raw of data) {
        if (!raw || typeof raw !== "object") continue;
        const obj = raw as Record<string, unknown>;
        const id = cleanString(obj.id);
        if (!id) continue;
        models.push({
          id,
          model: cleanString(obj.model),
          displayName: cleanString(obj.displayName),
          description: cleanString(obj.description),
          isDefault: obj.isDefault === true,
          supportedReasoningEfforts: Array.isArray(
            obj.supportedReasoningEfforts,
          )
            ? obj.supportedReasoningEfforts
                .map((effort) => {
                  if (typeof effort === "string") return cleanString(effort);
                  return effort && typeof effort === "object"
                    ? cleanString(
                        (effort as Record<string, unknown>).reasoningEffort,
                      )
                    : undefined;
                })
                .filter((effort): effort is string => !!effort)
            : undefined,
          defaultReasoningEffort: cleanString(obj.defaultReasoningEffort),
        });
      }
      cursor = cleanString(result.nextCursor) ?? null;
      if (!cursor) break;
    }
    return models;
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    const rpc = await this.ensureRpc(process.cwd());
    const activeTurnId = turnId ?? this.activeTurns.get(threadId);
    if (!activeTurnId) throw new Error("codex turn id required");
    await rpc.request("turn/interrupt", { threadId, turnId: activeTurnId });
  }

  respondToRequest(
    id: string | number,
    response: CodexAppServerRequestResponse,
  ): void {
    const rpc = this.rpc;
    if (!rpc) throw new Error("codex app-server is not running");
    rpc.respond(id, response);
  }

  subscribe(
    threadId: string | undefined,
    listener: CodexAppServerListener,
  ): () => void {
    const filtered = (event: CodexAppServerEvent) => {
      if (!threadId || !event.threadId || event.threadId === threadId) {
        listener(event);
      }
    };
    const replay = threadId ? this.history.get(threadId) : this.globalHistory;
    for (const event of replay ?? []) filtered(event);
    this.listeners.add(filtered);
    return () => {
      this.listeners.delete(filtered);
    };
  }

  activeTurn(threadId: string): string | undefined {
    return this.activeTurns.get(threadId);
  }

  private async ensureRpc(cwd: string): Promise<CodexAppServerRpc> {
    if (this.rpc && this.proc) return this.rpc;
    const proc = this.spawnProc(cwd);
    const rpc = new CodexAppServerRpc(proc);
    this.proc = proc;
    this.rpc = rpc;
    rpc.onEvent((event) => this.emit(event));
    this.initializePromise = this.initialize(rpc);
    void proc.exited.finally(() => {
      if (this.proc === proc) {
        this.proc = null;
        this.rpc = null;
        this.initializePromise = null;
        this.loadedThreads.clear();
        this.activeTurns.clear();
      }
    });
    await this.initializePromise;
    return rpc;
  }

  private async initialize(rpc: CodexAppServerRpc): Promise<void> {
    await rpc.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});
  }

  private async ensureThreadLoaded(
    rpc: CodexAppServerRpc,
    threadId: string,
    cwd: string,
  ): Promise<string> {
    if (this.loadedThreads.has(threadId)) return threadId;
    const result = await rpc.request("thread/resume", { threadId, cwd });
    const id = nestedString(result, ["thread", "id"]) ?? threadId;
    this.loadedThreads.add(id);
    return id;
  }

  private async startThread(
    rpc: CodexAppServerRpc,
    cwd: string,
  ): Promise<string> {
    const result = await rpc.request("thread/start", {
      cwd,
      serviceName: "supergit",
    });
    const threadId = nestedString(result, ["thread", "id"]);
    if (!threadId) throw new Error("codex app-server did not return thread.id");
    this.loadedThreads.add(threadId);
    return threadId;
  }

  private emit(event: CodexAppServerEvent): void {
    this.globalHistory.push(event);
    trim(this.globalHistory, this.historyLimit);
    if (event.threadId) {
      const events = this.history.get(event.threadId) ?? [];
      events.push(event);
      trim(events, this.historyLimit);
      this.history.set(event.threadId, events);
    }
    for (const listener of this.listeners) listener(event);
  }
}

function nestedString(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : undefined;
}

function textInput(text: string): JsonObject[] {
  return [{ type: "text", text, text_elements: [] }];
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cleanObject(obj: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function trim<T>(arr: T[], limit: number): void {
  if (arr.length > limit) arr.splice(0, arr.length - limit);
}

function eventThreadId(msg: JsonObject): string | undefined {
  return (
    nestedString(msg, ["params", "threadId"]) ??
    nestedString(msg, ["params", "thread", "id"]) ??
    nestedString(msg, ["params", "conversationId"])
  );
}

function eventTurnId(msg: JsonObject): string | undefined {
  return (
    nestedString(msg, ["params", "turnId"]) ??
    nestedString(msg, ["params", "turn", "id"])
  );
}

export class CodexAppServerRpc {
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Set<CodexAppServerListener>();
  private eventSeq = 0;
  private readonly completedTurns: (string | undefined)[] = [];
  private readonly turnWaiters: {
    turnId?: string;
    resolve(): void;
    reject(err: Error): void;
  }[] = [];
  private closed = false;

  constructor(private readonly proc: CodexAppServerProcess) {
    void this.pump();
    void proc.exited.then(
      () => this.rejectAll(new Error("codex app-server exited")),
      () => this.rejectAll(new Error("codex app-server exited")),
    );
  }

  onEvent(listener: CodexAppServerListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.closed)
      return Promise.reject(new Error("codex app-server closed"));
    const id = this.nextId++;
    const promise = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  notify(method: string, params: JsonObject): void {
    if (this.closed) return;
    this.write({ method, params });
  }

  respond(
    id: string | number,
    response: CodexAppServerRequestResponse,
  ): void {
    if (this.closed) return;
    if (response.error) {
      this.write({ id, error: response.error });
    } else {
      this.write({ id, result: response.result ?? {} });
    }
  }

  waitForTurnCompleted(turnId?: string): Promise<void> {
    if (
      this.completedTurns.some((id) => turnId === undefined || id === turnId)
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.turnWaiters.push({ turnId, resolve, reject });
    });
  }

  close(): void {
    this.closed = true;
  }

  private write(message: JsonObject): void {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async pump(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, idx).trim();
          buffered = buffered.slice(idx + 1);
          if (line) this.handleLine(line);
        }
      }
    } catch (e) {
      this.rejectAll(e instanceof Error ? e : new Error(String(e)));
    } finally {
      reader.releaseLock();
    }
  }

  private handleLine(line: string): void {
    let msg: JsonObject;
    try {
      msg = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    const id = msg.id;
    const method = typeof msg.method === "string" ? msg.method : undefined;
    if ((typeof id === "number" || typeof id === "string") && method) {
      this.emit({
        kind: "request",
        id,
        method,
        params:
          msg.params && typeof msg.params === "object"
            ? (msg.params as JsonObject)
            : {},
        threadId: eventThreadId(msg),
        turnId: eventTurnId(msg),
        receivedAt: new Date().toISOString(),
        seq: ++this.eventSeq,
      });
      return;
    }
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      const error = msg.error;
      if (error && typeof error === "object") {
        const message =
          typeof (error as JsonObject).message === "string"
            ? ((error as JsonObject).message as string)
            : `codex app-server request ${id} failed`;
        pending.reject(new Error(message));
      } else {
        const result = msg.result;
        pending.resolve(
          result && typeof result === "object" ? (result as JsonObject) : {},
        );
      }
      return;
    }

    if (method) {
      this.emit({
        kind: "notification",
        method,
        params:
          msg.params && typeof msg.params === "object"
            ? (msg.params as JsonObject)
            : {},
        threadId: eventThreadId(msg),
        turnId: eventTurnId(msg),
        receivedAt: new Date().toISOString(),
        seq: ++this.eventSeq,
      });
    }

    if (method === "turn/completed") {
      const turnId = nestedString(msg, ["params", "turn", "id"]);
      this.completedTurns.push(turnId);
      for (let i = this.turnWaiters.length - 1; i >= 0; i--) {
        const waiter = this.turnWaiters[i]!;
        if (waiter.turnId === undefined || waiter.turnId === turnId) {
          this.turnWaiters.splice(i, 1);
          waiter.resolve();
        }
      }
    }
  }

  private emit(event: CodexAppServerEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    for (const waiter of this.turnWaiters.splice(0)) waiter.reject(err);
  }
}
