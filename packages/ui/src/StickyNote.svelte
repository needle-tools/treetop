<script lang="ts" context="module">
  /** The two attachment kinds the layer carries: a free-form paper
   *  sticky ("note") and a compact chip pointing at a URL / commit /
   *  session / file ("link"). Both share the storage path, anchors,
   *  undo log, and SSE broadcast — only the rendering differs, so
   *  this component branches on `kind` rather than the layer routing
   *  to a sibling component. */
  export type AttachmentKind = "note" | "link" | "emoji";
  export interface LinkTarget {
    type: "url" | "commit" | "session" | "file" | "command";
    value: string;
    /** Display snapshot captured at pick-time so the chip renders
     *  instantly without re-hitting /api/agents or /api/commits.
     *  Round-trips through the daemon's flat-YAML frontmatter. */
    label?: string;
    subtitle?: string;
    meta?: string;
    /** Agent ("claude", "codex") — chip icon for session targets. */
    agent?: string;
    /** Git remote provider ("github", "gitlab", ...) — chip icon for
     *  commit targets. */
    provider?: string;
    /** Command targets reuse the link-card path; value is the
     *  custom-link id, with these fields captured for display/run. */
    repoId?: string;
    cwd?: string;
    command?: string;
    runMode?: "internal" | "external" | "shell";
  }
  export interface NoteShape {
    id: string;
    anchors: string[];
    tags: string[];
    body: string;
    createdAt: string;
    updatedAt: string;
    /** Absent on every pre-existing note file; treat undefined as "note". */
    kind?: AttachmentKind;
    target?: LinkTarget;
  }
</script>

<script lang="ts">
  /**
   * A single floating sticky note. Paper-y, slightly rotated, draggable,
   * inline editable. Position is held by the parent (StickyNotesLayer)
   * in localStorage so it survives reloads. Content + anchor changes go
   * through the daemon's /api/notes routes.
   *
   * Part of v1.y (floating-overlay phase) of the notes feature — see
   * plans/PLAN.md §"Notes with anchors + floating overlay".
   */
  import { onMount, onDestroy, createEventDispatcher } from "svelte";
  import { marked } from "marked";
  import {
    isAppIconToken,
    appIconNameFromToken,
    appIconUrl,
  } from "./app-icons";
  import DOMPurify from "dompurify";
  import AnchorPicker from "./AnchorPicker.svelte";
  import Popover from "./Popover.svelte";
  import MentionPicker from "./MentionPicker.svelte";
  import AttachmentIcon from "./AttachmentIcon.svelte";
  import InlineAttachmentChip from "./InlineAttachmentChip.svelte";
  import ChatPreview from "./ChatPreview.svelte";
  import { shrinkImageBlob } from "./image-shrink";
  import {
    fetchPreviewItems,
    type PreviewAction,
    type PreviewGap,
    type PreviewMsg,
    type PreviewSummary,
  } from "./preview-action";
  import {
    INLINE_ATTACHMENT_DRAG_MIME,
    commandCopyText,
    commandPowerLabel,
    extractNoteClipboardPayloadFromHtml,
    expandNoteBodyForCopyAsync,
    fetchTextAttachment,
    countTextLines,
    inferPastedTextMimeType,
    inlineAttachmentLabel,
    makeNoteClipboardHtml,
    makeNoteClipboardPayload,
    pastedTextFilenameForMime,
    pastedTextTitleForMime,
    makeImageAttachmentRef,
    makeNoteAttachmentRef,
    makeTextAttachmentRef,
    noteBodyToEditText,
    parseInlineAttachments,
    restoreEditTextAttachments,
    resolveLiveCommandLink,
    shouldAttachPastedText,
    textAttachmentMeta,
    visualAttachmentIndexes,
    type InlineAttachment,
    type InlineAttachmentEditRef,
    type InlineAttachmentPart,
  } from "./note-inline-attachments";
  import { defaultProviders } from "./mention-providers";
  import { pushRecent } from "./mention-recents";
  import { openUrl } from "./open-url";
  import type { PickItem } from "./mention-types";
  import { requestSessionFocus } from "./session-focus-store";
  import { sessionDisplayTitle, type AgentSession } from "./sessionSearch";
  import { iconFor } from "./icons";
  import { play } from "./sound";

  /** localStorage key for the user's preferred git client. Written
   *  by App.svelte's openIn funnel whenever a git-client app is
   *  invoked; read by the commit-chip click handler below when no
   *  provider web URL is available. Default "fork" — the only git
   *  GUI currently exposed in OpenInActions. */
  const GIT_CLIENT_PREF_KEY = "supergit:preferred-git-client";
  const EMOJI_STICKER_BASE_PX = 160;

  /** Trigger /api/open against the daemon. Mirrors App.svelte's
   *  openIn (same payload shape) but locally available so the chip
   *  can dispatch directly without prop-drilling another callback
   *  through the layer. */
  async function openInApp(path: string, app: string): Promise<void> {
    try {
      await fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, app }),
      });
    } catch {
      // Open failures are silent here — the daemon logs them, and
      // surfacing a toast from a click on a chip is more noise than
      // the user wants. The chip's `title` already shows the
      // payload for manual recovery.
    }
  }

  /** Encode a LinkTarget as a compact `supergit://` href for inline
   *  markdown mentions. Three deliberate compactness choices:
   *    1. No snapshot fields — the `[label]` half of the markdown link
   *       already carries the human-readable text; chip-style metadata
   *       (subtitle/meta/agent/provider) isn't shown inline and would
   *       just bloat the URL.
   *    2. Sessions store just the sessionId (UUID) rather than the
   *       full JSONL source path. `hrefToLinkTarget` resolves the live
   *       source from `repos[].worktrees[].agents` on click — same
   *       lookup the `liveSessionLabel` derivation already does.
   *    3. URL kind passes through verbatim (no wrapping needed for a
   *       plain https link). */
  function linkTargetToHref(t: LinkTarget): string {
    if (t.type === "url") return t.value;
    let value = t.value;
    if (t.type === "session") {
      const m = t.value.match(/\/([^/]+?)\.jsonl$/i);
      if (m) value = m[1];
    }
    return `supergit://${t.type}/${encodeURIComponent(value)}`;
  }

  /** Inverse of linkTargetToHref. Returns null when the href isn't a
   *  recognized supergit:// URL — caller then treats it as a plain
   *  external link. For sessions, walks the live repos snapshot to
   *  swap a stored sessionId back to its current source path; falls
   *  back to the raw value if no live match (orphan session) so click
   *  is a safe no-op rather than wrong. */
  function hrefToLinkTarget(href: string): LinkTarget | null {
    if (!href.startsWith("supergit://")) return null;
    try {
      // Manual parse: split on the first `/` after the scheme rather
      // than relying on `new URL()`. WHATWG's URL parser doesn't
      // populate `host`/`pathname` for "special-scheme" lookalikes the
      // same way across runtimes, and our shape is fixed:
      // supergit://<type>/<value>
      const rest = href.slice("supergit://".length);
      const slash = rest.indexOf("/");
      if (slash < 0) return null;
      const type = rest.slice(0, slash) as LinkTarget["type"];
      if (!["url", "commit", "session", "file", "command"].includes(type))
        return null;
      let value = decodeURIComponent(rest.slice(slash + 1));
      if (type === "session") {
        const id = value;
        const suffix = `/${id}.jsonl`;
        outer: for (const r of repos) {
          for (const wt of r.worktrees ?? []) {
            const agents = (
              wt as { agents?: Array<{ source: string; sessionId?: string }> }
            ).agents;
            if (!agents) continue;
            // Match by sessionId first (the daemon's authoritative id),
            // then fall back to the source path ending in `<id>.jsonl`
            // for sessions whose AgentSession.sessionId isn't populated
            // (older indexed records, or the brief window after spawn
            // before the JSONL is parsed).
            const a =
              agents.find((x) => x.sessionId === id) ??
              agents.find((x) => x.source.endsWith(suffix));
            if (a) {
              value = a.source;
              break outer;
            }
          }
        }
      }
      return { type, value };
    } catch {
      return null;
    }
  }

  /** Provider-specific commit URL builder. The repo's `webUrl` is
   *  the canonical project root (`https://github.com/foo/bar`); each
   *  provider's commit page sits at a slightly different path.
   *  Returns null when we don't know how to address that provider's
   *  commit view — caller falls back to opening the git client. */
  function buildCommitWebUrl(
    webUrl: string,
    provider: string | null,
    sha: string,
  ): string | null {
    if (!webUrl || !sha) return null;
    switch (provider) {
      case "github":
      case "codeberg":
      case "sourcehut":
      case "gitea":
        return `${webUrl}/commit/${sha}`;
      case "gitlab":
        return `${webUrl}/-/commit/${sha}`;
      case "bitbucket":
        return `${webUrl}/commits/${sha}`;
      case "azure":
        return `${webUrl}/commit/${sha}`;
      default:
        return null;
    }
  }

  interface AnchorableWorktree {
    path: string;
    branch: string;
  }
  interface AnchorableRepo {
    id: string;
    name?: string;
    path: string;
    worktrees?: AnchorableWorktree[];
    customLinks?: Array<{
      id: string;
      kind?: string;
      cmd?: string;
      cwd?: string;
      runMode?: "internal" | "external" | "shell";
      name?: string;
    }>;
  }

  export let note: NoteShape;
  /** Top-left position in viewport-relative px. Parent owns this. */
  export let x: number;
  export let y: number;
  /** Deterministic per-note tilt so rerenders don't make the note jitter. */
  export let tilt = 0;
  /** Persisted user rotation accumulated from past drags (degrees,
   *  clamped to ±30 by the parent). Composes on top of the static
   *  `tilt`, so the user can fling a note to a chosen angle and it
   *  stays there across reloads, undo/redo, etc. */
  export let rotation = 0;
  /** Spawn this note in edit mode (first time the user clicks "+ note"). */
  export let startEditing = false;
  /** When true, leaving edit mode (Esc, click-outside, Save) with an empty
   *  body dispatches `remove` instead of `save`. Used by the layer to
   *  discard freshly-spawned notes that never received any text — the
   *  user clicked "+", thought twice, and clicked away. */
  export let removeIfEmpty = false;
  /** When true, the layer is currently driving this note's `x`/`y`
   *  with a per-frame rAF loop (staging → pin slot fly). */
  export let flying = false;
  /** Used by the in-note "Move to…" / "Copy to…" picker to enumerate
   *  all anchorable rows. Threaded down from the StickyNotesLayer's
   *  `repos` prop. */
  export let repos: AnchorableRepo[] = [];
  export let onCommandLinkOpen:
    | ((payload: {
        linkId: string;
        repoId?: string;
        wtPath?: string;
        revealTerminal?: boolean;
      }) => void)
    | null = null;
  export let onCommandLinkEdit:
    | ((payload: { linkId: string; repoId?: string }) => void)
    | null = null;
  export let runningCommandIds: Set<string> = new Set();
  export let commandUrls: Record<string, string[]> = {};

  const dispatch = createEventDispatcher<{
    move: {
      id: string;
      x: number;
      y: number;
      clientX: number;
      clientY: number;
    };
    /** `target` is included when kind="link" so the layer's handleSave
     *  can route both fields through a single PUT. `null` clears an
     *  existing target (kind flip from link → note). Omitting both
     *  `target` and `kind` keeps the current PUT behaviour for notes. */
    save: {
      id: string;
      body: string;
      target?: LinkTarget | null;
      kind?: AttachmentKind;
    };
    remove: { id: string };
    focus: { id: string };
    reassign: { id: string; anchor: string; mode: "move" | "duplicate" };
    rotate: { id: string; rotation: number };
    grab: { id: string; grabXFrac: number; grabYFrac: number };
    dragdrop: { id: string; clientX: number; clientY: number };
    dragcancel: { id: string };
    scale: { id: string; emojiScale: number };
  }>();

  const EMOJI_SCALE_STEPS = [0.5, 0.875, 1.25, 1.625, 2.0] as const;
  function cycleEmojiScale(): void {
    const idx = EMOJI_SCALE_STEPS.findIndex(
      (s) => Math.abs(s - emojiScale) < 0.05,
    );
    const next = EMOJI_SCALE_STEPS[(idx + 1) % EMOJI_SCALE_STEPS.length] ?? 1;
    dispatch("scale", { id: note.id, emojiScale: next });
  }

  /** Open the target in whatever app makes sense for its type.
   *
   *   url    : open in a new browser tab.
   *   commit : prefer a browser commit page when we can build one
   *            (target.provider + repo.remotes[0].webUrl + sha); else
   *            shell out to the user's preferred git client (Fork by
   *            default; configurable via localStorage). The git
   *            client opens at the worktree, then the user navigates
   *            to the sha — Fork doesn't have a `--commit=<sha>` CLI
   *            today, so worktree-at-HEAD is the best we can do.
   *   session: write to the cross-component focus store; App.svelte
   *            ensures the session is visible in the row strip,
   *            scrolls it into view, and applies a brief outline.
   *   file   : reserved for a future /api/open file path call. */
  function openTarget(t: LinkTarget): void {
    if (t.type === "url") {
      openUrl(t.value);
      return;
    }
    if (t.type === "commit") {
      // 1) Already a browser URL (legacy / hand-pasted) — just open it.
      if (/^https?:\/\//i.test(t.value)) {
        openUrl(t.value);
        return;
      }
      // 2) Build a browser URL from the repo's origin remote.
      const wtAnchor = note.anchors.find((a) => a.startsWith("worktree:"));
      const wtPath = wtAnchor?.slice("worktree:".length);
      const repo = wtPath
        ? repos.find((r) => r.worktrees?.some((w) => w.path === wtPath))
        : undefined;
      const remoteRefs =
        (
          repo as
            | {
                remotes?: Array<{
                  name: string;
                  webUrl: string | null;
                  provider: string | null;
                }>;
              }
            | undefined
        )?.remotes ?? [];
      const origin =
        remoteRefs.find((r) => r.name === "origin") ?? remoteRefs[0];
      if (origin?.webUrl) {
        const url = buildCommitWebUrl(origin.webUrl, origin.provider, t.value);
        if (url) {
          openUrl(url);
          return;
        }
      }
      // 3) Fall back to the user's preferred git client at the worktree.
      if (wtPath) {
        const preferred =
          (typeof localStorage !== "undefined"
            ? localStorage.getItem(GIT_CLIENT_PREF_KEY)
            : null) ?? "fork";
        void openInApp(wtPath, preferred);
      }
      return;
    }
    if (t.type === "session") {
      // Surface the session in App's row strip. App owns the actual
      // open / scroll / outline-highlight side effects so this side
      // of the chip stays UI-state-agnostic.
      requestSessionFocus(t.value);
      return;
    }
    if (t.type === "command") {
      const live = commandLinkForTarget(t);
      const wtAnchor = note.anchors.find((a) => a.startsWith("worktree:"));
      const wtPath =
        wtAnchor?.slice("worktree:".length) || live?.link.cwd || t.cwd;
      const repoId = live?.repo.id ?? t.repoId;
      onCommandLinkOpen?.({
        linkId: live?.link.id ?? t.value,
        ...(repoId ? { repoId } : {}),
        ...(wtPath ? { wtPath } : {}),
        revealTerminal: false,
      });
      return;
    }
    // file: TODO — `/api/open` with the resolved absolute path.
  }

  /** Live-resolved label for SESSION chips, derived from the
   *  current `repos[].worktrees[].agents` snapshot the layer
   *  passes us. When the user renames a session (sets manualTitle)
   *  the change SSE refreshes /api/repos → repos prop updates →
   *  this `$:` re-derives → the chip's displayed text updates
   *  without re-saving the link. Falls back to `null` when no
   *  live row matches (orphan session, repo not loaded yet) so
   *  the chip uses the pick-time snapshot label. */
  $: liveSessionLabel = (() => {
    if (
      note.kind !== "link" ||
      !note.target ||
      note.target.type !== "session"
    ) {
      return null;
    }
    const src = note.target.value;
    for (const r of repos) {
      for (const wt of r.worktrees ?? []) {
        const found = (wt as { agents?: AgentSession[] }).agents?.find(
          (a) => a.source === src,
        );
        if (found) return sessionDisplayTitle(found);
      }
    }
    return null;
  })();

  /** Short display label for the chip body. URLs get their host, file
   *  paths get the basename, commits get the short SHA. Falls back to
   *  the raw value when no nicer reduction applies. */
  function displayLabel(t: LinkTarget): string {
    if (t.type === "url") {
      try {
        const u = new URL(t.value);
        const host = u.hostname.replace(/^www\./, "");
        return u.pathname && u.pathname !== "/" ? `${host}${u.pathname}` : host;
      } catch {
        return t.value;
      }
    }
    if (t.type === "commit") return t.value.slice(0, 7);
    if (t.type === "command") return t.label ?? t.command ?? t.value;
    if (t.type === "file") {
      const parts = t.value.split("/");
      return parts[parts.length - 1] || t.value;
    }
    return t.value;
  }

  /** Type → glyph mapping. Kept as a function (not a const map) so
   *  the call site in the template stays tidy; the glyphs are deliberate
   *  monochrome unicode so they inherit the chip's color and don't
   *  pull in an emoji font's coloured rendering. */
  function targetIcon(t: LinkTarget | undefined): string {
    if (!t) return "🔗";
    switch (t.type) {
      case "url":
        return "↗";
      case "commit":
        return "◆";
      case "session":
        return "▶";
      case "file":
        return "▤";
      case "command":
        return "⌁";
    }
  }

  /** While the user is choosing a new anchor, the editor flips into
   *  this mode and shows the AnchorPicker. `null` = picker closed. */
  let pickerMode: "move" | "duplicate" | null = null;

  let editing = startEditing;
  let draft = note.body;
  let editAttachmentRefs: InlineAttachmentEditRef[] = [];
  let copied = false;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  let openAttachmentRaw: string | null = null;
  let openAttachmentDraft = "";
  let openAttachmentEditRefs: InlineAttachmentEditRef[] = [];
  let openAttachmentNoteEditing = false;
  let confirmingAttachmentDeleteRaw: string | null = null;
  let attachmentDeleteTimerId: ReturnType<typeof setTimeout> | null = null;
  let attachmentTextareaEl: HTMLTextAreaElement | null = null;
  /** Convenience flag — once derived it gets used a few places (CSS
   *  class, dispatch branching, removeIfEmpty math). Re-derived
   *  whenever the note prop changes so kind flips propagate. */
  $: isLink = note.kind === "link";
  $: isEmoji = note.kind === "emoji";
  $: isAppIconBody = isEmoji && isAppIconToken(note.body ?? "");
  $: appIconName = isAppIconBody ? appIconNameFromToken(note.body) : null;
  $: isSessionLink =
    isLink &&
    note.target?.type === "session" &&
    !!note.target.value &&
    note.target.agent !== "shell";

  // ── Hover chat preview ──────────────────────────────────────────
  // Session-link cards expose a hover panel that previews the last
  // few user/assistant messages of the target session. Uses the same
  // ChatPreview component + fetch helper as the session dock and the
  // session-search popover, so the rendering stays consistent.
  type StickyPreviewItem = PreviewMsg | PreviewGap | PreviewAction;
  let previewItems: StickyPreviewItem[] | undefined = undefined;
  /** Cached Ollama summary for the linked session, shown above the
   *  messages when one already exists (never generated here). */
  let previewSummary: PreviewSummary | undefined = undefined;
  let previewLoading = false;
  let previewSource: string | null = null;
  let previewOpen = false;
  let previewTop = 0;
  let previewLeft = 0;
  const PREVIEW_SHOW_DELAY_MS = 280;
  const PREVIEW_DISMISS_DELAY_MS = 120;
  const PREVIEW_POLL_MS = 1500;
  let previewShowTimer: ReturnType<typeof setTimeout> | null = null;
  let previewDismissTimer: ReturnType<typeof setTimeout> | null = null;
  let previewPoller: ReturnType<typeof setInterval> | null = null;

  function clearPreviewTimers() {
    if (previewShowTimer) {
      clearTimeout(previewShowTimer);
      previewShowTimer = null;
    }
    if (previewDismissTimer) {
      clearTimeout(previewDismissTimer);
      previewDismissTimer = null;
    }
    if (previewPoller) {
      clearInterval(previewPoller);
      previewPoller = null;
    }
  }

  async function loadStickyPreview(source: string): Promise<void> {
    const r = await fetchPreviewItems(source);
    if (r && previewSource === source) {
      previewItems = r.items;
      previewSummary = r.summary;
    }
    previewLoading = false;
  }

  function onLinkCardEnter(ev: MouseEvent | FocusEvent) {
    if (!isSessionLink || !note.target) return;
    if (previewDismissTimer) {
      clearTimeout(previewDismissTimer);
      previewDismissTimer = null;
    }
    if (previewShowTimer) clearTimeout(previewShowTimer);
    const el = ev.currentTarget as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    previewTop = r.top + r.height / 2;
    previewLeft = r.right + 8;
    const src = note.target.value;
    const open = () => {
      previewOpen = true;
      previewSource = src;
      if (!previewItems) previewLoading = true;
      void loadStickyPreview(src);
      if (previewPoller) clearInterval(previewPoller);
      previewPoller = setInterval(
        () => void loadStickyPreview(src),
        PREVIEW_POLL_MS,
      );
    };
    if (previewOpen) open();
    else previewShowTimer = setTimeout(open, PREVIEW_SHOW_DELAY_MS);
  }

  function onLinkCardLeave() {
    if (previewShowTimer) {
      clearTimeout(previewShowTimer);
      previewShowTimer = null;
    }
    if (previewDismissTimer) clearTimeout(previewDismissTimer);
    previewDismissTimer = setTimeout(() => {
      previewOpen = false;
      if (previewPoller) {
        clearInterval(previewPoller);
        previewPoller = null;
      }
      previewDismissTimer = null;
    }, PREVIEW_DISMISS_DELAY_MS);
  }

  function onPreviewPanelEnter() {
    if (previewDismissTimer) {
      clearTimeout(previewDismissTimer);
      previewDismissTimer = null;
    }
  }

  onDestroy(() => {
    clearPreviewTimers();
    if (copiedTimer) clearTimeout(copiedTimer);
    if (attachmentDeleteTimerId) clearTimeout(attachmentDeleteTimerId);
  });

  /** Move a node to document.body on mount so it escapes any
   *  transformed ancestor (the sticky's `transform: rotate(...)`
   *  would otherwise become the containing block for `position:
   *  fixed` children — fixed coords would be relative to the
   *  rotated sticky instead of the viewport). Reverses on destroy. */
  function portal(node: HTMLElement) {
    const orig = node.parentNode;
    document.body.appendChild(node);
    return {
      destroy() {
        if (orig && orig.contains(node) === false) {
          try {
            node.remove();
          } catch {}
        }
      },
    };
  }

  /** Search scope derived from the note's first worktree anchor.
   *  The MentionPicker hands this to its providers so sessions
   *  filter to the same repo and commits hit the right worktree's
   *  /api/commits endpoint.
   *
   *  IMPORTANT: a fresh object literal here would make `scope` look
   *  changed on every render of this component, which would in turn
   *  make the picker's reactive block re-fire and re-fetch on every
   *  paint. Hold the values in a stable object and only reassign
   *  when one of them actually changed. */
  let pickerScope: {
    currentWorktreePath?: string;
    currentRepoPath?: string;
    currentRepoProvider?: string;
    sessionsInScope?: AgentSession[];
  } = {};
  $: {
    const wtAnchor = note.anchors.find((a) => a.startsWith("worktree:"));
    const wtPath = wtAnchor ? wtAnchor.slice("worktree:".length) : undefined;
    const repo = wtPath
      ? repos.find((r) => r.worktrees?.some((w) => w.path === wtPath))
      : undefined;
    const wt = wtPath
      ? repo?.worktrees?.find((w) => w.path === wtPath)
      : undefined;
    const nextRepoPath = repo?.path;
    // Pull the provider off the repo's primary remote — `origin` if
    // present, else the first detected one. Empty when the repo has
    // no remotes; the commit chip then falls back to its generic
    // ◆ glyph instead of a brand mark.
    const remoteRefs =
      (
        repo as
          | { remotes?: Array<{ name: string; provider?: string | null }> }
          | undefined
      )?.remotes ?? [];
    const origin = remoteRefs.find((r) => r.name === "origin") ?? remoteRefs[0];
    const nextProvider = origin?.provider ?? undefined;
    // The daemon's per-worktree session bucketing — same list that
    // powers the "+N sessions in this worktree" popover. Passing it
    // here makes the @-mention picker show that exact set, instead
    // of re-deriving it from /api/agents + cwd guessing.
    const nextSessions = (wt as { agents?: AgentSession[] } | undefined)
      ?.agents;
    if (
      pickerScope.currentWorktreePath !== wtPath ||
      pickerScope.currentRepoPath !== nextRepoPath ||
      pickerScope.currentRepoProvider !== nextProvider ||
      pickerScope.sessionsInScope !== nextSessions
    ) {
      pickerScope = {
        currentWorktreePath: wtPath,
        currentRepoPath: nextRepoPath,
        currentRepoProvider: nextProvider,
        sessionsInScope: nextSessions,
      };
    }
  }
  /** Inline @-mention state. Typing `@` inside the textarea (at the
   *  start of the body OR right after whitespace / newline) opens the
   *  MentionPicker as an embedded popover. The textarea keeps focus
   *  and forwards arrow/Enter/Esc keystrokes into the picker via the
   *  exported handles below. Picking inserts a markdown link with a
   *  `supergit://` href that `onBodyClick` later resolves and opens. */
  let mentionOpen = false;
  let mentionEditor: "note" | "attachment" = "note";
  let mentionStart = -1;
  let mentionQuery = "";
  let mentionPickerRef: {
    moveCursor: (delta: number) => void;
    commitCurrent: () => boolean;
    hasResults: () => boolean;
  } | null = null;

  /** Popover position in viewport coords. The popover lives in
   *  document.body via the `portal` action so its CSS uses
   *  `position: fixed` and reads these as top/left, with max-width
   *  clamped so it never spills off the right edge of the viewport.
   *  Recomputed whenever the textarea moves (input → autosize,
   *  scroll, resize, drag) and whenever the popover opens. */
  let popoverTop = 0;
  let popoverLeft = 0;
  let popoverMaxWidth = 840;
  let popoverMinWidth = 0;
  let popoverEl: HTMLDivElement | null = null;
  const POPOVER_MARGIN = 32;
  const POPOVER_MAX = 840;

  /** Viewport-clamped max-width for the LINK CHIP (.sticky-link)
   *  while it's in edit mode. The chip is positioned in document
   *  coords via `x`, so when it sits near the right edge of the
   *  viewport its auto-sized width (driven by the picker's
   *  max-content propagation) can extend past the viewport.
   *  Same idea as the inline popover, only on the chip itself. */
  let chipMaxWidth = POPOVER_MAX;
  function recomputeChipMaxWidth(): void {
    if (typeof window === "undefined") {
      chipMaxWidth = POPOVER_MAX;
      return;
    }
    // x is doc-relative; viewport right edge in doc coords is
    // scrollX + innerWidth. The chip lives between `x` and the
    // viewport right, minus a safety margin.
    const room = window.scrollX + window.innerWidth - x - POPOVER_MARGIN;
    chipMaxWidth = Math.max(260, Math.min(POPOVER_MAX, room));
  }
  // Reactive on x (drag/scroll repositions) and editing/isLink so
  // the math only runs while the chip is showing a picker.
  $: if (editing && isLink) {
    void x;
    recomputeChipMaxWidth();
  }

  function editorTextarea(
    target: "note" | "attachment",
  ): HTMLTextAreaElement | null {
    return target === "note" ? textareaEl : attachmentTextareaEl;
  }

  function editorText(target: "note" | "attachment"): string {
    return target === "note" ? draft : openAttachmentDraft;
  }

  function setEditorText(target: "note" | "attachment", value: string): void {
    if (target === "note") {
      draft = value;
    } else {
      openAttachmentDraft = value;
    }
  }

  function repositionMentionPopover(): void {
    const activeTextarea = editorTextarea(mentionEditor);
    if (!mentionOpen || !activeTextarea) return;
    const r = activeTextarea.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Cap horizontal space against the viewport edges, with a small
    // safety margin. The popover floors at the textarea width below
    // so a long search query still has typing room.
    let maxW = Math.min(POPOVER_MAX, vw - POPOVER_MARGIN * 2);
    if (maxW < r.width) maxW = r.width;
    // Default: align with the textarea's left edge. If extending
    // rightward by maxW would cross the viewport, slide the popover
    // left until it fits (clamped to the left edge).
    let left = r.left;
    if (left + maxW > vw - POPOVER_MARGIN) {
      left = Math.max(POPOVER_MARGIN, vw - POPOVER_MARGIN - maxW);
    }
    // Vertical: prefer below the textarea, but flip above when the
    // popover wouldn't fit between textarea-bottom and the viewport
    // bottom (e.g. a sticky in the middle of the screen with the
    // page scrolled up — below would overrun the fold). Uses the
    // popover's measured height when available, else a conservative
    // estimate so the first paint doesn't pop in below the fold.
    const measuredH = popoverEl?.offsetHeight ?? 0;
    const estH = measuredH > 0 ? measuredH : Math.min(vh - 64, 320);
    const spaceBelow = vh - r.bottom - POPOVER_MARGIN;
    const spaceAbove = r.top - POPOVER_MARGIN;
    let top: number;
    if (spaceBelow >= estH || spaceBelow >= spaceAbove) {
      top = r.bottom + 4;
    } else {
      top = Math.max(POPOVER_MARGIN, r.top - estH - 4);
    }
    popoverTop = top;
    popoverLeft = left;
    popoverMaxWidth = maxW;
    popoverMinWidth = r.width;
  }

  function closeMention(): void {
    mentionOpen = false;
    mentionEditor = "note";
    mentionStart = -1;
    mentionQuery = "";
  }

  // Reposition the popover whenever:
  //  - it opens (textarea position picked up for the first time)
  //  - the user types (textarea autosizes → bottom moves)
  //  - the query changes (picker list height changes)
  // The void-references force Svelte to keep these in the dep set.
  $: if (mentionOpen) {
    void mentionQuery;
    void draft;
    void openAttachmentDraft;
    // popoverEl in the dep list so the reposition re-runs once the
    // popover element has actually been mounted — first call uses
    // the height estimate, the follow-up uses the real measurement
    // (so the above/below flip can correct itself if needed).
    void popoverEl;
    queueMicrotask(repositionMentionPopover);
  }

  function onTextareaInput(target: "note" | "attachment" = "note"): void {
    const activeTextarea = editorTextarea(target);
    if (!activeTextarea) return;
    const caret = activeTextarea.selectionStart ?? 0;
    const text = editorText(target);
    if (mentionOpen) {
      if (mentionEditor !== target) return;
      // Track the live query span between the `@` and the caret.
      // Close if the user erased the `@`, moved the caret behind it,
      // or typed whitespace (mentions are single-token by design).
      if (
        mentionStart < 0 ||
        text[mentionStart] !== "@" ||
        caret <= mentionStart
      ) {
        closeMention();
        return;
      }
      const span = text.slice(mentionStart + 1, caret);
      if (/\s/.test(span)) {
        closeMention();
        return;
      }
      mentionQuery = span;
      return;
    }
    // Detect a fresh `@` at the start of the body or after whitespace.
    if (caret > 0 && text[caret - 1] === "@") {
      const prev = caret >= 2 ? text[caret - 2] : "";
      if (caret === 1 || prev === " " || prev === "\t" || prev === "\n") {
        mentionStart = caret - 1;
        mentionQuery = "";
        mentionOpen = true;
        mentionEditor = target;
      }
    }
  }

  function onMentionPick(e: CustomEvent<PickItem>): void {
    const targetEditor = mentionEditor;
    const activeTextarea = editorTextarea(targetEditor);
    if (!mentionOpen || !activeTextarea) return;
    const item = e.detail;
    const target: LinkTarget = {
      type: item.targetType,
      value: item.value,
      ...(item.label !== undefined ? { label: item.label } : {}),
      ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
      ...(item.meta !== undefined ? { meta: item.meta } : {}),
      ...(item.agent !== undefined ? { agent: item.agent } : {}),
      ...(item.provider !== undefined ? { provider: item.provider } : {}),
    };
    const label = (item.label || item.value).replace(/[\[\]]/g, "");
    const href = linkTargetToHref(target);
    const insertion = `[@${label}](${href})`;
    const text = editorText(targetEditor);
    const caret = activeTextarea.selectionStart ?? mentionStart + 1;
    const before = text.slice(0, mentionStart);
    const after = text.slice(caret);
    setEditorText(targetEditor, before + insertion + after);
    pushRecent(item);
    const newCaret = before.length + insertion.length;
    closeMention();
    queueMicrotask(() => {
      const nextTextarea = editorTextarea(targetEditor);
      if (!nextTextarea) return;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(newCaret, newCaret);
      // Re-run autosize so the textarea re-measures with the inserted text.
      nextTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** Click delegate on the rendered note body: intercept
   *  `supergit://` links and route them through openTarget; let plain
   *  http(s) anchors open in a new tab. Markdown produces real
   *  `<a href>`s; this lets inline mentions behave identically to the
   *  standalone link chip without re-rendering Svelte for each one. */
  function onBodyClick(e: MouseEvent): void {
    const t = e.target as HTMLElement | null;
    const a = t?.closest("a") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("supergit://")) {
      e.preventDefault();
      const target = hrefToLinkTarget(href);
      if (target) openTarget(target);
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      openUrl(href);
    }
  }

  function textSourceFromClipboardData(cd: DataTransfer | null): {
    kind: "clipboard";
    types: string[];
  } {
    return {
      kind: "clipboard",
      types: cd ? Array.from(cd.types) : [],
    };
  }

  function insertIntoDraft(
    text: string,
    target: "note" | "attachment" = "note",
  ): void {
    const activeTextarea = editorTextarea(target);
    const current = editorText(target);
    if (!activeTextarea) {
      setEditorText(target, current + text);
      return;
    }
    const start = activeTextarea.selectionStart ?? current.length;
    const end = activeTextarea.selectionEnd ?? start;
    setEditorText(target, current.slice(0, start) + text + current.slice(end));
    const caret = start + text.length;
    queueMicrotask(() => {
      const nextTextarea = editorTextarea(target);
      if (!nextTextarea) return;
      nextTextarea.focus();
      nextTextarea.setSelectionRange(caret, caret);
      nextTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function prepareBodyForEdit(body: string): string {
    const edit = noteBodyToEditText(body);
    editAttachmentRefs = edit.refs;
    return edit.text;
  }

  function bodyFragmentToEditText(
    body: string,
    target: "note" | "attachment" = "note",
  ): string {
    const existingRefs =
      target === "note" ? editAttachmentRefs : openAttachmentEditRefs;
    const usedText = target === "note" ? draft : openAttachmentDraft;
    const edit = noteBodyToEditText(body, {
      existingRefs,
      usedText,
    });
    if (target === "note") {
      editAttachmentRefs = [...editAttachmentRefs, ...edit.refs];
    } else {
      openAttachmentEditRefs = [...openAttachmentEditRefs, ...edit.refs];
    }
    return edit.text;
  }

  function insertBodyIntoDraft(
    body: string,
    target: "note" | "attachment" = "note",
  ): void {
    insertIntoDraft(bodyFragmentToEditText(body, target), target);
  }

  function insertAttachmentRef(
    ref: string,
    target: "note" | "attachment" = "note",
  ): void {
    const part = parseInlineAttachments(ref)[0];
    if (target === "attachment") {
      insertBodyIntoDraft(ref, "attachment");
      return;
    }
    if (editing && !isLink && part?.kind === "attachment") {
      insertBodyIntoDraft(ref);
      return;
    }
    insertIntoNoteBody(ref);
  }

  function insertIntoNoteBody(text: string): void {
    if (editing && !isLink) {
      insertIntoDraft(text);
      return;
    }
    const sep = note.body && !note.body.endsWith("\n") ? "\n" : "";
    dispatch("save", { id: note.id, body: `${note.body}${sep}${text}` });
  }

  async function uploadImageAttachment(
    blob: Blob,
    opts: {
      filename?: string;
      source: { kind: "clipboard" | "drop"; types: string[] };
    },
    target: "note" | "attachment" = "note",
  ): Promise<void> {
    try {
      const shrunk = await shrinkImageBlob(blob);
      const form = new FormData();
      form.append(
        "file",
        opts.filename
          ? new File([shrunk], opts.filename, { type: shrunk.type })
          : shrunk,
      );
      const res = await fetch("/api/attach", { method: "POST", body: form });
      if (!res.ok) throw new Error(`attach failed: ${res.status}`);
      const { path } = (await res.json()) as { path: string };
      const ref = makeImageAttachmentRef({
        path,
        filename: opts.filename,
        mimeType: shrunk.type || blob.type || undefined,
        size: shrunk.size,
        source: {
          ...opts.source,
          ...(opts.filename ? { filename: opts.filename } : {}),
        },
      });
      insertAttachmentRef(ref, target);
    } catch (err) {
      console.warn("Could not save image attachment", err);
    }
  }

  async function uploadTextAttachment(
    text: string,
    source: { kind: "clipboard"; types: string[] },
    target: "note" | "attachment" = "note",
  ): Promise<void> {
    try {
      const mimeType = inferPastedTextMimeType(text, source.types);
      const filename = pastedTextFilenameForMime(mimeType);
      const blob = new Blob([text], { type: mimeType });
      const file = new File([blob], filename, { type: mimeType });
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/attach", { method: "POST", body: form });
      if (!res.ok) throw new Error(`attach failed: ${res.status}`);
      const { path } = (await res.json()) as { path: string };
      insertAttachmentRef(
        makeTextAttachmentRef({
          path,
          filename,
          mimeType,
          size: blob.size,
          charCount: Array.from(text).length,
          lineCount: countTextLines(text),
          source,
        }),
        target,
      );
    } catch (err) {
      console.warn("Could not save text attachment", err);
    }
  }

  function insertClipboardNotePayloadFromHtml(
    html: string,
    target: "note" | "attachment" = "note",
  ): boolean {
    const payload = extractNoteClipboardPayloadFromHtml(html);
    if (!payload) return false;
    insertBodyIntoDraft(payload.body, target);
    return true;
  }

  function onTextareaPaste(
    e: ClipboardEvent,
    target: "note" | "attachment" = "note",
  ): void {
    const cd = e.clipboardData;
    if (!cd) return;
    if (insertClipboardNotePayloadFromHtml(cd.getData("text/html"), target)) {
      e.preventDefault();
      return;
    }
    for (const item of cd.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        void uploadImageAttachment(
          file,
          {
            filename: file.name && file.name !== "blob" ? file.name : undefined,
            source: { kind: "clipboard", types: Array.from(cd.types) },
          },
          target,
        );
        return;
      }
    }
    const text = cd.getData("text/plain");
    if (text && shouldAttachPastedText(text)) {
      e.preventDefault();
      void uploadTextAttachment(text, textSourceFromClipboardData(cd), target);
    }
  }

  function isAttachmentZoneTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      !!target.closest("[data-note-attachment-zone]")
    );
  }

  function onNoteDragOver(e: DragEvent): void {
    if (isLink || isEmoji || !attachmentDropAvailable) return;
    if (!isAttachmentZoneTarget(e.target)) return;
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }

  function onNoteDragLeave(_e: DragEvent): void {}

  function onNoteDrop(e: DragEvent): void {
    if (isLink || isEmoji || !attachmentDropAvailable) return;
    if (!isAttachmentZoneTarget(e.target)) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    const image = files.find((file) => file.type.startsWith("image/"));
    if (!image) return;
    e.preventDefault();
    void uploadImageAttachment(image, {
      filename: image.name,
      source: {
        kind: "drop",
        types: e.dataTransfer ? Array.from(e.dataTransfer.types) : [],
      },
    });
  }

  async function copyNoteBody(body: string, id?: string): Promise<void> {
    let text: string;
    let payload: ReturnType<typeof makeNoteClipboardPayload>;
    try {
      text = await expandNoteBodyForCopyAsync(body, fetchTextAttachment);
      payload = makeNoteClipboardPayload({ ...(id ? { id } : {}), body, text });
    } catch (err) {
      console.warn("Could not read note attachments for copy", err);
      return;
    }

    try {
      const ClipboardItemCtor = (
        globalThis as typeof globalThis & {
          ClipboardItem?: typeof ClipboardItem;
        }
      ).ClipboardItem;
      if (navigator.clipboard?.write && ClipboardItemCtor) {
        await navigator.clipboard.write([
          new ClipboardItemCtor({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([makeNoteClipboardHtml(payload, text)], {
              type: "text/html",
            }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      copied = true;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 1200);
    } catch (err) {
      console.warn("Could not copy note", err);
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
        if (copiedTimer) clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => (copied = false), 1200);
      } catch {
        // Clipboard denial is already visible: the button simply
        // doesn't flip to "copied".
      }
    }
  }

  async function copyNote(): Promise<void> {
    if (note.kind === "link" && note.target?.type === "command") {
      try {
        await navigator.clipboard.writeText(liveCommandRunText(note.target));
        copied = true;
        if (copiedTimer) clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => (copied = false), 1200);
      } catch (err) {
        console.warn("Could not copy command", err);
      }
      return;
    }
    await copyNoteBody(note.body, note.id);
  }

  async function textForAttachment(
    attachment: InlineAttachment,
  ): Promise<string> {
    if (attachment.kind !== "text") return "";
    return fetchTextAttachment(attachment.path);
  }

  function openInlineAttachment(
    raw: string,
    attachment: InlineAttachment,
  ): void {
    cancelPendingAttachmentDelete();
    openAttachmentRaw = raw;
    openAttachmentEditRefs = [];
    openAttachmentNoteEditing = false;
    if (attachment.kind === "note") {
      openAttachmentDraft = attachment.body;
      return;
    }
    if (attachment.kind === "emoji") {
      openAttachmentDraft = attachment.body;
      return;
    }
    if (attachment.kind === "link") {
      openAttachmentDraft = attachment.target.label ?? attachment.target.value;
      return;
    }
    openAttachmentDraft = attachment.kind === "text" ? "" : attachment.path;
    if (attachment.kind === "text") {
      void textForAttachment(attachment)
        .then((text) => {
          if (openAttachmentRaw !== raw) return;
          openAttachmentDraft = text;
          openAttachmentEditRefs = [];
          queueMicrotask(() => {
            attachmentTextareaEl?.dispatchEvent(
              new Event("input", { bubbles: true }),
            );
          });
        })
        .catch((err) => console.warn("Could not read text attachment", err));
    }
  }

  function closeInlineAttachment(): void {
    if (mentionEditor === "attachment") closeMention();
    cancelPendingAttachmentDelete();
    openAttachmentRaw = null;
    openAttachmentDraft = "";
    openAttachmentEditRefs = [];
    openAttachmentNoteEditing = false;
  }

  function openAttachmentByStep(step: number): void {
    if (!openAttachmentRaw || attachmentParts.length < 2) return;
    const index = attachmentParts.findIndex(
      (part) => part.raw === openAttachmentRaw,
    );
    if (index < 0) return;
    const next =
      attachmentParts[
        (index + step + attachmentParts.length) % attachmentParts.length
      ];
    if (next) openInlineAttachment(next.raw, next.attachment);
  }

  function onAttachmentModalKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeInlineAttachment();
      return;
    }
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !(e.target instanceof HTMLTextAreaElement) &&
      !(e.target instanceof HTMLInputElement) &&
      !(e.target instanceof HTMLElement && e.target.isContentEditable)
    ) {
      e.preventDefault();
      e.stopPropagation();
      openAttachmentByStep(e.key === "ArrowLeft" ? -1 : 1);
    }
  }

  function onAttachmentWindowKeydown(e: KeyboardEvent): void {
    if (!openAttachmentRaw) return;
    if (e.key !== "Escape" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
      return;
    }
    const target = e.target;
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      (target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement ||
        (target instanceof HTMLElement && target.isContentEditable))
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.key === "Escape") {
      closeInlineAttachment();
    } else {
      openAttachmentByStep(e.key === "ArrowLeft" ? -1 : 1);
    }
  }

  function mergeInlineAttachment(raw: string, replacement: string): void {
    const body = note.body.replace(raw, replacement);
    closeInlineAttachment();
    dispatch("save", { id: note.id, body });
  }

  function openAttachmentKind(): InlineAttachment["kind"] | null {
    if (!openAttachmentRaw) return null;
    return (
      attachmentParts.find((part) => part.raw === openAttachmentRaw)?.attachment
        .kind ?? null
    );
  }

  function mergeOpenTextAttachment(): void {
    if (!openAttachmentRaw) return;
    const body = restoreEditTextAttachments(
      openAttachmentDraft,
      openAttachmentEditRefs,
    );
    mergeInlineAttachment(openAttachmentRaw, body);
  }

  function saveOpenNoteAttachment(): void {
    if (!openAttachmentRaw) return;
    const body = restoreEditTextAttachments(
      openAttachmentDraft,
      openAttachmentEditRefs,
    );
    const replacement = makeNoteAttachmentRef({ body });
    const nextBody = note.body.replace(openAttachmentRaw, replacement);
    closeInlineAttachment();
    if (nextBody === note.body) return;
    dispatch("save", { id: note.id, body: nextBody });
  }

  function startOpenNoteAttachmentEdit(attachment: InlineAttachment): void {
    if (attachment.kind !== "note") return;
    const edit = noteBodyToEditText(attachment.body);
    openAttachmentDraft = edit.text;
    openAttachmentEditRefs = edit.refs;
    openAttachmentNoteEditing = true;
  }

  function attachmentCopyText(attachment: InlineAttachment): Promise<string> {
    if (attachment.kind === "text") return fetchTextAttachment(attachment.path);
    if (attachment.kind === "image") return Promise.resolve(attachment.path);
    if (attachment.kind === "note" || attachment.kind === "emoji") {
      return Promise.resolve(attachment.body);
    }
    if (attachment.target.type === "session") {
      return Promise.resolve(`Session: ${attachment.target.value}`);
    }
    if (attachment.target.type === "command") {
      return Promise.resolve(liveCommandRunText(attachment.target));
    }
    return Promise.resolve(attachment.target.label ?? attachment.target.value);
  }

  async function copyOpenAttachment(
    attachment: InlineAttachment,
  ): Promise<void> {
    try {
      const text = await attachmentCopyText(attachment);
      await navigator.clipboard.writeText(text);
      copied = true;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 1200);
    } catch (err) {
      console.warn("Could not copy attachment", err);
    }
  }

  function editOpenAttachment(raw: string, attachment: InlineAttachment): void {
    cancelPendingAttachmentDelete();
    if (attachment.kind === "note") {
      startOpenNoteAttachmentEdit(attachment);
      return;
    }
    if (attachment.kind === "text") {
      queueMicrotask(() => attachmentTextareaEl?.focus());
      return;
    }
    if (isCommandAttachment(attachment)) {
      editCommandTarget(attachment.target);
      return;
    }
    closeInlineAttachment();
    startEdit();
  }

  function cancelPendingAttachmentDelete(): void {
    if (attachmentDeleteTimerId !== null) {
      clearTimeout(attachmentDeleteTimerId);
      attachmentDeleteTimerId = null;
    }
    confirmingAttachmentDeleteRaw = null;
  }

  function deleteOpenAttachment(raw: string): void {
    if (confirmingAttachmentDeleteRaw === raw) {
      cancelPendingAttachmentDelete();
      return;
    }
    cancelPendingAttachmentDelete();
    confirmingAttachmentDeleteRaw = raw;
    attachmentDeleteTimerId = setTimeout(() => {
      attachmentDeleteTimerId = null;
      confirmingAttachmentDeleteRaw = null;
      if (detachedAttachmentPart?.raw === raw) {
        closeInlineAttachment();
        dispatch("remove", { id: note.id });
        return;
      }
      const body = removeInlineAttachmentRef(note.body, raw);
      closeInlineAttachment();
      if (body !== note.body) dispatch("save", { id: note.id, body });
    }, DELETE_GRACE_MS);
  }

  function onInlineAttachmentDragStart(
    e: DragEvent,
    raw: string,
    attachment: InlineAttachment,
  ): void {
    if (!e.dataTransfer) return;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(
      INLINE_ATTACHMENT_DRAG_MIME,
      JSON.stringify({ sourceNoteId: note.id, raw, attachment }),
    );
    e.dataTransfer.setData("text/plain", inlineAttachmentLabel(attachment));
  }

  async function mergeTextAttachment(
    raw: string,
    attachment: InlineAttachment,
  ): Promise<void> {
    if (attachment.kind !== "text") return;
    try {
      mergeInlineAttachment(raw, await textForAttachment(attachment));
    } catch (err) {
      console.warn("Could not read text attachment", err);
    }
  }

  function mergeNoteAttachment(
    raw: string,
    attachment: InlineAttachment,
  ): void {
    if (attachment.kind !== "note") return;
    mergeInlineAttachment(raw, attachment.body);
  }

  /** Two-step delete: clicking × arms a 3-second countdown (rather
   *  than firing immediately) so the user has a generous window to
   *  back out. The button glyph swaps to ■ while armed; a second
   *  click on it cancels. The countdown is also bailed out by
   *  entering edit mode (the user clearly didn't mean to discard) and
   *  by unmounting the component (component teardown shouldn't
   *  silently delete the underlying note). */
  const DELETE_GRACE_MS = 2000;
  let confirmingDelete = false;
  let deleteTimerId: ReturnType<typeof setTimeout> | null = null;
  let dragging = false;
  let dragDx = 0;
  let dragDy = 0;
  let textareaEl: HTMLTextAreaElement | null = null;
  let stickyEl: HTMLDivElement;
  let lastMouseX = 0;
  let dragStartClientX = 0;
  let dragStartClientY = 0;
  let dragMoved = false;
  let suppressNextClick = false;

  /** Drag-tilt physics: rotation added to the base `--tilt` while the
   *  user is dragging horizontally, so the note feels like a piece of
   *  paper trailing behind the cursor. We accumulate each horizontal
   *  pixel into a small rotation delta, then hand the release velocity
   *  to a simple spring swing on mouseup. */
  let dragRotation = 0;
  const DRAG_SCALE = 0.1;
  const DRAG_ROTATION_MAX = 10;
  let velocityEma = 0;
  let swingAngle = 0;
  let swingVelocity = 0;
  let swingRaf: number | null = null;
  const VELOCITY_ALPHA = 0.4;
  const SPRING_K = 0.06;
  const SPRING_DAMPING = 0.85;
  const SPRING_SETTLE = 0.05;

  function tickSwing(): void {
    swingVelocity += -SPRING_K * swingAngle;
    swingVelocity *= SPRING_DAMPING;
    swingAngle += swingVelocity;
    if (
      Math.abs(swingAngle) < SPRING_SETTLE &&
      Math.abs(swingVelocity) < SPRING_SETTLE
    ) {
      swingAngle = 0;
      swingVelocity = 0;
      swingRaf = null;
      return;
    }
    swingRaf = requestAnimationFrame(tickSwing);
  }

  function stopSwing(): void {
    if (swingRaf !== null) {
      cancelAnimationFrame(swingRaf);
      swingRaf = null;
    }
    swingAngle = 0;
    swingVelocity = 0;
  }
  /** Grab point inside the note as a fraction of the box (0..1). Set
   *  on mousedown and used as the `transform-origin` so the rotation
   *  pivots under the cursor. The note's `left/top` already track
   *  the cursor via `dragDx/Dy`, so the grab point's *screen*
   *  position stays anchored to the cursor — rotation just spins
   *  the rest of the box around it. Persisted across drags so the
   *  final rotation reads the same after release as it did mid-drag. */
  export let grabXFrac = 0;
  export let grabYFrac = 0;
  export let emojiScale = 1;
  export let attachmentDropAvailable = false;
  export let attachmentDropActive = false;
  export let attachmentDropSourceActive = false;
  let liveGrabXFrac: number | null = null;
  let liveGrabYFrac: number | null = null;
  $: effectiveGrabXFrac = liveGrabXFrac ?? grabXFrac;
  $: effectiveGrabYFrac = liveGrabYFrac ?? grabYFrac;
  let textStatsByPath: Record<
    string,
    { lineCount: number; charCount: number }
  > = {};
  const pendingTextStats = new Set<string>();
  $: showAttachmentDropActive = attachmentDropActive;

  onMount(() => {
    if (editing && !isLink && textareaEl) {
      draft = prepareBodyForEdit(note.body);
      // Note-kind edit: textarea gets caret-at-end so re-edits feel
      // like "append" rather than "overwrite". Link-kind delegates
      // focus to MentionPicker, which manages its own input.
      queueMicrotask(() => {
        if (!textareaEl) return;
        textareaEl.focus();
        const end = textareaEl.value.length;
        textareaEl.setSelectionRange(end, end);
        textareaEl.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    // Click-outside-to-save: when the note is in edit mode and the
    // user mousedowns anywhere outside this sticky's box (including
    // its popover descendants — they're inside stickyEl), commit
    // the current draft. Mousedown rather than click so we beat any
    // focus / blur shuffling that might happen on the next element.
    const onWindowDown = (e: MouseEvent) => {
      if (!editing) return;
      const t = e.target as Node | null;
      if (!t || !stickyEl) return;
      if (stickyEl.contains(t)) return;
      saveEdit();
    };
    window.addEventListener("mousedown", onWindowDown);
    // Esc cancels a pending delete from anywhere — the user may not
    // have focus on the stop button when they think "wait, no". The
    // existing textarea handler also treats Esc as cancel-edit, but
    // entering edit mode already cleared confirmingDelete, so the two
    // paths can't both fire on the same press.
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirmingDelete) {
        e.preventDefault();
        cancelPendingDelete();
      }
    };
    window.addEventListener("keydown", onWindowKey);
    // Reposition the @-mention popover when the page scrolls or the
    // viewport resizes — the popover is portaled to <body> with fixed
    // coords, so anything moving the textarea relative to the
    // viewport needs to retrigger the clamp-to-viewport math.
    const onWindowReflow = () => {
      if (mentionOpen) repositionMentionPopover();
      if (editing && isLink) recomputeChipMaxWidth();
    };
    window.addEventListener("scroll", onWindowReflow, true);
    window.addEventListener("resize", onWindowReflow);
    return () => {
      window.removeEventListener("mousedown", onWindowDown);
      window.removeEventListener("keydown", onWindowKey);
      window.removeEventListener("scroll", onWindowReflow, true);
      window.removeEventListener("resize", onWindowReflow);
      stopSwing();
      cancelPendingDelete();
    };
  });

  function onMouseDownHeader(e: MouseEvent): void {
    startMouseDrag(e, false);
  }

  function onMouseDownCard(e: MouseEvent): void {
    startMouseDrag(e, true);
  }

  function startMouseDrag(e: MouseEvent, allowButtonTarget: boolean): void {
    // Only drag with primary button; ignore clicks on buttons inside header.
    if (e.button !== 0) return;
    if (!allowButtonTarget && (e.target as HTMLElement).closest("button"))
      return;
    dragging = true;
    dragMoved = false;

    const w = stickyEl?.offsetWidth || 240;
    const h = stickyEl?.offsetHeight || 1;
    const cxDoc = e.clientX + window.scrollX;
    const cyDoc = e.clientY + window.scrollY;

    const oldGx = effectiveGrabXFrac * w;
    const oldGy = effectiveGrabYFrac * h;
    const oldPivotDocX = x + oldGx;
    const oldPivotDocY = y + oldGy;
    const cdx = cxDoc - oldPivotDocX;
    const cdy = cyDoc - oldPivotDocY;
    const R = (displayedTilt * Math.PI) / 180;
    const cosR = Math.cos(R);
    const sinR = Math.sin(R);
    const bdx = cosR * cdx + sinR * cdy;
    const bdy = -sinR * cdx + cosR * cdy;
    const newGx = Math.max(0, Math.min(w, oldGx + bdx));
    const newGy = Math.max(0, Math.min(h, oldGy + bdy));
    const newGxFrac = w > 0 ? newGx / w : 0;
    const newGyFrac = h > 0 ? newGy / h : 0;
    liveGrabXFrac = newGxFrac;
    liveGrabYFrac = newGyFrac;
    dragDx = newGx;
    dragDy = newGy;
    lastMouseX = e.clientX;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    dragRotation = 0;
    stopSwing();
    velocityEma = 0;

    dispatch("grab", {
      id: note.id,
      grabXFrac: newGxFrac,
      grabYFrac: newGyFrac,
    });
    dispatch("move", {
      id: note.id,
      x: cxDoc - newGx,
      y: cyDoc - newGy,
      clientX: e.clientX,
      clientY: e.clientY,
    });
    dispatch("focus", { id: note.id });

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragging) return;
    const dx = e.clientX - lastMouseX;
    lastMouseX = e.clientX;
    velocityEma = velocityEma * (1 - VELOCITY_ALPHA) + dx * VELOCITY_ALPHA;
    const proposed = dragRotation + dx * DRAG_SCALE;
    const minDelta = -DRAG_ROTATION_MAX - rotation;
    const maxDelta = DRAG_ROTATION_MAX - rotation;
    dragRotation = Math.max(minDelta, Math.min(maxDelta, proposed));
    if (
      Math.hypot(e.clientX - dragStartClientX, e.clientY - dragStartClientY) > 3
    ) {
      dragMoved = true;
    }
    const nx = Math.max(0, e.clientX + window.scrollX - dragDx);
    const ny = Math.max(0, e.clientY + window.scrollY - dragDy);
    dispatch("move", {
      id: note.id,
      x: nx,
      y: ny,
      clientX: e.clientX,
      clientY: e.clientY,
    });
  }

  function onMouseUp(e: MouseEvent): void {
    const moved = dragMoved;
    dragging = false;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    if (moved) {
      suppressNextClick = true;
      setTimeout(() => (suppressNextClick = false), 0);
      dispatch("dragdrop", {
        id: note.id,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    }
    if (dragRotation !== 0) {
      const next = Math.max(
        -DRAG_ROTATION_MAX,
        Math.min(DRAG_ROTATION_MAX, rotation + dragRotation),
      );
      dispatch("rotate", { id: note.id, rotation: next });
    }
    const initialKick = velocityEma * DRAG_SCALE;
    if (Math.abs(initialKick) > 0.3) {
      stopSwing();
      swingVelocity = initialKick;
      swingAngle = 0;
      swingRaf = requestAnimationFrame(tickSwing);
    }
    dragRotation = 0;
    velocityEma = 0;
    if (!moved) {
      dispatch("dragcancel", { id: note.id });
    }
    setTimeout(() => {
      if (!dragging) {
        liveGrabXFrac = null;
        liveGrabYFrac = null;
      }
    }, 0);
  }

  function onLinkBodyClick(): void {
    if (suppressNextClick || !note.target) return;
    openTarget(note.target);
  }

  function onDetachedAttachmentClick(
    raw: string,
    attachment: InlineAttachment,
  ): void {
    if (suppressNextClick) return;
    openInlineAttachment(raw, attachment);
  }

  $: displayedTilt =
    tilt +
    Math.max(
      -DRAG_ROTATION_MAX - 8,
      Math.min(DRAG_ROTATION_MAX + 8, rotation + dragRotation + swingAngle),
    );

  function cancelPendingDelete(): void {
    if (deleteTimerId !== null) {
      clearTimeout(deleteTimerId);
      deleteTimerId = null;
    }
    confirmingDelete = false;
  }

  function onDeleteClick(): void {
    if (confirmingDelete) {
      cancelPendingDelete();
      return;
    }
    confirmingDelete = true;
    deleteTimerId = setTimeout(() => {
      deleteTimerId = null;
      confirmingDelete = false;
      dispatch("remove", { id: note.id });
    }, DELETE_GRACE_MS);
  }

  function startEdit(): void {
    // Editing implies "I want to keep this note, just change it" —
    // cancel any in-flight delete so the user doesn't see their
    // freshly-typed text vanish 3 seconds later.
    cancelPendingDelete();
    draft = isLink ? note.body : prepareBodyForEdit(note.body);
    editing = true;
    play("note-edit-start");
    if (!isLink) {
      queueMicrotask(() => {
        if (textareaEl) {
          textareaEl.focus();
          const end = textareaEl.value.length;
          textareaEl.setSelectionRange(end, end);
        }
      });
    }
    // Link-kind: MentionPicker auto-focuses its own search input.
  }

  function cancelEdit(): void {
    editing = false;
    draft = note.body;
    editAttachmentRefs = [];
    // "Discard if empty" applies to both kinds, but the emptiness
    // test differs: for notes it's the markdown body, for links it's
    // the target value (the user spawned a chip and never typed a URL).
    const stillEmpty = isLink ? !note.target?.value : !note.body.trim();
    if (removeIfEmpty && stillEmpty) {
      dispatch("remove", { id: note.id });
    }
  }

  /** Picker fired a pick — translate the PickItem into a save event
   *  (target + kind), update the recents store, and exit edit mode.
   *  The redundant-save check is the same logic the note path uses,
   *  so re-picking the same item doesn't churn the events log.
   *
   *  Display snapshot (label/subtitle/meta) is captured into the
   *  target now so the chip renders instantly on reload — no
   *  per-chip /api/agents or /api/commits lookup needed. */
  function onPickerPick(e: CustomEvent<PickItem>): void {
    const item = e.detail;
    const target: LinkTarget = {
      type: item.targetType,
      value: item.value,
      ...(item.label !== undefined ? { label: item.label } : {}),
      ...(item.subtitle !== undefined ? { subtitle: item.subtitle } : {}),
      ...(item.meta !== undefined ? { meta: item.meta } : {}),
      ...(item.agent !== undefined ? { agent: item.agent } : {}),
      ...(item.provider !== undefined ? { provider: item.provider } : {}),
    };
    if (
      target.type === note.target?.type &&
      target.value === note.target?.value
    ) {
      editing = false;
      return;
    }
    pushRecent(item);
    editing = false;
    dispatch("save", { id: note.id, body: "", target, kind: "link" });
  }

  function saveEdit(): void {
    editing = false;
    if (isLink) {
      // Link kind commits via picker pick — explicit Save is a no-op
      // beyond closing the editor. If the chip was staged-and-empty
      // (no pick made), treat like cancel + discard.
      if (removeIfEmpty && !note.target?.value) {
        dispatch("remove", { id: note.id });
      }
      return;
    }
    const trimmed = restoreEditTextAttachments(draft, editAttachmentRefs);
    editAttachmentRefs = [];
    if (removeIfEmpty && !trimmed.trim()) {
      dispatch("remove", { id: note.id });
      return;
    }
    if (trimmed === note.body) return;
    play("note-edit-end");
    dispatch("save", { id: note.id, body: trimmed });
  }

  function onKey(
    e: KeyboardEvent,
    target: "note" | "attachment" = "note",
  ): void {
    // While the @-mention picker is open, the textarea forwards
    // navigation/commit keys into it. The picker decides whether the
    // current cursor maps to a real pick; if not, fall through so
    // Enter still saves the note.
    if (mentionOpen && mentionPickerRef && mentionEditor === target) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        mentionPickerRef.moveCursor(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        mentionPickerRef.moveCursor(-1);
        return;
      }
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        if (mentionPickerRef.hasResults()) {
          e.preventDefault();
          e.stopPropagation();
          mentionPickerRef.commitCurrent();
          return;
        }
        // No results yet — fall through to save.
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMention();
        return;
      }
    }
    // Enter (no modifier) saves — sticky notes are short scratchpads,
    // so plain Enter as the save shortcut is the muscle memory the
    // user wants. Shift+Enter falls through to the textarea default
    // (insert newline). Esc reverts.
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      e.stopPropagation();
      if (target === "note") {
        saveEdit();
      } else if (openAttachmentKind() === "text") {
        mergeOpenTextAttachment();
      } else {
        saveOpenNoteAttachment();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (target === "note") {
        cancelEdit();
      } else {
        closeInlineAttachment();
      }
    }
  }

  /** Hard cap on inline supergit-mention label width. Doubled from
   *  the original 30 so a session title / commit subject reads in
   *  full before the ellipsis bites — long labels still wrap inside
   *  the chip rather than ballooning the note horizontally because
   *  the chip is an inline-flex element. */
  const MAX_INLINE_LABEL_CH = 60;

  function clampLabel(s: string): string {
    return s.length <= MAX_INLINE_LABEL_CH
      ? s
      : s.slice(0, MAX_INLINE_LABEL_CH - 1) + "…";
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Resolve a session UUID → live `AgentSession` record from the
   *  current repos snapshot. Renderer uses this to pull both the
   *  display label (via `sessionDisplayTitle`) AND the agent name
   *  (for the inline-mention icon) in one pass. Returns null when
   *  nothing matches — caller falls back to the saved label. */
  function findSessionAgent(id: string): AgentSession | null {
    const suffix = `/${id}.jsonl`;
    for (const r of repos) {
      for (const wt of r.worktrees ?? []) {
        const agents = (wt as { agents?: AgentSession[] }).agents;
        if (!agents) continue;
        const found =
          agents.find((x) => x.sessionId === id) ??
          agents.find((x) => x.source.endsWith(suffix));
        if (found) return found;
      }
    }
    return null;
  }

  /** Codex's wordmark path — copied from AgentIcon.svelte. Kept here
   *  rather than imported because the inline-mention render is a
   *  string-concat / `@html` flow that can't mount Svelte components
   *  per anchor. If the canonical path ever changes in AgentIcon,
   *  both spots need the same update. */
  const CODEX_PATH =
    "M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z";

  /** Inline-icon HTML for the rendered note body's @-mention chips.
   *  Mirrors AgentIcon / AttachmentIcon's resolution so chips that
   *  appear in note text use the same brand marks as the standalone
   *  link-chip and the @-mention picker rows. Returns "" when no
   *  recognizable agent/provider — caller renders the link without
   *  an icon prefix. */
  function inlineMentionIconHtml(opts: {
    agent?: string;
    provider?: string;
  }): string {
    // Bumped from 12 → 16 so the brand marks read at a glance inside
    // the note body's handwriting-font text. The container's flexbox
    // centring (.inline-mention-icon CSS) keeps them aligned with the
    // surrounding line regardless of size.
    const size = 16;
    if (opts.agent === "claude") {
      return `<img class="inline-mention-icon" src="/agents/claude.svg" alt="" aria-hidden="true" width="${size}" height="${size}" />`;
    }
    if (opts.agent === "codex") {
      return `<svg class="inline-mention-icon" viewBox="0 0 24 24" fill="currentColor" width="${size}" height="${size}" aria-hidden="true"><path d="${CODEX_PATH}"/></svg>`;
    }
    if (opts.agent === "ollama") {
      return `<img class="inline-mention-icon" src="/agents/ollama.svg" alt="" aria-hidden="true" width="${size}" height="${size}" />`;
    }
    if (opts.agent) {
      return `<span class="inline-mention-icon agent-icon-dot agent-${escapeHtml(opts.agent)}" aria-hidden="true"></span>`;
    }
    if (opts.provider) {
      const def = iconFor(opts.provider);
      if (!def) return "";
      const paths = (def.paths ?? []).map((d) => `<path d="${d}" />`).join("");
      const circles = (def.circles ?? [])
        .map((c) => `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" />`)
        .join("");
      if (def.filled) {
        return `<svg class="inline-mention-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" stroke="none" aria-hidden="true">${paths}${circles}</svg>`;
      }
      // stroke-width bumped from 1.8 → 2.2 so the GitHub/GitLab brand
      // outlines read as solid at the inline-mention size; thinner
      // strokes faded into the surrounding text.
      return `<svg class="inline-mention-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}${circles}</svg>`;
    }
    return "";
  }

  /** Render the note body to HTML with two post-processing passes
   *  that make inline supergit-mentions feel live:
   *    1. Session links get their displayed text re-resolved from
   *       the current `repos` snapshot so renaming a session updates
   *       every note that mentions it without an edit.
   *    2. All inline-mention labels get clamped to MAX_INLINE_LABEL_CH
   *       characters with an ellipsis — the markdown source keeps the
   *       full label so the user can copy it verbatim, but the
   *       rendered chip stays a single readable token. */
  function enhanceSupergitLinks(raw: string): string {
    // `[^>]*` between the closing-quote of href and the `>` lets
    // marked-added attributes (target="_blank", rel="noopener ...")
    // pass through. Without this the regex matched only the bare
    // `<a href="...">` form that marked happened to emit on early
    // calls; once marked started adding the safety attributes,
    // matching dropped to zero and the inline icons stopped rendering.
    return raw.replace(
      /<a href="(supergit:\/\/(session|commit|file|url)\/([^"]*))"[^>]*>([^<]*)<\/a>/g,
      (_full, fullHref, kind, valEnc, savedLabel) => {
        const stripped = savedLabel.replace(/^@/, "");
        let label = stripped;
        let iconHtml = "";
        if (kind === "session") {
          const id = (() => {
            try {
              return decodeURIComponent(valEnc);
            } catch {
              return valEnc;
            }
          })();
          const found = findSessionAgent(id);
          if (found) {
            label = sessionDisplayTitle(found);
            iconHtml = inlineMentionIconHtml({ agent: found.agent });
          }
        } else if (kind === "commit") {
          // Use the note's worktree-anchored repo provider (resolved
          // into `pickerScope`) so the inline chip shows the same
          // brand mark — GitHub / GitLab / Bitbucket / ... — that the
          // standalone link chip and the picker rows use.
          const provider = pickerScope.currentRepoProvider;
          if (provider) iconHtml = inlineMentionIconHtml({ provider });
        }
        const clamped = clampLabel(label.trim() || stripped);
        return `<a href="${fullHref}" title="${escapeHtml(label)}">${iconHtml}@${escapeHtml(clamped)}</a>`;
      },
    );
  }

  function renderBody(
    body: string,
    _reposToken: AnchorableRepo[],
    _scopeToken: typeof pickerScope,
  ): string {
    if (!body.trim()) return '<p class="sticky-empty">(empty)</p>';
    const raw = DOMPurify.sanitize(
      marked.parse(body, { async: false }) as string,
    );
    return enhanceSupergitLinks(raw);
  }

  function renderInlineBody(body: string): string {
    if (!body) return "";
    const raw = DOMPurify.sanitize(marked.parseInline(body) as string);
    return enhanceSupergitLinks(raw);
  }

  function pastedTextTitle(attachment: InlineAttachment): string {
    if (attachment.kind !== "text") return inlineAttachmentLabel(attachment);
    return pastedTextTitleForMime(attachment.mimeType);
  }

  function ensureTextStats(attachment: InlineAttachment): void {
    if (attachment.kind !== "text") return;
    if (typeof attachment.lineCount === "number") return;
    if (
      textStatsByPath[attachment.path] ||
      pendingTextStats.has(attachment.path)
    )
      return;
    pendingTextStats.add(attachment.path);
    void fetchTextAttachment(attachment.path)
      .then((text) => {
        pendingTextStats.delete(attachment.path);
        textStatsByPath = {
          ...textStatsByPath,
          [attachment.path]: {
            lineCount: countTextLines(text),
            charCount: Array.from(text).length,
          },
        };
      })
      .catch(() => {
        pendingTextStats.delete(attachment.path);
      });
  }

  function pastedTextMeta(attachment: InlineAttachment): string {
    if (attachment.kind !== "text") return "";
    ensureTextStats(attachment);
    return textAttachmentMeta(attachment, textStatsByPath[attachment.path]);
  }

  function noteAttachmentTitle(attachment: InlineAttachment): string {
    if (attachment.kind !== "note") return inlineAttachmentLabel(attachment);
    return attachment.body.trim().split(/\r?\n/)[0]?.trim() || "Note";
  }

  function linkAttachmentTitle(attachment: InlineAttachment): string {
    if (attachment.kind !== "link") return inlineAttachmentLabel(attachment);
    if (attachment.target.type === "session") {
      const found = findSessionAgent(attachment.target.value);
      if (found) return sessionDisplayTitle(found);
    }
    if (attachment.target.type === "command") {
      const live = commandLinkForTarget(attachment.target)?.link;
      return (
        live?.name ??
        live?.cmd ??
        attachment.target.label ??
        attachment.target.command ??
        attachment.target.value
      );
    }
    return attachment.target.label ?? displayLabel(attachment.target);
  }

  function linkAttachmentMeta(attachment: InlineAttachment): string {
    if (attachment.kind !== "link") return "";
    if (attachment.target.type === "command") {
      const parts = [
        isCommandRunning(attachment.target, commandStateKey) ? "ON" : "OFF",
        liveCommandMode(attachment.target, commandStateKey),
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : "command";
    }
    const parts = [attachment.target.meta, attachment.target.subtitle].filter(
      Boolean,
    );
    return parts.length ? parts.join(" · ") : attachment.target.type;
  }

  $: isCommandLink = note.kind === "link" && note.target?.type === "command";

  $: commandStateKey = [
    [...runningCommandIds].sort().join("|"),
    repos
      .map(
        (repo) =>
          `${repo.id}:${(repo.customLinks ?? [])
            .map((link) =>
              [
                link.id,
                link.kind ?? "",
                link.cmd ?? "",
                link.cwd ?? "",
                link.runMode ?? "",
                link.name ?? "",
              ].join("\u001f"),
            )
            .join("\u001e")}`,
      )
      .join("\u001d"),
  ].join("\u001c");

  $: commandUrlsKey = Object.entries(commandUrls)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, urls]) => `${id}:${urls.join("\u001f")}`)
    .join("\u001e");

  function commandLinkForTarget(
    target: LinkTarget | undefined,
  ): ReturnType<typeof resolveLiveCommandLink> {
    return resolveLiveCommandLink(target, repos);
  }

  function commandLinkIdForTarget(target: LinkTarget): string {
    return commandLinkForTarget(target)?.link.id ?? target.value;
  }

  function isCommandRunning(
    target: LinkTarget | undefined,
    stateKey = commandStateKey,
  ): boolean {
    void stateKey;
    return (
      target?.type === "command" &&
      runningCommandIds.has(commandLinkIdForTarget(target))
    );
  }

  function isCommandAttachment(
    attachment: InlineAttachment,
  ): attachment is InlineAttachment & {
    kind: "link";
    target: LinkTarget & { type: "command" };
  } {
    return attachment.kind === "link" && attachment.target.type === "command";
  }

  function liveCommandRunText(target: LinkTarget): string {
    if (target.type !== "command") return target.value;
    const link = commandLinkForTarget(target)?.link;
    return commandCopyText(target, link);
  }

  function liveCommandLabel(
    target: LinkTarget,
    stateKey = commandStateKey,
  ): string {
    void stateKey;
    if (target.type !== "command") return target.value;
    const link = commandLinkForTarget(target)?.link;
    return link?.name?.trim() || link?.cmd?.trim() || commandPowerLabel(target);
  }

  function liveCommandMode(
    target: LinkTarget,
    stateKey = commandStateKey,
  ): string {
    void stateKey;
    if (target.type !== "command") return "command";
    const live = commandLinkForTarget(target)?.link;
    const cwd = live?.cwd ?? target.cwd;
    const mode = live?.runMode ?? target.runMode;
    const modeLabel =
      mode === "internal"
        ? "hidden terminal"
        : mode === "external"
          ? "external terminal"
          : mode === "shell"
            ? "background shell"
            : "command";
    const cwdLabel = cwd?.split("/").filter(Boolean).pop();
    return cwdLabel ? `${cwdLabel} · ${modeLabel}` : modeLabel;
  }

  function commandUrlsForTarget(
    target: LinkTarget,
    urlsKey = commandUrlsKey,
  ): string[] {
    void urlsKey;
    if (target.type !== "command") return [];
    const liveId = commandLinkIdForTarget(target);
    return commandUrls[liveId] ?? commandUrls[target.value] ?? [];
  }

  function commandUrlLabel(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.port || parsed.hostname.replace(/^www\./, "");
    } catch {
      return "url";
    }
  }

  function editCommandTarget(target: LinkTarget): void {
    if (target.type !== "command") return;
    const live = commandLinkForTarget(target);
    const repoId = live?.repo.id ?? target.repoId;
    closeInlineAttachment();
    onCommandLinkEdit?.({
      linkId: live?.link.id ?? target.value,
      ...(repoId ? { repoId } : {}),
    });
  }

  function activateAttachment(raw: string, attachment: InlineAttachment): void {
    if (isCommandAttachment(attachment)) {
      openTarget(attachment.target);
      return;
    }
    openInlineAttachment(raw, attachment);
  }

  type AttachmentPart = Extract<InlineAttachmentPart, { kind: "attachment" }>;

  function visualPartsFor(
    parts: readonly InlineAttachmentPart[],
  ): AttachmentPart[] {
    const visualIndexes = visualAttachmentIndexes(parts);
    return parts.filter(
      (part, i): part is AttachmentPart =>
        part.kind === "attachment" && visualIndexes.has(i),
    );
  }

  /** Reactive HTML used by the body. Re-derives whenever the note's
   *  body changes, the live `repos` snapshot updates (so renaming a
   *  session flows into every inline mention pointing at it), or
   *  `pickerScope` changes (so a commit chip in a new note picks up
   *  the right provider brand mark on its first render). */
  let bodyParts: InlineAttachmentPart[] = [];
  $: {
    void note;
    void repos;
    void pickerScope;
    bodyParts = parseInlineAttachments(note.body);
    if (
      openAttachmentRaw &&
      !bodyParts.some(
        (part) => part.kind === "attachment" && part.raw === openAttachmentRaw,
      )
    ) {
      closeInlineAttachment();
    }
  }

  $: detachedAttachmentPart =
    !editing && bodyParts.length === 1 && bodyParts[0]?.kind === "attachment"
      ? bodyParts[0]
      : null;
  $: isDetachedAttachment = !!detachedAttachmentPart;
  $: visualAttachmentIndexesInBody = visualAttachmentIndexes(bodyParts);
  $: attachmentParts = bodyParts.filter(
    (part): part is Extract<InlineAttachmentPart, { kind: "attachment" }> =>
      part.kind === "attachment",
  );
  $: bottomVisualParts = visualPartsFor(bodyParts);

  /** Svelte action: keep a textarea's height in lockstep with its
   *  content so the user never sees a scrollbar or has to grab the
   *  resize corner. The CSS sets `resize: none` + `field-sizing:
   *  content` for browsers that support the modern property — this
   *  is the JS fallback for everywhere else. Reset to 0 before
   *  reading scrollHeight so shrinking back to a smaller value works
   *  (scrollHeight is min-bounded by the current height in some
   *  layout passes). */
  function autosize(node: HTMLTextAreaElement) {
    const resize = () => {
      node.style.height = "0";
      node.style.height = `${node.scrollHeight}px`;
    };
    resize();
    node.addEventListener("input", resize);
    return {
      update: resize,
      destroy() {
        node.removeEventListener("input", resize);
      },
    };
  }
</script>

<svelte:window on:keydown|capture={onAttachmentWindowKeydown} />

{#snippet noteMentionPopover()}
  <div
    bind:this={popoverEl}
    use:portal
    class="sticky-mention-popover"
    style:top="{popoverTop}px"
    style:left="{popoverLeft}px"
    style:max-width="{popoverMaxWidth}px"
    style:min-width="{popoverMinWidth}px"
  >
    <MentionPicker
      bind:this={mentionPickerRef}
      providers={defaultProviders}
      scope={pickerScope}
      hideInput={true}
      externalQuery={mentionQuery}
      autofocus={false}
      on:pick={onMentionPick}
      on:cancel={closeMention}
    />
  </div>
{/snippet}

{#snippet noteEditorSurface(target: "note" | "attachment")}
  <div class="sticky-textarea-wrap">
    {#if target === "note"}
      <textarea
        bind:this={textareaEl}
        class="sticky-textarea"
        bind:value={draft}
        placeholder="Write something… markdown OK. Type @ to link a session or commit. Enter saves, Shift+Enter newline, Esc reverts."
        on:keydown={(e) => onKey(e, "note")}
        on:paste={(e) => onTextareaPaste(e, "note")}
        on:input={() => onTextareaInput("note")}
        use:autosize
      ></textarea>
    {:else}
      <textarea
        bind:this={attachmentTextareaEl}
        class="sticky-textarea"
        bind:value={openAttachmentDraft}
        placeholder="Write something… markdown OK. Type @ to link a session or commit. Enter saves, Shift+Enter newline, Esc reverts."
        on:keydown={(e) => onKey(e, "attachment")}
        on:paste={(e) => onTextareaPaste(e, "attachment")}
        on:input={() => onTextareaInput("attachment")}
        use:autosize
      ></textarea>
    {/if}
    {#if mentionOpen && mentionEditor === target}
      {@render noteMentionPopover()}
    {/if}
  </div>
{/snippet}

{#snippet renderedNoteBody(
  parts: InlineAttachmentPart[],
  visualIndexes: Set<number>,
  visualParts: AttachmentPart[],
  interactive: boolean,
)}
  {#each parts as part, i}
    {#if part.kind === "text"}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      {@html parts.length === 1
        ? renderBody(part.text, repos, pickerScope)
        : renderInlineBody(part.text)}
    {:else if !visualIndexes.has(i)}
      <InlineAttachmentChip
        attachment={part.attachment}
        raw={part.raw}
        selected={interactive && openAttachmentRaw === part.raw}
        draggable={interactive}
        onDragStart={(e) => {
          if (interactive)
            onInlineAttachmentDragStart(e, part.raw, part.attachment);
        }}
        onOpen={() => {
          if (interactive) activateAttachment(part.raw, part.attachment);
        }}
        onMerge={() => {
          if (!interactive) return;
          if (part.attachment.kind === "text") {
            void mergeTextAttachment(part.raw, part.attachment);
          } else if (part.attachment.kind === "note") {
            mergeNoteAttachment(part.raw, part.attachment);
          }
        }}
      />
    {/if}
  {/each}
  {#if visualParts.length > 0}
    <div
      class="sticky-trailing-attachments"
      class:stacked={visualParts.length > 1}
    >
      {#each visualParts as visual, j}
        <button
          type="button"
          class={`sticky-trailing-card tilt-${j % 5}`}
          class:sticky-trailing-card-emoji={visual.attachment.kind === "emoji"}
          class:sticky-trailing-card-image={visual.attachment.kind === "image"}
          class:sticky-trailing-card-text={visual.attachment.kind === "text"}
          class:sticky-trailing-card-note={visual.attachment.kind === "note"}
          class:sticky-trailing-card-link={visual.attachment.kind === "link"}
          class:sticky-trailing-card-command={isCommandAttachment(
            visual.attachment,
          )}
          draggable={interactive}
          title="View attachment"
          style:--stack-index={j}
          style:--stack-count={visualParts.length}
          on:dragstart={(e) => {
            if (interactive)
              onInlineAttachmentDragStart(e, visual.raw, visual.attachment);
          }}
          on:click|stopPropagation={() => {
            if (interactive) activateAttachment(visual.raw, visual.attachment);
          }}
          on:dblclick|stopPropagation
        >
          {@render attachmentPreview(visual.attachment, "stack")}
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet attachmentPreview(
  attachment: InlineAttachment,
  mode: "detached" | "stack" | "media",
)}
  {#if attachment.kind === "image"}
    <span
      class="sticky-photo-frame"
      class:sticky-photo-frame-media={mode === "media"}
    >
      <img
        src={`/api/image?path=${encodeURIComponent(attachment.path)}`}
        alt={attachment.filename ?? "Attached image"}
        draggable={mode === "media" ? "true" : "false"}
      />
    </span>
  {:else if attachment.kind === "text"}
    <span
      class="sticky-snippet-card"
      class:sticky-snippet-card-media={mode === "media"}
    >
      <span class="sticky-snippet-icon" aria-hidden="true">T</span>
      <span class="sticky-snippet-title">{pastedTextTitle(attachment)}</span>
      <span class="sticky-snippet-meta">{pastedTextMeta(attachment)}</span>
    </span>
  {:else if attachment.kind === "emoji"}
    <span
      class={mode === "stack"
        ? "sticky-trailing-emoji"
        : "sticky-detached-emoji"}>{attachment.body}</span
    >
  {:else if attachment.kind === "note"}
    <span
      class="sticky-mini-note-card"
      class:sticky-mini-note-card-media={mode === "media"}
    >
      <span class="sticky-mini-note-icon" aria-hidden="true">✎</span>
      <span class="sticky-mini-note-title">Note</span>
      <span class="sticky-mini-note-body"
        >{noteAttachmentTitle(attachment)}</span
      >
    </span>
  {:else if attachment.kind === "link" && attachment.target.type === "command"}
    {@render commandPowerPreview(attachment.target, mode)}
  {:else if attachment.kind === "link"}
    <span
      class="attachment-link-card attach-card"
      class:attachment-link-card-stack={mode === "stack"}
      class:attachment-link-card-media={mode === "media"}
    >
      <span class="attach-card-icon" aria-hidden="true">
        <AttachmentIcon
          agent={attachment.target.agent ?? ""}
          provider={attachment.target.provider ??
            (attachment.target.type === "commit"
              ? (pickerScope.currentRepoProvider ?? "")
              : "")}
          glyph={targetIcon(attachment.target)}
          size={mode === "stack" ? 30 : 56}
        />
      </span>
      <span class="attach-card-label">{linkAttachmentTitle(attachment)}</span>
      <span class="attach-card-meta">{linkAttachmentMeta(attachment)}</span>
    </span>
  {/if}
{/snippet}

{#snippet commandPowerPreview(
  target: LinkTarget,
  mode: "detached" | "stack" | "media",
)}
  {@const running = isCommandRunning(target, commandStateKey)}
  {@const urls = commandUrlsForTarget(target, commandUrlsKey)}
  <span
    class="command-power-card"
    class:command-power-card-running={running}
    class:command-power-card-detached={mode === "detached"}
    class:command-power-card-stack={mode === "stack"}
    class:command-power-card-media={mode === "media"}
  >
    <span class="command-power-ring" aria-hidden="true">
      <span class="command-power-led"></span>
      <span class="command-power-state">{running ? "ON" : "OFF"}</span>
    </span>
    <span class="command-power-details">
      <span class="command-power-name"
        >{liveCommandLabel(target, commandStateKey)}</span
      >
      {#if mode !== "detached"}
        <span class="command-power-meta"
          >{liveCommandMode(target, commandStateKey)}</span
        >
      {/if}
    </span>
    {#if mode === "detached" && urls.length > 0}
      <span class="command-url-satellites" aria-label="Command URLs">
        {#each urls.slice(0, 4) as url, i}
          <span
            class="command-url-satellite"
            class:main={i === 0}
            role="link"
            tabindex="-1"
            title={`Open ${url}`}
            on:mousedown|stopPropagation
            on:click|stopPropagation={() => openUrl(url)}
            on:keydown={(e) => {
              if (e.key === "Enter") openUrl(url);
            }}
          >
            {commandUrlLabel(url)}
          </span>
        {/each}
      </span>
    {/if}
  </span>
{/snippet}

<div
  bind:this={stickyEl}
  class="sticky"
  class:dragging
  class:editing
  class:sticky-link={isLink}
  class:sticky-emoji={isEmoji}
  class:sticky-detached={isDetachedAttachment}
  class:sticky-command-link={isCommandLink}
  class:attachment-drop-active={showAttachmentDropActive}
  data-note-id={note.id}
  data-kind={isEmoji ? "emoji" : isLink ? "link" : "note"}
  style="left: {x}px; top: {y}px; --tilt: {displayedTilt}deg; --grab-x: {(flying
    ? 0.5
    : effectiveGrabXFrac) * 100}%; --grab-y: {(flying
    ? 0
    : effectiveGrabYFrac) * 100}%;{editing && isLink
    ? ` max-width: ${chipMaxWidth}px;`
    : ''}"
  role="dialog"
  tabindex="-1"
  aria-label={isEmoji
    ? "Emoji sticker"
    : isLink
      ? "Sticky link"
      : "Sticky note"}
  on:mousedown={() => dispatch("focus", { id: note.id })}
  on:dragover={onNoteDragOver}
  on:drop={onNoteDrop}
  on:dragleave={onNoteDragLeave}
  on:dblclick={() => {
    if (editing || isEmoji) return;
    if (note.kind === "link" && note.target?.type === "command") {
      editCommandTarget(note.target);
      return;
    }
    startEdit();
  }}
>
  <header
    class="sticky-header"
    role="toolbar"
    tabindex="-1"
    aria-label="Note actions"
    on:mousedown={onMouseDownHeader}
    title="Drag to move"
  >
    {#if !editing && !isLink && !isEmoji && !isDetachedAttachment}
      <span class="sticky-attach-indicator" aria-hidden="true">📎</span>
    {/if}
    {#if attachmentDropSourceActive}
      <span class="sticky-attach-source-indicator" aria-hidden="true">📎</span>
    {/if}
    <span class="sticky-grip" aria-hidden="true">⋮⋮</span>
    <div class="sticky-actions">
      {#if editing && !isLink}
        <!-- Save sits on the left, Cancel on the right: when the user
             clicks ✎ to enter edit mode, their cursor lands on the
             left slot of the toolbar — and the natural next action
             after typing is Save, not Cancel. Keeping the affirmative
             action under the cursor avoids a wasted aim. -->
        <button
          class="sticky-btn primary"
          on:click={saveEdit}
          title="Save (Enter)">Save</button
        >
        <button class="sticky-btn" on:click={cancelEdit} title="Cancel (Esc)"
          >Cancel</button
        >
      {:else if editing && isLink}
        <!-- Link editing is picker-driven: pick = save, Esc /
             click-outside = cancel. No explicit Cancel button — it
             was redundant with the click-outside dismiss the layer
             already handles, and the empty toolbar gives the
             picker more room to breathe. -->
      {:else}
        {#if !isEmoji}
          <button
            class="sticky-btn"
            on:click={() => void copyNote()}
            title={copied
              ? "Copied"
              : note.kind === "link" && note.target?.type === "command"
                ? "Copy command"
                : "Copy note for pasting into a session"}
            aria-label={note.kind === "link" && note.target?.type === "command"
              ? "Copy command"
              : "Copy note"}>{copied ? "✓" : "⧉"}</button
          >
        {/if}
        <button
          class="sticky-btn"
          on:click={() => {
            if (note.kind === "link" && note.target?.type === "command") {
              editCommandTarget(note.target);
              return;
            }
            startEdit();
          }}
          title={note.kind === "link" && note.target?.type === "command"
            ? "Edit command in toolbar"
            : "Edit"}
          aria-label={note.kind === "link" && note.target?.type === "command"
            ? "Edit command in toolbar"
            : "Edit"}>✎</button
        >
        <button
          class="sticky-btn danger"
          class:confirming={confirmingDelete}
          on:click={onDeleteClick}
          title={confirmingDelete
            ? "Click to cancel — note will delete in 2 seconds"
            : "Delete (3-second grace; click again to cancel)"}
          aria-label={confirmingDelete ? "Cancel pending delete" : "Delete"}
          >{confirmingDelete ? "■" : "×"}</button
        >
      {/if}
    </div>
  </header>

  {#if isEmoji}
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <span
      class="sticky-emoji-glyph"
      class:sticky-emoji-glyph-app={isAppIconBody}
      style="font-size: calc({EMOJI_STICKER_BASE_PX}px * {emojiScale})"
      on:mousedown={onMouseDownHeader}
      on:dblclick|stopPropagation={cycleEmojiScale}
      title="Drag to move — double-click to resize"
      >{#if isAppIconBody && appIconName}
        <img
          class="sticky-emoji-app-img"
          src={appIconUrl(appIconName)}
          alt={appIconName}
          draggable="false"
        />
      {:else}{note.body}{/if}</span
    >
    <button
      class="sticky-emoji-delete sticky-btn danger"
      on:click={onDeleteClick}
      title={confirmingDelete ? "Click to cancel" : "Delete"}
      aria-label={confirmingDelete ? "Cancel pending delete" : "Delete"}
      >{confirmingDelete ? "■" : "×"}</button
    >
  {:else if editing}
    {#if isLink}
      <!-- Link editor: fuzzy mention picker (sessions + commits +
           future providers). The picker IS the editor — there is no
           free-text input fallback, so paste-detection lives inside
           the picker's "use as URL" affordance instead of as a
           sibling heuristic. -->
      <MentionPicker
        providers={defaultProviders}
        scope={pickerScope}
        on:pick={onPickerPick}
        on:cancel={cancelEdit}
        placeholder="Find a session or commit…"
      />
    {:else}
      <!-- Inline @-mention popover is portaled to <body> so viewport-fixed
           coords are not skewed by the sticky's rotation. Embedded mode:
           the picker hides its own input and is driven by the textarea's
           query + forwarded arrow/enter keystrokes. -->
      {@render noteEditorSurface("note")}
    {/if}
    <!-- Footer-row of ancillary edit actions. Move-to / Copy-to live
         here (rather than the header toolbar) so the textarea — the
         primary affordance during edit — stays anchored next to
         Cancel / Save. Each button's destination Popover opens
         downward from its position; clampToViewport flips it up
         when the note is near the bottom of the viewport. Hidden for
         link kind: those are picker-driven and the footer's extra
         affordances would crowd the popover. -->
    {#if !isLink}
      <footer class="sticky-edit-footer">
        <span class="sticky-action-anchor">
          <button
            class="sticky-btn tiny"
            on:click={() =>
              (pickerMode = pickerMode === "move" ? null : "move")}
            class:active={pickerMode === "move"}
            title="Move this note to another repo/worktree">move to</button
          >
          {#if pickerMode === "move"}
            <Popover variant="agents" extraClass="sticky-anchor-popover">
              <span slot="head">Move note to…</span>
              <AnchorPicker
                {repos}
                currentAnchor={note.anchors[0] ?? null}
                on:pick={(e) => {
                  dispatch("reassign", {
                    id: note.id,
                    anchor: e.detail.anchor,
                    mode: "move",
                  });
                  pickerMode = null;
                }}
                on:cancel={() => (pickerMode = null)}
              />
            </Popover>
          {/if}
        </span>
        <span class="sticky-action-anchor">
          <button
            class="sticky-btn tiny"
            on:click={() =>
              (pickerMode = pickerMode === "duplicate" ? null : "duplicate")}
            class:active={pickerMode === "duplicate"}
            title="Duplicate this note to another repo/worktree (original stays)"
            >copy to</button
          >
          {#if pickerMode === "duplicate"}
            <Popover variant="agents" extraClass="sticky-anchor-popover">
              <span slot="head">Duplicate note to…</span>
              <AnchorPicker
                {repos}
                currentAnchor={note.anchors[0] ?? null}
                on:pick={(e) => {
                  dispatch("reassign", {
                    id: note.id,
                    anchor: e.detail.anchor,
                    mode: "duplicate",
                  });
                  pickerMode = null;
                }}
                on:cancel={() => (pickerMode = null)}
              />
            </Popover>
          {/if}
        </span>
      </footer>
    {/if}
  {:else if isLink}
    {#if note.target}
      <!-- Click-to-open chip body. We mousedown.stopPropagation so the
           click doesn't accidentally fire the surrounding focus/drag
           handlers; the actual open happens on click (mouseup) so a
           drag-out from the chip still works the way the user expects.
           Three-slot layout: icon + primary label (ellipsis) +
           subtitle + meta. Snapshot fields render verbatim when
           present; older links without a snapshot fall back to the
           value-derived `displayLabel`. -->
      <!-- Saved link uses the vertical CARD layout — distinct from
           the horizontal `.attach-row` the picker dropdown uses —
           because a pinned chip is a static artifact the user wants
           to read in full (multi-line wrap > ellipsis). Big icon
           up top, subject/title in the middle (wraps, line-clamped
           to 4 lines), muted meta line at the bottom. The picker
           rows keep .attach-row for scannable-column alignment. -->
      <button
        class={note.target.type === "command"
          ? "sticky-link-body command-power-button"
          : "sticky-link-body attach-card"}
        type="button"
        title={note.target.type === "command"
          ? `${isCommandRunning(note.target, commandStateKey) ? "Stop" : "Run"} command`
          : "Click to open"}
        on:mousedown|stopPropagation={onMouseDownCard}
        on:click={onLinkBodyClick}
        on:dblclick|stopPropagation
        on:mouseenter={onLinkCardEnter}
        on:mouseleave={onLinkCardLeave}
        on:focusin={onLinkCardEnter}
        on:focusout={onLinkCardLeave}
      >
        {#if note.target.type === "command"}
          {@render commandPowerPreview(note.target, "detached")}
        {:else}
          <span class="attach-card-icon" aria-hidden="true">
            <AttachmentIcon
              agent={note.target.agent ?? ""}
              provider={note.target.provider ??
                (note.target.type === "commit"
                  ? (pickerScope.currentRepoProvider ?? "")
                  : "")}
              glyph={targetIcon(note.target)}
              size={56}
            />
          </span>
          <span class="attach-card-label">
            {liveSessionLabel ?? note.target.label ?? displayLabel(note.target)}
          </span>
          {#if note.target.subtitle || note.target.meta}
            <span class="attach-card-meta">
              {#if note.target.meta}{note.target.meta}{/if}
              {#if note.target.meta && note.target.subtitle}
                ·
              {/if}
              {#if note.target.subtitle}{note.target.subtitle}{/if}
            </span>
          {/if}
        {/if}
      </button>
    {:else}
      <!-- Pinned but never typed — the staging path always assigns a
           target on save, so this is only reachable for a note that
           was kind-flipped to "link" without picking one yet. Show a
           neutral placeholder until the user edits. -->
      <div
        class="sticky-link-body sticky-link-empty attach-card"
        role="textbox"
        tabindex="0"
        aria-readonly="true"
        title="Double-click to edit"
      >
        <span class="attach-card-icon" aria-hidden="true">
          <AttachmentIcon glyph="🔗" size={56} />
        </span>
        <span class="attach-card-label muted">(empty link)</span>
      </div>
    {/if}
  {:else}
    {#if detachedAttachmentPart}
      <button
        type="button"
        class="sticky-detached-attachment"
        class:sticky-detached-image={detachedAttachmentPart.attachment.kind ===
          "image"}
        class:sticky-detached-text={detachedAttachmentPart.attachment.kind ===
          "text"}
        class:sticky-detached-note={detachedAttachmentPart.attachment.kind ===
          "note"}
        class:sticky-detached-link={detachedAttachmentPart.attachment.kind ===
          "link"}
        class:sticky-detached-command={isCommandAttachment(
          detachedAttachmentPart.attachment,
        )}
        title={isCommandAttachment(detachedAttachmentPart.attachment)
          ? `${isCommandRunning(detachedAttachmentPart.attachment.target, commandStateKey) ? "Stop" : "Run"} command`
          : "View attachment"}
        on:mousedown={onMouseDownCard}
        on:click={() =>
          activateAttachment(
            detachedAttachmentPart.raw,
            detachedAttachmentPart.attachment,
          )}
        on:dblclick|stopPropagation
      >
        {@render attachmentPreview(
          detachedAttachmentPart.attachment,
          "detached",
        )}
      </button>
    {:else}
      <div
        class="sticky-body"
        role="textbox"
        tabindex="0"
        aria-readonly="true"
        title="Double-click to edit"
        on:click={onBodyClick}
      >
        {@render renderedNoteBody(
          bodyParts,
          visualAttachmentIndexesInBody,
          bottomVisualParts,
          true,
        )}
      </div>
    {/if}
  {/if}

  {#if attachmentDropAvailable && !editing && !isLink && !isEmoji && !isDetachedAttachment}
    <div
      class="sticky-attachment-zone"
      class:active={showAttachmentDropActive}
      data-note-attachment-zone="true"
      title="Drop here to attach"
      aria-hidden="true"
    >
      <span class="sticky-attachment-zone-label">attach</span>
    </div>
  {/if}

  {#if openAttachmentRaw}
    {@const openIndex = attachmentParts.findIndex(
      (part) => part.raw === openAttachmentRaw,
    )}
    {@const openPart = openIndex >= 0 ? attachmentParts[openIndex] : null}
    {#if openPart}
      <section
        use:portal
        class="attachment-media-scrim"
        role="presentation"
        tabindex="-1"
        on:click={closeInlineAttachment}
        on:keydown={onAttachmentModalKeydown}
      >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          class="attachment-media-modal"
          class:attachment-media-modal-image={openPart.attachment.kind ===
            "image"}
          class:attachment-media-modal-note={openPart.attachment.kind ===
            "note"}
          class:attachment-media-modal-text={openPart.attachment.kind ===
            "text"}
          class:attachment-media-modal-card={openPart.attachment.kind ===
            "link" || openPart.attachment.kind === "emoji"}
          role="dialog"
          aria-modal="true"
          aria-label="Attachment"
          tabindex="-1"
          on:click|stopPropagation
          on:dblclick|stopPropagation
        >
          <header class="attachment-media-head">
            <span class="attachment-media-title">
              {inlineAttachmentLabel(openPart.attachment)}
            </span>
            <span
              class="attachment-media-actions"
              role="toolbar"
              aria-label="Attachment actions"
            >
              <button
                type="button"
                class="sticky-btn tiny"
                title={copied
                  ? "Copied"
                  : isCommandAttachment(openPart.attachment)
                    ? "Copy command"
                    : "Copy attachment"}
                aria-label={isCommandAttachment(openPart.attachment)
                  ? "Copy command"
                  : "Copy attachment"}
                on:click={() => void copyOpenAttachment(openPart.attachment)}
                >{copied ? "✓" : "⧉"}</button
              >
              <button
                type="button"
                class="sticky-btn tiny"
                title={isCommandAttachment(openPart.attachment)
                  ? "Edit command in toolbar"
                  : "Edit attachment"}
                aria-label={isCommandAttachment(openPart.attachment)
                  ? "Edit command in toolbar"
                  : "Edit attachment"}
                on:click={() =>
                  editOpenAttachment(openPart.raw, openPart.attachment)}
                >✎</button
              >
              <button
                type="button"
                class="sticky-btn tiny danger"
                class:confirming={confirmingAttachmentDeleteRaw ===
                  openPart.raw}
                title={confirmingAttachmentDeleteRaw === openPart.raw
                  ? "Click to cancel — attachment will delete in 2 seconds"
                  : "Delete attachment (3-second grace; click again to cancel)"}
                aria-label={confirmingAttachmentDeleteRaw === openPart.raw
                  ? "Cancel pending attachment delete"
                  : "Delete attachment"}
                on:click={() => deleteOpenAttachment(openPart.raw)}
                >{confirmingAttachmentDeleteRaw === openPart.raw
                  ? "■"
                  : "×"}</button
              >
            </span>
            {#if attachmentParts.length > 1}
              <button
                type="button"
                class="attachment-media-nav"
                aria-label="Previous attachment"
                title="Previous attachment"
                on:click={() => openAttachmentByStep(-1)}>‹</button
              >
              <button
                type="button"
                class="attachment-media-nav"
                aria-label="Next attachment"
                title="Next attachment"
                on:click={() => openAttachmentByStep(1)}>›</button
              >
            {/if}
            <span class="attachment-media-count">
              {openIndex + 1} / {attachmentParts.length}
            </span>
            <button
              type="button"
              class="sticky-btn tiny"
              title="Close"
              on:click={closeInlineAttachment}>×</button
            >
          </header>

          <div
            class="attachment-media-shell"
            class:attachment-media-shell-image={openPart.attachment.kind ===
              "image"}
            class:attachment-media-shell-note={openPart.attachment.kind ===
              "note"}
            class:attachment-media-shell-text={openPart.attachment.kind ===
              "text"}
            class:attachment-media-shell-card={openPart.attachment.kind ===
              "link" || openPart.attachment.kind === "emoji"}
          >
            <div class="attachment-media-body">
              {#if openPart.attachment.kind === "text"}
                <div class="attachment-text-editor">
                  <textarea
                    bind:this={attachmentTextareaEl}
                    class="attachment-textarea"
                    bind:value={openAttachmentDraft}
                    on:keydown={(e) => onKey(e, "attachment")}
                    use:autosize
                  ></textarea>
                  <footer class="attachment-text-editor-footer">
                    <button
                      type="button"
                      class="sticky-btn primary"
                      on:click={mergeOpenTextAttachment}>merge in</button
                    >
                    <button
                      type="button"
                      class="sticky-btn"
                      on:click={closeInlineAttachment}>Cancel</button
                    >
                  </footer>
                </div>
              {:else if openPart.attachment.kind === "note"}
                {#if openAttachmentNoteEditing}
                  <div class="attachment-note-editor">
                    {@render noteEditorSurface("attachment")}
                    <footer
                      class="sticky-edit-footer attachment-note-editor-footer"
                    >
                      <button
                        type="button"
                        class="sticky-btn primary"
                        on:click={saveOpenNoteAttachment}>Save</button
                      >
                      <button
                        type="button"
                        class="sticky-btn"
                        on:click={closeInlineAttachment}>Cancel</button
                      >
                    </footer>
                  </div>
                {:else}
                  {@const noteParts = parseInlineAttachments(
                    openPart.attachment.body,
                  )}
                  {@const noteVisualIndexes =
                    visualAttachmentIndexes(noteParts)}
                  {@const noteVisualParts = visualPartsFor(noteParts)}
                  <div class="attachment-note-view">
                    <div
                      class="sticky-body"
                      role="textbox"
                      tabindex="0"
                      aria-readonly="true"
                      on:click={onBodyClick}
                    >
                      {@render renderedNoteBody(
                        noteParts,
                        noteVisualIndexes,
                        noteVisualParts,
                        false,
                      )}
                    </div>
                    <footer class="attachment-note-view-footer">
                      <button
                        type="button"
                        class="sticky-btn"
                        title={copied ? "Copied" : "Copy note"}
                        on:click={() =>
                          void copyNoteBody(openPart.attachment.body)}
                        >{copied ? "✓" : "⧉"}</button
                      >
                      <button
                        type="button"
                        class="sticky-btn"
                        title="Edit"
                        on:click={() =>
                          startOpenNoteAttachmentEdit(openPart.attachment)}
                        >✎</button
                      >
                    </footer>
                  </div>
                {/if}
              {:else}
                {@render attachmentPreview(openPart.attachment, "media")}
              {/if}
            </div>
          </div>
        </div>
      </section>
    {/if}
  {/if}

  {#if isSessionLink && previewOpen}
    <aside
      use:portal
      class="sticky-link-preview"
      style:top="{previewTop}px"
      style:left="{previewLeft}px"
      aria-hidden="true"
      on:mouseenter={onPreviewPanelEnter}
      on:mouseleave={onLinkCardLeave}
    >
      <ChatPreview
        items={previewItems}
        summary={previewSummary}
        agent={(note.target?.agent ?? undefined) as
          | "claude"
          | "codex"
          | "copilot"
          | "shell"
          | undefined}
        loading={previewLoading}
      />
    </aside>
  {/if}

  {#if confirmingDelete}
    <div class="sticky-delete-progress" aria-hidden="true"></div>
  {/if}
</div>
