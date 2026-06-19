export interface CodexQueuedMessage<Attachment = unknown> {
  id: string;
  text: string;
  attachments: Attachment[];
  createdAt: string;
}

export interface CodexQueuePayload<Attachment = unknown> {
  text: string;
  attachments: Attachment[];
}

export function parseCodexQueue<Attachment = unknown>(
  raw: string | null | undefined,
  fallbackCreatedAt: () => string = () => new Date().toISOString(),
): CodexQueuedMessage<Attachment>[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item): CodexQueuedMessage<Attachment> | null => {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      if (typeof obj.id !== "string" || typeof obj.text !== "string")
        return null;
      return {
        id: obj.id,
        text: obj.text,
        attachments: Array.isArray(obj.attachments)
          ? (obj.attachments as Attachment[])
          : [],
        createdAt:
          typeof obj.createdAt === "string"
            ? obj.createdAt
            : fallbackCreatedAt(),
      };
    })
    .filter((item): item is CodexQueuedMessage<Attachment> => !!item);
}

export function canSaveCodexQueueEdit<Attachment>(
  text: string,
  attachments: readonly Attachment[],
): boolean {
  return text.trim().length > 0 || attachments.length > 0;
}

export function enqueueCodexQueue<Attachment>(
  queue: readonly CodexQueuedMessage<Attachment>[],
  payload: CodexQueuePayload<Attachment>,
  id: string,
  createdAt: string,
): CodexQueuedMessage<Attachment>[] {
  return [
    ...queue,
    {
      id,
      text: payload.text,
      attachments: [...payload.attachments],
      createdAt,
    },
  ];
}

export function updateCodexQueuedMessage<Attachment>(
  queue: readonly CodexQueuedMessage<Attachment>[],
  id: string,
  payload: CodexQueuePayload<Attachment>,
): CodexQueuedMessage<Attachment>[] {
  const text = payload.text.trim();
  return queue.map((item) =>
    item.id === id
      ? { ...item, text, attachments: [...payload.attachments] }
      : item,
  );
}

export function removeCodexQueuedMessage<Attachment>(
  queue: readonly CodexQueuedMessage<Attachment>[],
  id: string,
): CodexQueuedMessage<Attachment>[] {
  return queue.filter((item) => item.id !== id);
}

export function removeCodexQueuedAttachment<Attachment>(
  attachments: readonly Attachment[],
  index: number,
): Attachment[] {
  return attachments.filter((_, i) => i !== index);
}
