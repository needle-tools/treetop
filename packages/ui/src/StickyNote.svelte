<script lang="ts" context="module">
  /** The two attachment kinds the layer carries: a free-form paper
   *  sticky ("note") and a compact chip pointing at a URL / commit /
   *  session / file ("link"). Both share the storage path, anchors,
   *  undo log, and SSE broadcast — only the rendering differs, so
   *  this component branches on `kind` rather than the layer routing
   *  to a sibling component. */
  export type AttachmentKind = "note" | "link";
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
  import AnchorPicker from "./AnchorPicker.svelte";
  import Popover from "./Popover.svelte";
  import MentionPicker from "./MentionPicker.svelte";
  import AttachmentIcon from "./AttachmentIcon.svelte";
  import ChatPreview from "./ChatPreview.svelte";
  import {
    fetchPreviewItems,
    type PreviewAction,
    type PreviewGap,
    type PreviewMsg,
  } from "./preview-action";
  import { defaultProviders } from "./mention-providers";
  import { pushRecent } from "./mention-recents";
  import type { PickItem } from "./mention-types";
  import { requestSessionFocus } from "./session-focus-store";
  import { sessionDisplayTitle, type AgentSession } from "./sessionSearch";

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
      window.open(t.value, "_blank", "noopener,noreferrer");
      return;
    }
    if (t.type === "commit") {
      // 1) Already a browser URL (legacy / hand-pasted) — just open it.
      if (/^https?:\/\//i.test(t.value)) {
        window.open(t.value, "_blank", "noopener,noreferrer");
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
          window.open(url, "_blank", "noopener,noreferrer");
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
  /** Convenience flag — once derived it gets used a few places (CSS
   *  class, dispatch branching, removeIfEmpty math). Re-derived
   *  whenever the note prop changes so kind flips propagate. */
  $: isLink = note.kind === "link";
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

  onDestroy(() => clearPreviewTimers());

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
  } = {};
  $: {
    const wtAnchor = note.anchors.find((a) => a.startsWith("worktree:"));
    const wtPath = wtAnchor ? wtAnchor.slice("worktree:".length) : undefined;
    const repo = wtPath
      ? repos.find((r) => r.worktrees?.some((w) => w.path === wtPath))
      : undefined;
    const nextRepoPath = repo?.path;
    // Pull the provider off the repo's primary remote — `origin` if
    // present, else the first detected one. Empty when the repo has
    // no remotes; the commit chip then falls back to its generic
    // ◆ glyph instead of a brand mark.
    const remoteRefs = (repo as { remotes?: Array<{ name: string; provider?: string | null }> } | undefined)?.remotes ?? [];
    const origin = remoteRefs.find((r) => r.name === "origin") ?? remoteRefs[0];
    const nextProvider = origin?.provider ?? undefined;
    if (
      pickerScope.currentWorktreePath !== wtPath ||
      pickerScope.currentRepoPath !== nextRepoPath ||
      pickerScope.currentRepoProvider !== nextProvider
    ) {
      pickerScope = {
        currentWorktreePath: wtPath,
        currentRepoPath: nextRepoPath,
        currentRepoProvider: nextProvider,
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

  function closeMention(): void {
    mentionOpen = false;
    mentionStart = -1;
    mentionQuery = "";
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
      window.open(href, "_blank", "noopener,noreferrer");
    }
  }

  /** Two-step delete: clicking × arms a 3-second countdown (rather
   *  than firing immediately) so the user has a generous window to
   *  back out. The button glyph swaps to ■ while armed; a second
   *  click on it cancels. The countdown is also bailed out by
   *  entering edit mode (the user clearly didn't mean to discard) and
   *  by unmounting the component (component teardown shouldn't
   *  silently delete the underlying note). */
  const DELETE_GRACE_MS = 3000;
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

  onMount(() => {
    if (editing && !isLink && textareaEl) {
      // Note-kind edit: textarea gets caret-at-end so re-edits feel
      // like "append" rather than "overwrite". Link-kind delegates
      // focus to MentionPicker, which manages its own input.
      textareaEl.focus();
      const end = textareaEl.value.length;
      textareaEl.setSelectionRange(end, end);
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
    return () => {
      window.removeEventListener("mousedown", onWindowDown);
      window.removeEventListener("keydown", onWindowKey);
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

    // Re-anchoring math: the note may already have a persisted
    // rotation `R` from a prior drag, pivoting around the previous
    // grab point. The cursor's screen-coord offset from that previous
    // pivot is NOT the same as the box-coord offset (the paper has
    // been rotated). To find which fiber of paper the cursor is
    // actually touching, inverse-rotate the screen offset by `-R`.
    const oldGx = grabXFrac * w;
    const oldGy = grabYFrac * h;
    const oldPivotDocX = x + oldGx;
    const oldPivotDocY = y + oldGy;
    const cdx = cxDoc - oldPivotDocX;
    const cdy = cyDoc - oldPivotDocY;
    const R = (rotation * Math.PI) / 180;
    const cosR = Math.cos(R);
    const sinR = Math.sin(R);
    // Rotate by -R: (cos -sin; sin cos) with negated sin
    const bdx = cosR * cdx + sinR * cdy;
    const bdy = -sinR * cdx + cosR * cdy;
    const newGx = oldGx + bdx;
    const newGy = oldGy + bdy;
    const newGxFrac = Math.max(0, Math.min(1, newGx / w));
    const newGyFrac = Math.max(0, Math.min(1, newGy / h));

    // `dragDx/Dy` are now the box-coord position of the cursor (=
    // the new transform-origin). mousemove uses these to compute the
    // new doc top-left as `cursor_doc - dragD`, which keeps the
    // cursor anchored on top of the pivot.
    dragDx = newGx;
    dragDy = newGy;
    lastMouseX = e.clientX;
    // Kick off the pendulum tick. If a previous gesture's pendulum is
    // still settling, leave its current angle/velocity intact — the
    // new motion just composes on top.
    startPendulum();

    // Persist the new pivot. Also dispatch a move so the note shifts
    // its left/top to compensate for the transform-origin change —
    // changing the pivot under a rotated box would otherwise visibly
    // jump the note. The math (algebra in the comment above on
    // re-pivoting math) guarantees that with newLeft = cxDoc - newGx
    // and newTop = cyDoc - newGy, the visual position is unchanged
    // across the re-anchor.
    dispatch("grab", { id: note.id, grabXFrac: newGxFrac, grabYFrac: newGyFrac });
    dispatch("move", { id: note.id, x: cxDoc - newGx, y: cyDoc - newGy });
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

  function onMouseUp(): void {
    dragging = false;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
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
    draft = note.body;
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
    const trimmed = draft;
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

  /** Hard cap on inline supergit-mention label width. Past this the
   *  text gets truncated with an ellipsis so a long commit subject /
   *  renamed session title can't make the note balloon horizontally. */
  const MAX_INLINE_LABEL_CH = 30;

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

  /** Resolve a session UUID → live display label from the current
   *  repos snapshot. Uses the shared `sessionDisplayTitle` so inline
   *  mentions, the session-search popover, and the @-mention picker
   *  all agree on what a session is called. Returns null when no
   *  agent matches — caller falls back to the markdown's saved label. */
  function resolveSessionLiveLabel(id: string): string | null {
    const suffix = `/${id}.jsonl`;
    for (const r of repos) {
      for (const wt of r.worktrees ?? []) {
        const agents = (wt as { agents?: AgentSession[] }).agents;
        if (!agents) continue;
        const found = agents.find((x) => x.sessionId === id) ??
          agents.find((x) => x.source.endsWith(suffix));
        if (found) return sessionDisplayTitle(found);
      }
    }
    return null;
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
  function renderBody(body: string, _reposToken: AnchorableRepo[]): string {
    if (!body.trim()) return "<p class=\"sticky-empty\">(empty)</p>";
    const raw = marked.parse(body, { async: false }) as string;
    return raw.replace(
      /<a href="(supergit:\/\/(session|commit|file|url)\/([^"]*))">([^<]*)<\/a>/g,
      (_full, fullHref, kind, valEnc, savedLabel) => {
        const stripped = savedLabel.replace(/^@/, "");
        let label = stripped;
        if (kind === "session") {
          const id = (() => {
            try {
              return decodeURIComponent(valEnc);
            } catch {
              return valEnc;
            }
          })();
          const live = resolveSessionLiveLabel(id);
          if (live) label = live;
        }
        const clamped = clampLabel(label.trim() || stripped);
        return `<a href="${fullHref}" title="${escapeHtml(label)}">@${escapeHtml(clamped)}</a>`;
      },
    );
  }

  /** Reactive HTML used by the body. Re-derives whenever the note's
   *  body changes OR the live `repos` snapshot updates — so renaming
   *  a session via its SessionView header automatically flows into
   *  every inline mention pointing at it. */
  $: bodyHtml = renderBody(note.body, repos);

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
  data-note-id={note.id}
  data-kind={isLink ? "link" : "note"}
  style="left: {x}px; top: {y}px; --tilt: {displayedTilt}deg; --grab-x: {(flying ? 0.5 : grabXFrac) * 100}%; --grab-y: {(flying ? 0 : grabYFrac) * 100}%;"
  role="dialog"
  aria-label={isLink ? "Sticky link" : "Sticky note"}
  on:mousedown={() => dispatch("focus", { id: note.id })}
  on:dblclick={() => {
    // Whole-note dblclick enters edit mode. The buttons / textarea
    // have their own click handlers and dblclick bubbles up here
    // afterwards; the !editing guard skips us when we're already
    // in edit mode (or the user double-clicked Edit / Cancel, which
    // already flipped state on the first click).
    if (!editing) startEdit();
  }}
>
  <header
    class="sticky-header"
    role="toolbar"
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
            ? "Click to cancel — note will delete in 3 seconds"
            : "Delete (3-second grace; click again to cancel)"}
          aria-label={confirmingDelete ? "Cancel pending delete" : "Delete"}
        >{confirmingDelete ? "■" : "×"}</button>
      {/if}
    </div>
  </header>

  {#if editing}
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
          on:input={onTextareaInput}
          use:autosize
        ></textarea>
        {#if mentionOpen}
          <!-- Inline @-mention popover. Embedded mode: the picker
               hides its own input and is driven by `externalQuery` +
               our forwarded arrow/enter keystrokes, so the textarea
               stays focused while the user keeps typing. -->
          <div class="sticky-mention-popover">
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
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div
      class="sticky-body"
      role="textbox"
      tabindex="0"
      aria-readonly="true"
      title="Double-click to edit"
      on:click={onBodyClick}
    >{@html bodyHtml}</div>
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
    <!-- 3s countdown ring traced around the note's perimeter via a
         single <rect> with pathLength normalized to 100 and an animated
         stroke-dashoffset. `vector-effect: non-scaling-stroke` is set
         in CSS so the line stays a consistent thickness even though
         the SVG itself is sized via percentages and the rect is
         stretched non-uniformly. -->
    <svg class="sticky-delete-progress" aria-hidden="true">
      <rect width="100%" height="100%" rx="4" ry="4" pathLength="100" />
    </svg>
  {/if}
</div>
