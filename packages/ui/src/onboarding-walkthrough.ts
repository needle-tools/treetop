import { getDaemonKV } from "./daemon-kv";

export type EmojiAnim =
  | "bounce"
  | "fly-up"
  | "fly-down"
  | "fly-left"
  | "spin"
  | "heartbeat";

export interface WalkthroughStep {
  id: string;
  emoji: string;
  emojiAnim?: EmojiAnim;
  target: (wtPath: string, rowEl?: HTMLElement | null) => HTMLElement | null;
  message: string;
  placement: "top" | "bottom";
}

export const WALKTHROUGH_STEPS: WalkthroughStep[] = [
  {
    id: "new-session",
    emoji: "\u{1F680}",
    emojiAnim: "fly-up",
    target: (_wt, row) =>
      row?.querySelector<HTMLElement>("[data-new-agent-anchor]") ?? null,
    message:
      "Click the + button to start a new session — pick Claude, Codex, Ollama, or a plain terminal.",
    placement: "bottom",
  },
  {
    id: "open-in-actions",
    emoji: "\u{1F517}",
    emojiAnim: "bounce",
    target: (_wt, row) =>
      row?.querySelector<HTMLElement>(".row-status") ?? null,
    message:
      "Open this repo in your editor, terminal, Fork, or add custom links to dashboards and staging URLs.",
    placement: "bottom",
  },
  {
    id: "sessions-strip",
    emoji: "\u{1F4BB}",
    emojiAnim: "fly-left",
    target: (_wt, row) =>
      row?.querySelector<HTMLElement>("[data-wt-strip]") ??
      row?.querySelector<HTMLElement>(".row-body") ??
      null,
    message:
      "Your agent sessions appear here as columns. Scroll horizontally to see them all.",
    placement: "top",
  },
  {
    id: "sticky-notes",
    emoji: "\u{1F4CC}",
    emojiAnim: "fly-down",
    target: (_wt, row) => row?.querySelector<HTMLElement>(".notes-add") ?? null,
    message:
      "Pin sticky notes to any repo or worktree — keep track of TODOs, context, or reminders.",
    placement: "bottom",
  },
  {
    id: "emoji-sticker",
    emoji: "\u{1F3A8}",
    emojiAnim: "spin",
    target: (_wt, row) =>
      row?.querySelector<HTMLElement>(".notes-add-emoji") ??
      row?.querySelector<HTMLElement>(".notes-add") ??
      null,
    message:
      "Add emoji stickers to mark a repo's status — ship it, WIP, on fire, whatever fits.",
    placement: "bottom",
  },
  {
    id: "menubar",
    emoji: "\u{2699}\u{FE0F}",
    emojiAnim: "spin",
    target: () => document.querySelector<HTMLElement>(".menubar"),
    message:
      "The menubar gives you quick access to notes, actions, events, and this help button. You can replay this tour anytime from the \u{2753} icon.",
    placement: "bottom",
  },
  {
    id: "finish",
    emoji: "\u{1F49A}",
    emojiAnim: "heartbeat",
    target: () => document.querySelector<HTMLElement>(".menubar"),
    message:
      "You\u{2019}re all set! Thanks for using supergit by Needle. Happy shipping! \u{1F389}",
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
