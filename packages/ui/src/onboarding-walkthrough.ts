import { getDaemonKV } from "./daemon-kv";

export interface WalkthroughStep {
  id: string;
  emoji: string;
  target: (wtPath: string) => HTMLElement | null;
  message: string;
  placement: "top" | "bottom";
}

export const WALKTHROUGH_STEPS: WalkthroughStep[] = [
  {
    id: "new-session",
    emoji: "\u{1F680}",
    target: (wt) =>
      document.querySelector<HTMLElement>(
        `[data-new-agent-anchor="${CSS.escape(wt)}"]`,
      ),
    message:
      "Click the + button to start a new session — pick Claude, Codex, Ollama, or a plain terminal.",
    placement: "bottom",
  },
  {
    id: "open-in-actions",
    emoji: "\u{1F517}",
    target: (wt) =>
      document.querySelector<HTMLElement>(
        `[data-wt-row="${CSS.escape(wt)}"] .row-status`,
      ),
    message:
      "Open this repo in your editor, terminal, Fork, or add custom links to dashboards and staging URLs.",
    placement: "bottom",
  },
  {
    id: "sessions-strip",
    emoji: "\u{1F4BB}",
    target: (wt) =>
      document.querySelector<HTMLElement>(
        `[data-wt-strip="${CSS.escape(wt)}"]`,
      ) ??
      document.querySelector<HTMLElement>(
        `[data-wt-row="${CSS.escape(wt)}"] .row-body`,
      ),
    message:
      "Your agent sessions appear here as columns. Scroll horizontally to see them all.",
    placement: "top",
  },
  {
    id: "sticky-notes",
    emoji: "\u{1F4CC}",
    target: (wt) =>
      document.querySelector<HTMLElement>(
        `[data-wt-row="${CSS.escape(wt)}"] .notes-add`,
      ),
    message:
      "Pin sticky notes to any repo or worktree — jot down TODOs, context, or reminders.",
    placement: "bottom",
  },
  {
    id: "emoji-sticker",
    emoji: "\u{1F3A8}",
    target: (wt) =>
      document.querySelector<HTMLElement>(
        `[data-wt-row="${CSS.escape(wt)}"] .notes-add-emoji`,
      ) ??
      document.querySelector<HTMLElement>(
        `[data-wt-row="${CSS.escape(wt)}"] .notes-add`,
      ),
    message:
      "Add emoji stickers to mark a repo's status — ship it, WIP, on fire, whatever fits.",
    placement: "bottom",
  },
  {
    id: "menubar",
    emoji: "\u{2699}\u{FE0F}",
    target: () =>
      document.querySelector<HTMLElement>(".menubar"),
    message:
      "The menubar gives you quick access to notes, actions, events, and this help button. You can replay this tour anytime from the \u{2753} icon.",
    placement: "bottom",
  },
];

export function walkthroughHash(): string {
  const payload = WALKTHROUGH_STEPS.map((s) => `${s.id}:${s.message}`).join(
    "|",
  );
  let h = 5381;
  for (let i = 0; i < payload.length; i++) {
    h = ((h << 5) + h + payload.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

const KV_KEY = "supergit:onboardingWalkthroughSeen";

export function walkthroughSeen(wtPath: string): boolean {
  const raw = getDaemonKV().getItem(KV_KEY);
  if (!raw) return false;
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    return map[wtPath] === walkthroughHash();
  } catch {
    return false;
  }
}

export function markWalkthroughSeen(wtPath: string): void {
  const raw = getDaemonKV().getItem(KV_KEY);
  let map: Record<string, string> = {};
  try {
    if (raw) map = JSON.parse(raw);
  } catch {}
  map[wtPath] = walkthroughHash();
  getDaemonKV().setItem(KV_KEY, JSON.stringify(map));
}

export function clearWalkthroughSeen(wtPath: string): void {
  const raw = getDaemonKV().getItem(KV_KEY);
  if (!raw) return;
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    delete map[wtPath];
    getDaemonKV().setItem(KV_KEY, JSON.stringify(map));
  } catch {}
}
