export interface MessageBlock {
  type: string;
  text?: string;
}

export interface Message<B extends MessageBlock = MessageBlock> {
  role: string;
  blocks: B[];
  timestamp?: string;
}

export interface VisualWorkEntry<
  B extends MessageBlock = MessageBlock,
  M extends Message<B> = Message<B>,
> {
  message: M;
  blocks: B[];
  messageIndex: number;
}

export type VisualTranscriptItem<
  B extends MessageBlock = MessageBlock,
  M extends Message<B> = Message<B>,
> =
  | {
      kind: "message";
      message: M;
      blocks: B[];
      messageIndex: number;
    }
  | {
      kind: "work";
      entries: VisualWorkEntry<B, M>[];
      startedAt?: string;
      endedAt?: string;
    };

const BURST_GAP_MS = 30_000;

function isInternalUserMessageText(text: string): boolean {
  return text.trimStart().startsWith("<turn_aborted>");
}

export function extractUserText(m: Message): string {
  const text = (m.blocks ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n")
    .trim();
  return isInternalUserMessageText(text) ? "" : text;
}

export function lastUserMessageBurst(msgs: Message[]): string | undefined {
  if (!msgs || msgs.length === 0) return undefined;
  const collected: string[] = [];
  let prevTs: number | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const text = extractUserText(m);
    if (text.length === 0) continue;
    const tsRaw = m.timestamp ? Date.parse(m.timestamp) : NaN;
    const ts = Number.isNaN(tsRaw) ? null : tsRaw;
    if (collected.length > 0 && prevTs !== null && ts !== null) {
      if (prevTs - ts > BURST_GAP_MS) break;
    }
    collected.unshift(text);
    if (ts !== null) prevTs = ts;
  }
  if (collected.length === 0) return undefined;
  return collected.join("\n");
}

export function lastUserMessageWithContext(
  msgs: Message[],
  burst: string | undefined,
): string | undefined {
  if (!burst) return undefined;
  if (burst.length >= 10 && burst.includes(" ")) return burst;
  if (!msgs) return burst;
  let pastBurst = false;
  let prevTs: number | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const text = extractUserText(m);
    if (text.length === 0) continue;
    const tsRaw = m.timestamp ? Date.parse(m.timestamp) : NaN;
    const ts = Number.isNaN(tsRaw) ? null : tsRaw;
    if (!pastBurst) {
      if (prevTs !== null && ts !== null && prevTs - ts > BURST_GAP_MS) {
        pastBurst = true;
      } else {
        if (ts !== null) prevTs = ts;
        continue;
      }
    }
    if (pastBurst) return `${text}\n[…]\n${burst}`;
  }
  return burst;
}

function isAssistantResponseBlock(block: MessageBlock): boolean {
  return block.type === "text";
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function pushPendingWork<
  B extends MessageBlock,
  M extends Message<B>,
>(
  out: VisualTranscriptItem<B, M>[],
  pendingWork: VisualWorkEntry<B, M>[],
): void {
  for (const entry of pendingWork) {
    out.push({
      kind: "message",
      message: entry.message,
      blocks: entry.blocks,
      messageIndex: entry.messageIndex,
    });
  }
  pendingWork.length = 0;
}

export function buildVisualTranscriptItems<
  B extends MessageBlock,
  M extends Message<B>,
>(messages: readonly M[]): VisualTranscriptItem<B, M>[] {
  const out: VisualTranscriptItem<B, M>[] = [];
  const pendingWork: VisualWorkEntry<B, M>[] = [];
  let lastUserTimestamp: string | undefined;

  messages.forEach((message, messageIndex) => {
    const blocks = message.blocks ?? [];
    if (message.role === "user") {
      pushPendingWork(out, pendingWork);
      out.push({ kind: "message", message, blocks, messageIndex });
      lastUserTimestamp = message.timestamp;
      return;
    }

    if (message.role !== "assistant") {
      pendingWork.push({ message, blocks, messageIndex });
      return;
    }

    const responseBlocks = blocks.filter(isAssistantResponseBlock);
    const workBlocks = blocks.filter((block) => !isAssistantResponseBlock(block));

    if (workBlocks.length > 0) {
      pendingWork.push({ message, blocks: workBlocks, messageIndex });
    }

    if (responseBlocks.length === 0) return;

    if (pendingWork.length > 0) {
      const firstWorkTs = pendingWork.find((entry) =>
        timestampMs(entry.message.timestamp),
      )?.message.timestamp;
      out.push({
        kind: "work",
        entries: [...pendingWork],
        startedAt: lastUserTimestamp ?? firstWorkTs,
        endedAt: message.timestamp,
      });
      pendingWork.length = 0;
    }

    out.push({
      kind: "message",
      message,
      blocks: responseBlocks,
      messageIndex,
    });
  });

  pushPendingWork(out, pendingWork);
  return out;
}
