import { sessionAgentUsageFromMessages, type SessionAgentUsage } from "@treetop/nicifier";
import { apiUrl, withRequestDeadline } from "./api";
import { codexAppHistoryMessagesFromThread, codexAppHistoryTurnIds, type CodexAppSessionTransport, type CodexAppThreadPage } from "./codex-event-stream";

export type SubagentUsageLoader = (id: string) => Promise<SessionAgentUsage>;

/** Owns one session/source generation; refreshes are serial and never open/resume child runs. */
export function createSubagentUsageTracker(load: SubagentUsageLoader, changed: (usage: ReadonlyMap<string, SessionAgentUsage>, errors: ReadonlyMap<string, string>) => void, parentId?: string) {
  const usage = new Map<string, SessionAgentUsage>();
  const errors = new Map<string, string>();
  let stopped = false;
  let running = false;
  const pending = new Set<string>();
  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (pending.size && !stopped) {
        const id = pending.values().next().value!;
        pending.delete(id);
        if (id === parentId) continue;
        try {
          const next = await load(id);
          if (stopped) return;
          usage.set(id, next);
          errors.delete(id);
          for (const child of next.childIds) if (child !== parentId && !usage.has(child) && !errors.has(child)) pending.add(child);
        } catch (error) {
          if (stopped) return;
          errors.set(id, error instanceof Error ? error.message : String(error));
        }
        changed(new Map(usage), new Map(errors));
      }
    } finally { running = false; }
  }
  return {
    ensure(ids: readonly string[], refresh = false) {
      for (const id of ids) if (refresh || (!usage.has(id) && !errors.has(id))) pending.add(id);
      void drain();
    },
    stop() { stopped = true; pending.clear(); },
  };
}

/** Live reads app-server only; transcript mode reads compact transcript usage only. */
export function createDaemonSubagentUsageLoader(options: { live: boolean; cwd: string; daemonId?: string; transport?: CodexAppSessionTransport }): SubagentUsageLoader {
  const history = new Map<string, Map<string, Record<string, unknown>>>();
  const descendants = new Map<string, Map<string, readonly string[]>>();
  const turnIds = new Map<string, Set<string>>();
  async function json(url: string) {
    return withRequestDeadline(30_000, async signal => {
      const response = await fetch(apiUrl(url, options.daemonId), { signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    });
  }
  return async id => {
    if (!options.live) {
      const resolved = await json(`/api/session/resolve?${new URLSearchParams({ agent: "codex", id })}`);
      if (!resolved.source) throw new Error("Child transcript not found");
      return await json(`/api/session/usage?${new URLSearchParams({ source: resolved.source })}`) as SessionAgentUsage;
    }
    const known = turnIds.get(id) ?? new Set<string>();
    const turns = new Map(history.get(id));
    const childrenByTurn = new Map(descendants.get(id));
    const nextIds = new Set(known);
    let startedAt: string | undefined;
    let cursor: string | null = null;
    let model: string | undefined;
    do {
      const request = { threadId: id, cwd: options.cwd, limit: 100, cursor };
      const page: CodexAppThreadPage = options.transport
        ? await options.transport.readThread(request)
        : await json(`/api/codex-app/thread?${new URLSearchParams({ threadId: id, cwd: options.cwd, limit: "100", ...(cursor ? { cursor } : {}) })}`);
      if (!page.thread || typeof page.thread !== "object" || (page.thread as { id?: string }).id !== id) throw new Error("Child app-server history is not available from this source");
      if (typeof page.model === "string") model ??= page.model;
      const ids = codexAppHistoryTurnIds(page.thread);
      const createdAt = page.thread && typeof page.thread === "object" ? (page.thread as { createdAt?: number }).createdAt : undefined;
      if (typeof createdAt === "number") startedAt = new Date(createdAt * 1000).toISOString();
      const overlap = [...ids].some(turn => known.has(turn));
      for (const turn of ids) nextIds.add(turn);
      // A returned turn replaces that turn's snapshot, including removed/corrected items.
      // Normalize chronologically once across page boundaries so cumulative usage has
      // the same baseline as the existing app-server history path.
      const pageMessages = codexAppHistoryMessagesFromThread(page.thread, { model });
      const usageIds = new Set(pageMessages.filter(message => message.tokenUsage).map(message => message.id));
      for (const turn of (page.thread as { turns?: Record<string, unknown>[] }).turns ?? []) {
        if (typeof turn.id !== "string") continue;
        const items = Array.isArray(turn.items) ? turn.items as Record<string, unknown>[] : [];
        // Retain usage checkpoints, not megabytes of tool output/images. This is
        // accounting state, not a second conversation/history renderer.
        turns.set(turn.id, { ...turn, items: items.filter(item => usageIds.has(`codex-usage-${item.id ?? item.call_id ?? turn.id}`)) });
        childrenByTurn.set(turn.id, sessionAgentUsageFromMessages(pageMessages.filter(message => message.turnId === turn.id)).childIds);
      }
      cursor = !overlap && typeof page.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor);
    history.set(id, turns);
    descendants.set(id, childrenByTurn);
    turnIds.set(id, nextIds);
    const result = sessionAgentUsageFromMessages(codexAppHistoryMessagesFromThread({ id, turns: [...turns.values()].sort((a, b) => Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0)) }, { model }));
    return { ...result, childIds: [...new Set([...childrenByTurn.values()].flat())], startedAt, complete: result.segments.length > 0 };
  };
}
