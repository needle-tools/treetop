import { resolve } from "node:path";
import type { AgentSession } from "./agents";
import type { NormalizedMessage } from "./sessions";
import type { PtyBackend } from "./terminals/types";
import { DecPrivateModeTracker } from "./dec-private-modes";

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
        entry.mode !== "terminal" &&
        entry.visualAppStopped !== true &&
        (entry.source === session.source ||
          entry.transcriptSource === session.source ||
          entry.resumeSessionId === session.sessionId ||
          entry.source === `__codex_app__:${session.sessionId}`),
    );
  if (targets.length !== 1)
    throw new Error(
      "Native session must be open in exactly one Treetop column before sending",
    );
  return targets[0]!;
}

/** Returns undefined only when there is no matching live PTY. Never spawn a process. */
export async function sendTerminalSessionMessage(
  backend: Pick<PtyBackend, "list" | "get">,
  session: AgentSession,
  text: string,
): Promise<{ delivery: "terminal"; terminalId: string } | undefined> {
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
  const modes = new DecPrivateModeTracker();
  let busy = false;
  let awaiting = false;
  // Subscribe replays current DEC modes and state synchronously, just as a
  // renderer reattach does. Refuse input into busy agents or approval prompts.
  const unsubscribe = handle.subscribe({
    onData: (bytes) => modes.observe(bytes),
    onExit: () => {},
    onState: (state) => {
      busy = state.working === true;
      awaiting = state.awaitingInput === true;
    },
  });
  unsubscribe();
  if (busy || awaiting)
    throw new Error(
      "Session is busy or awaiting confirmation; retry when it is ready for a message",
    );
  if (modes.snapshot()[2004] !== true)
    throw new Error("Session terminal is not ready for pasted messages");
  handle.write(`\x1b[200~${text}\x1b[201~`);
  // Let the TUI consume the paste before submitting it as a user message.
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (!handle.isAlive())
    throw new Error("Session exited before the message could be submitted");
  handle.write("\r");
  return { delivery: "terminal", terminalId: matches[0]!.id };
}
