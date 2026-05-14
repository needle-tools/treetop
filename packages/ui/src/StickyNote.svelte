<script lang="ts" context="module">
  export interface NoteShape {
    id: string;
    anchors: string[];
    tags: string[];
    body: string;
    createdAt: string;
    updatedAt: string;
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
  import { onMount, createEventDispatcher } from "svelte";
  import { marked } from "marked";
  import AnchorPicker from "./AnchorPicker.svelte";
  import Popover from "./Popover.svelte";

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
  /** Spawn this note in edit mode (first time the user clicks "+ note"). */
  export let startEditing = false;
  /** Used by the in-note "Move to…" / "Copy to…" picker to enumerate
   *  all anchorable rows. Threaded down from the StickyNotesLayer's
   *  `repos` prop. */
  export let repos: AnchorableRepo[] = [];

  const dispatch = createEventDispatcher<{
    move: { id: string; x: number; y: number };
    save: { id: string; body: string };
    remove: { id: string };
    focus: { id: string };
    reassign: { id: string; anchor: string; mode: "move" | "duplicate" };
  }>();

  /** While the user is choosing a new anchor, the editor flips into
   *  this mode and shows the AnchorPicker. `null` = picker closed. */
  let pickerMode: "move" | "duplicate" | null = null;

  let editing = startEditing;
  let draft = note.body;
  let dragging = false;
  let dragDx = 0;
  let dragDy = 0;
  let textareaEl: HTMLTextAreaElement | null = null;
  let stickyEl: HTMLDivElement;

  onMount(() => {
    if (editing && textareaEl) {
      textareaEl.focus();
      // Place caret at end so existing body isn't selected.
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
    return () => window.removeEventListener("mousedown", onWindowDown);
  });

  function onMouseDownHeader(e: MouseEvent): void {
    // Only drag with primary button; ignore clicks on buttons inside header.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true;
    // x/y are document coordinates (layer is position: absolute at
    // doc top-left). Translate the mouse event's viewport-relative
    // client coords to doc coords by adding the page scroll. That
    // way a user who scrolls *while dragging* still has the note
    // track the cursor correctly — both dragDx and the live mouse
    // position read scroll, so the diff stays consistent.
    dragDx = e.clientX + window.scrollX - x;
    dragDy = e.clientY + window.scrollY - y;
    dispatch("focus", { id: note.id });
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragging) return;
    const nx = Math.max(0, e.clientX + window.scrollX - dragDx);
    const ny = Math.max(0, e.clientY + window.scrollY - dragDy);
    dispatch("move", { id: note.id, x: nx, y: ny });
  }

  function onMouseUp(): void {
    dragging = false;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }

  function startEdit(): void {
    draft = note.body;
    editing = true;
    queueMicrotask(() => {
      textareaEl?.focus();
      if (textareaEl) {
        const end = textareaEl.value.length;
        textareaEl.setSelectionRange(end, end);
      }
    });
  }

  function cancelEdit(): void {
    editing = false;
    draft = note.body;
  }

  function saveEdit(): void {
    const trimmed = draft;
    editing = false;
    if (trimmed === note.body) return;
    dispatch("save", { id: note.id, body: trimmed });
  }

  function onKey(e: KeyboardEvent): void {
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

  function rendered(body: string): string {
    if (!body.trim()) return "<p class=\"sticky-empty\">(empty)</p>";
    return marked.parse(body, { async: false }) as string;
  }

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
  data-note-id={note.id}
  style="left: {x}px; top: {y}px; --tilt: {tilt}deg;"
  role="dialog"
  aria-label="Sticky note"
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
      {#if editing}
        <button class="sticky-btn" on:click={cancelEdit} title="Cancel (Esc)">Cancel</button>
        <button class="sticky-btn primary" on:click={saveEdit} title="Save (Enter)">Save</button>
      {:else}
        <button
          class="sticky-btn"
          on:click={startEdit}
          title="Edit"
          aria-label="Edit"
        >✎</button>
        <button
          class="sticky-btn danger"
          on:click={() => dispatch("remove", { id: note.id })}
          title="Delete (an Undo toast lets you bring it back)"
          aria-label="Delete"
        >×</button>
      {/if}
    </div>
  </header>

  {#if editing}
    <textarea
      bind:this={textareaEl}
      class="sticky-textarea"
      bind:value={draft}
      placeholder="Write something… markdown OK. Enter saves, Shift+Enter newline, Esc reverts."
      on:keydown={onKey}
      use:autosize
    ></textarea>
    <!-- Footer-row of ancillary edit actions. Move-to / Copy-to live
         here (rather than the header toolbar) so the textarea — the
         primary affordance during edit — stays anchored next to
         Cancel / Save. Each button's destination Popover opens
         downward from its position; clampToViewport flips it up
         when the note is near the bottom of the viewport. -->
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
  {:else}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div
      class="sticky-body"
      role="textbox"
      tabindex="0"
      aria-readonly="true"
      title="Double-click to edit"
    >{@html rendered(note.body)}</div>
  {/if}
</div>
