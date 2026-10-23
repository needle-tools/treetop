import type {
  UiContextReport,
  UiContextSnapshot,
  UiActionCommand,
} from "../../daemon/src/ui-context";
import { NATIVE_WINDOW_FOCUS_EVENT } from "./window-focus-events";

export const UI_CONTEXT_WINDOW_ID = crypto.randomUUID();

export async function applyUiAction(
  command: UiActionCommand,
  windowId: string,
  adapter: {
    focusSession: (source: string, sessionId?: string) => Promise<void>;
    voiceMessage?: (text: string, cwd: string) => Promise<void>;
    focusProject: (repoId: string, cwd: string) => Promise<void>;
    setZenMode: (
      enabled: boolean,
      repoId?: string,
      cwd?: string,
    ) => Promise<void>;
  },
  acknowledge: (result: {
    requestId: string;
    windowId: string;
    ok: boolean;
    error?: string;
  }) => Promise<void> = async (result) => {
    const response = await fetch("/api/ui-action-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      throw new Error(
        `UI action acknowledgement failed: HTTP ${response.status}`,
      );
  },
): Promise<void> {
  if (command.windowId !== windowId) return;
  let error: string | undefined;
  try {
    switch (command.action) {
      case "voice_message":
        if (!adapter.voiceMessage) throw new Error("Voice messages are unavailable in this window");
        await adapter.voiceMessage(command.text, command.cwd);
        break;
      case "focus_session":
        await adapter.focusSession(command.source, command.sessionId);
        break;
      case "focus_project":
        await adapter.focusProject(command.repoId, command.cwd);
        break;
      case "set_zen_mode":
        await adapter.setZenMode(command.enabled, command.repoId, command.cwd);
        break;
      default:
        throw new Error("Unknown UI action");
    }
  } catch (failure) {
    error = (
      failure instanceof Error ? failure.message : String(failure)
    ).slice(0, 4096);
  }
  await acknowledge({
    requestId: command.requestId,
    windowId,
    ok: error === undefined,
    ...(error === undefined ? {} : { error }),
  });
}

export function installUiContextPublisher(
  snapshot: () => UiContextSnapshot,
  options: {
    document?: Document;
    window?: Window;
    publish?: (report: UiContextReport) => Promise<void>;
    onError?: (error: unknown) => void;
  } = {},
): () => void {
  const doc = options.document ?? document,
    win = options.window ?? window;
  const windowId = UI_CONTEXT_WINDOW_ID;
  let sequence = 0,
    disposed = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const publish =
    options.publish ??
    (async (report) => {
      const response = await fetch("/api/ui-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
        keepalive: true,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`UI context report failed: HTTP ${response.status}`);
    });
  function report(closing = false) {
    if (disposed && !closing) return;
    const current = snapshot();
    if (closing) {
      current.windowFocused = false;
      current.visible = false;
      current.focusedSession = null;
      current.visibleProjects = [];
    }
    void publish({ windowId, sequence: ++sequence, snapshot: current }).catch(
      (error) => (options.onError ?? console.warn)(error),
    );
  }
  function changed() {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      report();
    }, 100);
  }
  const heartbeat = setInterval(() => report(), 1500);
  const windowEvents = [
    "focus",
    "blur",
    "scroll",
    "resize",
    NATIVE_WINDOW_FOCUS_EVENT,
  ];
  for (const event of windowEvents)
    win.addEventListener(event, changed, { passive: true });
  doc.addEventListener("focusin", changed);
  doc.addEventListener("visibilitychange", changed);
  report();
  return () => {
    disposed = true;
    clearInterval(heartbeat);
    if (debounce !== null) clearTimeout(debounce);
    for (const event of windowEvents) win.removeEventListener(event, changed);
    doc.removeEventListener("focusin", changed);
    doc.removeEventListener("visibilitychange", changed);
    report(true);
  };
}
