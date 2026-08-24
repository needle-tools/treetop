import type {
  NativeAgentAdapter,
  NativeAgentRun,
  NativeAgentStartedSession,
  NativeAgentStartRequest,
  NativeAgentTurnRequest,
} from "./native-agent-adapters";
import { existsSync } from "node:fs";

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

export interface CodexAppServerRecordedFrame {
  seq: number;
  at: string;
  direction: "client" | "server";
  raw: string;
  message: JsonObject;
}

export interface CodexAppServerRecording {
  id: string;
  startedAt: string;
  endedAt?: string;
  frames: CodexAppServerRecordedFrame[];
}

export type CodexAppServerRpcRecorder = (
  frame: Omit<CodexAppServerRecordedFrame, "seq" | "at">,
) => void;

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
  hidden?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  serviceTiers?: { id: string; name?: string; description?: string }[];
  defaultServiceTier?: string;
  additionalSpeedTiers?: string[];
}

export interface CodexTurnOverrides {
  model?: string;
  approvalPolicy?: unknown;
  sandboxPolicy?: JsonObject;
  effort?: string;
  serviceTier?: string;
  summary?: string;
}

export type CodexGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface CodexThreadGoal {
  threadId?: string;
  goalId?: string;
  objective?: string;
  status?: CodexGoalStatus | string;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface CodexThreadReadResult {
  thread: JsonObject;
  model?: string;
  turns?: JsonObject[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export interface CodexRealtimeVoiceStart {
  threadId: string;
  sdp: string;
}

export const DEFAULT_REALTIME_VOICE = "sol";

const VOICE_INSTRUCTIONS =
  "You are Treetop's global voice assistant. Reply briefly, usually in one short sentence. " +
  "Use get_context whenever the current project, session, notes, or Zen mode matters. " +
  "Only focus projects or sessions and change Zen mode when the user asks. " +
  "Use scroll_to when the user asks to show, jump to, or scroll to a session, note, project, worktree, or lane. " +
  "Use read_session_messages to inspect recent session prompts and read_recent_completions to inspect recently completed sessions. " +
  "When the user asks you to tell, ask, reply, continue, or send instructions to an existing agent session, use send_session_message. " +
  "Only create, update, or move notes and stickers when the user explicitly asks for a note, reminder, sticker, or persistent workspace artifact. " +
  "Use move_note to move notes or stickers between semantic areas such as the top area, active project, session, lane, worktree, or workspace; use attachToNoteId only when putting a sticker into a note. " +
  "Do not run shell commands or edit files from voice mode. " +
  "Never claim a UI action succeeded unless its tool response says it did.";

const VOICE_TOOLS: JsonObject[] = [
  {
    type: "function",
    name: "get_context",
    description:
      "Read the current UI context, including active project, active/latest session, Zen mode, projects, open sessions, and recent notes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "focus_project",
    description: "Bring an existing project into view.",
    inputSchema: {
      type: "object",
      properties: { repoId: { type: "string" } },
      required: ["repoId"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "focus_session",
    description:
      "Bring an existing session column into view by source or session id.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        sessionId: { type: "string" },
        id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "scroll_to",
    description:
      "Scroll to a session, note, project, worktree, or lane. Use sessionId/id when the user gives a session id.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["session", "note", "project", "worktree", "lane"],
        },
        id: { type: "string" },
        source: { type: "string" },
        sessionId: { type: "string" },
        title: { type: "string" },
        repoId: { type: "string" },
        worktreePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_session_messages",
    description:
      "Read recent messages and status metadata for an existing session.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        sessionId: { type: "string" },
        title: { type: "string" },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_recent_completions",
    description:
      "Read sessions that recently completed a turn and are waiting for the user to notice.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "send_session_message",
    description:
      "Send a user message into an existing agent session. Omit source to use the active/focused session.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "set_zen_mode",
    description:
      "Turn Zen mode on or off, optionally focusing a specific project when enabling it.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        repoId: { type: "string" },
      },
      required: ["enabled"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_note",
    description:
      "Create a markdown note. When anchors are omitted, it is pinned to the active worktree or project.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        anchors: { type: "array", items: { type: "string" } },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_note",
    description: "Read a full note body by note id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_note",
    description: "Update an existing note body, anchors, or tags by note id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        body: { type: "string" },
        anchors: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "create_sticker",
    description:
      "Create a sticker note. Use a visible emoji, app-icon token, or sticker token as body.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string" },
        anchor: { type: "string" },
      },
      required: ["body"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "move_note",
    description:
      "Move an existing note or sticker by note id to another semantic anchor/top area, or attach a sticker into another note. Use area:'top' for the global top area.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        anchor: { type: "string" },
        anchors: { type: "array", items: { type: "string" } },
        area: {
          type: "string",
          enum: ["top", "top area", "global", "workspace", "active"],
        },
        destination: { type: "string" },
        attachToNoteId: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "move_sticker",
    description:
      "Compatibility alias for moving an existing sticker by note id. Prefer move_note unless the user specifically says sticker.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        anchor: { type: "string" },
        anchors: { type: "array", items: { type: "string" } },
        attachToNoteId: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

function defaultSpawn(cwd: string): CodexAppServerProcess {
  const proc = Bun.spawn({
    cmd: codexAppServerCommand(),
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

export function codexAppServerCommand(binary = resolveCodexBinary()): string[] {
  return [binary, "app-server", "--enable", "realtime_conversation"];
}

export function classifyRealtimeVoiceError(
  message: string,
): { status: 403 | 501; error: string } | null {
  if (
    /method not found|experimentalApi|realtime.*(?:unsupported|not available)|does not support realtime conversation/i.test(
      message,
    )
  ) {
    return {
      status: 501,
      error: "Voice mode is unavailable in this Codex App Server version.",
    };
  }
  if (/voice session access denied/i.test(message)) {
    return {
      status: 403,
      error: "Codex App Server denied this voice session.",
    };
  }
  return null;
}

export function realtimeVoiceStartParams(req: {
  threadId: string;
  sdp: string;
  prompt?: string;
  voice?: string;
}): JsonObject {
  return cleanObject({
    threadId: req.threadId,
    outputModality: "audio",
    includeStartupContext: true,
    prompt: cleanString(req.prompt),
    version: "v3",
    voice: cleanString(req.voice) ?? DEFAULT_REALTIME_VOICE,
    transport: { type: "webrtc", sdp: req.sdp },
  });
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
  private recording: CodexAppServerRecording | null = null;
  private recordingSeq = 0;

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

  async startRealtimeVoice(req: {
    cwd: string;
    sdp: string;
    prompt?: string;
    voice?: string;
  }): Promise<CodexRealtimeVoiceStart> {
    const rpc = await this.ensureRpc(req.cwd);
    const thread = await rpc.request("thread/start", {
      cwd: req.cwd,
      ephemeral: true,
      serviceName: "voice",
      developerInstructions: VOICE_INSTRUCTIONS,
      dynamicTools: VOICE_TOOLS,
    });
    const threadId = nestedString(thread, ["thread", "id"]);
    if (!threadId) {
      throw new Error("codex app-server did not return voice thread.id");
    }
    this.loadedThreads.add(threadId);

    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<string>((resolve, reject) => {
      unsubscribe = this.subscribe(threadId, (event) => {
        if (event.method === "thread/realtime/sdp") {
          const sdp = cleanString(event.params.sdp);
          if (sdp) resolve(sdp);
        } else if (event.method === "thread/realtime/error") {
          reject(
            new Error(
              cleanString(event.params.message) ??
                "Codex realtime voice failed to start",
            ),
          );
        }
      });
      timer = setTimeout(
        () => reject(new Error("timed out waiting for realtime SDP answer")),
        15_000,
      );
    });

    try {
      const [, sdp] = await Promise.all([
        rpc.request(
          "thread/realtime/start",
          realtimeVoiceStartParams({
            threadId,
            prompt: cleanString(req.prompt),
            sdp: req.sdp,
            voice: cleanString(req.voice),
          }),
        ),
        answer,
      ]);
      return { threadId, sdp };
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe();
    }
  }

  async stopRealtimeVoice(threadId: string): Promise<void> {
    const rpc = await this.ensureRpc(process.cwd());
    await rpc.request("thread/realtime/stop", { threadId });
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
      serviceTier: cleanString(req.overrides?.serviceTier),
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
    expectedTurnId: string;
    text?: string;
    input?: JsonObject[];
  }): Promise<{ turnId?: string }> {
    const rpc = await this.ensureRpc(process.cwd());
    const result = await rpc.request("turn/steer", {
      threadId: req.threadId,
      expectedTurnId: req.expectedTurnId,
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
        const supportedReasoningEfforts = Array.isArray(
          obj.supportedReasoningEfforts,
        )
          ? obj.supportedReasoningEfforts
              .map(codexReasoningEffortId)
              .filter((effort): effort is string => !!effort)
          : undefined;
        const serviceTiers = Array.isArray(obj.serviceTiers)
          ? obj.serviceTiers
              .map(codexServiceTier)
              .filter(
                (
                  tier,
                ): tier is {
                  id: string;
                  name?: string;
                  description?: string;
                } => !!tier,
              )
          : undefined;
        const additionalSpeedTiers = Array.isArray(obj.additionalSpeedTiers)
          ? obj.additionalSpeedTiers
              .map(cleanString)
              .filter((tier): tier is string => !!tier)
          : undefined;
        models.push({
          id,
          model: cleanString(obj.model),
          displayName: cleanString(obj.displayName),
          description: cleanString(obj.description),
          isDefault: obj.isDefault === true,
          ...(obj.hidden === true ? { hidden: true } : {}),
          ...(supportedReasoningEfforts
            ? { supportedReasoningEfforts }
            : {}),
          defaultReasoningEffort: cleanString(obj.defaultReasoningEffort),
          ...(serviceTiers ? { serviceTiers } : {}),
          ...(cleanString(obj.defaultServiceTier)
            ? { defaultServiceTier: cleanString(obj.defaultServiceTier) }
            : {}),
          ...(additionalSpeedTiers ? { additionalSpeedTiers } : {}),
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

  async getGoal(threadId: string, cwd: string): Promise<CodexThreadGoal | null> {
    const rpc = await this.ensureRpc(cwd);
    const result = await rpc.request("thread/goal/get", { threadId });
    return codexGoalFromResult(result);
  }

  async setGoal(req: {
    threadId: string;
    cwd: string;
    objective?: string | null;
    status?: CodexGoalStatus | string | null;
    tokenBudget?: number | null;
  }): Promise<CodexThreadGoal | null> {
    const rpc = await this.ensureRpc(req.cwd);
    const result = await rpc.request(
      "thread/goal/set",
      cleanObject({
        threadId: req.threadId,
        objective:
          typeof req.objective === "string" ? req.objective : req.objective,
        status: typeof req.status === "string" ? req.status : req.status,
        tokenBudget:
          typeof req.tokenBudget === "number" ? req.tokenBudget : req.tokenBudget,
      }),
    );
    return codexGoalFromResult(result);
  }

  async clearGoal(threadId: string, cwd: string): Promise<void> {
    const rpc = await this.ensureRpc(cwd);
    await rpc.request("thread/goal/clear", { threadId });
  }

  async readThread(req: {
    threadId: string;
    cwd: string;
    includeTurns?: boolean;
    turnsLimit?: number;
    turnsCursor?: string;
  }): Promise<CodexThreadReadResult> {
    const rpc = await this.ensureRpc(req.cwd);
    const wantsTurnsPage = !!req.turnsLimit && req.turnsLimit > 0;
    let thread: JsonObject | undefined;
    let initialTurnsPage: JsonObject | undefined;
    if (!this.loadedThreads.has(req.threadId)) {
      const resumeResult = await this.resumeThread(rpc, req.threadId, req.cwd, {
        excludeTurns: true,
        initialTurnsPage:
          wantsTurnsPage && !req.turnsCursor
            ? {
                limit: req.turnsLimit,
                sortDirection: "desc",
                itemsView: "full",
              }
            : undefined,
      });
      thread = resumeResult.thread;
      initialTurnsPage = resumeResult.initialTurnsPage;
    }
    if (!wantsTurnsPage || req.turnsCursor || !initialTurnsPage) {
      const result = await rpc.request("thread/read", {
        threadId: req.threadId,
        includeTurns: req.includeTurns === true,
      });
      thread = nestedObject(result, ["thread"]);
    }
    if (!thread) throw new Error("codex app-server did not return thread");
    const model = codexThreadModel(thread);
    if (!wantsTurnsPage) {
      return cleanObject({ thread, model }) as CodexThreadReadResult;
    }
    if (initialTurnsPage && !req.turnsCursor) {
      const turns = Array.isArray(initialTurnsPage.data)
        ? (initialTurnsPage.data.filter(
            (turn): turn is JsonObject => !!turn && typeof turn === "object",
          ) as JsonObject[])
        : [];
      return cleanObject({
        thread,
        model,
        turns,
        nextCursor:
          typeof initialTurnsPage.nextCursor === "string"
            ? initialTurnsPage.nextCursor
            : null,
        backwardsCursor:
          typeof initialTurnsPage.backwardsCursor === "string"
            ? initialTurnsPage.backwardsCursor
            : null,
      }) as CodexThreadReadResult;
    }
    const turnsResult = await rpc.request("thread/turns/list", {
      threadId: req.threadId,
      cursor: req.turnsCursor ?? null,
      limit: req.turnsLimit,
      sortDirection: "desc",
      itemsView: "full",
    });
    const turns = Array.isArray(turnsResult.data)
      ? (turnsResult.data.filter(
          (turn): turn is JsonObject => !!turn && typeof turn === "object",
        ) as JsonObject[])
      : [];
    return cleanObject({
      thread,
      model,
      turns,
      nextCursor:
        typeof turnsResult.nextCursor === "string"
          ? turnsResult.nextCursor
          : null,
      backwardsCursor:
        typeof turnsResult.backwardsCursor === "string"
          ? turnsResult.backwardsCursor
          : null,
    }) as CodexThreadReadResult;
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
      if (!threadId || event.threadId === threadId) {
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

  startRecording(): CodexAppServerRecording {
    this.recording = {
      id: `codex-app-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      startedAt: new Date().toISOString(),
      frames: [],
    };
    this.recordingSeq = 0;
    return this.recordingSnapshot()!;
  }

  recordingSnapshot(): CodexAppServerRecording | null {
    if (!this.recording) return null;
    return {
      ...this.recording,
      frames: this.recording.frames.map((frame) => ({
        ...frame,
        raw: frame.raw,
        message: cloneJsonObject(frame.message),
      })),
    };
  }

  stopRecording(): CodexAppServerRecording | null {
    if (!this.recording) return null;
    const stopped: CodexAppServerRecording = {
      ...this.recordingSnapshot()!,
      endedAt: new Date().toISOString(),
    };
    this.recording = null;
    return stopped;
  }

  private observeTurnLifecycle(event: CodexAppServerEvent): void {
    const threadId = event.threadId;
    if (!threadId) return;

    if (event.method === "turn/started") {
      if (event.turnId) this.activeTurns.set(threadId, event.turnId);
      return;
    }

    if (event.method === "turn/status") {
      if (event.params.active === true && event.turnId) {
        this.activeTurns.set(threadId, event.turnId);
      } else if (event.params.active === false) {
        const currentTurnId = this.activeTurns.get(threadId);
        if (!event.turnId || currentTurnId === event.turnId) {
          this.activeTurns.delete(threadId);
        }
      }
      return;
    }

    if (event.method === "turn/completed") {
      const currentTurnId = this.activeTurns.get(threadId);
      if (!event.turnId || currentTurnId === event.turnId) {
        this.activeTurns.delete(threadId);
      }
    }
  }

  private async ensureRpc(cwd: string): Promise<CodexAppServerRpc> {
    if (this.rpc && this.proc) return this.rpc;
    const proc = this.spawnProc(cwd);
    const rpc = new CodexAppServerRpc(proc, (frame) =>
      this.recordRpcFrame(frame),
    );
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
    return (await this.resumeThread(rpc, threadId, cwd)).threadId;
  }

  private async resumeThread(
    rpc: CodexAppServerRpc,
    threadId: string,
    cwd: string,
    options: JsonObject = {},
  ): Promise<{
    threadId: string;
    thread?: JsonObject;
    initialTurnsPage?: JsonObject;
  }> {
    if (this.loadedThreads.has(threadId)) return { threadId };
    const result = await rpc.request(
      "thread/resume",
      cleanObject({ threadId, cwd, ...options }),
    );
    const id = nestedString(result, ["thread", "id"]) ?? threadId;
    this.loadedThreads.add(id);
    return {
      threadId: id,
      thread: nestedObject(result, ["thread"]),
      initialTurnsPage: nestedObject(result, ["initialTurnsPage"]),
    };
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
    this.observeTurnLifecycle(event);
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

  private recordRpcFrame(
    frame: Omit<CodexAppServerRecordedFrame, "seq" | "at">,
  ): void {
    if (!this.recording) return;
    this.recording.frames.push({
      seq: ++this.recordingSeq,
      at: new Date().toISOString(),
      direction: frame.direction,
      raw: frame.raw,
      message: cloneJsonObject(frame.message),
    });
  }
}

export function resolveCodexBinary(): string {
  const envPath = cleanString(process.env.CODEX_CLI_PATH);
  if (envPath && existsSync(envPath)) return envPath;
  const chatGptBundledCodex =
    "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (existsSync(chatGptBundledCodex)) return chatGptBundledCodex;
  return "codex";
}

function nestedString(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : undefined;
}

function nestedObject(obj: unknown, path: string[]): JsonObject | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur && typeof cur === "object" ? (cur as JsonObject) : undefined;
}

function nestedNumber(obj: unknown, path: string[]): number | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : undefined;
}

function textInput(text: string): JsonObject[] {
  return [{ type: "text", text, text_elements: [] }];
}

function codexThreadModel(thread: JsonObject): string | undefined {
  return (
    nestedString(thread, ["settings", "model"]) ??
    nestedString(thread, ["model"])
  );
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

function cloneJsonObject(obj: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(obj)) as JsonObject;
}

function codexReasoningEffortId(effort: unknown): string | undefined {
  if (typeof effort === "string") return cleanString(effort);
  if (!effort || typeof effort !== "object") return undefined;
  const obj = effort as Record<string, unknown>;
  return cleanString(obj.reasoningEffort) ?? cleanString(obj.effort);
}

function codexServiceTier(
  tier: unknown,
): { id: string; name?: string; description?: string } | undefined {
  if (typeof tier === "string") {
    const id = cleanString(tier);
    return id ? { id } : undefined;
  }
  if (!tier || typeof tier !== "object") return undefined;
  const obj = tier as Record<string, unknown>;
  const id = cleanString(obj.id) ?? cleanString(obj.serviceTier);
  if (!id) return undefined;
  return {
    id,
    name: cleanString(obj.name) ?? cleanString(obj.displayName),
    description: cleanString(obj.description),
  };
}

function codexGoalFromResult(result: JsonObject): CodexThreadGoal | null {
  const goal =
    nestedObject(result, ["goal"]) ??
    nestedObject(result, ["threadGoal"]) ??
    nestedObject(result, ["thread", "goal"]);
  if (!goal) return null;
  const tokenBudget =
    typeof goal.tokenBudget === "number" || goal.tokenBudget === null
      ? goal.tokenBudget
      : undefined;
  return {
    threadId: cleanString(goal.threadId),
    goalId: cleanString(goal.goalId),
    objective: cleanString(goal.objective),
    status: cleanString(goal.status),
    tokenBudget,
    tokensUsed:
      nestedNumber(goal, ["tokensUsed"]) ?? nestedNumber(goal, ["tokens_used"]),
    timeUsedSeconds:
      nestedNumber(goal, ["timeUsedSeconds"]) ??
      nestedNumber(goal, ["time_used_seconds"]),
    createdAt:
      nestedNumber(goal, ["createdAt"]) ?? nestedNumber(goal, ["createdAtMs"]),
    updatedAt:
      nestedNumber(goal, ["updatedAt"]) ?? nestedNumber(goal, ["updatedAtMs"]),
  };
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

  constructor(
    private readonly proc: CodexAppServerProcess,
    private readonly recorder?: CodexAppServerRpcRecorder,
  ) {
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
    const raw = JSON.stringify(message);
    this.recorder?.({ direction: "client", raw, message });
    this.proc.stdin.write(`${raw}\n`);
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
    this.recorder?.({ direction: "server", raw: line, message: msg });
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
