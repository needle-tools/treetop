export interface MessageBlock {
  type: string;
  text?: string;
}

export interface Message {
  role: string;
  blocks: MessageBlock[];
  timestamp?: string;
}

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
