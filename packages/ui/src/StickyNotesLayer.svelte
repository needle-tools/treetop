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
    kind?: "note" | "link";
    /** Pre-resolved link target. Set by callers (like the chat
     *  burger-menu) that already know the exact session/commit/url
     *  the user wants — the layer skips the picker, stages briefly
     *  at `originRect`, then flies to the pin slot. Empty/absent
     *  means "open the picker so the user can choose". */
    target?: {
      type: "url" | "commit" | "session" | "file";
      value: string;
      label?: string;
      subtitle?: string;
      meta?: string;
      agent?: string;
      provider?: string;
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

  /** Bumped by App.svelte on any SSE `change` event so the layer
   *  refetches if a note was created/updated/deleted via another tab
   *  or by hand on disk. */
  export let changeKey = 0;
  /** Live repos snapshot — passed down to each StickyNote so the
   *  in-edit Move-to / Copy-to picker can list all anchorable
   *  destinations without each note re-fetching /api/repos. */
  interface AnchorableWorktree { path: string; branch: string; }
  interface AnchorableRepo {
    id: string;
    name?: string;
    path: string;
    worktrees?: AnchorableWorktree[];
  }
  export let repos: AnchorableRepo[] = [];

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
  }
  let staging: Record<string, Staging> = {};
  /** Notes mid-fly (staging → pinned). Position is driven by a rAF
   *  loop in this layer (not a CSS transition) — so the per-frame
   *  `x` updates that StickyNote receives feed its pendulum physics,
   *  which produces the same drag-style swing the user gets when
   *  moving the note by hand. */
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
    // Mid-fly: ease-out cubic between captured from/to. The pendulum
    // in StickyNote reads the changing `x` prop and swings accordingly,
    // so the note tilts during the flight exactly the way it would if
    // the user were dragging it across by hand.
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
    kind?: "note" | "link";
    target?: {
      type: "url" | "commit" | "session" | "file";
      value: string;
      label?: string;
      subtitle?: string;
      meta?: string;
      agent?: string;
      provider?: string;
    };
  }): Promise<void> {
    const kind = args.kind ?? "note";
    const hasTarget = !!args.target;
    try {
      // POST with target up-front when the caller already knows it
      // (Save-as-link path) — skips an extra PUT round-trip and
      // means the server returns a fully-formed note we can drop
      // straight into the fly animation.
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "",
          anchors: [args.anchor],
          ...(kind === "link" ? { kind: "link" } : {}),
          ...(args.target ? { target: args.target } : {}),
        }),
      });
      if (!res.ok) return;
      const created = (await res.json()) as NoteShape;
      // Park the new note as "staged" at originRect — same launching
      // pad whether the user is about to pick from the dropdown OR
      // we already have the target and are about to fly the chip
      // straight into its slot. Centred horizontally on the trigger.
      const docX =
        args.originRect.left + args.originRect.width / 2 - NOTE_W / 2 + window.scrollX;
      const docY = args.originRect.bottom + 8 + window.scrollY;
      staging = { ...staging, [created.id]: { docX, docY, anchor: args.anchor } };
      notes = [created, ...notes];
      // Bring to front so the new chip always sits above any
      // previously-pinned attachments — both the picker case and
      // the auto-commit case use the same z-order, which means
      // Save-as-link is no longer hidden behind an older chip.
      bringToFront(created.id);
      // Picker case: enter edit mode so the user can search. Auto-
      // commit case: skip edit mode entirely — the target is set,
      // we're just animating it home.
      editingId = hasTarget ? null : created.id;
      tick++;
      await svelteTick();
      editingId = null;
      if (hasTarget) {
        // Same staging→pinned animation `handleSave` runs after a
        // picker pick. Reusing it (rather than duplicating the
        // offset/fly setup) keeps the two spawn paths visually
        // identical, including the pendulum swing during travel.
        await flyStagedToPin(created.id);
      }
    } catch {}
  }

  /** Common "staged → pinned" animation: pick the best slot on the
   *  anchor row, lock in the offset, kick off the rAF fly loop, and
   *  clear staging. Called from `handleSave` (picker pick) AND from
   *  `handleSpawn` when an auto-commit target was supplied. */
  async function flyStagedToPin(id: string): Promise<void> {
    const st = staging[id];
    if (!st) return;
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
        | { type: "url" | "commit" | "session" | "file"; value: string }
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
    // Play the shrink+fade first (the .removing class on the host
    // triggers a ~300ms transform/opacity transition) — only then do
    // we hit the server and splice the note out of the array. Doing
    // it the other way would unmount the StickyNote before the
    // animation could even begin.
    removingIds = new Set([...removingIds, id]);
    await new Promise((r) => setTimeout(r, 320));
    // Staged-and-empty: the user opened the "+" affordance and walked
    // away without typing. Same fade-out, but no undo toast — the 3s
    // grace already gave them a chance to back out, and the empty
    // note isn't worth a recovery affordance.
    if (isStaging) {
      try {
        await fetch(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {}
      notes = notes.filter((n) => n.id !== id);
      const next = { ...staging };
      delete next[id];
      staging = next;
      const nextRemoving = new Set(removingIds);
      nextRemoving.delete(id);
      removingIds = nextRemoving;
      return;
    }
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

  function handleMove(e: CustomEvent<{ id: string; x: number; y: number }>): void {
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
      // Per-kind cap: links 40vh, notes 70vh. The row's actual
      // margin is the MAX across attachments (`need.set` below),
      // so a row with both kinds picks whichever pushes further
      // — bounded by its kind. The chip itself is still rendered
      // at its real offset (screenPosFor reads offsetY directly);
      // only the row-spacer is capped.
      const vh = typeof window !== "undefined" ? window.innerHeight : 800;
      const kindMax = note.kind === "link" ? vh * 0.40 : vh * 0.70;
      const wantUnclamped =
        stickyRect.bottom + ROW_SAFETY - liRect.bottom;
      const want = Math.max(0, Math.min(kindMax, wantUnclamped));
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
    _registerLayer(handleSpawn);
    _registerFlyRestore(handleFlyRestore);
    void refresh();

    // No scroll listener — the layer is `position: absolute` at the
    // document's top-left, so notes inside it are part of the document
    // flow and scroll natively on the compositor without any JS
    // bookkeeping. Resize still needs a tick because the row positions
    // relative to the document change when the viewport resizes.
    window.addEventListener("resize", scheduleTick);

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
        startEditing={editingId === note.id}
        removeIfEmpty={!!staging[note.id]}
        flying={!!flyingNotes[note.id]}
        {repos}
        on:move={handleMove}
        on:save={handleSave}
        on:remove={handleRemove}
        on:focus={handleFocus}
        on:reassign={handleReassign}
        on:rotate={handleRotate}
        on:grab={handleGrab}
      />
    </div>
  {/each}
</div>

{#if undoables.length > 0}
  <div class="undo-toasts" role="status" aria-live="polite">
    {#each undoables as u (u.key)}
      <div class="undo-toast">
        <span class="undo-toast-text">
          Note deleted{u.note.body
            ? ` · “${u.note.body.split("\n")[0].slice(0, 32)}${
                u.note.body.length > 32 ? "…" : ""
              }”`
            : ""}
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
