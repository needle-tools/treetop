export interface UiContextSession {
  source: string;
  sessionId?: string;
  agent?: string;
  repoId?: string;
  title?: string;
}
export interface UiContextProject {
  id: string;
  name: string;
  path: string;
  daemonId?: string;
  worktreePaths?: string[];
}
export interface UiContextSnapshot {
  windowFocused: boolean;
  visible: boolean;
  zenMode: boolean;
  focusedSession: UiContextSession | null;
  lastActiveSession: UiContextSession | null;
  activeProject: UiContextProject | null;
  visibleProjects: UiContextProject[];
}
export interface UiContextReport {
  windowId: string;
  sequence: number;
  snapshot: UiContextSnapshot;
}

export type UiAction =
  | { action: "session_input"; source: string; sessionId?: string; operation: "inspect" | "stage" | "submit" | "send"; text?: string; draftId?: string; senderSource?: string; maxChars?: number }
  | { action: "voice_message"; text: string; cwd: string }
  | { action: "focus_session"; source: string; sessionId?: string }
  | { action: "focus_project"; repoId: string; cwd: string }
  | { action: "set_zen_mode"; enabled: boolean; repoId?: string; cwd?: string };
export type UiActionCommand = UiAction & {
  windowId: string;
  requestId: string;
};

export class UiActionRequests {
  private pending = new Map<
    string,
    {
      windowId: string;
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  request(
    windowId: string,
    action: UiAction,
    dispatch: (command: UiActionCommand) => void,
    timeoutMs = 8000,
  ): Promise<Record<string, unknown>> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(
            "Treetop window did not acknowledge the action; inspect get_ui_context before retrying",
          ),
        );
      }, timeoutMs);
      this.pending.set(requestId, { windowId, resolve, reject, timer });
      try {
        dispatch({ ...action, windowId, requestId });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }
  complete(value: unknown): void {
    const input = object(value);
    if (
      typeof input.requestId !== "string" ||
      typeof input.windowId !== "string" ||
      typeof input.ok !== "boolean" ||
      (input.error !== undefined &&
        (typeof input.error !== "string" || input.error.length > 4096))
    )
      throw new Error("Invalid UI action result");
    const request = this.pending.get(input.requestId);
    if (!request || request.windowId !== input.windowId)
      throw new Error("UI action request not found for this window");
    const result = input.result === undefined ? undefined : object(input.result);
    clearTimeout(request.timer);
    this.pending.delete(input.requestId);
    if (input.ok)
      request.resolve({
        applied: true,
        windowId: input.windowId,
        requestId: input.requestId,
        ...(result !== undefined ? { result } : {}),
      });
    else
      request.reject(
        new Error(
          typeof input.error === "string" ? input.error : "UI action failed",
        ),
      );
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function strings(
  value: unknown,
  required: string[],
  optional: string[],
): Record<string, string> {
  const input = object(value),
    result: Record<string, string> = {};
  for (const key of [...required, ...optional]) {
    if (input[key] === undefined && !required.includes(key)) continue;
    if (
      typeof input[key] !== "string" ||
      !(input[key] as string).trim() ||
      (input[key] as string).length > 4096
    )
      throw new Error(`Invalid ${key}`);
    result[key] = input[key] as string;
  }
  return result;
}
function session(value: unknown): UiContextSession | null {
  return value == null
    ? null
    : (strings(
        value,
        ["source"],
        ["sessionId", "agent", "repoId", "title"],
      ) as unknown as UiContextSession);
}
function project(value: unknown): UiContextProject {
  const input = object(value);
  const result = strings(
    value,
    ["id", "name", "path"],
    ["daemonId"],
  ) as unknown as UiContextProject;
  if (input.worktreePaths !== undefined) {
    if (
      !Array.isArray(input.worktreePaths) ||
      input.worktreePaths.length > 100 ||
      input.worktreePaths.some((p) => typeof p !== "string" || p.length > 4096)
    )
      throw new Error("Invalid worktreePaths");
    result.worktreePaths = [...input.worktreePaths];
  }
  return result;
}

/** Live presence is ephemeral, not a saved workspace preference. */
export class UiContextRegistry {
  private windows = new Map<
    string,
    {
      snapshot: UiContextSnapshot;
      sequence: number;
      updatedAt: number;
      lastFocusedAt: number;
    }
  >();
  report(value: unknown, now = Date.now()): void {
    const input = object(value),
      raw = object(input.snapshot);
    if (
      typeof input.windowId !== "string" ||
      !input.windowId ||
      input.windowId.length > 128 ||
      !Number.isSafeInteger(input.sequence) ||
      (input.sequence as number) < 0
    )
      throw new Error("Invalid windowId or sequence");
    for (const key of ["windowFocused", "visible", "zenMode"])
      if (typeof raw[key] !== "boolean") throw new Error(`Invalid ${key}`);
    if (!Array.isArray(raw.visibleProjects) || raw.visibleProjects.length > 100)
      throw new Error("Invalid visibleProjects");
    const snapshot: UiContextSnapshot = {
      windowFocused: raw.windowFocused as boolean,
      visible: raw.visible as boolean,
      zenMode: raw.zenMode as boolean,
      focusedSession:
        raw.windowFocused && raw.visible ? session(raw.focusedSession) : null,
      lastActiveSession: session(raw.lastActiveSession),
      activeProject:
        raw.activeProject == null ? null : project(raw.activeProject),
      visibleProjects: raw.visible ? raw.visibleProjects.map(project) : [],
    };
    for (const [id, entry] of this.windows)
      if (now - entry.updatedAt > 60_000) this.windows.delete(id);
    const old = this.windows.get(input.windowId);
    if (old && old.sequence >= (input.sequence as number)) return;
    if (!old && this.windows.size >= 100)
      throw new Error("Too many UI windows");
    this.windows.set(input.windowId, {
      snapshot,
      sequence: input.sequence as number,
      updatedAt: now,
      lastFocusedAt:
        snapshot.windowFocused && snapshot.visible
          ? now
          : (old?.lastFocusedAt ?? 0),
    });
  }
  read(windowId?: string, now = Date.now()): Record<string, unknown> {
    const fresh = [...this.windows].filter(
      ([, entry]) => now - entry.updatedAt <= 15_000,
    );
    const windows = fresh.map(([id, entry]) => ({
      windowId: id,
      focused: entry.snapshot.windowFocused,
      visible: entry.snapshot.visible,
      ageMs: now - entry.updatedAt,
    }));
    const selected = windowId
      ? fresh.find(([id]) => id === windowId)
      : fresh.sort(
          (a, b) =>
            Number(b[1].snapshot.windowFocused && b[1].snapshot.visible) -
              Number(a[1].snapshot.windowFocused && a[1].snapshot.visible) ||
            b[1].lastFocusedAt - a[1].lastFocusedAt ||
            b[1].updatedAt - a[1].updatedAt,
        )[0];
    if (!selected)
      return {
        available: false,
        reason: "No fresh UI context; open or return to a Treetop window.",
        windows,
      };
    const [id, entry] = selected;
    return {
      available: true,
      windowId: id,
      ...entry.snapshot,
      updatedAt: new Date(entry.updatedAt).toISOString(),
      ageMs: now - entry.updatedAt,
      windows,
    };
  }
}
