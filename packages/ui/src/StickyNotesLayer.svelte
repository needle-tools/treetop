<script lang="ts" context="module">
  /**
   * Imperative façade for the rest of the app. The "+ note" buttons in
   * App.svelte call `spawnNote({ anchor, originRect })` to ask the
   * layer to POST a new note and pin it under the matching row.
   *
   * Module-scoped so any component can import the function without
   * threading props through the App tree. The layer registers itself
   * on mount; spawnNote queues calls made before mount.
   */
  /** Reusable spawn payload — the same shape powers every "create
   *  a new attachment" entry point in the app:
   *   - The `+`/🔗 toolbar buttons (target undefined → user picks).
   *   - The Save-as-link menu item on SessionView (target preset →
   *     auto-commit + fly).
   *   - Future surfaces (drag-from-commit, slash-command, etc.).
   *
   *  When `target` is omitted the layer stages the attachment at
   *  `originRect` and opens the picker. When `target` is provided
   *  the same staging-then-fly animation runs but the layer
   *  auto-commits without showing the picker, so the chip lands in
   *  its pin slot in one continuous motion. Both paths share the
   *  best-free-slot picker and the fly rAF loop. */
  type SpawnArgs = {
    anchor: string;
    /** Bounding rect of the element that triggered the spawn — used
     *  to derive the staged attachment's horizontal offset. The fly
     *  animation interpolates FROM this rect TO the chosen pin
     *  slot, so the user's eye follows the chip from where they
     *  clicked. */
    originRect: DOMRect;
    /** Which attachment to seed. Defaults to "note". */
    kind?: "note" | "link" | "emoji";
    /** Pre-filled body text. Used by emoji stickers to set the glyph
     *  at creation time so the note auto-commits without an edit phase. */
    body?: string;
    /** Pre-resolved link target. Set by callers (like the chat
     *  burger-menu) that already know the exact session/commit/url
     *  the user wants — the layer skips the picker, stages briefly
     *  at `originRect`, then flies to the pin slot. Empty/absent
     *  means "open the picker so the user can choose". */
    target?: {
      type: "url" | "commit" | "session" | "file" | "command";
      value: string;
      label?: string;
      subtitle?: string;
      meta?: string;
      agent?: string;
      provider?: string;
      repoId?: string;
      cwd?: string;
      command?: string;
      runMode?: "internal" | "external" | "shell";
    };
  };

  let registered: ((args: SpawnArgs) => Promise<void>) | null = null;
  const pending: SpawnArgs[] = [];

  /** Canonical spawn entry-point. Aliased as `spawnLinkWithTarget`
   *  below for callers whose semantics are "create this exact link
   *  now" rather than "open the picker"; both call the same layer
   *  function under the hood. */
  export async function spawnNote(args: SpawnArgs): Promise<void> {
    if (registered) {
      await registered(args);
      return;
    }
    pending.push(args);
  }

  /** Semantic alias of spawnNote for the auto-commit case. Callers
   *  pre-fill `target` (and usually `kind: "link"`) so the layer
   *  skips the picker, flies the chip into its slot, and brings it
   *  to front — same animation the picker path uses, just no human
   *  in the loop. */
  export async function spawnLinkWithTarget(
    args: Omit<SpawnArgs, "kind"> & { target: NonNullable<SpawnArgs["target"]> },
  ): Promise<void> {
    await spawnNote({ ...args, kind: "link" });
  }

  export function _registerLayer(fn: (args: SpawnArgs) => Promise<void>): void {
    registered = fn;
    while (pending.length > 0) {
      void fn(pending.shift()!);
    }
  }
  export function _unregisterLayer(): void {
    registered = null;
  }

  /** Imperative fly-in for a freshly-restored note (Undo on a
   *  `remove_note` event). Mirrors `spawnNote`'s shape but takes an
   *  existing note id — the daemon writes it back to disk during the
   *  undo round-trip, the layer's existing `refresh()` re-fetches
   *  `/api/notes`, and *this* call just registers the intended
   *  origin rect so refresh can stage the note at that rect in the
   *  same render pass as it lands in `notes`. Synchronous on
   *  purpose: the caller invokes it *before* `await toggleEvent`, so
   *  the intent is on file before the SSE→refresh fires, otherwise
   *  the note pops in at its pin slot and only flies after the
   *  await chain unblocks. */
  type FlyRestoreArgs = { id: string; originRect: DOMRect };
  let registeredFlyRestore: ((args: FlyRestoreArgs) => void) | null = null;
  const pendingFlyRestore: FlyRestoreArgs[] = [];
  export function flyRestoreNote(args: FlyRestoreArgs): void {
    if (registeredFlyRestore) {
      registeredFlyRestore(args);
      return;
    }
    pendingFlyRestore.push(args);
  }
  export function _registerFlyRestore(
    fn: (args: FlyRestoreArgs) => void,
  ): void {
    registeredFlyRestore = fn;
    while (pendingFlyRestore.length > 0) {
      fn(pendingFlyRestore.shift()!);
    }
  }
  export function _unregisterFlyRestore(): void {
    registeredFlyRestore = null;
  }
</script>

<script lang="ts">
  import { onMount, onDestroy, afterUpdate, tick as svelteTick } from "svelte";
  import StickyNote, { type NoteShape } from "./StickyNote.svelte";
  import { notesCountByAnchor, notesAll } from "./notes-counts";
  import { getDaemonKV } from "./daemon-kv";
  import { relativeAge } from "./mention-providers";
  import { shrinkImageBlob } from "./image-shrink";
  import {
    INLINE_ATTACHMENT_DRAG_MIME,
    LINK_TARGET_DRAG_MIME,
    SESSION_LINK_DRAG_MIME,
    STAGE_PROMPT_EVENT,
    appendInlineAttachmentRef,
    expandNoteBodyForTerminalPasteChunks,
    fetchTextAttachment,
    makeEmojiAttachmentRef,
    makeImageAttachmentRef,
    makeLinkAttachmentRef,
    makeNoteAttachmentRef,
    moveInlineAttachmentRefBefore,
    moveInlineAttachmentRefToEnd,
    parseInlineAttachments,
    removeInlineAttachmentRef,
    sessionLinkTargetMatchesSource,
    type InlineAttachment,
  } from "./note-inline-attachments";

  /** Bumped by App.svelte on any SSE `change` event so the layer
   *  refetches if a note was created/updated/deleted via another tab
   *  or by hand on disk. */
  export let changeKey = 0;
  /** Live repos snapshot — passed down to each StickyNote so the
   *  in-edit Move-to / Copy-to picker can list all anchorable
   *  destinations without each note re-fetching /api/repos. */
  interface AnchorableWorktree {
    path: string;
    branch: string;
    agents?: Array<{
      source: string;
      agent: string;
      title?: string;
      manualTitle?: string;
      firstUserMessage?: string;
      sessionId?: string;
      messageCount?: number;
      lastActive?: string;
    }>;
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
  export let repos: AnchorableRepo[] = [];
  export let onCommandLinkOpen:
    | ((
        payload: {
          linkId: string;
          repoId?: string;
          wtPath?: string;
          revealTerminal?: boolean;
        },
      ) => void)
    | null = null;
  export let onCommandLinkEdit:
    | ((
        payload: {
          linkId: string;
          repoId?: string;
        },
      ) => void)
    | null = null;
  export let runningCommandIds: Set<string> = new Set();
  export let commandUrls: Record<string, string[]> = {};

  let notes: NoteShape[] = [];
  /** Per-note storage. `offsetXFrac` is the note's left edge as a
   *  fraction of the anchor row's width (0 = row's left edge, 1 =
   *  right edge), so notes ride window resizes proportionally rather
   *  than drifting off-screen. `offsetY` is a small vertical wiggle
   *  in absolute px around the row's bottom edge — kept as px
   *  because it's clamped to a few px either way regardless of
   *  viewport. Pre-refactor entries used an absolute `offsetX` (px);
   *  `screenPosFor` reads one of those once, converts to a fraction,
   *  and rewrites the entry so the legacy field disappears on first
   *  read. */
  interface NoteOffset {
    offsetXFrac?: number;    // 0..1 of row width
    offsetY?: number;
    /** Persisted user-chosen rotation in degrees (±30 max). Set by
     *  the drag's `rotate` event when the user releases the note —
     *  composes with the deterministic per-note `tilt` jitter. */
    rotation?: number;
    /** Where inside the note the user grabbed on the last drag (0..1
     *  fractions of width / height). Used as `transform-origin` so
     *  the rotation pivots around that point — keeps the cursor
     *  anchored to the same spot on the paper while it spins. */
    grabXFrac?: number;
    grabYFrac?: number;
    emojiScale?: number;
  }
  let offsets: Record<string, NoteOffset & { offsetX?: number }> = {};
  let zOrder: string[] = [];
  let editingId: string | null = null;
  let lastChangeKey = -1;
  /** Notes that were just spawned via the "+" button and haven't been
   *  committed yet. While staged, the note floats below the originating
   *  button (not pinned to a row) and `removeIfEmpty` is on so leaving
   *  edit mode with empty body discards it. Cleared once the user
   *  saves non-empty text — at which point the note flies into its
   *  permanent pin slot on the row. */
  interface Staging {
    docX: number;
    docY: number;
    anchor: string;
    keepAtOrigin?: boolean;
  }
  let staging: Record<string, Staging> = {};
  /** Notes mid-fly (staging → pinned). Position is driven by a rAF
   *  loop in this layer rather than a CSS transition. */
  interface FlyingState {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    startMs: number;
    durationMs: number;
  }
  let flyingNotes: Record<string, FlyingState> = {};
  /** Notes mid-fade-out animation before delete. */
  let removingIds = new Set<string>();
  let lastPointer = { clientX: 0, clientY: 0 };
  let draggingPinnedNoteId: string | null = null;
  let attachmentDropNoteId: string | null = null;
  let attachmentDragAvailable = false;
  let attachmentDragSourceNoteId: string | null = null;
  let dragStartOffsets: Record<string, (NoteOffset & { offsetX?: number }) | null> = {};
  /** Bumped by scroll/resize/MutationObserver to force a re-derive of
   *  every note's screen position from its anchor row's current rect. */
  let tick = 0;

  const OFFSETS_KEY = "supergit:notes-offsets";
  const Z_KEY = "supergit:notes-zorder";
  const NOTE_W = 240;
  /** Upper bound on the link chip's rendered width — matches the
   *  `.sticky.sticky-link` max-width in notes.css. Used purely for
   *  clamping screen position so the chip + its picker don't run
   *  off the right edge of the viewport when staged near an
   *  edge-aligned + button. Bumping the CSS max-width? Bump this
   *  too. */
  const LINK_W = 540;
  /** How far the note's TOP edge sits above the row's bottom edge.
   *  The overlap is where the sticker-tape pseudo-element lives — the
   *  note "hangs" from the row's bottom, like a Post-it taped to the
   *  underside of the repo card. */
  const NOTE_OVERLAP = 10;
  /** Gap between the note's bottom edge and the next row's top edge.
   *  Generous so the strip of notes reads as visually detached from
   *  the next repo, rather than crammed against it. */
  const ROW_SAFETY = 24;
  /** Vertical wiggle bounds for the note's drag, relative to the
   *  default `rowBottom - NOTE_OVERLAP` baseline. Both directions
   *  scale with row height — short rows can't be invaded by a giant
   *  drag, tall rows have room to play. The pixel ceilings keep
   *  things sane on very tall rows. */
  const NOTE_WIGGLE_UP_PX = 100;
  const NOTE_WIGGLE_UP_PCT = 0.2;
  /** Per-kind downward drag range. Both kinds now share the same
   *  generous allowance — paper notes used to clamp tight against
   *  the row, but applyRowMargins' vh-based cap (70vh for notes,
   *  40vh for links) already prevents runaway gaps, so the wiggle
   *  itself can be liberal. The user can drag any attachment far
   *  below the row; the row's margin only grows up to its kind
   *  cap, past which the chip floats over the inter-row gap. */
  const LINK_WIGGLE_DOWN_PX = 1600;
  const NOTE_WIGGLE_DOWN_PX = 1600;
  // Pleasant micro-tilt range; deterministic per id so rerenders don't
  // jitter. Using charCode parity gives a stable -2°..+2° spread.
  function tiltFor(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return ((h % 5) - 2);
  }

  function loadOffsets(): void {
    try {
      const raw = getDaemonKV().getItem(OFFSETS_KEY);
      if (raw) offsets = JSON.parse(raw) ?? {};
    } catch {
      offsets = {};
    }
    try {
      const raw = getDaemonKV().getItem(Z_KEY);
      if (raw) zOrder = JSON.parse(raw) ?? [];
    } catch {
      zOrder = [];
    }
  }
  function saveOffsets(): void {
    try {
      getDaemonKV().setItem(OFFSETS_KEY, JSON.stringify(offsets));
    } catch {}
  }
  function saveZ(): void {
    try {
      getDaemonKV().setItem(Z_KEY, JSON.stringify(zOrder));
    } catch {}
  }

  function bringToFront(id: string): void {
    zOrder = [...zOrder.filter((x) => x !== id), id];
    saveZ();
  }

  /** Per-note z-index, derived reactively from `zOrder` so the
   *  template re-applies the new value whenever a focus/drag/save
   *  reshuffles the stack. Plain `zIndexOf(note.id)` in the template
   *  would only re-run when the each-iteration's identity changed —
   *  same compiler-can't-see-inside-functions limitation as
   *  `positionsByNoteId`. Notes not in `zOrder` (e.g. just-fetched
   *  before they've been interacted with) sit at the bottom of the
   *  stack at 1000. */
  let zIndexById: Record<string, number> = {};
  $: {
    void zOrder;
    const next: Record<string, number> = {};
    for (let i = 0; i < zOrder.length; i++) next[zOrder[i]!] = 1000 + i;
    zIndexById = next;
  }

  function cssEscape(s: string): string {
    if (typeof (window as any).CSS?.escape === "function") {
      return (window as any).CSS.escape(s);
    }
    return s.replace(/["\\]/g, "\\$&");
  }

  /** Resolve a note's first usable anchor to the row's outer `<li>`.
   *  The "+ note" button writes `worktree:<wt.path>` and the row template
   *  carries `data-wt-row="<wt.path>"`. Returns null when:
   *  - the row is missing (collapsed via the picker, repo removed,
   *    or not yet mounted);
   *  - the row is folded (`.row-folded`) — a hanging note would
   *    overlap the next repo in the single-line summary state;
   *  - the user has hidden this row's notes via the "notes" toggle
   *    (`.row-notes-hidden`) — CSS-only hide, components stay
   *    mounted in the layer.
   *  The note re-appears the moment the row is expanded / toggled
   *  back on (MutationObserver kicks a tick on the class change). */
  function findAnchorLi(note: NoteShape): HTMLElement | null {
    for (const a of note.anchors) {
      if (a.startsWith("worktree:")) {
        const path = a.slice("worktree:".length);
        const el = document.querySelector<HTMLElement>(
          `[data-wt-row="${cssEscape(path)}"]:not(.row-folded):not(.row-notes-hidden)`,
        );
        if (el) return el;
      }
    }
    return null;
  }

  function visibleWorktreeRows(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-wt-row]:not(.row-folded):not(.row-notes-hidden)",
      ),
    );
  }

  function anchorFromRow(li: HTMLElement): string | null {
    const path = li.dataset.wtRow;
    return path ? `worktree:${path}` : null;
  }

  function primaryDropAnchor(note: NoteShape): string | undefined {
    return note.anchors.find((a) => a.startsWith("worktree:") || a.startsWith("repo:"));
  }

  function noteCanDropOnAnchor(note: NoteShape, anchor: string): boolean {
    return primaryDropAnchor(note) === anchor;
  }

  function notesShareDropAnchor(a: NoteShape, b: NoteShape): boolean {
    const anchor = primaryDropAnchor(a);
    return !!anchor && anchor === primaryDropAnchor(b);
  }

  function dropTargetAt(
    clientX: number,
    clientY: number,
  ): { anchor: string; li: HTMLElement } | null {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const li = (el as HTMLElement).closest<HTMLElement>("[data-wt-row]");
      if (!li || li.classList.contains("row-folded") || li.classList.contains("row-notes-hidden")) {
        continue;
      }
      const anchor = anchorFromRow(li);
      if (anchor) return { anchor, li };
    }

    for (const li of visibleWorktreeRows()) {
      const r = li.getBoundingClientRect();
      const ownedBottom = r.bottom + (parseFloat(li.style.marginBottom || "0") || 0);
      if (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= ownedBottom
      ) {
        const anchor = anchorFromRow(li);
        if (anchor) return { anchor, li };
      }
    }

    let best: { li: HTMLElement; dist: number } | null = null;
    for (const li of visibleWorktreeRows()) {
      const r = li.getBoundingClientRect();
      const ownedBottom = r.bottom + (parseFloat(li.style.marginBottom || "0") || 0);
      const dy =
        clientY < r.top ? r.top - clientY :
        clientY > ownedBottom ? clientY - ownedBottom :
        0;
      const dx =
        clientX < r.left ? r.left - clientX :
        clientX > r.right ? clientX - r.right :
        0;
      const dist = dy * dy + dx * dx * 0.15;
      if (!best || dist < best.dist) best = { li, dist };
    }
    if (!best) return null;
    const anchor = anchorFromRow(best.li);
    return anchor ? { anchor, li: best.li } : null;
  }

  function noteCreationTargetAtPoint(
    clientX: number,
    clientY: number,
  ): { anchor: string; li: HTMLElement } | null {
    const rows = visibleWorktreeRows()
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    for (let i = 0; i < rows.length; i++) {
      const li = rows[i]!;
      const r = li.getBoundingClientRect();
      const nextTop = rows[i + 1]?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
      const ownedBottom = Math.max(
        r.bottom + (parseFloat(li.style.marginBottom || "0") || 0),
        Math.min(nextTop, r.bottom + 24),
      );
      if (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.bottom &&
        clientY <= ownedBottom
      ) {
        const anchor = anchorFromRow(li);
        if (anchor) return { anchor, li };
      }
    }
    return null;
  }

  function isEmptyNoteCreationTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return !target.closest(
      [
        ".sticky",
        ".session-col",
        ".terminal-wrap",
        ".xterm-host",
        ".attachment-media-scrim",
        "[data-note-attachment-zone]",
        "[data-inline-attachment-raw]",
        "button",
        "a",
        "input",
        "textarea",
        "select",
        "[contenteditable='true']",
        "[role='button']",
      ].join(", "),
    );
  }

  function noteAtPoint(clientX: number, clientY: number, excludeId?: string): NoteShape | null {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const sticky = (el as HTMLElement).closest<HTMLElement>(".sticky[data-note-id]");
      const id = sticky?.dataset.noteId;
      if (!id || id === excludeId) continue;
      const note = notes.find((n) => n.id === id);
      if (note) return note;
    }
    return null;
  }

  function attachmentZoneNoteAtPoint(
    clientX: number,
    clientY: number,
    excludeId?: string,
  ): NoteShape | null {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const zone = (el as HTMLElement).closest<HTMLElement>("[data-note-attachment-zone]");
      if (!zone) continue;
      const sticky = zone.closest<HTMLElement>(".sticky[data-note-id]");
      const id = sticky?.dataset.noteId;
      if (!id || id === excludeId) continue;
      const note = notes.find((n) => n.id === id);
      if (note && note.kind !== "link" && note.kind !== "emoji") return note;
    }
    return null;
  }

  function attachmentZoneNoteFromEventTarget(target: EventTarget | null): NoteShape | null {
    if (!(target instanceof Element)) return null;
    const zone = target.closest<HTMLElement>("[data-note-attachment-zone]");
    const sticky = zone?.closest<HTMLElement>(".sticky[data-note-id]");
    const id = sticky?.dataset.noteId;
    const note = id ? notes.find((n) => n.id === id) ?? null : null;
    return note && note.kind !== "link" && note.kind !== "emoji" ? note : null;
  }

  function noteCanReceiveAttachments(note: NoteShape): boolean {
    return note.kind !== "link" && note.kind !== "emoji";
  }

  function isTerminalEventTarget(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest(".xterm-host, .terminal-wrap");
  }

  function isAttachmentModalEventTarget(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest(".attachment-media-scrim");
  }

  function isEditableEventTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return !!target.closest("input, textarea, [contenteditable='true']");
  }

  function inlineAttachmentRawAtPoint(
    clientX: number,
    clientY: number,
    sourceRaw: string,
  ): string | null {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const chip = (el as HTMLElement).closest<HTMLElement>("[data-inline-attachment-raw]");
      const raw = chip?.dataset.inlineAttachmentRaw;
      if (raw && raw !== sourceRaw) return raw;
    }
    return null;
  }

  function sessionColumnAtPoint(clientX: number, clientY: number): HTMLElement | null {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const col = (el as HTMLElement).closest<HTMLElement>(
        ".session-col[data-session-source]",
      );
      if (col?.dataset.sessionSource) return col;
    }
    return null;
  }

  function sessionLinkTargetAtPoint(
    clientX: number,
    clientY: number,
  ): NoteShape["target"] | null {
    const col = sessionColumnAtPoint(clientX, clientY);
    const source = col?.dataset.sessionSource;
    if (!source) return null;

    let label = "(session)";
    let agent = "";
    let subtitle = "";
    let meta = "";
    outer: for (const repo of repos) {
      for (const wt of repo.worktrees ?? []) {
        const found = wt.agents?.find((a) => a.source === source);
        if (!found) continue;
        agent = found.agent;
        label =
          found.manualTitle?.trim() ||
          found.title?.trim() ||
          found.firstUserMessage?.trim() ||
          (found.sessionId ? `session ${found.sessionId.slice(0, 8)}` : label);
        subtitle = found.messageCount ? `${found.messageCount} msg` : "";
        meta = found.lastActive ? relativeAge(found.lastActive) : "";
        break outer;
      }
    }

    return {
      type: "session",
      value: source,
      label,
      ...(agent ? { agent } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(meta ? { meta } : {}),
    };
  }

  function notePayloadForInlineAttachment(
    raw: string,
    attachment: InlineAttachment,
  ): {
    body: string;
    kind?: "note" | "link" | "emoji";
    target?: NoteShape["target"];
  } {
    if (attachment.kind === "emoji") {
      return { body: attachment.body, kind: "emoji" };
    }
    if (attachment.kind === "link") {
      return { body: "", kind: "link", target: attachment.target };
    }
    if (attachment.kind === "note") {
      return { body: attachment.body };
    }
    return { body: raw };
  }

  function setDroppedOffset(
    id: string,
    li: HTMLElement,
    clientX: number,
    clientY: number,
    grab?: {
      grabXFrac?: number;
      grabYFrac?: number;
      width?: number;
      height?: number;
    },
  ): void {
    const rowRect = li.getBoundingClientRect();
    const rowDocLeft = rowRect.left + window.scrollX;
    const rowDocBottom = rowRect.bottom + window.scrollY;
    const grabX = grab?.grabXFrac !== undefined && grab.width !== undefined
      ? grab.grabXFrac * grab.width
      : NOTE_W / 2;
    const grabY = grab?.grabYFrac !== undefined && grab.height !== undefined
      ? grab.grabYFrac * grab.height
      : 28;
    const desiredX = clientX + window.scrollX - grabX;
    const desiredY = clientY + window.scrollY - grabY;
    const offsetXFrac = rowRect.width > 0
      ? Math.min(1, Math.max(0, (desiredX - rowDocLeft) / rowRect.width))
      : DEFAULT_OFFSET_X_FRAC;
    const baseY = rowDocBottom - NOTE_OVERLAP;
    const wiggleUp = Math.min(NOTE_WIGGLE_UP_PX, rowRect.height * NOTE_WIGGLE_UP_PCT);
    const offsetY = Math.min(
      NOTE_WIGGLE_DOWN_PX,
      Math.max(-wiggleUp, desiredY - baseY),
    );
    const prev = offsets[id] ?? {};
    offsets = { ...offsets, [id]: { ...prev, offsetXFrac, offsetY } };
    saveOffsets();
  }

  function grabGeometryFor(note: NoteShape): {
    grabXFrac?: number;
    grabYFrac?: number;
    width?: number;
    height?: number;
  } {
    const sticky = document.querySelector<HTMLElement>(
      `.sticky[data-note-id="${cssEscape(note.id)}"]`,
    );
    const off = offsets[note.id];
    return {
      grabXFrac: off?.grabXFrac,
      grabYFrac: off?.grabYFrac,
      width: sticky?.offsetWidth,
      height: sticky?.offsetHeight,
    };
  }

  /** Screen position for one note. Pure — every reactive input is read
   *  at call time, so the caller is responsible for tracking the deps
   *  (we do that in the `$:` block below). Returns null when the
   *  anchor row isn't on screen — the layer hides the note rather
   *  than letting it drift.
   *
   *  Both X and Y are computed from the outer `<li>`'s bounding box,
   *  not the inner `.row-content`. That matters because we push the
   *  rows below this one with `margin-bottom` (outside the `<li>`'s
   *  border box) rather than `padding-bottom` (inside it) — so the
   *  `<li>`'s visible bottom edge is the row's actual bottom edge,
   *  not a phantom line above a padded space. Anchoring on the `<li>`
   *  is what makes the note's tape tuck under the *visible* bottom
   *  edge instead of floating somewhere inside the row. */
  function screenPosFor(note: NoteShape): { x: number; y: number } | null {
    // Staged notes float beneath the "+" button until the user commits
    // text (or discards via Esc / click-outside). docX/docY were
    // captured at spawn so the note scrolls naturally with the page.
    // Clamp against the *visible viewport's right edge*, not the
    // document's scrollWidth — a staged chip near an edge-aligned
    // button would otherwise extend off-screen on a non-scrolling
    // page (the chip itself doesn't widen the document, but
    // scrollWidth doesn't account for that either, leaving the
    // popover-style content invisible past the viewport edge).
    const st = staging[note.id];
    if (st) {
      const w = note.kind === "link" ? LINK_W : NOTE_W;
      const viewportRight = window.scrollX + window.innerWidth - 8;
      const maxX = Math.max(0, viewportRight - w);
      return { x: Math.min(Math.max(0, st.docX), maxX), y: st.docY };
    }
    // Mid-fly: ease-out cubic between captured from/to.
    const fly = flyingNotes[note.id];
    if (fly) {
      const t = Math.min(1, (performance.now() - fly.startMs) / fly.durationMs);
      const e = 1 - Math.pow(1 - t, 3);
      return {
        x: fly.fromX + (fly.toX - fly.fromX) * e,
        y: fly.fromY + (fly.toY - fly.fromY) * e,
      };
    }
    const li = findAnchorLi(note);
    if (!li) return null;
    const r = li.getBoundingClientRect();
    const off = offsets[note.id];
    // Resolution order for the horizontal offset:
    //   1. offsetXFrac    — preferred; scales with row width on resize.
    //   2. legacy offsetX — one-shot: convert to a fraction and rewrite
    //                       the entry so this branch never fires again
    //                       for this note.
    //   3. default        — right-of-center for fresh notes.
    let offsetX: number;
    if (off?.offsetXFrac !== undefined) {
      offsetX = off.offsetXFrac * r.width;
    } else if (off?.offsetX !== undefined && r.width > 0) {
      const frac = Math.max(0, Math.min(1, off.offsetX / r.width));
      offsets[note.id] = { offsetXFrac: frac, offsetY: off.offsetY };
      saveOffsets();
      offsetX = frac * r.width;
    } else {
      offsetX = DEFAULT_OFFSET_X_FRAC * r.width;
    }
    const offsetY = off?.offsetY ?? 0;
    // Document coordinates — the layer is `position: absolute` at the
    // document's top-left, so children that use these values scroll
    // natively with the page. Translating viewport-relative rects to
    // doc-relative is just `+ window.scrollX/Y` since getBoundingClientRect
    // is viewport-relative.
    const docLeft = r.left + window.scrollX;
    const docBottom = r.bottom + window.scrollY;
    const maxX = Math.max(0, document.documentElement.scrollWidth - NOTE_W - 4);
    const x = Math.min(Math.max(0, docLeft + offsetX), maxX);
    // Default Y tucks the note's top under the row's bottom edge by
    // NOTE_OVERLAP px — that's where the "tape" pseudo-element sits.
    // offsetY adds the small per-note wiggle the user can drag.
    const y = docBottom - NOTE_OVERLAP + offsetY;
    return { x, y };
  }

  /** Fraction of the row width where a brand-new (never-dragged)
   *  note lands. 0.6 places it right of center, clear of the row's
   *  header chips and reasonably close to the "+ note" button. */
  const DEFAULT_OFFSET_X_FRAC = 0.6;

  /** Pre-computed screen position per note. Reactive in `tick` (every
   *  scroll / resize / mutation), `offsets` (any horizontal drag), and
   *  `notes` (create / update / remove). Without this $: layer the
   *  `{@const pos = screenPosFor(note)}` in the template would only
   *  re-run when the each-block's identity changed — drags wouldn't
   *  move the note, and the row's-bottom anchor wouldn't follow when
   *  the page scrolled. */
  let positionsByNoteId: Record<string, { x: number; y: number } | null> = {};
  $: {
    // Touch every reactive dep so the Svelte compiler binds this
    // statement to all three.
    void tick;
    void offsets;
    void staging;
    void flyingNotes;
    const next: Record<string, { x: number; y: number } | null> = {};
    for (const n of notes) next[n.id] = screenPosFor(n);
    positionsByNoteId = next;
  }

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/notes");
      if (!res.ok) return;
      const fetched = (await res.json()) as NoteShape[];
      // Drain any pending fly-restores whose note just arrived. Done
      // BEFORE we assign `notes` so the staging entries land in the
      // same synchronous block — Svelte batches `notes` and
      // `staging` writes into one render pass, and `screenPosFor`
      // reads `staging` first, so the very first paint of the
      // restored note happens at the trigger rect rather than the
      // pin slot. Skipping this ordering is the bug that made the
      // note "appear, pause, then fly".
      const prevIds = new Set(notes.map((n) => n.id));
      const flyAfter: string[] = [];
      if (Object.keys(pendingRestoresByNoteId).length > 0) {
        const nextStaging = { ...staging };
        let stagingChanged = false;
        for (const n of fetched) {
          const rect = pendingRestoresByNoteId[n.id];
          if (!rect) continue;
          if (prevIds.has(n.id)) {
            // Already present — pending intent is stale; drop it
            // without animating to avoid a jarring teleport.
            delete pendingRestoresByNoteId[n.id];
            continue;
          }
          const anchor = n.anchors[0];
          if (!anchor) {
            delete pendingRestoresByNoteId[n.id];
            continue;
          }
          const w = n.kind === "link" ? LINK_W : NOTE_W;
          const docX =
            rect.left + rect.width / 2 - w / 2 + window.scrollX;
          const docY = rect.bottom + 8 + window.scrollY;
          nextStaging[n.id] = { docX, docY, anchor };
          stagingChanged = true;
          flyAfter.push(n.id);
          delete pendingRestoresByNoteId[n.id];
        }
        if (stagingChanged) staging = nextStaging;
      }
      notes = fetched;
      // Trim z-order entries for notes that no longer exist so the
      // list stays bounded. We deliberately do NOT trim `offsets`:
      // keeping the offset record for deleted notes means an undo
      // — via toast, events badge, or Ctrl+Z — restores the note to
      // its previous slot, regardless of how long the undo grace
      // window was. localStorage size is fine for hundreds of stale
      // entries; if it ever becomes a problem we can age them out by
      // a lastUsed timestamp.
      const live = new Set(notes.map((n) => n.id));
      const trimmed = zOrder.filter((id) => live.has(id));
      if (trimmed.length !== zOrder.length) {
        zOrder = trimmed;
        saveZ();
      }
      // Publish per-anchor counts so App.svelte can render the
      // count badge next to each row's "+ note" button without
      // duplicating the /api/notes fetch.
      const counts: Record<string, number> = {};
      for (const n of notes) {
        for (const a of n.anchors) {
          counts[a] = (counts[a] ?? 0) + 1;
        }
      }
      notesCountByAnchor.set(counts);
      notesAll.set(notes);
      // Kick a re-derive so freshly-fetched notes pick up positions.
      tick++;
      // Now that the staged render has landed, hand the restored
      // notes off to the same fly loop the spawn path uses.
      if (flyAfter.length > 0) {
        await svelteTick();
        for (const id of flyAfter) {
          bringToFront(id);
          void flyStagedToPin(id);
        }
      }
    } catch {
      // Network errors are non-fatal — the layer just stays empty.
    }
  }

  async function handleSpawn(args: {
    anchor: string;
    originRect: DOMRect;
    kind?: "note" | "link" | "emoji";
    body?: string;
    target?: {
      type: "url" | "commit" | "session" | "file" | "command";
      value: string;
      label?: string;
      subtitle?: string;
      meta?: string;
      agent?: string;
      provider?: string;
      repoId?: string;
      cwd?: string;
      command?: string;
      runMode?: "internal" | "external" | "shell";
    };
  }): Promise<void> {
    const kind = args.kind ?? "note";
    const hasTarget = !!args.target;
    const autoCommit = hasTarget || kind === "emoji";
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: args.body ?? "",
          anchors: [args.anchor],
          ...(kind !== "note" ? { kind } : {}),
          ...(args.target ? { target: args.target } : {}),
        }),
      });
      if (!res.ok) return;
      const created = (await res.json()) as NoteShape;
      const docX =
        args.originRect.left + args.originRect.width / 2 - NOTE_W / 2 + window.scrollX;
      const docY = args.originRect.bottom + 8 + window.scrollY;
      staging = { ...staging, [created.id]: { docX, docY, anchor: args.anchor } };
      if (kind === "emoji") {
        const scale = 0.85 + Math.random() * 0.3;
        const prev = offsets[created.id] ?? {};
        offsets = { ...offsets, [created.id]: { ...prev, emojiScale: scale } };
        saveOffsets();
      }
      notes = [created, ...notes];
      bringToFront(created.id);
      editingId = autoCommit ? null : created.id;
      tick++;
      await svelteTick();
      editingId = null;
      if (autoCommit) {
        await flyStagedToPin(created.id);
      }
    } catch {}
  }

  async function createNoteAtPoint(
    target: { anchor: string; li: HTMLElement },
    clientX: number,
    clientY: number,
  ): Promise<void> {
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "",
          anchors: [target.anchor],
          tags: [],
        }),
      });
      if (!res.ok) return;
      const created = (await res.json()) as NoteShape;
      setDroppedOffset(created.id, target.li, clientX, clientY);
      staging = {
        ...staging,
        [created.id]: {
          docX: clientX + window.scrollX - NOTE_W / 2,
          docY: clientY + window.scrollY - 28,
          anchor: target.anchor,
          keepAtOrigin: true,
        },
      };
      notes = [created, ...notes];
      bringToFront(created.id);
      editingId = created.id;
      tick++;
      await svelteTick();
      editingId = null;
    } catch {}
  }

  interface InlineAttachmentDragPayload {
    sourceNoteId: string;
    raw: string;
    attachment: InlineAttachment;
  }

  function hasInlineAttachmentDrag(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes(INLINE_ATTACHMENT_DRAG_MIME);
  }

  function parseInlineAttachmentDrag(e: DragEvent): InlineAttachmentDragPayload | null {
    const raw = e.dataTransfer?.getData(INLINE_ATTACHMENT_DRAG_MIME);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== "object") return null;
      const obj = value as Partial<InlineAttachmentDragPayload>;
      if (
        typeof obj.sourceNoteId !== "string" ||
        typeof obj.raw !== "string" ||
        !obj.attachment ||
        typeof obj.attachment !== "object"
      ) {
        return null;
      }
      return {
        sourceNoteId: obj.sourceNoteId,
        raw: obj.raw,
        attachment: obj.attachment,
      };
    } catch {
      return null;
    }
  }

  function hasLinkTargetDrag(e: DragEvent): boolean {
    const types = Array.from(e.dataTransfer?.types ?? []);
    return types.includes(LINK_TARGET_DRAG_MIME) || types.includes(SESSION_LINK_DRAG_MIME);
  }

  function imageFileFromTransfer(dt: DataTransfer | null): File | null {
    if (!dt) return null;
    for (const file of Array.from(dt.files ?? [])) {
      if (file.type.startsWith("image/")) return file;
    }
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) return file;
    }
    return null;
  }

  function hasFileTransfer(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    return (
      Array.from(dt.types ?? []).includes("Files") ||
      Array.from(dt.items ?? []).some((item) => item.kind === "file")
    );
  }

  function hasImageFileTransfer(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    return (
      Array.from(dt.files ?? []).some((file) => file.type.startsWith("image/")) ||
      Array.from(dt.items ?? []).some((item) => item.kind === "file" && item.type.startsWith("image/"))
    );
  }

  function transferCanAppendToNote(e: DragEvent): boolean {
    attachmentDragSourceNoteId = null;
    if (hasLinkTargetDrag(e)) return true;
    if (hasInlineAttachmentDrag(e)) {
      const payload = parseInlineAttachmentDrag(e);
      attachmentDragSourceNoteId = payload?.sourceNoteId ?? null;
      return !payload || payload.attachment.kind !== "note";
    }
    return hasImageFileTransfer(e.dataTransfer);
  }

  async function uploadDroppedImageAttachment(
    file: File,
    source: { kind: "clipboard" | "drop"; types: string[] },
  ): Promise<string | null> {
    try {
      const shrunk = await shrinkImageBlob(file);
      const filename = file.name && file.name !== "blob" ? file.name : undefined;
      const form = new FormData();
      form.append(
        "file",
        filename ? new File([shrunk], filename, { type: shrunk.type }) : shrunk,
      );
      const res = await fetch("/api/attach", { method: "POST", body: form });
      if (!res.ok) return null;
      const { path } = (await res.json()) as { path: string };
      return makeImageAttachmentRef({
        path,
        ...(filename ? { filename } : {}),
        mimeType: shrunk.type || file.type || undefined,
        size: shrunk.size,
        source: {
          ...source,
          ...(filename ? { filename } : {}),
        },
      });
    } catch {
      return null;
    }
  }

  async function appendImageAttachmentToNote(note: NoteShape, raw: string): Promise<void> {
    if (note.kind === "link" || note.kind === "emoji") return;
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: appendInlineAttachmentRef(note.body, raw) }),
      });
      if (!res.ok) return;
      const updated = (await res.json()) as NoteShape;
      notes = notes.map((n) => (n.id === updated.id ? updated : n));
      bringToFront(updated.id);
      tick++;
    } catch {}
  }

  async function createImageAttachmentNote(
    raw: string,
    rowTarget: { anchor: string; li: HTMLElement },
    clientX: number,
    clientY: number,
  ): Promise<void> {
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: raw,
          anchors: [rowTarget.anchor],
          tags: [],
        }),
      });
      if (!res.ok) return;
      const created = (await res.json()) as NoteShape;
      setDroppedOffset(created.id, rowTarget.li, clientX, clientY);
      notes = [created, ...notes];
      bringToFront(created.id);
      tick++;
    } catch {}
  }

  async function placeImageAttachment(
    raw: string,
    clientX: number,
    clientY: number,
    eventTarget: EventTarget | null,
  ): Promise<void> {
    const targetNote =
      attachmentZoneNoteFromEventTarget(eventTarget) ||
      attachmentZoneNoteAtPoint(clientX, clientY);
    if (targetNote && targetNote.kind !== "link" && targetNote.kind !== "emoji") {
      await appendImageAttachmentToNote(targetNote, raw);
      return;
    }
    const rowTarget = dropTargetAt(clientX, clientY);
    if (rowTarget) await createImageAttachmentNote(raw, rowTarget, clientX, clientY);
  }

  function parseLinkTargetDrag(e: DragEvent): NoteShape["target"] | null {
    const raw =
      e.dataTransfer?.getData(LINK_TARGET_DRAG_MIME) ||
      e.dataTransfer?.getData(SESSION_LINK_DRAG_MIME);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== "object") return null;
      const target = (value as { target?: unknown }).target;
      if (!target || typeof target !== "object") return null;
      const obj = target as Record<string, unknown>;
      if (
        obj.type !== "url" &&
        obj.type !== "commit" &&
        obj.type !== "session" &&
        obj.type !== "file" &&
        obj.type !== "command"
      ) {
        return null;
      }
      if (typeof obj.value !== "string" || !obj.value) {
        return null;
      }
      return {
        type: obj.type,
        value: obj.value,
        ...(typeof obj.label === "string" ? { label: obj.label } : {}),
        ...(typeof obj.agent === "string" ? { agent: obj.agent } : {}),
        ...(typeof obj.subtitle === "string" ? { subtitle: obj.subtitle } : {}),
        ...(typeof obj.meta === "string" ? { meta: obj.meta } : {}),
        ...(typeof obj.provider === "string" ? { provider: obj.provider } : {}),
        ...(typeof obj.repoId === "string" ? { repoId: obj.repoId } : {}),
        ...(typeof obj.cwd === "string" ? { cwd: obj.cwd } : {}),
        ...(typeof obj.command === "string" ? { command: obj.command } : {}),
        ...(obj.runMode === "internal" || obj.runMode === "external" || obj.runMode === "shell"
          ? { runMode: obj.runMode }
          : {}),
      };
    } catch {
      return null;
    }
  }

  function onWindowDragOver(e: DragEvent): void {
    if (isTerminalEventTarget(e.target) || isAttachmentModalEventTarget(e.target)) {
      resetAttachmentDrag();
      return;
    }
    attachmentDragAvailable = transferCanAppendToNote(e);
    attachmentDropNoteId = attachmentDragAvailable
      ? attachmentZoneNoteAtPoint(e.clientX, e.clientY)?.id ?? null
      : null;
    if (hasInlineAttachmentDrag(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      return;
    }
    if (
      hasLinkTargetDrag(e) &&
      (attachmentZoneNoteAtPoint(e.clientX, e.clientY) || dropTargetAt(e.clientX, e.clientY))
    ) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (
      hasImageFileTransfer(e.dataTransfer) &&
      (attachmentZoneNoteAtPoint(e.clientX, e.clientY) || dropTargetAt(e.clientX, e.clientY))
    ) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      return;
    }
    if (hasFileTransfer(e.dataTransfer) && dropTargetAt(e.clientX, e.clientY)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
  }

  function updatePinnedNoteAttachmentTarget(clientX: number, clientY: number): void {
    if (!draggingPinnedNoteId) return;
    const source = notes.find((n) => n.id === draggingPinnedNoteId);
    attachmentDragAvailable = !!source && pinnedNoteCanAppend(source);
    attachmentDropNoteId =
      attachmentDragAvailable
        ? attachmentZoneNoteAtPoint(clientX, clientY, draggingPinnedNoteId)?.id ?? null
        : null;
  }

  async function onWindowDrop(e: DragEvent): Promise<void> {
    if (
      e.defaultPrevented ||
      isTerminalEventTarget(e.target) ||
      isAttachmentModalEventTarget(e.target)
    ) {
      return;
    }
    const hasInline = hasInlineAttachmentDrag(e);
    const hasTargetLink = hasLinkTargetDrag(e);
    const image = imageFileFromTransfer(e.dataTransfer);
    if (!hasInline && !hasTargetLink && !image) return;
    const payload = hasInline ? parseInlineAttachmentDrag(e) : null;
    const targetNote = attachmentZoneNoteAtPoint(
      e.clientX,
      e.clientY,
      payload?.sourceNoteId,
    );
    if (hasTargetLink && targetNote) {
      e.preventDefault();
      const target = parseLinkTargetDrag(e);
      if (target) await appendLinkTargetToNote(targetNote, target);
      return;
    }
    if (hasTargetLink) {
      const target = parseLinkTargetDrag(e);
      const rowTarget = dropTargetAt(e.clientX, e.clientY);
      if (target && rowTarget) {
        e.preventDefault();
        await createLinkTargetNote(target, rowTarget, e.clientX, e.clientY);
      }
      return;
    }
    if (image && !hasInline) {
      e.preventDefault();
      const raw = await uploadDroppedImageAttachment(image, {
        kind: "drop",
        types: e.dataTransfer ? Array.from(e.dataTransfer.types) : [],
      });
      if (raw) await placeImageAttachment(raw, e.clientX, e.clientY, e.target);
      return;
    }
    if (!hasInline) return;
    e.preventDefault();
    if (payload && targetNote) {
      await moveInlineAttachmentIntoNote(
        payload,
        targetNote,
        inlineAttachmentRawAtPoint(e.clientX, e.clientY, payload.raw),
      );
      return;
    }
    const target = dropTargetAt(e.clientX, e.clientY);
    if (!payload || !target) return;
    await detachInlineAttachment(payload, target, e.clientX, e.clientY);
  }

  function onWindowDropEvent(e: DragEvent): void {
    resetAttachmentDrag();
    void onWindowDrop(e);
  }

  function onWindowPointerMove(e: PointerEvent): void {
    lastPointer = { clientX: e.clientX, clientY: e.clientY };
    updatePinnedNoteAttachmentTarget(e.clientX, e.clientY);
  }

  function onWindowMouseMove(e: MouseEvent): void {
    lastPointer = { clientX: e.clientX, clientY: e.clientY };
    updatePinnedNoteAttachmentTarget(e.clientX, e.clientY);
  }

  function onWindowDragEnd(): void {
    resetAttachmentDrag();
  }

  function onWindowDragLeave(e: DragEvent): void {
    if (e.relatedTarget === null) resetAttachmentDrag();
  }

  function onWindowDoubleClick(e: MouseEvent): void {
    if (!isEmptyNoteCreationTarget(e.target)) return;
    const target = noteCreationTargetAtPoint(e.clientX, e.clientY);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    void createNoteAtPoint(target, e.clientX, e.clientY);
  }

  function onWindowPaste(e: ClipboardEvent): void {
    if (
      e.defaultPrevented ||
      isTerminalEventTarget(e.target) ||
      isAttachmentModalEventTarget(e.target) ||
      isEditableEventTarget(e.target)
    ) {
      return;
    }
    const image = imageFileFromTransfer(e.clipboardData);
    if (!image) return;
    e.preventDefault();
    void uploadDroppedImageAttachment(image, {
      kind: "clipboard",
      types: e.clipboardData ? Array.from(e.clipboardData.types) : [],
    }).then(async (raw) => {
      if (!raw) return;
      await placeImageAttachment(raw, lastPointer.clientX, lastPointer.clientY, e.target);
    });
  }

  async function detachInlineAttachment(
    payload: InlineAttachmentDragPayload,
    target: { anchor: string; li: HTMLElement },
    clientX: number,
    clientY: number,
  ): Promise<void> {
    const source = notes.find((n) => n.id === payload.sourceNoteId);
    if (!source) return;
    if (!noteCanDropOnAnchor(source, target.anchor)) return;
    const nextSourceBody = removeInlineAttachmentRef(source.body, payload.raw);
    if (nextSourceBody === source.body) return;
    const sourceParts = parseInlineAttachments(source.body);

    if (
      sourceParts.length === 1 &&
      sourceParts[0]?.kind === "attachment" &&
      sourceParts[0].raw === payload.raw
    ) {
      const auxiliaryAnchors = source.anchors.filter(
        (a) => !a.startsWith("worktree:") && !a.startsWith("repo:"),
      );
      try {
        const res = await fetch(`/api/notes/${encodeURIComponent(source.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anchors: [target.anchor, ...auxiliaryAnchors] }),
        });
        if (!res.ok) return;
        const updated = (await res.json()) as NoteShape;
        setDroppedOffset(updated.id, target.li, clientX, clientY);
        notes = notes.map((n) => (n.id === updated.id ? updated : n));
        bringToFront(updated.id);
        tick++;
      } catch {}
      return;
    }

    try {
      const sourceRes = await fetch(`/api/notes/${encodeURIComponent(source.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: nextSourceBody }),
      });
      if (!sourceRes.ok) return;
      const updatedSource = (await sourceRes.json()) as NoteShape;
      notes = notes.map((n) => (n.id === updatedSource.id ? updatedSource : n));

      const createRes = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...notePayloadForInlineAttachment(payload.raw, payload.attachment),
          anchors: [target.anchor],
          tags: source.tags,
        }),
      });
      if (!createRes.ok) {
        await fetch(`/api/notes/${encodeURIComponent(source.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: source.body }),
        }).catch(() => {});
        notes = notes.map((n) => (n.id === source.id ? source : n));
        return;
      }
      const created = (await createRes.json()) as NoteShape;
      setDroppedOffset(created.id, target.li, clientX, clientY);
      notes = [created, ...notes];
      bringToFront(created.id);
      tick++;
    } catch {}
  }

  async function moveInlineAttachmentIntoNote(
    payload: InlineAttachmentDragPayload,
    targetNote: NoteShape,
    beforeRaw: string | null = null,
  ): Promise<void> {
    const source = notes.find((n) => n.id === payload.sourceNoteId);
    if (!source) return;
    if (payload.sourceNoteId !== targetNote.id && payload.attachment.kind === "note") {
      return;
    }
    if (payload.sourceNoteId !== targetNote.id && !notesShareDropAnchor(source, targetNote)) {
      return;
    }
    if (payload.sourceNoteId === targetNote.id) {
      const nextBody = beforeRaw
        ? moveInlineAttachmentRefBefore(source.body, payload.raw, beforeRaw)
        : moveInlineAttachmentRefToEnd(source.body, payload.raw);
      if (nextBody === source.body) return;
      try {
        const res = await fetch(`/api/notes/${encodeURIComponent(source.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: nextBody }),
        });
        if (!res.ok) return;
        const updated = (await res.json()) as NoteShape;
        notes = notes.map((n) => (n.id === updated.id ? updated : n));
        bringToFront(updated.id);
        tick++;
      } catch {}
      return;
    }
    const nextTargetBody = appendInlineAttachmentRef(targetNote.body, payload.raw);
    const sourceParts = parseInlineAttachments(source.body);
    const sourceIsStandalone =
      sourceParts.length === 1 &&
      sourceParts[0]?.kind === "attachment" &&
      sourceParts[0].raw === payload.raw;
    const nextSourceBody = sourceIsStandalone
      ? ""
      : removeInlineAttachmentRef(source.body, payload.raw);
    if (!sourceIsStandalone && nextSourceBody === source.body) return;

    try {
      const targetRes = await fetch(`/api/notes/${encodeURIComponent(targetNote.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: nextTargetBody }),
      });
      if (!targetRes.ok) return;
      const updatedTarget = (await targetRes.json()) as NoteShape;
      notes = notes.map((n) => (n.id === updatedTarget.id ? updatedTarget : n));

      if (sourceIsStandalone) {
        const res = await fetch(`/api/notes/${encodeURIComponent(source.id)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          await fetch(`/api/notes/${encodeURIComponent(targetNote.id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: targetNote.body }),
          }).catch(() => {});
          notes = notes.map((n) => (n.id === targetNote.id ? targetNote : n));
          return;
        }
        notes = notes.filter((n) => n.id !== source.id);
      } else {
        const sourceRes = await fetch(`/api/notes/${encodeURIComponent(source.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: nextSourceBody }),
        });
        if (!sourceRes.ok) {
          await fetch(`/api/notes/${encodeURIComponent(targetNote.id)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: targetNote.body }),
          }).catch(() => {});
          notes = notes.map((n) => (n.id === targetNote.id ? targetNote : n));
          return;
        }
        const updatedSource = (await sourceRes.json()) as NoteShape;
        notes = notes.map((n) => (n.id === updatedSource.id ? updatedSource : n));
      }
      bringToFront(targetNote.id);
      tick++;
    } catch {}
  }

  /** Common "staged → pinned" animation: pick the best slot on the
   *  anchor row, lock in the offset, kick off the rAF fly loop, and
   *  clear staging. Called from `handleSave` (picker pick) AND from
   *  `handleSpawn` when an auto-commit target was supplied. */
  async function flyStagedToPin(id: string): Promise<void> {
    const st = staging[id];
    if (!st) return;
    if (st.keepAtOrigin) {
      const next = { ...staging };
      delete next[id];
      staging = next;
      return;
    }
    const offsetXFrac = findBestOffsetXFrac(st.anchor, id);
    const prev = offsets[id] ?? {};
    offsets = { ...offsets, [id]: { ...prev, offsetXFrac } };
    saveOffsets();
    const note = notes.find((n) => n.id === id);
    const li = note ? findAnchorLi(note) : null;
    if (li) {
      const r = li.getBoundingClientRect();
      const docLeft = r.left + window.scrollX;
      const docBottom = r.bottom + window.scrollY;
      const maxX = Math.max(
        0,
        document.documentElement.scrollWidth - NOTE_W - 4,
      );
      const toX = Math.min(
        Math.max(0, docLeft + offsetXFrac * r.width),
        maxX,
      );
      const toY = docBottom - NOTE_OVERLAP;
      flyingNotes = {
        ...flyingNotes,
        [id]: {
          fromX: st.docX,
          fromY: st.docY,
          toX,
          toY,
          startMs: performance.now(),
          durationMs: 550,
        },
      };
      startFlyLoop();
    }
    const next = { ...staging };
    delete next[id];
    staging = next;
  }

  /** Pick a horizontal slot (offsetXFrac) on the anchor row that has
   *  the most free space between existing notes. Each pinned note is
   *  treated as covering [frac, frac + noteFrac] of the row's width;
   *  the longest gap among those covered intervals (plus the row
   *  edges) wins, and the new note lands at its centre. Falls back to
   *  the default frac when the row width is unknown or has no siblings. */
  function findBestOffsetXFrac(anchor: string, excludeId: string): number {
    if (!anchor.startsWith("worktree:")) return DEFAULT_OFFSET_X_FRAC;
    const path = anchor.slice("worktree:".length);
    const li = document.querySelector<HTMLElement>(
      `[data-wt-row="${cssEscape(path)}"]`,
    );
    if (!li) return DEFAULT_OFFSET_X_FRAC;
    const rowWidth = li.getBoundingClientRect().width;
    if (rowWidth <= 0) return DEFAULT_OFFSET_X_FRAC;
    const noteFrac = Math.min(0.5, NOTE_W / rowWidth);
    const max = Math.max(0, 1 - noteFrac);
    const occupied = notes
      .filter(
        (n) => n.id !== excludeId && n.anchors.includes(anchor) && !staging[n.id],
      )
      .map((n) => offsets[n.id]?.offsetXFrac)
      .filter((f): f is number => typeof f === "number")
      .map((f) => ({ start: f, end: Math.min(1, f + noteFrac) }))
      .sort((a, b) => a.start - b.start);
    let bestCentre = DEFAULT_OFFSET_X_FRAC;
    let bestSize = -1;
    let cursor = 0;
    for (const iv of occupied) {
      const gapEnd = Math.min(max, iv.start - noteFrac);
      if (gapEnd > cursor) {
        const size = gapEnd - cursor;
        if (size > bestSize) {
          bestSize = size;
          bestCentre = (cursor + gapEnd) / 2;
        }
      }
      cursor = Math.max(cursor, iv.end);
    }
    if (cursor < max) {
      const size = max - cursor;
      if (size > bestSize) {
        bestSize = size;
        bestCentre = (cursor + max) / 2;
      }
    }
    return Math.max(0, Math.min(max, bestCentre));
  }

  async function handleSave(
    e: CustomEvent<{
      id: string;
      body: string;
      target?:
        | { type: "url" | "commit" | "session" | "file" | "command"; value: string }
        | null;
      kind?: "note" | "link";
    }>,
  ): Promise<void> {
    if (staging[e.detail.id]) {
      // First commit of a staged note. Optimistically apply the
      // picked target + kind locally so the chip wears the right
      // brand mark while the fly animation runs and the PUT
      // round-trips. Without this it'd render its "(empty link)"
      // placeholder for ~50-300ms — the icon would visibly flash
      // in after the PUT response landed.
      if (e.detail.target || e.detail.kind) {
        notes = notes.map((n) =>
          n.id === e.detail.id
            ? {
                ...n,
                ...(e.detail.target
                  ? { target: e.detail.target as NoteShape["target"] }
                  : {}),
                ...(e.detail.kind ? { kind: e.detail.kind } : {}),
              }
            : n,
        );
      }
      // Shared with the auto-commit Save-as-link path. One helper,
      // one fly animation — picker pick and "save with target"
      // both look identical from this point forward.
      await flyStagedToPin(e.detail.id);
    }
    try {
      // PUT body shape mirrors the daemon's accepted fields. We only
      // forward `kind`/`target` when the child component actually sent
      // them (link saves), so paper-note PUTs stay identical to the
      // pre-link payload — no churn on the events log.
      const putBody: Record<string, unknown> = { body: e.detail.body };
      if (e.detail.kind !== undefined) putBody.kind = e.detail.kind;
      if (e.detail.target !== undefined) putBody.target = e.detail.target;
      const res = await fetch(`/api/notes/${encodeURIComponent(e.detail.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(putBody),
      });
      if (!res.ok) return;
      const updated = (await res.json()) as NoteShape;
      notes = notes.map((n) => (n.id === updated.id ? updated : n));
      // Last interaction wins: writing to a note brings it to the
      // top of the stack alongside drag/focus.
      bringToFront(updated.id);
    } catch {}
  }

  /** Toast snapshot used to render the "Note deleted · Undo" pill.
   *  The actual undo is delegated to the workspace events log
   *  (/api/events/:id/undo) so the toast and the events-badge undo
   *  use the *same* mechanism — no parallel paths, no chance of the
   *  two views getting out of sync. We don't track the offset here
   *  because `offsets[id]` stays in localStorage even after the note
   *  is deleted: any undo path (toast, events badge, Ctrl+Z) finds
   *  the entry waiting and restores the note to its old spot. */
  interface Undoable {
    key: number;            // stable {#each} key
    eventId: string;        // /api/events/<eventId>/undo target
    body: string;           // for the toast text only
    timeoutId: ReturnType<typeof setTimeout>;
  }
  let undoables: Undoable[] = [];
  let nextUndoKey = 1;
  const UNDO_GRACE_MS = 8000;

  async function handleRemove(e: CustomEvent<{ id: string }>): Promise<void> {
    const id = e.detail.id;
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    const isStaging = !!staging[id];
    if (isStaging) {
      try {
        await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {}
      notes = notes.filter((n) => n.id !== id);
      const next = { ...staging };
      delete next[id];
      staging = next;
      return;
    }
    // Play the shrink+fade first (the .removing class on the host
    // triggers a ~300ms transform/opacity transition) — only then do
    // we hit the server and splice the note out of the array. Doing
    // it the other way would unmount the StickyNote before the
    // animation could even begin.
    removingIds = new Set([...removingIds, id]);
    await new Promise((r) => setTimeout(r, 320));
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        // Server refused — roll back the animation so the note
        // re-materializes rather than getting stuck invisible.
        const nextRemoving = new Set(removingIds);
        nextRemoving.delete(id);
        removingIds = nextRemoving;
        return;
      }
      const { eventId } = (await res.json().catch(() => ({}))) as {
        eventId?: string;
      };
      notes = notes.filter((n) => n.id !== id);
      const nextRemoving = new Set(removingIds);
      nextRemoving.delete(id);
      removingIds = nextRemoving;
      // NB: deliberately not deleting offsets[id] / zOrder entries —
      // they're preserved across deletion so an undo (via any path)
      // brings the note back to its previous slot, not the default
      // position.
      if (!eventId) return; // can't offer undo without an event id
      const key = nextUndoKey++;
      const timeoutId = setTimeout(() => {
        undoables = undoables.filter((u) => u.key !== key);
      }, UNDO_GRACE_MS);
      undoables = [
        ...undoables,
        { key, eventId, body: note.body, timeoutId },
      ];
    } catch {}
  }

  async function undoDelete(key: number): Promise<void> {
    const u = undoables.find((x) => x.key === key);
    if (!u) return;
    clearTimeout(u.timeoutId);
    undoables = undoables.filter((x) => x.key !== key);
    try {
      // The daemon's undo handler recreates the note with the same id;
      // its offset is already sitting in localStorage from before the
      // delete, so SSE-triggered refresh will place it back exactly
      // where it was without any client-side hand-off.
      await fetch(`/api/events/${encodeURIComponent(u.eventId)}/undo`, {
        method: "POST",
      });
    } catch {}
  }

  function dismissUndo(key: number): void {
    const u = undoables.find((x) => x.key === key);
    if (u) clearTimeout(u.timeoutId);
    undoables = undoables.filter((x) => x.key !== key);
  }

  function handleMove(
    e: CustomEvent<{ id: string; x: number; y: number; clientX?: number; clientY?: number }>,
  ): void {
    // e.detail.{x,y} arrive in document coordinates (StickyNote's
    // drag handler adds window.scrollX/Y). Translate them back to
    // row-relative offsets that survive scroll/resize: offsetXFrac
    // is X relative to the row's width; offsetY is Y relative to the
    // row's bottom edge, clamped to a small wiggle range.
    const note = notes.find((n) => n.id === e.detail.id);
    if (!note) return;
    const li = findAnchorLi(note);
    if (!li) return;
    const rowRect = li.getBoundingClientRect();
    const rowDocLeft = rowRect.left + window.scrollX;
    const rowDocBottom = rowRect.bottom + window.scrollY;
    const rawFrac = rowRect.width > 0
      ? (e.detail.x - rowDocLeft) / rowRect.width
      : DEFAULT_OFFSET_X_FRAC;
    const offsetXFrac = Math.min(1, Math.max(0, rawFrac));
    const baseY = rowDocBottom - NOTE_OVERLAP;
    const wiggleUp = Math.min(NOTE_WIGGLE_UP_PX, rowRect.height * NOTE_WIGGLE_UP_PCT);
    // Both kinds use the same generous downward range now —
    // applyRowMargins' vh-based cap (70vh for notes, 40vh for
    // links) is the real bound on how far the row can grow, so
    // the wiggle is free to be liberal in both cases.
    const wiggleDown =
      note.kind === "link" ? LINK_WIGGLE_DOWN_PX : NOTE_WIGGLE_DOWN_PX;
    const offsetY = Math.min(
      wiggleDown,
      Math.max(-wiggleUp, e.detail.y - baseY),
    );
    // Spread the previous entry so we don't wipe sibling fields like
    // `grabXFrac` / `grabYFrac` / `rotation` that other handlers set.
    // Without this, the `grab` dispatch from mousedown was being
    // overwritten by the very next move dispatch, falling back to a
    // 0,0 transform-origin (top-left of unrotated paper).
    const prev = offsets[e.detail.id] ?? {};
    offsets = {
      ...offsets,
      [e.detail.id]: { ...prev, offsetXFrac, offsetY },
    };
    saveOffsets();
    tick++;
    if (e.detail.clientX !== undefined && e.detail.clientY !== undefined) {
      updatePinnedNoteAttachmentTarget(e.detail.clientX, e.detail.clientY);
    }
  }

  function handleFocus(e: CustomEvent<{ id: string }>): void {
    bringToFront(e.detail.id);
  }

  /** Drag-end rotation snapshot from StickyNote. Persist verbatim;
   *  the child already clamped to ±30° before dispatching. */
  function handleRotate(e: CustomEvent<{ id: string; rotation: number }>): void {
    const prev = offsets[e.detail.id] ?? {};
    offsets = {
      ...offsets,
      [e.detail.id]: { ...prev, rotation: e.detail.rotation },
    };
    saveOffsets();
  }

  /** Grab-point capture from StickyNote's mousedown. The fraction is
   *  applied as `transform-origin` so rotation pivots around the
   *  cursor; persisting it across drags keeps the visual appearance
   *  stable after release. */
  function handleGrab(
    e: CustomEvent<{ id: string; grabXFrac: number; grabYFrac: number }>,
  ): void {
    draggingPinnedNoteId = e.detail.id;
    dragStartOffsets = {
      ...dragStartOffsets,
      [e.detail.id]: offsets[e.detail.id] ? { ...offsets[e.detail.id] } : null,
    };
    const prev = offsets[e.detail.id] ?? {};
    offsets = {
      ...offsets,
      [e.detail.id]: {
        ...prev,
        grabXFrac: e.detail.grabXFrac,
        grabYFrac: e.detail.grabYFrac,
      },
    };
    saveOffsets();
  }

  function handleDragCancel(e: CustomEvent<{ id: string }>): void {
    clearDragState(e.detail.id);
  }

  function restoreDragStartOffset(id: string): void {
    if (!(id in dragStartOffsets)) return;
    const start = dragStartOffsets[id];
    const next = { ...offsets };
    if (start) {
      next[id] = start;
    } else {
      delete next[id];
    }
    offsets = next;
    saveOffsets();
    tick++;
  }

  function clearDragState(id?: string): void {
    if (!id || draggingPinnedNoteId === id) draggingPinnedNoteId = null;
    attachmentDropNoteId = null;
    attachmentDragAvailable = false;
    attachmentDragSourceNoteId = null;
    if (id && id in dragStartOffsets) {
      const next = { ...dragStartOffsets };
      delete next[id];
      dragStartOffsets = next;
    }
  }

  function inlineRefForPinnedNote(note: NoteShape): string | null {
    if (note.kind === "emoji") {
      return makeEmojiAttachmentRef({ body: note.body });
    }
    if (note.kind === "link") {
      return note.target ? makeLinkAttachmentRef({ target: note.target }) : null;
    }
    const parts = parseInlineAttachments(note.body);
    if (parts.length === 1 && parts[0]?.kind === "attachment") {
      return parts[0].raw;
    }
    return makeNoteAttachmentRef({ body: note.body });
  }

  function pinnedNoteCanAppend(source: NoteShape): boolean {
    const raw = inlineRefForPinnedNote(source);
    if (!raw) return false;
    const part = parseInlineAttachments(raw)[0];
    return part?.kind === "attachment" && part.attachment.kind !== "note";
  }

  function noteShowsAttachmentDropZone(note: NoteShape): boolean {
    if (!noteCanReceiveAttachments(note)) return false;
    if (draggingPinnedNoteId) {
      const source = notes.find((n) => n.id === draggingPinnedNoteId);
      return !!source &&
        source.id !== note.id &&
        pinnedNoteCanAppend(source) &&
        notesShareDropAnchor(source, note);
    }
    return attachmentDragAvailable;
  }

  function resetAttachmentDrag(): void {
    attachmentDropNoteId = null;
    attachmentDragAvailable = false;
    attachmentDragSourceNoteId = null;
  }

  async function appendLinkTargetToNote(
    note: NoteShape,
    target: NonNullable<NoteShape["target"]>,
  ): Promise<void> {
    if (note.kind === "link" || note.kind === "emoji") return;
    const raw = makeLinkAttachmentRef({ target });
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: appendInlineAttachmentRef(note.body, raw) }),
      });
      if (!res.ok) return;
      const updated = (await res.json()) as NoteShape;
      notes = notes.map((n) => (n.id === updated.id ? updated : n));
      bringToFront(updated.id);
      tick++;
    } catch {}
  }

  async function createLinkTargetNote(
    target: NonNullable<NoteShape["target"]>,
    rowTarget: { anchor: string; li: HTMLElement },
    clientX: number,
    clientY: number,
  ): Promise<void> {
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "",
          kind: "link",
          target,
          anchors: [rowTarget.anchor],
          tags: [],
        }),
      });
      if (!res.ok) return;
      const created = (await res.json()) as NoteShape;
      setDroppedOffset(created.id, rowTarget.li, clientX, clientY);
      notes = [created, ...notes];
      bringToFront(created.id);
      tick++;
    } catch {}
  }

  async function stageNoteBodyIntoSessionPrompt(
    note: NoteShape,
    sessionSource: string,
  ): Promise<void> {
    if (note.kind === "emoji") return;
    if (note.kind === "link") {
      if (note.target?.type !== "session" && note.target?.type !== "command") return;
      if (
        note.target.type === "session" &&
        sessionLinkTargetMatchesSource(note.target, sessionSource)
      ) {
        return;
      }
      const text = note.target.type === "session"
        ? `Session: ${note.target.value}`
        : `Command: ${note.target.command ?? note.target.label ?? note.target.value}`;
      window.dispatchEvent(
        new CustomEvent(STAGE_PROMPT_EVENT, {
          detail: { source: sessionSource, chunks: [text] },
        }),
      );
      return;
    }
    try {
      const chunks = await expandNoteBodyForTerminalPasteChunks(
        note.body,
        fetchTextAttachment,
        { omitTargetSessionSource: sessionSource },
      );
      if (!chunks.some((chunk) => chunk.trim())) return;
      window.dispatchEvent(
        new CustomEvent(STAGE_PROMPT_EVENT, {
          detail: { source: sessionSource, chunks },
        }),
      );
    } catch {}
  }

  async function handleDragDrop(
    e: CustomEvent<{ id: string; clientX: number; clientY: number }>,
  ): Promise<void> {
    const source = notes.find((n) => n.id === e.detail.id);
    if (!source) return;
    const sessionCol = sessionColumnAtPoint(e.detail.clientX, e.detail.clientY);
    const sessionSource = sessionCol?.dataset.sessionSource;
    if (sessionSource) {
      restoreDragStartOffset(source.id);
      clearDragState(source.id);
      await stageNoteBodyIntoSessionPrompt(source, sessionSource);
      return;
    }
    const target = attachmentZoneNoteAtPoint(e.detail.clientX, e.detail.clientY, source.id);
    if (target && target.kind !== "link" && target.kind !== "emoji") {
      if (!notesShareDropAnchor(source, target)) {
        restoreDragStartOffset(source.id);
        clearDragState(source.id);
        return;
      }
      const raw = inlineRefForPinnedNote(source);
      if (!raw) {
        restoreDragStartOffset(source.id);
        clearDragState(source.id);
        return;
      }
      const part = parseInlineAttachments(raw)[0];
      if (part?.kind === "attachment" && part.attachment.kind === "note") {
        restoreDragStartOffset(source.id);
        clearDragState(source.id);
        return;
      }
      await movePinnedNoteIntoNote(source, target, raw);
      clearDragState(source.id);
      return;
    }
    const rowTarget = dropTargetAt(e.detail.clientX, e.detail.clientY);
    if (rowTarget) {
      await movePinnedNoteToRow(source, rowTarget, e.detail.clientX, e.detail.clientY);
      clearDragState(source.id);
      return;
    }
    clearDragState(source.id);
  }

  async function movePinnedNoteIntoNote(
    source: NoteShape,
    target: NoteShape,
    raw: string,
  ): Promise<void> {
    try {
      const targetRes = await fetch(`/api/notes/${encodeURIComponent(target.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: appendInlineAttachmentRef(target.body, raw) }),
      });
      if (!targetRes.ok) return;
      const updatedTarget = (await targetRes.json()) as NoteShape;
      notes = notes.map((n) => (n.id === updatedTarget.id ? updatedTarget : n));

      const sourceRes = await fetch(`/api/notes/${encodeURIComponent(source.id)}`, {
        method: "DELETE",
      });
      if (!sourceRes.ok) {
        await fetch(`/api/notes/${encodeURIComponent(target.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: target.body }),
        }).catch(() => {});
        notes = notes.map((n) => (n.id === target.id ? target : n));
        return;
      }
      notes = notes.filter((n) => n.id !== source.id);
      bringToFront(target.id);
      tick++;
    } catch {}
  }

  async function movePinnedNoteToRow(
    note: NoteShape,
    rowTarget: { anchor: string; li: HTMLElement },
    clientX: number,
    clientY: number,
  ): Promise<void> {
    if (!noteCanDropOnAnchor(note, rowTarget.anchor)) return;
    const grab = grabGeometryFor(note);
    const auxiliaryAnchors = note.anchors.filter(
      (a) => !a.startsWith("worktree:") && !a.startsWith("repo:"),
    );
    try {
      const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anchors: [rowTarget.anchor, ...auxiliaryAnchors] }),
      });
      if (!res.ok) return;
      const updated = (await res.json()) as NoteShape;
      setDroppedOffset(updated.id, rowTarget.li, clientX, clientY, grab);
      notes = notes.map((n) => (n.id === updated.id ? updated : n));
      bringToFront(updated.id);
      tick++;
    } catch {}
  }

  /** "Move…" or "Copy…" inside a sticky's edit mode. Move rewrites
   *  the note's anchors via PUT; Copy POSTs a fresh note with the
   *  same body/tags but the new anchor. Both go through the daemon's
   *  reversible event log so Ctrl+Z still works. */
  async function handleReassign(
    e: CustomEvent<{ id: string; anchor: string; mode: "move" | "duplicate" }>,
  ): Promise<void> {
    const note = notes.find((n) => n.id === e.detail.id);
    if (!note) return;
    if (e.detail.mode === "move") {
      // Replace the first worktree/repo anchor with the new one; keep
      // any auxiliary anchors (commit:..., session:...) intact.
      const others = note.anchors.filter(
        (a) => !a.startsWith("worktree:") && !a.startsWith("repo:"),
      );
      const nextAnchors = [e.detail.anchor, ...others];
      try {
        const res = await fetch(`/api/notes/${encodeURIComponent(note.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anchors: nextAnchors }),
        });
        if (!res.ok) return;
        const updated = (await res.json()) as NoteShape;
        notes = notes.map((n) => (n.id === updated.id ? updated : n));
        tick++;
      } catch {}
    } else {
      const others = note.anchors.filter(
        (a) => !a.startsWith("worktree:") && !a.startsWith("repo:"),
      );
      const dupAnchors = [e.detail.anchor, ...others];
      try {
        const res = await fetch("/api/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: note.body,
            anchors: dupAnchors,
            tags: note.tags,
          }),
        });
        if (!res.ok) return;
        const created = (await res.json()) as NoteShape;
        notes = [created, ...notes];
        bringToFront(created.id);
        tick++;
      } catch {}
    }
  }

  // Watch the change-key without firing on the initial value so we
  // don't double-fetch on mount.
  $: void onChangeKey(changeKey);
  function onChangeKey(key: number): void {
    if (key === lastChangeKey) return;
    lastChangeKey = key;
    void refresh();
  }

  // Schedule a tick on the next animation frame so coalesced
  // scroll/resize/mutation bursts only repaint once per frame.
  let rafPending = false;
  function scheduleTick(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      tick++;
    });
  }

  let mutationObs: MutationObserver | null = null;
  let resizeObs: ResizeObserver | null = null;
  /** Per-note ResizeObserver: notes grow/shrink while the user types
   *  in edit mode, and the row's padding-bottom must follow. We track
   *  observed elements separately so we can untrack stale ones in
   *  afterUpdate. */
  let noteResizeObs: ResizeObserver | null = null;
  const observedNoteEls = new Set<Element>();

  /** Outer wrapper for the layer; used both as a stable querySelector
   *  scope (so we don't accidentally match anything in a future
   *  sibling overlay) and as a sentinel for "did we mount yet?". */
  let layerEl: HTMLDivElement;

  /** Rows we previously pushed down with margin-bottom. Tracked so
   *  we can clear the inline style when a row no longer has any
   *  visible notes anchored to it. */
  let marginedRows = new Set<HTMLElement>();

  /** Measure every rendered note and apply just-enough margin-bottom
   *  on each anchored row's `<li>` so the rows below don't overlap.
   *  Margin (not padding) on purpose: padding extends the row's
   *  background box, which would visually swallow the hanging note
   *  inside the row's tinted area. Margin keeps the row visually
   *  compact and adds the spacer *outside* the box — so the note's
   *  tape tucks under the row's visible bottom edge.
   *
   *  Called from afterUpdate (every reactive render) and from the
   *  per-note ResizeObserver (typing in edit mode resizes the note's
   *  textarea, which we'd otherwise miss). */
  function applyRowMargins(): void {
    if (!layerEl) return;
    const need = new Map<HTMLElement, number>();
    const nowObserved = new Set<Element>();
    for (const note of notes) {
      // Don't reserve row space for staged notes — they're floating
      // over the button area, not yet pinned. The row only expands
      // once the user commits text and the note flies into a slot.
      if (staging[note.id]) continue;
      const li = findAnchorLi(note);
      if (!li) continue;
      const stickyEl = layerEl.querySelector<HTMLElement>(
        `.sticky[data-note-id="${cssEscape(note.id)}"]`,
      );
      if (!stickyEl) continue;
      // Track this element for size changes (textarea grow on edit).
      if (!observedNoteEls.has(stickyEl)) {
        noteResizeObs?.observe(stickyEl);
        observedNoteEls.add(stickyEl);
      }
      nowObserved.add(stickyEl);
      const stickyRect = stickyEl.getBoundingClientRect();
      const liRect = li.getBoundingClientRect();
      // Margin so the next row's top sits at `note.bottom + safety`.
      // Extra-safety = max(0, offsetY): the further the user has
      // dragged a note *down* from its baseline, the bigger the gap
      // to the next repo (so a note pulled far away from its repo
      // doesn't crowd the next one). Notes wiggled upward leave the
      // safety at the baseline ROW_SAFETY since their bottom edge
      // is already higher up than the default position.
      // Just clear the chip's actual rendered bottom + a fixed
      // ROW_SAFETY (24px). The user's drag offset is already
      // baked into stickyRect.bottom via the DOM measurement, so
      // adding it AGAIN as an extraSafety multiplier was doubling
      // the gap — a note dragged 100px down was reserving 224+px
      // of row-margin instead of 124. Fixed-gap math reads as
      // "constant breathing room between chip and next row"
      // regardless of how far the user pulled the chip.
      //
      const wantUnclamped =
        stickyRect.bottom + ROW_SAFETY - liRect.bottom;
      const want = Math.max(0, wantUnclamped);
      const prev = need.get(li) ?? 0;
      if (want > prev) need.set(li, want);
    }
    // Stop observing notes that disappeared since last pass.
    for (const el of observedNoteEls) {
      if (!nowObserved.has(el)) {
        noteResizeObs?.unobserve(el);
        observedNoteEls.delete(el);
      }
    }
    // Clear margin on rows that no longer need it.
    for (const li of marginedRows) {
      if (!need.has(li)) {
        li.style.marginBottom = "";
      }
    }
    // Apply margin to anchored rows. Compare with the current inline
    // value so we only write when it actually changes — otherwise the
    // ResizeObserver fires for our own writes and we loop.
    let changed = false;
    for (const [li, pad] of need) {
      const cur = parseFloat(li.style.marginBottom || "0") || 0;
      if (Math.abs(cur - pad) > 0.5) {
        li.style.marginBottom = `${pad}px`;
        changed = true;
      }
    }
    marginedRows = new Set(need.keys());
    // When a row's padding-bottom actually changed it kicks a 180ms
    // CSS transition. The transition itself doesn't fire any DOM
    // events, so without a manual nudge our layer wouldn't repaint
    // and a note pinned to a *sibling* row (which is sliding down
    // because the row above it just gained padding) would visually
    // detach from its row for the duration of the slide. The rAF
    // loop ticks every frame for slightly longer than the transition,
    // so each repaint repositions the note from its anchor's
    // currently-interpolated rect.
    if (changed) startTransitionLoop();
  }

  /** Run a rAF loop that bumps `tick` every frame until `now` reaches
   *  `transitionEndMs`. Extends rather than restarts if called again
   *  while a loop is in flight (consecutive padding changes keep the
   *  loop alive). Idle cost is zero — the loop self-terminates the
   *  frame after the transition window ends. */
  /** rAF loop that pumps `tick++` (and prunes finished entries from
   *  `flyingNotes`) for as long as at least one note is mid-fly.
   *  Idempotent — calling it while already active is a no-op. */
  let flyRafActive = false;
  function startFlyLoop(): void {
    if (flyRafActive) return;
    flyRafActive = true;
    const step = () => {
      const now = performance.now();
      let anyActive = false;
      let mutated = false;
      const next: Record<string, FlyingState> = {};
      for (const [id, fly] of Object.entries(flyingNotes)) {
        if (now < fly.startMs + fly.durationMs) {
          next[id] = fly;
          anyActive = true;
        } else {
          mutated = true;
        }
      }
      if (mutated) flyingNotes = next;
      // tick++ kicks positionsByNoteId to recompute via screenPosFor,
      // which reads performance.now() for the eased fraction.
      tick++;
      if (anyActive) requestAnimationFrame(step);
      else flyRafActive = false;
    };
    requestAnimationFrame(step);
  }

  let transitionEndMs = 0;
  let transitionRafActive = false;
  function startTransitionLoop(durationMs = 220): void {
    transitionEndMs = Math.max(transitionEndMs, performance.now() + durationMs);
    if (transitionRafActive) return;
    transitionRafActive = true;
    const step = () => {
      if (performance.now() >= transitionEndMs) {
        transitionRafActive = false;
        return;
      }
      tick++;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  afterUpdate(() => {
    applyRowMargins();
  });

  /** Pending fly-restore registrations keyed by note id. App.svelte
   *  records an intent here *before* it issues the undo POST, then
   *  `refresh()` (triggered by the resulting SSE) drains the
   *  matching entries the moment the new note lands in `notes` — so
   *  staging is set in the same synchronous block as `notes = ...`,
   *  and the very first render of the restored note already places
   *  it at the trigger rect rather than the pin slot. */
  let pendingRestoresByNoteId: Record<string, DOMRect> = {};
  function handleFlyRestore(args: { id: string; originRect: DOMRect }): void {
    pendingRestoresByNoteId[args.id] = args.originRect;
  }

  onMount(() => {
    loadOffsets();
    lastPointer = { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 };
    _registerLayer(handleSpawn);
    _registerFlyRestore(handleFlyRestore);
    void refresh();

    // No scroll listener — the layer is `position: absolute` at the
    // document's top-left, so notes inside it are part of the document
    // flow and scroll natively on the compositor without any JS
    // bookkeeping. Resize still needs a tick because the row positions
    // relative to the document change when the viewport resizes.
    window.addEventListener("resize", scheduleTick);
    window.addEventListener("pointermove", onWindowPointerMove);
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("dragend", onWindowDragEnd);
    window.addEventListener("dragleave", onWindowDragLeave);
    window.addEventListener("drop", onWindowDropEvent);
    window.addEventListener("dblclick", onWindowDoubleClick);
    window.addEventListener("paste", onWindowPaste);

    // MutationObserver picks up row add/remove, fold/unfold, picker
    // open (which changes the row's layout). We deliberately exclude
    // `style` from the attribute filter so our own padding-bottom
    // writes on `<li>` don't loop back through the observer.
    mutationObs = new MutationObserver(scheduleTick);
    const main = document.querySelector("main");
    if (main) {
      mutationObs.observe(main, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "data-wt-row"],
      });
    }
    // ResizeObserver on <main> covers viewport-resizing the dashboard
    // (sidebar collapse, devtools open) where children shift without
    // attribute changes.
    resizeObs = new ResizeObserver(scheduleTick);
    if (main) resizeObs.observe(main);

    // Per-note ResizeObserver: fires when a note's textarea grows /
    // shrinks under edits. The afterUpdate pass owns the actual
    // padding write, so this just kicks the tick.
    noteResizeObs = new ResizeObserver(scheduleTick);

    // Initial tick so notes draw on first paint after the row list mounts.
    scheduleTick();
  });

  onDestroy(() => {
    _unregisterLayer();
    _unregisterFlyRestore();
    window.removeEventListener("resize", scheduleTick);
    window.removeEventListener("pointermove", onWindowPointerMove);
    window.removeEventListener("mousemove", onWindowMouseMove);
    window.removeEventListener("dragover", onWindowDragOver);
    window.removeEventListener("dragend", onWindowDragEnd);
    window.removeEventListener("dragleave", onWindowDragLeave);
    window.removeEventListener("drop", onWindowDropEvent);
    window.removeEventListener("dblclick", onWindowDoubleClick);
    window.removeEventListener("paste", onWindowPaste);
    mutationObs?.disconnect();
    resizeObs?.disconnect();
    noteResizeObs?.disconnect();
    observedNoteEls.clear();
    // Tell the rAF loop to exit on its next frame.
    transitionEndMs = 0;
    // Clear pending undo timers so a hot reload doesn't fire them
    // against a torn-down component.
    for (const u of undoables) clearTimeout(u.timeoutId);
    undoables = [];
    // Leaving inline margin on rows would survive a hot-reload; clear
    // them so the next mount starts from a clean slate.
    for (const li of marginedRows) li.style.marginBottom = "";
    marginedRows.clear();
  });
</script>

<div class="sticky-layer" aria-hidden={notes.length === 0} bind:this={layerEl}>
  {#each notes as note (note.id)}
    {@const pos = positionsByNoteId[note.id]}
    <!-- Render the host even when the row is folded (`pos === null`)
         and just hide it with display: none. Conditionally rendering
         would unmount StickyNote, which loses the user's in-flight
         edit state — collapsing then expanding a row would yank the
         newest sticky back into edit mode because StickyNote's
         `onMount` re-reads `startEditing` against a stale
         editingId. Hiding instead of unmounting preserves the
         local edit state. -->
    <div
      class="sticky-host"
      class:hidden={!pos}
      class:flying={!!flyingNotes[note.id]}
      class:removing={removingIds.has(note.id)}
      style="z-index: {zIndexById[note.id] ?? 1000};"
    >
      <StickyNote
        {note}
        x={pos?.x ?? 0}
        y={pos?.y ?? 0}
        tilt={tiltFor(note.id)}
        rotation={offsets[note.id]?.rotation ?? 0}
        grabXFrac={offsets[note.id]?.grabXFrac ?? 0}
        grabYFrac={offsets[note.id]?.grabYFrac ?? 0}
        emojiScale={offsets[note.id]?.emojiScale ?? 1}
        attachmentDropAvailable={noteShowsAttachmentDropZone(note)}
        attachmentDropActive={attachmentDropNoteId === note.id}
        attachmentDropSourceActive={!!attachmentDropNoteId &&
          (draggingPinnedNoteId === note.id || attachmentDragSourceNoteId === note.id)}
        startEditing={editingId === note.id}
        removeIfEmpty={!!staging[note.id]}
        flying={!!flyingNotes[note.id]}
        {repos}
        {onCommandLinkOpen}
        {onCommandLinkEdit}
        {runningCommandIds}
        {commandUrls}
        on:move={handleMove}
        on:save={handleSave}
        on:remove={handleRemove}
        on:focus={handleFocus}
        on:reassign={handleReassign}
        on:rotate={handleRotate}
        on:grab={handleGrab}
        on:dragdrop={handleDragDrop}
        on:dragcancel={handleDragCancel}
      />
    </div>
  {/each}
</div>

{#if undoables.length > 0}
  <div class="undo-toasts" role="status" aria-live="polite">
    {#each undoables as u (u.key)}
      <div class="undo-toast">
        <span class="undo-toast-text">
          Note deleted{u.body
            ? ` · \u201C${u.body.split('\n')[0].slice(0, 32)}${
                u.body.length > 32 ? '\u2026' : ''
              }\u201D`
            : ''}
        </span>
        <button class="undo-toast-btn" on:click={() => void undoDelete(u.key)}>
          Undo
        </button>
        <button
          class="undo-toast-dismiss"
          on:click={() => dismissUndo(u.key)}
          aria-label="Dismiss"
        >×</button>
      </div>
    {/each}
  </div>
{/if}
