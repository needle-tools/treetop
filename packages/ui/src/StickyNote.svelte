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

  export let note: NoteShape;
  /** Top-left position in viewport-relative px. Parent owns this. */
  export let x: number;
  export let y: number;
  /** Deterministic per-note tilt so rerenders don't make the note jitter. */
  export let tilt = 0;
  /** Spawn this note in edit mode (first time the user clicks "+ note"). */
  export let startEditing = false;

  const dispatch = createEventDispatcher<{
    move: { id: string; x: number; y: number };
    save: { id: string; body: string };
    remove: { id: string };
    focus: { id: string };
  }>();

  let editing = startEditing;
  let draft = note.body;
  let dragging = false;
  let dragDx = 0;
  let dragDy = 0;
  let textareaEl: HTMLTextAreaElement | null = null;

  onMount(() => {
    if (editing && textareaEl) {
      textareaEl.focus();
      // Place caret at end so existing body isn't selected.
      const end = textareaEl.value.length;
      textareaEl.setSelectionRange(end, end);
    }
  });

  function onMouseDownHeader(e: MouseEvent): void {
    // Only drag with primary button; ignore clicks on buttons inside header.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    dragging = true;
    dragDx = e.clientX - x;
    dragDy = e.clientY - y;
    dispatch("focus", { id: note.id });
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e: MouseEvent): void {
    if (!dragging) return;
    const nx = Math.max(0, e.clientX - dragDx);
    const ny = Math.max(0, e.clientY - dragDy);
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
</script>

<div
  class="sticky"
  class:dragging
  class:editing
  data-note-id={note.id}
  style="left: {x}px; top: {y}px; --tilt: {tilt}deg;"
  role="dialog"
  aria-label="Sticky note"
  on:mousedown={() => dispatch("focus", { id: note.id })}
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
    ></textarea>
  {:else}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <div
      class="sticky-body"
      role="textbox"
      tabindex="0"
      aria-readonly="true"
      title="Double-click to edit"
      on:dblclick={startEdit}
    >{@html rendered(note.body)}</div>
  {/if}

  {#if note.anchors.length > 0 && !editing}
    <footer class="sticky-meta" title={note.anchors.join("\n")}>
      ⚓ {note.anchors[0]}{note.anchors.length > 1 ? ` +${note.anchors.length - 1}` : ""}
    </footer>
  {/if}
</div>
