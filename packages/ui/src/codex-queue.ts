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

export function reorderCodexQueuedMessage<Attachment>(
  queue: readonly CodexQueuedMessage<Attachment>[],
  id: string,
  beforeId: string | null,
): CodexQueuedMessage<Attachment>[] {
  const fromIndex = queue.findIndex((item) => item.id === id);
  if (fromIndex < 0) return queue as CodexQueuedMessage<Attachment>[];
  const moving = queue[fromIndex];
  if (!moving) return queue as CodexQueuedMessage<Attachment>[];
  const withoutMoving = queue.filter((item) => item.id !== id);
  const toIndex =
    beforeId === null
      ? withoutMoving.length
      : withoutMoving.findIndex((item) => item.id === beforeId);
  if (toIndex < 0) return queue as CodexQueuedMessage<Attachment>[];
  if (queue[toIndex]?.id === id || fromIndex === toIndex) {
    return queue as CodexQueuedMessage<Attachment>[];
  }
  return [
    ...withoutMoving.slice(0, toIndex),
    moving,
    ...withoutMoving.slice(toIndex),
  ];
}

export function mergeCodexQueuedMessageUp<Attachment>(
  queue: readonly CodexQueuedMessage<Attachment>[],
  id: string,
): CodexQueuedMessage<Attachment>[] {
  const index = queue.findIndex((item) => item.id === id);
  if (index <= 0) return queue as CodexQueuedMessage<Attachment>[];
  const previous = queue[index - 1];
  const current = queue[index];
  if (!previous || !current) return queue as CodexQueuedMessage<Attachment>[];
  return [
    ...queue.slice(0, index - 1),
    {
      ...previous,
      text: [previous.text, current.text].filter(Boolean).join("\n\n"),
      attachments: [...previous.attachments, ...current.attachments],
    },
    ...queue.slice(index + 1),
  ];
}

export function removeCodexQueuedAttachment<Attachment>(
  attachments: readonly Attachment[],
  index: number,
): Attachment[] {
  return attachments.filter((_, i) => i !== index);
}
