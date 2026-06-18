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
