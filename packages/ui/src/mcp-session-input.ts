import type { UiAction } from "../../daemon/src/ui-context";

export type SessionInputAction = Extract<UiAction, { action: "session_input" }>;
export interface AiInputOrigin {
  source?: string;
  edited?: boolean;
}
export interface InputSnapshot {
  owner: string;
  known: boolean;
  text: string;
  attachments: number;
  queue: Array<{ id: string; text: string; ai?: AiInputOrigin }>;
}

/** No terminal-screen guesses: only an authoritative input owner may prefill. */
export function createSessionInputController(adapter: {
  snapshot: () => InputSnapshot;
  setText: (text: string) => void;
  submit: (origin: AiInputOrigin) => Promise<Record<string, unknown>>;
}) {
  let draft:
    | { id: string; text: string; owner: string; origin: AiInputOrigin }
    | undefined;
  let submitting = false;
  function inspect(maxChars = 6000): Record<string, unknown> {
    const state = adapter.snapshot();
    if (draft && (draft.owner !== state.owner || (!state.text && !submitting)))
      draft = undefined;
    if (!state.known)
      return {
        inputState: "unknown",
        queueState: "unknown",
        reason:
          "This input is not available for authoritative inspection (CLI/TUI, unavailable composer, or queue editing). Unknown does not mean empty.",
      };
    let remaining = maxChars;
    const clip = (text: string) => {
      const clipped = text.slice(0, remaining);
      remaining -= clipped.length;
      return { text: clipped, truncated: clipped.length !== text.length };
    };
    const ai = draft?.owner === state.owner && !!state.text ? draft : undefined;
    return {
      inputState: state.text || state.attachments ? "draft" : "empty",
      draft: {
        ...clip(state.text),
        attachments: state.attachments,
        author: ai ? "ai" : "user",
        ...(ai
          ? {
              draftId: ai.id,
              senderSource: ai.origin.source,
              edited: state.text !== ai.text || state.attachments > 0,
            }
          : {}),
      },
      queueState: "known",
      queue: state.queue
        .slice(0, 20)
        .map((item) => ({
          id: item.id,
          ...clip(item.text),
          author: item.ai ? "ai" : "user",
          ...(item.ai
            ? { senderSource: item.ai.source, edited: !!item.ai.edited }
            : {}),
        })),
      hasMoreQueued: state.queue.length > 20,
    };
  }
  async function act(
    command: SessionInputAction,
  ): Promise<Record<string, unknown>> {
    if (command.operation === "inspect") return inspect(command.maxChars);
    const state = adapter.snapshot();
    if (!state.known)
      return { status: "input_unknown", ...inspect(command.maxChars) };
    if (submitting) return { status: "submission_pending" };
    const text = command.text ?? "";
    if (command.operation !== "submit") {
      if (state.text || state.attachments)
        return { status: "draft_exists", ...inspect(command.maxChars) };
      if (!text.trim()) throw new Error("Message text is required");
      draft = {
        id: crypto.randomUUID(),
        owner: state.owner,
        text,
        origin: { source: command.senderSource },
      };
      adapter.setText(text);
      if (command.operation === "stage")
        return {
          status: "staged",
          draftId: draft.id,
          ...inspect(command.maxChars),
        };
    } else if (
      !draft ||
      draft.owner !== state.owner ||
      command.draftId !== draft.id ||
      state.text !== draft.text ||
      text !== draft.text ||
      state.attachments > 0
    ) {
      return { status: "draft_changed", ...inspect(command.maxChars) };
    }
    submitting = true;
    try {
      const result = await adapter.submit(draft!.origin);
      draft = undefined;
      return result;
    } finally {
      submitting = false;
    }
  }
  return { act, inspect };
}

const inputs = new Set<{
  matches: (source: string, sessionId?: string) => boolean;
  act: (command: SessionInputAction) => Promise<Record<string, unknown>>;
}>();
export function registerSessionInput(
  input: typeof inputs extends Set<infer T> ? T : never,
): () => void {
  inputs.add(input);
  return () => inputs.delete(input);
}
export async function applySessionInput(
  command: SessionInputAction,
): Promise<Record<string, unknown>> {
  const matches = [...inputs].filter((input) =>
    input.matches(command.source, command.sessionId),
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Session input is open in multiple columns"
        : "Session input is not mounted in this window; open the target session first",
    );
  return matches[0]!.act(command);
}
