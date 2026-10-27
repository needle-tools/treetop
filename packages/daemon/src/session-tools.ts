import { resolve } from "node:path";
import type { AgentSession } from "./agents";
import type { NormalizedMessage } from "./sessions";
import type { PtyBackend, TerminalHandle } from "./terminals/types";
import { DecPrivateModeTracker } from "./dec-private-modes";

/** Single-use receipts: intervening human input invalidates explicit submission. */
export class TerminalMessageDrafts {
  private drafts = new Map<
    string,
    {
      source: string;
      terminalId: string;
      revision: number;
      createdAt: number;
      text?: string;
    }
  >();
  private pending = new Set<string>();
  inspect(
    backend: Pick<PtyBackend, "list" | "get">,
    session: AgentSession,
    maxChars = 6000,
  ): Record<string, unknown> | undefined {
    const target = terminalTarget(backend, session);
    if (!target) return undefined;
    const entry = [...this.drafts].find(
      ([, draft]) =>
        draft.source === session.source && draft.terminalId === target.id,
    );
    const draft = entry?.[1];
    return {
      delivery: "terminal",
      terminalId: target.id,
      inputState: "unknown",
      queueState: "unknown",
      reason:
        "CLI-owned input and queue cannot be read reliably. Injected text appends at the current cursor; it does not replace or clear existing text.",
      ...(draft
        ? {
            injectedDraft: {
              draftId: entry![0],
              author: "ai",
              text: (draft.text ?? "").slice(0, maxChars),
              truncated: (draft.text?.length ?? 0) > maxChars,
              inputChanged: target.handle.inputRevision?.() !== draft.revision,
              expired: Date.now() - draft.createdAt > 300_000,
            },
          }
        : {}),
    };
  }
  async deliver(
    backend: Pick<PtyBackend, "list" | "get">,
    session: AgentSession,
    text: string,
    action: "stage" | "submit" | "send",
    draftId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    const target = terminalTarget(backend, session);
    if (!target) return undefined;
    if (this.pending.has(target.id))
      throw new Error("A message is already being injected into this terminal");
    this.pending.add(target.id);
    try {
      if (action === "submit") {
        const draft = this.drafts.get(draftId ?? "");
        if (
          !draft ||
          draft.terminalId !== target.id ||
          draft.source !== session.source
        )
          throw new Error("Draft not found for this session");
        if (draft.text !== text)
          throw new Error("Submit text must match the staged text");
        return this.submit(draftId!, session.source, target.handle);
      }
      this.assertCanStage(session.source, backend);
      if (!target.handle.inputRevision)
        throw new Error("Terminal does not support tracked message injection");
      const delivery = await sendTerminalSessionMessage(
        backend,
        session,
        text,
        false,
      );
      const id = this.stage(session.source, target.id, target.handle, text);
      if (action === "stage")
        return {
          ...delivery,
          draftId: id,
          inputState: "unknown",
          next: "AI-filled text was appended at the CLI cursor without Enter. Review it, then press Enter or explicitly submit this draft_id with the same text.",
        };
      await new Promise((resolve) => setTimeout(resolve, 150));
      return this.submit(id, session.source, target.handle);
    } finally {
      this.pending.delete(target.id);
    }
  }
  assertCanStage(source: string, backend: Pick<PtyBackend, "get">): void {
    for (const [id, draft] of this.drafts) {
      if (draft.source !== source) continue;
      const handle = backend.get(draft.terminalId);
      if (handle?.isAlive() && handle.inputRevision?.() === draft.revision)
        throw new Error(
          "This session already has a staged draft; review or submit it instead of pasting again",
        );
      this.drafts.delete(id);
    }
  }
  stage(
    source: string,
    terminalId: string,
    handle: TerminalHandle,
    text?: string,
  ): string {
    if (!handle.inputRevision)
      throw new Error(
        "Terminal does not support safe draft submission; press Enter manually",
      );
    for (const [id, draft] of this.drafts)
      if (
        Date.now() - draft.createdAt > 300_000 ||
        draft.terminalId === terminalId
      )
        this.drafts.delete(id);
    const id = crypto.randomUUID();
    this.drafts.set(id, {
      source,
      text,
      terminalId,
      revision: handle.inputRevision(),
      createdAt: Date.now(),
    });
    return id;
  }
  terminalId(id: string): string | undefined {
    return this.drafts.get(id)?.terminalId;
  }
  submit(id: string, source: string, handle: TerminalHandle) {
    const draft = this.drafts.get(id);
    if (!draft || draft.source !== source)
      throw new Error("Draft not found for this session");
    this.drafts.delete(id);
    if (
      Date.now() - draft.createdAt > 300_000 ||
      !handle.isAlive() ||
      handle.inputRevision?.() !== draft.revision
    )
      throw new Error(
        "Draft expired or terminal input changed; inspect the terminal before trying again",
      );
    assertTerminalMessageReady(handle);
    handle.write("\r");
    return {
      delivery: "terminal",
      terminalId: draft.terminalId,
      status: "submitted",
      confirmed: false,
    };
  }
}

export function recentSessionMessages(
  messages: NormalizedMessage[],
  options: {
    limit: number;
    offset: number;
    maxChars: number;
    verbose: boolean;
  },
) {
  const readable = messages.flatMap((message) => {
    if (!options.verbose && !["user", "assistant"].includes(message.role))
      return [];
    const text = message.blocks
      .flatMap((block) => {
        if (block.type === "thinking") return [];
        if (block.type === "text") return [block.text ?? ""];
        if (!options.verbose) return [];
        return [
          `[${block.type}${block.toolName ? `: ${block.toolName}` : ""}] ${block.text ?? block.title ?? ""}`,
        ];
      })
      .join("\n")
      .trim();
    return text
      ? [
          {
            role: message.role,
            text,
            ...(message.timestamp ? { timestamp: message.timestamp } : {}),
          },
        ]
      : [];
  });
  const end = Math.max(0, readable.length - options.offset);
  const selected = readable.slice(Math.max(0, end - options.limit), end);
  let remaining = options.maxChars;
  let truncated = false;
  // Keep the most recent text first when the total character budget is tight.
  const result = selected
    .reverse()
    .map((message) => {
      const text = message.text.slice(0, remaining);
      const shortened = text.length < message.text.length;
      truncated ||= shortened;
      remaining -= text.length;
      return { ...message, text, ...(shortened ? { truncated: true } : {}) };
    })
    .reverse();
  return { messages: result, hasMore: end > options.limit, truncated };
}

function samePath(a: string, b: string) {
  return process.platform === "win32"
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
}

/** Persisted native column settings travel with the target session. */
export function openCodexMessageTarget(
  prefs: Record<string, string>,
  session: AgentSession,
): Record<string, unknown> {
  if (session.agent !== "codex" || !session.sessionId)
    throw new Error("A Codex session ID is required");
  const open = JSON.parse(prefs["supergit:openSessions"] ?? "{}") as Record<
    string,
    Array<Record<string, unknown>>
  >;
  const targets = Object.values(open)
    .flat()
    .filter(
      (entry) =>
        entry.agent === "codex" &&
        (entry.source === session.source ||
          entry.transcriptSource === session.source ||
          entry.resumeSessionId === session.sessionId ||
          entry.source === `__codex_app__:${session.sessionId}`),
    );
  const native = targets.filter(
    (entry) => entry.mode !== "terminal" && entry.visualAppStopped !== true,
  );
  if (!native.length && targets.length)
    throw new Error(
      "Session is open as a terminal or stopped chat but has no matching live PTY. Resume its terminal before sending; focusing alone does not resume it.",
    );
  if (native.length !== 1)
    throw new Error(
      "Native session must be open in exactly one Treetop column before sending",
    );
  return native[0]!;
}

/** Returns undefined only when there is no matching live PTY. Never spawn a process. */
export async function sendTerminalSessionMessage(
  backend: Pick<PtyBackend, "list" | "get">,
  session: AgentSession,
  text: string,
  submit = true,
): Promise<
  | {
      delivery: "terminal";
      terminalId: string;
      status: "staged" | "submitted";
      confirmed: false;
    }
  | undefined
> {
  const target = terminalTarget(backend, session);
  if (!target) return undefined;
  const handle = target.handle;
  assertTerminalMessageReady(handle);
  handle.write(`\x1b[200~${text}\x1b[201~`);
  if (!submit)
    return {
      delivery: "terminal",
      terminalId: target.id,
      status: "staged",
      confirmed: false,
    };
  const revision = handle.inputRevision?.();
  // Let the TUI consume the paste before submitting it as a user message.
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (!handle.isAlive())
    throw new Error("Session exited before the message could be submitted");
  if (revision !== undefined && handle.inputRevision?.() !== revision)
    throw new Error(
      "Terminal input changed after paste; inspect the draft before submitting",
    );
  assertTerminalMessageReady(handle);
  handle.write("\r");
  return {
    delivery: "terminal",
    terminalId: target.id,
    status: "submitted",
    confirmed: false,
  };
}

function terminalTarget(
  backend: Pick<PtyBackend, "list" | "get">,
  session: AgentSession,
) {
  if (!session.sessionId || !["claude", "codex"].includes(session.agent))
    return undefined;
  const matches = backend
    .list()
    .filter(
      (record) =>
        !record.exitedAt &&
        record.ownerId === session.sessionId &&
        record.agent === session.agent &&
        samePath(record.cwd, session.cwd),
    );
  if (!matches.length) return undefined;
  if (matches.length > 1)
    throw new Error(
      "Session has multiple live terminals; close the duplicate before sending",
    );
  const handle = backend.get(matches[0]!.id);
  if (!handle?.isAlive())
    throw new Error("Session terminal is no longer running");
  return { id: matches[0]!.id, handle };
}

function assertTerminalMessageReady(handle: TerminalHandle): void {
  const modes = new DecPrivateModeTracker();
  let awaiting = false;
  // Subscribe replays current DEC modes and state synchronously, just as a
  // renderer reattach does. Busy TUIs can accept drafts/queues; approval prompts cannot.
  const unsubscribe = handle.subscribe({
    onData: (bytes) => modes.observe(bytes),
    onExit: () => {},
    onState: (state) => {
      awaiting = state.awaitingInput === true;
    },
  });
  unsubscribe();
  if (awaiting)
    throw new Error(
      "Session is awaiting confirmation; resolve that prompt before injecting a message",
    );
  if (modes.snapshot()[2004] !== true)
    throw new Error("Session terminal is not ready for pasted messages");
}
