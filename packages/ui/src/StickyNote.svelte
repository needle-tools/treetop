<script lang="ts" context="module">
  /** The two attachment kinds the layer carries: a free-form paper
   *  sticky ("note") and a compact chip pointing at a URL / commit /
   *  session / file ("link"). Both share the storage path, anchors,
   *  undo log, and SSE broadcast — only the rendering differs, so
   *  this component branches on `kind` rather than the layer routing
   *  to a sibling component. */
  export type AttachmentKind = "note" | "link" | "emoji";
  export interface LinkTarget {
    type: "url" | "commit" | "session" | "file";
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
  } from "./preview-action";
  import {
    INLINE_ATTACHMENT_DRAG_MIME,
    extractNoteClipboardPayloadFromHtml,
    expandNoteBodyForCopyAsync,
    fetchTextAttachment,
    inlineAttachmentLabel,
    makeNoteClipboardHtml,
    makeNoteClipboardPayload,
    makeImageAttachmentRef,
    makeTextAttachmentRef,
    noteBodyToEditText,
    parseInlineAttachments,
    restoreEditTextAttachments,
    shouldAttachPastedText,
    trailingImageAttachmentIndexes,
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

  /** localStorage key for the user's preferred git client. Written
   *  by App.svelte's openIn funnel whenever a git-client app is
   *  invoked; read by the commit-chip click handler below when no
   *  provider web URL is available. Default "fork" — the only git
   *  GUI currently exposed in OpenInActions. */
  const GIT_CLIENT_PREF_KEY = "supergit:preferred-git-client";

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
      if (!["url", "commit", "session", "file"].includes(type)) return null;
      let value = decodeURIComponent(rest.slice(slash + 1));
      if (type === "session") {
        const id = value;
        const suffix = `/${id}.jsonl`;
        outer: for (const r of repos) {
          for (const wt of r.worktrees ?? []) {
            const agents = (wt as { agents?: Array<{ source: string; sessionId?: string }> }).agents;
            if (!agents) continue;
            // Match by sessionId first (the daemon's authoritative id),
            // then fall back to the source path ending in `<id>.jsonl`
            // for sessions whose AgentSession.sessionId isn't populated
            // (older indexed records, or the brief window after spawn
            // before the JSONL is parsed).
            const a = agents.find((x) => x.sessionId === id) ??
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

  interface AnchorableWorktree { path: string; branch: string; }
  interface AnchorableRepo {
    id: string;
    name?: string;
    path: string;
    worktrees?: AnchorableWorktree[];
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
   *  with a per-frame rAF loop (staging → pin slot fly). We kick the
   *  pendulum on so it samples the changing `x` and tilts the note
   *  during travel — the exact same swing-by-physics motion the user
   *  gets from a manual drag. */
  export let flying = false;
  /** Used by the in-note "Move to…" / "Copy to…" picker to enumerate
   *  all anchorable rows. Threaded down from the StickyNotesLayer's
   *  `repos` prop. */
  export let repos: AnchorableRepo[] = [];

  const dispatch = createEventDispatcher<{
    move: { id: string; x: number; y: number };
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
  }>();

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
        (repo as { remotes?: Array<{ name: string; webUrl: string | null; provider: string | null }> } | undefined)
          ?.remotes ?? [];
      const origin = remoteRefs.find((r) => r.name === "origin") ?? remoteRefs[0];
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
    if (note.kind !== "link" || !note.target || note.target.type !== "session") {
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
  /** Convenience flag — once derived it gets used a few places (CSS
   *  class, dispatch branching, removeIfEmpty math). Re-derived
   *  whenever the note prop changes so kind flips propagate. */
  $: isLink = note.kind === "link";
  $: isEmoji = note.kind === "emoji";
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
          try { node.remove(); } catch {}
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
    const remoteRefs = (repo as { remotes?: Array<{ name: string; provider?: string | null }> } | undefined)?.remotes ?? [];
    const origin = remoteRefs.find((r) => r.name === "origin") ?? remoteRefs[0];
    const nextProvider = origin?.provider ?? undefined;
    // The daemon's per-worktree session bucketing — same list that
    // powers the "+N sessions in this worktree" popover. Passing it
    // here makes the @-mention picker show that exact set, instead
    // of re-deriving it from /api/agents + cwd guessing.
    const nextSessions = (wt as { agents?: AgentSession[] } | undefined)?.agents;
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

  function repositionMentionPopover(): void {
    if (!mentionOpen || !textareaEl) return;
    const r = textareaEl.getBoundingClientRect();
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
    // popoverEl in the dep list so the reposition re-runs once the
    // popover element has actually been mounted — first call uses
    // the height estimate, the follow-up uses the real measurement
    // (so the above/below flip can correct itself if needed).
    void popoverEl;
    queueMicrotask(repositionMentionPopover);
  }

  function onTextareaInput(): void {
    if (!textareaEl) return;
    const caret = textareaEl.selectionStart ?? 0;
    const text = draft;
    if (mentionOpen) {
      // Track the live query span between the `@` and the caret.
      // Close if the user erased the `@`, moved the caret behind it,
      // or typed whitespace (mentions are single-token by design).
      if (mentionStart < 0 || text[mentionStart] !== "@" || caret <= mentionStart) {
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
      }
    }
  }

  function onMentionPick(e: CustomEvent<PickItem>): void {
    if (!mentionOpen || !textareaEl) return;
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
    const caret = textareaEl.selectionStart ?? mentionStart + 1;
    const before = draft.slice(0, mentionStart);
    const after = draft.slice(caret);
    draft = before + insertion + after;
    pushRecent(item);
    const newCaret = before.length + insertion.length;
    closeMention();
    queueMicrotask(() => {
      if (!textareaEl) return;
      textareaEl.focus();
      textareaEl.setSelectionRange(newCaret, newCaret);
      // Re-run autosize so the textarea re-measures with the inserted text.
      textareaEl.dispatchEvent(new Event("input", { bubbles: true }));
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

  function textSourceFromClipboardData(cd: DataTransfer | null): { kind: "clipboard"; types: string[] } {
    return {
      kind: "clipboard",
      types: cd ? Array.from(cd.types) : [],
    };
  }

  function insertIntoDraft(text: string): void {
    if (!textareaEl) {
      draft += text;
      return;
    }
    const start = textareaEl.selectionStart ?? draft.length;
    const end = textareaEl.selectionEnd ?? start;
    draft = draft.slice(0, start) + text + draft.slice(end);
    const caret = start + text.length;
    queueMicrotask(() => {
      if (!textareaEl) return;
      textareaEl.focus();
      textareaEl.setSelectionRange(caret, caret);
      textareaEl.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function prepareBodyForEdit(body: string): string {
    const edit = noteBodyToEditText(body);
    editAttachmentRefs = edit.refs;
    return edit.text;
  }

  function bodyFragmentToEditText(body: string): string {
    const edit = noteBodyToEditText(body, {
      existingRefs: editAttachmentRefs,
      usedText: draft,
    });
    editAttachmentRefs = [...editAttachmentRefs, ...edit.refs];
    return edit.text;
  }

  function insertBodyIntoDraft(body: string): void {
    insertIntoDraft(bodyFragmentToEditText(body));
  }

  function insertAttachmentRef(ref: string): void {
    const part = parseInlineAttachments(ref)[0];
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
    opts: { filename?: string; source: { kind: "clipboard" | "drop"; types: string[] } },
  ): Promise<void> {
    try {
      const shrunk = await shrinkImageBlob(blob);
      const form = new FormData();
      form.append(
        "file",
        opts.filename ? new File([shrunk], opts.filename, { type: shrunk.type }) : shrunk,
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
      insertAttachmentRef(ref);
    } catch (err) {
      console.warn("Could not save image attachment", err);
    }
  }

  async function uploadTextAttachment(
    text: string,
    source: { kind: "clipboard"; types: string[] },
  ): Promise<void> {
    try {
      const blob = new Blob([text], { type: "text/plain" });
      const file = new File([blob], "pasted-content.txt", { type: "text/plain" });
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/attach", { method: "POST", body: form });
      if (!res.ok) throw new Error(`attach failed: ${res.status}`);
      const { path } = (await res.json()) as { path: string };
      insertAttachmentRef(makeTextAttachmentRef({
        path,
        filename: "pasted-content.txt",
        mimeType: "text/plain",
        size: blob.size,
        charCount: Array.from(text).length,
        source,
      }));
    } catch (err) {
      console.warn("Could not save text attachment", err);
    }
  }

  function insertClipboardNotePayloadFromHtml(html: string): boolean {
    const payload = extractNoteClipboardPayloadFromHtml(html);
    if (!payload) return false;
    insertBodyIntoDraft(payload.body);
    return true;
  }

  function onTextareaPaste(e: ClipboardEvent): void {
    const cd = e.clipboardData;
    if (!cd) return;
    if (insertClipboardNotePayloadFromHtml(cd.getData("text/html"))) {
      e.preventDefault();
      return;
    }
    for (const item of cd.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        void uploadImageAttachment(file, {
          filename: file.name && file.name !== "blob" ? file.name : undefined,
          source: { kind: "clipboard", types: Array.from(cd.types) },
        });
        return;
      }
    }
    const text = cd.getData("text/plain");
    if (text && shouldAttachPastedText(text)) {
      e.preventDefault();
      void uploadTextAttachment(text, textSourceFromClipboardData(cd));
    }
  }

  function onNoteDragOver(e: DragEvent): void {
    if (isLink || isEmoji) return;
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }

  function onNoteDrop(e: DragEvent): void {
    if (isLink || isEmoji) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    const image = files.find((file) => file.type.startsWith("image/"));
    if (!image) return;
    e.preventDefault();
    void uploadImageAttachment(image, {
      filename: image.name,
      source: { kind: "drop", types: e.dataTransfer ? Array.from(e.dataTransfer.types) : [] },
    });
  }

  async function copyNote(): Promise<void> {
    let text: string;
    let payload: ReturnType<typeof makeNoteClipboardPayload>;
    try {
      text = await expandNoteBodyForCopyAsync(note.body, fetchTextAttachment);
      payload = makeNoteClipboardPayload({ id: note.id, body: note.body, text });
    } catch (err) {
      console.warn("Could not read note attachments for copy", err);
      return;
    }

    try {
      const ClipboardItemCtor = (globalThis as typeof globalThis & {
        ClipboardItem?: typeof ClipboardItem;
      }).ClipboardItem;
      if (navigator.clipboard?.write && ClipboardItemCtor) {
        await navigator.clipboard.write([
          new ClipboardItemCtor({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob(
              [makeNoteClipboardHtml(payload, text)],
              { type: "text/html" },
            ),
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

  async function textForAttachment(attachment: InlineAttachment): Promise<string> {
    if (attachment.kind !== "text") return "";
    return fetchTextAttachment(attachment.path);
  }

  function openInlineAttachment(raw: string, attachment: InlineAttachment): void {
    openAttachmentRaw = raw;
    if (attachment.kind === "note" || attachment.kind === "emoji") {
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
          if (openAttachmentRaw === raw) openAttachmentDraft = text;
        })
        .catch((err) => console.warn("Could not read text attachment", err));
    }
  }

  function closeInlineAttachment(): void {
    openAttachmentRaw = null;
    openAttachmentDraft = "";
  }

  function mergeInlineAttachment(raw: string, replacement: string): void {
    const body = note.body.replace(raw, replacement);
    closeInlineAttachment();
    dispatch("save", { id: note.id, body });
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

  async function mergeTextAttachment(raw: string, attachment: InlineAttachment): Promise<void> {
    if (attachment.kind !== "text") return;
    try {
      mergeInlineAttachment(raw, await textForAttachment(attachment));
    } catch (err) {
      console.warn("Could not read text attachment", err);
    }
  }

  function mergeNoteAttachment(raw: string, attachment: InlineAttachment): void {
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

  /** Pendulum physics. The note's drag-tilt is modelled as a bob
   *  hanging from the grab point: when the pivot (cursor) accelerates
   *  horizontally, the bob lags due to inertia; gravity pulls it
   *  back toward vertical when the pivot moves at constant velocity
   *  or stops. So:
   *    - steady drag → no acceleration → bob hangs straight (no tilt);
   *    - cursor speeds up / slows down / stops → acceleration spikes
   *      → bob swings, then gravity restores it, oscillating with
   *      damping until settled.
   *  Each frame samples the pivot's doc-X (note.x + grab fraction ×
   *  width), derives velocity and acceleration, and feeds the
   *  acceleration into the pendulum equation
   *    α = -GRAVITY · angle  −  INERTIA · pivotAccel
   *  followed by a per-frame damping multiplier on ω. */
  const GRAVITY = 0.01;            // restoring force per degree
  const INERTIA = -0.2;            // angular accel per px/frame² of pivot
  const PEND_DAMP = 0.8;          // per-frame velocity multiplier
  const PEND_SETTLE = .5;        // angle AND velocity both below → stop rAF
  /** Hard cap on the pendulum displacement so an absurd flick doesn't
   *  send the note past the +90° / −90° point where small-angle
   *  approximations stop making sense. */
  const PEND_CAP = 25;
  let pendulumAngle = 0;
  let pendulumVelocity = 0;
  let pivotXPrev = 0;
  let pivotVelPrev = 0;
  let pendulumActive = false;
  let pendulumRaf: number | null = null;

  function tickPendulum(): void {
    const w = stickyEl?.offsetWidth ?? 240;
    const pivotX = x + grabXFrac * w;
    const pivotV = pivotX - pivotXPrev;
    const pivotA = pivotV - pivotVelPrev;
    pivotXPrev = pivotX;
    pivotVelPrev = pivotV;
    const accel = -GRAVITY * pendulumAngle - INERTIA * pivotA;
    pendulumVelocity += accel;
    pendulumVelocity *= PEND_DAMP;
    pendulumAngle = Math.max(
      -PEND_CAP,
      Math.min(PEND_CAP, pendulumAngle + pendulumVelocity),
    );
    if (
      !dragging &&
      Math.abs(pendulumAngle) < PEND_SETTLE &&
      Math.abs(pendulumVelocity) < PEND_SETTLE
    ) {
      pendulumAngle = 0;
      pendulumVelocity = 0;
      pendulumActive = false;
      pendulumRaf = null;
      return;
    }
    pendulumRaf = requestAnimationFrame(tickPendulum);
  }

  function startPendulum(): void {
    if (!pendulumActive) {
      pendulumActive = true;
      // Seed pivot tracking from the current state so the first frame
      // doesn't fire a spurious acceleration spike from x ↔ 0.
      const w = stickyEl?.offsetWidth ?? 240;
      pivotXPrev = x + grabXFrac * w;
      pivotVelPrev = 0;
    }
    if (pendulumRaf === null) {
      pendulumRaf = requestAnimationFrame(tickPendulum);
    }
  }

  function stopPendulum(): void {
    if (pendulumRaf !== null) {
      cancelAnimationFrame(pendulumRaf);
      pendulumRaf = null;
    }
    pendulumActive = false;
    pendulumAngle = 0;
    pendulumVelocity = 0;
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
      stopPendulum();
      cancelPendingDelete();
    };
  });

  function onMouseDownHeader(e: MouseEvent): void {
    // Only drag with primary button; ignore clicks on buttons inside header.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true;

    const w = stickyEl?.offsetWidth || 240;
    const h = stickyEl?.offsetHeight || 1;
    const cxDoc = e.clientX + window.scrollX;
    const cyDoc = e.clientY + window.scrollY;
    dragDx = cxDoc - x;
    dragDy = cyDoc - y;
    const newGxFrac = Math.max(0, Math.min(1, dragDx / w));
    const newGyFrac = Math.max(0, Math.min(1, dragDy / h));
    lastMouseX = e.clientX;
    // Kick off the pendulum tick. If a previous gesture's pendulum is
    // still settling, leave its current angle/velocity intact — the
    // new motion just composes on top.
    startPendulum();

    // Persist the approximate grab point for the swing origin, but
    // do not dispatch an immediate move: the first movement should
    // start from the note's actual stored left/top, otherwise a
    // clamped transform-origin can make the note twitch before the
    // user has really dragged it.
    dispatch("grab", { id: note.id, grabXFrac: newGxFrac, grabYFrac: newGyFrac });
    dispatch("focus", { id: note.id });

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragging) return;
    // Note tilt is now driven by the pendulum sampling `x` per rAF
    // tick — there's no per-mousemove cumulative input. The bob
    // hangs straight during steady drag and only swings when the
    // cursor accelerates or decelerates.
    lastMouseX = e.clientX;
    const nx = Math.max(0, e.clientX + window.scrollX - dragDx);
    const ny = Math.max(0, e.clientY + window.scrollY - dragDy);
    dispatch("move", { id: note.id, x: nx, y: ny });
  }

  function onMouseUp(e: MouseEvent): void {
    dragging = false;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    dispatch("dragdrop", { id: note.id, clientX: e.clientX, clientY: e.clientY });
    // Freeze the final rotation: roll the in-flight `dragRotation`
    // into the persisted `rotation` so the note holds whatever angle
    // it was at when the user released. The clamp on every move
    // means `rotation + dragRotation` is already inside ±30, so the
    // outer clamp here is just defensive.
    // Nothing to persist — pendulum is purely transient and decays
    // to 0 on its own. The rAF loop self-terminates once angle and
    // velocity are both under PEND_SETTLE.
  }

  /** Composite tilt rendered in CSS = persisted user rotation (from
   *  the rotation prop, set externally — undo restore, etc.) + the
   *  static per-note jitter (`tilt`) + the live pendulum
   *  displacement. Pendulum is transient and decays to 0; the
   *  rotation prop is the long-term rest angle. Applies to both
   *  paper notes and link cards — both swing on drag and carry a
   *  small static jitter so the row looks alive. */
  $: displayedTilt = tilt + rotation + pendulumAngle;

  /** Layer-driven fly hook: while `flying` is true the parent is
   *  pumping fresh `x` values into us each frame, so kick the
   *  pendulum on. The pendulum's settle check (angle + velocity both
   *  near zero AND not dragging) keeps it ticking as long as the
   *  pivot's acceleration stays non-zero — which is the case for the
   *  whole eased fly — and then it decays naturally once the layer
   *  stops moving the note. */
  $: if (flying) startPendulum();

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
    dispatch("save", { id: note.id, body: trimmed });
  }

  function onKey(e: KeyboardEvent): void {
    // While the @-mention picker is open, the textarea forwards
    // navigation/commit keys into it. The picker decides whether the
    // current cursor maps to a real pick; if not, fall through so
    // Enter still saves the note.
    if (mentionOpen && mentionPickerRef) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mentionPickerRef.moveCursor(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionPickerRef.moveCursor(-1);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (mentionPickerRef.hasResults()) {
          e.preventDefault();
          mentionPickerRef.commitCurrent();
          return;
        }
        // No results yet — fall through to save.
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }
    // Enter (no modifier) saves — sticky notes are short scratchpads,
    // so plain Enter as the save shortcut is the muscle memory the
    // user wants. Shift+Enter falls through to the textarea default
    // (insert newline). Esc reverts.
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
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
        const found = agents.find((x) => x.sessionId === id) ??
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
  const CODEX_PATH = "M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z";

  /** Inline-icon HTML for the rendered note body's @-mention chips.
   *  Mirrors AgentIcon / AttachmentIcon's resolution so chips that
   *  appear in note text use the same brand marks as the standalone
   *  link-chip and the @-mention picker rows. Returns "" when no
   *  recognizable agent/provider — caller renders the link without
   *  an icon prefix. */
  function inlineMentionIconHtml(opts: { agent?: string; provider?: string }): string {
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
    if (!body.trim()) return "<p class=\"sticky-empty\">(empty)</p>";
    const raw = DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
    return enhanceSupergitLinks(raw);
  }

  function renderInlineBody(body: string): string {
    if (!body) return "";
    const raw = DOMPurify.sanitize(marked.parseInline(body) as string);
    return enhanceSupergitLinks(raw);
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
      !bodyParts.some((part) => part.kind === "attachment" && part.raw === openAttachmentRaw)
    ) {
      closeInlineAttachment();
    }
  }

  $: detachedAttachmentPart =
    !editing && bodyParts.length === 1 && bodyParts[0]?.kind === "attachment"
      ? bodyParts[0]
      : null;
  $: trailingImageIndexes = trailingImageAttachmentIndexes(bodyParts);

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

<div
  bind:this={stickyEl}
  class="sticky"
  class:dragging
  class:editing
  class:sticky-link={isLink}
  class:sticky-emoji={isEmoji}
  data-note-id={note.id}
  data-kind={isEmoji ? "emoji" : isLink ? "link" : "note"}
  style="left: {x}px; top: {y}px; --tilt: {displayedTilt}deg; --grab-x: {(flying ? 0.5 : grabXFrac) * 100}%; --grab-y: {(flying ? 0 : grabYFrac) * 100}%;{editing && isLink ? ` max-width: ${chipMaxWidth}px;` : ''}"
  role="dialog"
  tabindex="-1"
  aria-label={isEmoji ? "Emoji sticker" : isLink ? "Sticky link" : "Sticky note"}
  on:mousedown={() => dispatch("focus", { id: note.id })}
  on:dragover={onNoteDragOver}
  on:drop={onNoteDrop}
  on:dblclick={() => {
    if (!editing && !isEmoji) startEdit();
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
    <span class="sticky-grip" aria-hidden="true">⋮⋮</span>
    <div class="sticky-actions">
      {#if editing && !isLink}
        <!-- Save sits on the left, Cancel on the right: when the user
             clicks ✎ to enter edit mode, their cursor lands on the
             left slot of the toolbar — and the natural next action
             after typing is Save, not Cancel. Keeping the affirmative
             action under the cursor avoids a wasted aim. -->
        <button class="sticky-btn primary" on:click={saveEdit} title="Save (Enter)">Save</button>
        <button class="sticky-btn" on:click={cancelEdit} title="Cancel (Esc)">Cancel</button>
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
            title={copied ? "Copied" : "Copy note for pasting into a session"}
            aria-label="Copy note"
          >{copied ? "✓" : "⧉"}</button>
        {/if}
        <button
          class="sticky-btn"
          on:click={startEdit}
          title="Edit"
          aria-label="Edit"
        >✎</button>
        <button
          class="sticky-btn danger"
          class:confirming={confirmingDelete}
          on:click={onDeleteClick}
          title={confirmingDelete
            ? "Click to cancel — note will delete in 2 seconds"
            : "Delete (3-second grace; click again to cancel)"}
          aria-label={confirmingDelete ? "Cancel pending delete" : "Delete"}
        >{confirmingDelete ? "■" : "×"}</button>
      {/if}
    </div>
  </header>

  {#if isEmoji}
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <span
      class="sticky-emoji-glyph"
      style="font-size: calc(10vw * {emojiScale})"
      on:mousedown={onMouseDownHeader}
      title="Drag to move"
    >{note.body}</span>
    <button
      class="sticky-emoji-delete sticky-btn danger"
      on:click={onDeleteClick}
      title={confirmingDelete ? "Click to cancel" : "Delete"}
      aria-label={confirmingDelete ? "Cancel pending delete" : "Delete"}
    >{confirmingDelete ? "■" : "×"}</button>
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
      <div class="sticky-textarea-wrap">
        <textarea
          bind:this={textareaEl}
          class="sticky-textarea"
          bind:value={draft}
          placeholder="Write something… markdown OK. Type @ to link a session or commit. Enter saves, Shift+Enter newline, Esc reverts."
          on:keydown={onKey}
          on:paste={onTextareaPaste}
          on:input={onTextareaInput}
          use:autosize
        ></textarea>
        {#if mentionOpen}
          <!-- Inline @-mention popover. Portaled to <body> so we
               can position it with viewport-fixed coords clamped to
               the screen — the sticky's `transform: rotate(...)`
               would otherwise make it the containing block for
               `position: fixed` descendants and the popover would
               inherit the rotation and clipping. Embedded mode:
               the picker hides its own input and is driven by
               `externalQuery` + our forwarded arrow/enter
               keystrokes, so the textarea stays focused while the
               user keeps typing. -->
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
        {/if}
      </div>
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
          on:click={() => (pickerMode = pickerMode === "move" ? null : "move")}
          class:active={pickerMode === "move"}
          title="Move this note to another repo/worktree"
        >move to</button>
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
          on:click={() => (pickerMode = pickerMode === "duplicate" ? null : "duplicate")}
          class:active={pickerMode === "duplicate"}
          title="Duplicate this note to another repo/worktree (original stays)"
        >copy to</button>
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
        class="sticky-link-body attach-card"
        type="button"
        title="Click to open"
        on:mousedown|stopPropagation
        on:click={() => note.target && openTarget(note.target)}
        on:dblclick|stopPropagation
        on:mouseenter={onLinkCardEnter}
        on:mouseleave={onLinkCardLeave}
        on:focusin={onLinkCardEnter}
        on:focusout={onLinkCardLeave}
      >
        <span class="attach-card-icon" aria-hidden="true">
          <AttachmentIcon
            agent={note.target.agent ?? ""}
            provider={note.target.provider
              ?? (note.target.type === "commit"
                ? pickerScope.currentRepoProvider ?? ""
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
            {#if note.target.meta && note.target.subtitle} · {/if}
            {#if note.target.subtitle}{note.target.subtitle}{/if}
          </span>
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
        class:sticky-detached-image={detachedAttachmentPart.attachment.kind === "image"}
        class:sticky-detached-text={detachedAttachmentPart.attachment.kind === "text"}
        draggable="true"
        title="View attachment"
        on:dragstart={(e) =>
          onInlineAttachmentDragStart(
            e,
            detachedAttachmentPart.raw,
            detachedAttachmentPart.attachment,
          )}
        on:click={() =>
          openInlineAttachment(
            detachedAttachmentPart.raw,
            detachedAttachmentPart.attachment,
          )}
        on:dblclick|stopPropagation
      >
        {#if detachedAttachmentPart.attachment.kind === "image"}
          <span class="sticky-photo-frame">
            <img
              src={`/api/image?path=${encodeURIComponent(detachedAttachmentPart.attachment.path)}`}
              alt={detachedAttachmentPart.attachment.filename ?? "Attached image"}
            />
          </span>
          <span class="sticky-photo-caption">
            {detachedAttachmentPart.attachment.filename
              ?? detachedAttachmentPart.attachment.path.split("/").pop()
              ?? "Image attachment"}
          </span>
        {:else if detachedAttachmentPart.attachment.kind === "text"}
          <span class="sticky-detached-text-icon" aria-hidden="true">T</span>
          <span>{`Pasted Content, ${detachedAttachmentPart.attachment.charCount} chars`}</span>
        {:else if detachedAttachmentPart.attachment.kind === "emoji"}
          <span class="sticky-detached-emoji">{detachedAttachmentPart.attachment.body}</span>
        {:else if detachedAttachmentPart.attachment.kind === "note"}
          <span class="sticky-detached-text-icon" aria-hidden="true">✎</span>
          <span>{inlineAttachmentLabel(detachedAttachmentPart.attachment)}</span>
        {:else}
          <span class="sticky-detached-text-icon" aria-hidden="true">↗</span>
          <span>{inlineAttachmentLabel(detachedAttachmentPart.attachment)}</span>
        {/if}
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
        {#each bodyParts as part, i}
          {#if part.kind === "text"}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html bodyParts.length === 1
              ? renderBody(part.text, repos, pickerScope)
              : renderInlineBody(part.text)}
          {:else if part.attachment.kind === "image" && trailingImageIndexes.has(i)}
            <button
              type="button"
              class="sticky-trailing-image"
              draggable="true"
              title="View attachment"
              on:dragstart={(e) =>
                onInlineAttachmentDragStart(e, part.raw, part.attachment)}
              on:click|stopPropagation={() =>
                openInlineAttachment(part.raw, part.attachment)}
              on:dblclick|stopPropagation
            >
              <span class="sticky-photo-frame">
                <img
                  src={`/api/image?path=${encodeURIComponent(part.attachment.path)}`}
                  alt={part.attachment.filename ?? "Attached image"}
                />
              </span>
              <span class="sticky-photo-caption">
                {part.attachment.filename
                  ?? part.attachment.path.split("/").pop()
                  ?? "Image attachment"}
              </span>
            </button>
          {:else}
            <InlineAttachmentChip
              attachment={part.attachment}
              raw={part.raw}
              selected={openAttachmentRaw === part.raw}
              draggable={true}
              onDragStart={(e) =>
                onInlineAttachmentDragStart(e, part.raw, part.attachment)}
              onOpen={() => openInlineAttachment(part.raw, part.attachment)}
              onMerge={() => {
                if (part.attachment.kind === "text") {
                  void mergeTextAttachment(part.raw, part.attachment);
                } else if (part.attachment.kind === "note") {
                  mergeNoteAttachment(part.raw, part.attachment);
                }
              }}
            />
          {/if}
        {/each}
      </div>
    {/if}
    {#if openAttachmentRaw}
      {@const openPart = bodyParts.find((part) =>
        part.kind === "attachment" && part.raw === openAttachmentRaw
      )}
      {#if openPart?.kind === "attachment"}
        <section
          class="inline-attachment-editor"
          role="group"
          on:dblclick|stopPropagation
        >
          <header class="inline-attachment-editor-head">
            <span>
              {inlineAttachmentLabel(openPart.attachment)}
            </span>
            <button
              type="button"
              class="sticky-btn tiny"
              title="Close"
              on:click={closeInlineAttachment}
            >×</button>
          </header>
          {#if openPart.attachment.kind === "text" || openPart.attachment.kind === "note"}
            <textarea
              class="inline-attachment-textarea"
              bind:value={openAttachmentDraft}
              spellcheck="false"
            ></textarea>
            <div class="inline-attachment-editor-actions">
              <button
                type="button"
                class="sticky-btn primary"
                on:click={() =>
                  openAttachmentRaw &&
                  mergeInlineAttachment(openAttachmentRaw, openAttachmentDraft)}
              >merge in</button>
            </div>
          {:else if openPart.attachment.kind === "image"}
            <img
              class="inline-attachment-image"
              src={`/api/image?path=${encodeURIComponent(openPart.attachment.path)}`}
              alt={openPart.attachment.filename ?? "Attached image"}
            />
            <code class="inline-attachment-path">{openPart.attachment.path}</code>
          {:else if openPart.attachment.kind === "emoji"}
            <div class="inline-attachment-emoji">{openPart.attachment.body}</div>
          {:else}
            <code class="inline-attachment-path">{openPart.attachment.target.value}</code>
          {/if}
        </section>
      {/if}
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
