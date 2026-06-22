import { apiUrl } from "./api";

export interface CodexAppEvent {
  kind: "notification" | "request";
  id?: string | number;
  method: string;
  params: Record<string, unknown>;
  threadId?: string;
  turnId?: string;
  receivedAt: string;
  seq?: number;
}

export interface CodexLiveToolUse {
  id: string;
  toolName: "exec_command" | "file change";
  toolInput: unknown;
  toolUseId: string;
  inputQuality: number;
}

export type CodexEventStreamState =
  | "connecting"
  | "live"
  | "reconnecting";

interface EventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  addEventListener(type: string, fn: (evt: MessageEvent) => void): void;
  close(): void;
}

type EventSourceConstructor = new (url: string) => EventSourceLike;

interface Subscriber {
  onEvent?: (event: CodexAppEvent) => void;
  onState?: (state: CodexEventStreamState) => void;
}

export function codexEventThreadIdForSession(opts: {
  agent: string;
  mode: string;
  sessionId: string | undefined;
  liveCodexApp: boolean;
}): string | undefined {
  if (opts.agent !== "codex") return undefined;
  if (opts.mode !== "read") return undefined;
  if (!opts.liveCodexApp) return undefined;
  return opts.sessionId || undefined;
}

interface Hub {
  es: EventSourceLike;
  state: CodexEventStreamState;
  subscribers: Set<Subscriber>;
  history: CodexAppEvent[];
}

const hubs = new Map<string, Hub>();
const HISTORY_LIMIT = 1_000;
let eventSourceCtorForTests: EventSourceConstructor | null = null;

function daemonKey(daemonId: string | undefined): string {
  return daemonId ?? "";
}

function eventSourceUrl(daemonId: string | undefined): string {
  return apiUrl("/api/codex-app/events", daemonId);
}

function eventSourceCtor(): EventSourceConstructor {
  const ctor = eventSourceCtorForTests ?? globalThis.EventSource;
  if (!ctor) throw new Error("EventSource is not available");
  return ctor as EventSourceConstructor;
}

function setState(hub: Hub, state: CodexEventStreamState): void {
  hub.state = state;
  for (const subscriber of hub.subscribers) subscriber.onState?.(state);
}

function pushEvent(hub: Hub, event: CodexAppEvent): void {
  hub.history.push(event);
  if (hub.history.length > HISTORY_LIMIT) {
    hub.history.splice(0, hub.history.length - HISTORY_LIMIT);
  }
  for (const subscriber of hub.subscribers) subscriber.onEvent?.(event);
}

function parseEvent(data: unknown): CodexAppEvent | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as CodexAppEvent;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.method !== "string") return null;
    if (parsed.kind !== "notification" && parsed.kind !== "request") return null;
    if (!parsed.params || typeof parsed.params !== "object") return null;
    if (typeof parsed.receivedAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function codexLiveToolUseFromEvent(
  event: CodexAppEvent,
): CodexLiveToolUse | null {
  const itemId = codexEventItemId(event);
  if (!itemId) return null;
  const toolName = codexEventToolName(event.method, event.params);
  if (!toolName) return null;
  const id = `${toolName === "file change" ? "codex-file" : "codex-tool"}-${itemId}`;
  const toolInput =
    toolName === "file change" && event.params.changes !== undefined
      ? event.params.changes
      : codexEventToolInput(event.params);
  return {
    id,
    toolName,
    toolInput,
    toolUseId: itemId,
    inputQuality: codexToolInputQuality(toolInput),
  };
}

export function codexEventItemId(event: CodexAppEvent): string | undefined {
  const item = codexEventItem(event.params);
  return typeof event.params.itemId === "string"
    ? event.params.itemId
    : typeof item?.id === "string"
      ? item.id
    : event.turnId;
}

export function codexToolInputQuality(input: unknown): number {
  if (typeof input === "string") return input.trim() ? 3 : 0;
  if (!input || typeof input !== "object") return 0;
  const record = input as Record<string, unknown>;
  let quality = 0;
  for (const [key, value] of Object.entries(record)) {
    if (
      key === "itemId" ||
      key === "turnId" ||
      key === "delta" ||
      key === "output" ||
      key === "stdout" ||
      key === "stderr"
    ) {
      continue;
    }
    if (value === undefined || value === null || value === "") continue;
    quality += key === "cmd" || key === "command" || key === "changes" ? 2 : 1;
  }
  return quality;
}

function codexEventToolName(
  method: string,
  params?: Record<string, unknown>,
): CodexLiveToolUse["toolName"] | null {
  const item = params ? codexEventItem(params) : undefined;
  if (item?.type === "commandExecution") return "exec_command";
  if (item?.type === "fileChange") return "file change";
  if (method.includes("commandExecution") || method.includes("command/exec")) {
    return "exec_command";
  }
  if (method.includes("process/")) return "exec_command";
  if (method.includes("fileChange")) return "file change";
  return null;
}

function codexEventToolInput(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const item = codexEventItem(params);
  if (item?.type === "commandExecution") {
    return cleanCodexToolInput({
      command: stringField(item, "command"),
      cwd: stringField(item, "cwd"),
      source: stringField(item, "source"),
      commandActions: Array.isArray(item.commandActions)
        ? item.commandActions
        : undefined,
    });
  }
  if (item?.type === "fileChange") {
    return cleanCodexToolInput({
      changes: item.changes,
      cwd: stringField(item, "cwd"),
    });
  }
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (
      key === "delta" ||
      key === "threadId" ||
      key === "turnId" ||
      key === "itemId" ||
      value === undefined
    ) {
      continue;
    }
    input[key] = value;
  }
  return Object.keys(input).length ? input : undefined;
}

function codexEventItem(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return params.item && typeof params.item === "object"
    ? (params.item as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function cleanCodexToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function createHub(daemonId: string | undefined): Hub {
  const es = new (eventSourceCtor())(eventSourceUrl(daemonId));
  const hub: Hub = {
    es,
    state: "connecting",
    subscribers: new Set(),
    history: [],
  };
  es.onopen = () => setState(hub, "live");
  es.onerror = () => setState(hub, "reconnecting");
  es.addEventListener("codex", (msg) => {
    const event = parseEvent(msg.data);
    if (event) pushEvent(hub, event);
  });
  return hub;
}

export function subscribeCodexEvents(
  daemonId: string | undefined,
  subscriber: Subscriber,
): () => void {
  const key = daemonKey(daemonId);
  let hub = hubs.get(key);
  if (!hub) {
    hub = createHub(daemonId);
    hubs.set(key, hub);
  }
  hub.subscribers.add(subscriber);
  subscriber.onState?.(hub.state);
  for (const event of hub.history) subscriber.onEvent?.(event);
  return () => {
    const current = hubs.get(key);
    if (!current) return;
    current.subscribers.delete(subscriber);
    if (current.subscribers.size > 0) return;
    current.es.close();
    hubs.delete(key);
  };
}

export function __setCodexEventSourceCtorForTests(
  ctor: EventSourceConstructor | null,
): void {
  eventSourceCtorForTests = ctor;
}

export function __resetCodexEventStreamsForTests(): void {
  for (const hub of hubs.values()) hub.es.close();
  hubs.clear();
  eventSourceCtorForTests = null;
}
