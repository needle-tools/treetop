import type {
  WorkspacePreviewMessage,
  WorkspacePreviewSession,
} from "./repo-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isWorkspacePreviewMessage(
  value: unknown,
): value is WorkspacePreviewMessage {
  if (!isRecord(value)) return false;
  if (
    value.role !== "user" &&
    value.role !== "assistant" &&
    value.role !== "system" &&
    value.role !== "tool"
  ) {
    return false;
  }
  return Array.isArray(value.blocks);
}

export function parseWorkspacePreviewJsonl(raw: string): WorkspacePreviewMessage[] {
  const out: WorkspacePreviewMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as unknown;
    if (isWorkspacePreviewMessage(parsed)) out.push(parsed);
  }
  return out;
}

export function transcriptText(message: WorkspacePreviewMessage): string {
  return message.blocks
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function transcriptLastUserMessage(
  messages: WorkspacePreviewMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const text = transcriptText(message);
    if (text) return text;
  }
  return undefined;
}

export function transcriptPreviewText(
  messages: WorkspacePreviewMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = transcriptText(message);
    if (text) return text;
  }
  return transcriptLastUserMessage(messages);
}

export function hydrateWorkspacePreviewSession<
  T extends Omit<
    WorkspacePreviewSession,
    "lastUserMessage" | "messageCount" | "preview" | "transcript"
  >,
>(
  session: T,
  transcript: WorkspacePreviewMessage[],
): T & WorkspacePreviewSession {
  return {
    ...session,
    transcript,
    messageCount: transcript.filter(
      (message) => message.role === "user" || message.role === "assistant",
    ).length,
    lastUserMessage: transcriptLastUserMessage(transcript),
    preview: transcriptPreviewText(transcript),
  };
}
