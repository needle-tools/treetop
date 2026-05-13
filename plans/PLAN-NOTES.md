# PLAN-NOTES.md — sticky-note overlay per repo

**Status: proposed** (not started).

Cute, draggable sticky notes attached to a repo row. Text-only for v0;
drag to reorder, drag across slots to reposition, trash with undo.
Componentized so later passes can layer on fonts, colours, sizes,
markdown, anchors, or a tiny physics sim without rewiring the
fundamentals.

This is **not** the "Notes with anchors" feature already sketched in
[PLAN.md §Notes with anchors + floating overlay](./PLAN.md#notes-with-anchors--floating-overlay).
That one is markdown-bodied, anchored to git objects (file:line,
folder, commit, worktree, session), and rendered as a global floating
overlay. It targets v1.x+ and stays parked.

This plan is the *lightweight cousin*: a per-repo scratchpad surface
that lives **in** the row's layout, no anchor resolution, no markdown,
no overlay. They can coexist later — different storage files,
different UI surfaces, same workspace.

## v0 scope (what ships)

- **Per-repo notes.** A note belongs to exactly one repo row.
- **Two slots per row.** `above` and `below`. Notes within a slot lay
  out horizontally (a strip of stickies). The slot reserves vertical
  space so sibling repo rows reflow cleanly.
- **Drag/drop:**
  - Reorder within a slot.
  - Drag from `above` ↔ `below` on the same row.
  - Drag onto a different repo row's slot (cross-repo move).
- **Trash with undo.** Click the trash icon → note disappears with a
  toast "Note trashed · Undo". Undo restores it with its original id,
  text, position, and order.
- **Plain text only.** Single-line on the sticky face; click to edit
  inline; Shift+Enter for newline, Enter to commit, Esc to revert.
- **Componentized.** `<StickyNote>` and `<NoteStack>` are independent
  pieces with no implicit row coupling — see [UI](#ui).

## Explicit non-goals for v0

- No anchors (file:line, commit, folder, worktree, session). That's
  PLAN.md's job.
- No markdown rendering, no font styles, no colours, no font sizes,
  no images. Hooks reserved in the data model; UI doesn't render them.
- No physics sim ("dangling on a string"). Mocked up cute, deferred —
  pick it up in a v0.x pass once the layout is stable.
- No floating-overlay layer / `position: fixed` cards.
- No pinning to the dashboard chrome (toolbar / sidebar / global).
- No global "all notes" index, no search.
- No keyboard-only reorder shortcuts beyond inline edit.
- No multi-select / bulk operations.

## Data model

One workspace file: `<workspace>/notes.json`.

```ts
interface Note {
  id: string;                     // uuid
  repoId: string;                 // FK → repos.json
  slot: "above" | "below";
  order: number;                  // dense integer per (repoId, slot); 0 is leftmost
  text: string;                   // utf-8, no length cap at storage layer
  createdAt: string;              // ISO
  // Reserved for later passes — not rendered in v0. Storing them now
  // means a v0 note survives a future schema bump without migration.
  style?: {
    color?: string;               // #rrggbb
    font?: string;
    size?: number;
  };
}

interface NotesFile {
  notes: Note[];
}
```

**Why one file, not per-repo:** matches the existing `repos.json`
shape; one read on boot; trivial to broadcast `change` deltas; easier
test fixtures. Will not scale to thousands of notes but v0's expected
volume is tens.

**Why a flat `order` int and not a linked list / fractional indices:**
v0 has so few notes per slot that re-numbering on insert is free, and
a dense int is the easiest thing to assert on in tests.

## Storage class

`NotesStore` in `packages/daemon/src/notes.ts`, mirroring `Workspace`'s
shape (constructor private, async `open(path)`, methods read-modify-write
the file):

```ts
class NotesStore {
  static async open(workspacePath: string): Promise<NotesStore>;

  async list(): Promise<Note[]>;                          // all notes, all repos
  async listForRepo(repoId: string): Promise<Note[]>;     // sorted by (slot, order)

  async add(input: {
    repoId: string;
    slot: "above" | "below";
    text: string;
  }): Promise<Note>;                                       // appended at slot end

  async remove(id: string): Promise<Note | null>;          // returns deleted note or null

  /** Re-insert with original id + order. Used by undo. */
  async restore(note: Note): Promise<void>;

  async setText(id: string, text: string): Promise<{ oldText: string; newText: string }>;

  /** Move note to (slot, order) within possibly-different repo.
   *  Returns enough info to invert. */
  async move(id: string, to: { repoId: string; slot: "above" | "below"; order: number }):
    Promise<{ from: { repoId: string; slot: "above" | "below"; order: number } }>;
}
```

## Routes

Mirror the existing daemon idioms (see how `add_repo` / `remove_repo` /
`rename_repo` work in `packages/daemon/src/server.ts`):

| Method | Path                              | Event type    | Reversible |
|--------|-----------------------------------|---------------|------------|
| GET    | `/api/notes`                      | —             | —          |
| GET    | `/api/repos/:id/notes`            | —             | —          |
| POST   | `/api/notes`                      | `add_note`    | yes (inverse = note id) |
| DELETE | `/api/notes/:id`                  | `remove_note` | yes (inverse = full note) |
| PATCH  | `/api/notes/:id/text`             | `edit_note`   | yes (inverse = `oldText`) |
| PATCH  | `/api/notes/:id/move`             | `move_note`   | yes (inverse = `from`) |

Body shapes:

```http
POST /api/notes
{ "repoId": "...", "slot": "above" | "below", "text": "..." }

PATCH /api/notes/:id/text
{ "text": "..." }

PATCH /api/notes/:id/move
{ "repoId": "...", "slot": "above" | "below", "order": <int> }
```

Each mutating route appends to `events.jsonl` with the inverse payload
the existing `/api/events/:id/(undo|redo)` handler will need (extend
the switch in `server.ts:1400` with cases for the four new event
types). Broadcast `change` kinds: `note_add`, `note_remove`,
`note_edit`, `note_move`.

**Edit debounce.** The UI batches `edit_note` calls — one event per
edit *commit* (Enter / blur), not per keystroke — so the event log
doesn't bloat and undo step size feels right.

## UI

Two new Svelte components under `packages/ui/src/`:

```
StickyNote.svelte         # one note: text face, edit-in-place, trash button on hover
NoteStack.svelte          # one repo+slot: lays out N <StickyNote>, owns drop-target geometry
```

The repo-row component (existing) becomes the *host*: it renders a
`<NoteStack slot="above" />` above its title strip and a
`<NoteStack slot="below" />` below its content. The host reserves
`auto` vertical space for each stack so when a stack is empty it
collapses to 0px and siblings reflow naturally.

**Drag/drop** uses native HTML5 DnD (no library):

- `StickyNote` is `draggable="true"`, sets `dataTransfer` to its id.
- `NoteStack` listens for `dragenter` / `dragover` (calls
  `preventDefault` to accept), tracks pointer X to compute the
  insertion index between siblings, paints a visible gap there.
- On `drop`, calls `PATCH /api/notes/:id/move` with the resolved
  `{ repoId, slot, order }`.
- Drop on a different `NoteStack` (different `repoId` or `slot`) just
  works — same code path.

**Trash + undo:**

- Trash icon on hover (top-right of the sticky).
- Click → optimistic remove + toast (existing toast slot, if any —
  otherwise add a minimal one in this PR), `Undo` button.
- `Undo` posts to `/api/events/:eventId/undo` with the `remove_note`
  event's id. Toast lasts ~6s; after that, the event is still
  reachable via the existing event-history UI surface.

**Inline edit:** click sticky face → contenteditable; Enter commits
(`PATCH /api/notes/:id/text`), Esc reverts, blur commits, Shift+Enter
inserts a newline.

**Add a note:** small `＋` affordance at the trailing end of each
`NoteStack`, or empty-state click target when the stack is empty.

**Future hooks (not built v0, but the seams are there):**

- `StickyNote` reads `note.style` if present — v0 just ignores it.
  Later: pass through to inline style.
- `NoteStack` exposes a `layout` prop. Default `"row"`. Later:
  `"physics"` swaps in a verlet-spring positioner without touching
  the data layer.

## Reactivity / SSE

Follow the existing `broadcast("change", { kind, … })` pattern from
`server.ts`. The UI's existing SSE listener gains four new kinds:

```ts
case "note_add":    // payload: { note }
case "note_remove": // payload: { id }
case "note_edit":   // payload: { id, text }
case "note_move":   // payload: { id, repoId, slot, order }
```

Each maps to a tiny store mutation; no full refetch.

## Tests (TDD per [CLAUDE.md](../CLAUDE.md))

All red-before-green. New file `packages/daemon/test/notes.test.ts`:

- `NotesStore.add` → appended at end of slot.
- `NotesStore.list` / `listForRepo` → returns notes sorted by `(slot, order)`.
- `NotesStore.remove` → returns the deleted note (used for inverse).
- `NotesStore.restore` → re-inserts at original `order`, neighbours
  shift to make room; idempotent against id collision (throws).
- `NotesStore.setText` → returns `{ oldText, newText }`.
- `NotesStore.move` → cross-slot and cross-repo move; `order` is
  re-densified on both ends; returns the inverse `from`.

New file `packages/daemon/test/notes-integration.test.ts` (round-trip
per `CLAUDE.md` §"Test coverage"):

- `add_note → undo → redo` restores the same `id`, `text`,
  `createdAt`.
- `remove_note → undo` restores the same id at the same `order`,
  neighbours shift correctly.
- `edit_note → undo` restores the previous text byte-for-byte.
- `move_note → undo` restores `repoId`, `slot`, and `order`
  byte-for-byte.

UI tests in `packages/ui/test/notes.test.ts` against the store layer
(no DOM): subscribe / apply SSE-style deltas / verify derived state.

## Estimate

~1 day end-to-end:

- **2h** — `NotesStore` + tests (TDD).
- **2h** — routes + event-log inverses + integration tests.
- **3h** — `<StickyNote>` + `<NoteStack>` + host wiring + drag/drop.
- **1h** — trash toast + undo path.
- **0.5h** — SSE hookup.
- **0.5h** — polish (empty-state, hover affordances, focus rings).

Risk items: drop-target geometry (insertion-gap painting is fiddly
without a library), and the inline-edit caret behaviour on first
click. Both are well-known patterns; budget is honest.

## Open question — pick before coding

**Slot model: one stack per slot, horizontal, OR free-position
within slot?**

- **(A) Horizontal stack** (this plan's default): notes within a slot
  are a horizontal strip, drag re-orders the strip. Layout is
  deterministic, easy to test, easy to reflow.
- **(B) Free-position within slot**: notes can sit anywhere within
  the slot's reserved height, with a target snap-grid. More "cute"
  but the order semantics get fuzzy, undo of a move needs to encode
  `(x, y)` not just `order`, and slot height has to be chosen up
  front rather than derived from note count.

Recommendation: **(A) for v0**. (B) is a v0.x follow-up once the
physics-sim idea is back on the table — at that point `NoteStack`'s
`layout` prop swaps in, data model gains optional `x` / `y`, done.
