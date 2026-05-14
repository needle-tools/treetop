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
  /** Persisted user rotation accumulated from past drags (degrees,
   *  clamped to ±30 by the parent). Composes on top of the static
   *  `tilt`, so the user can fling a note to a chosen angle and it
   *  stays there across reloads, undo/redo, etc. */
  export let rotation = 0;
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
    rotate: { id: string; rotation: number };
    grab: { id: string; grabXFrac: number; grabYFrac: number };
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
  /** Drag-tilt physics: rotation added to the base `--tilt` while the
   *  user is dragging horizontally, so the note feels like a piece of
   *  paper trailing behind the cursor. We *accumulate* — each pixel
   *  of horizontal travel adds `DRAG_SCALE` degrees in that direction.
   *  No smoothing, no velocity decay: holding the note still keeps it
   *  exactly where it is; moving steadily right or left builds up
   *  rotation in that direction (clamped to ±30°). */
  let lastMouseX = 0;
  let dragRotation = 0;
  const DRAG_SCALE = 0.1;        // degrees per pixel of horizontal drag
  const DRAG_ROTATION_MAX = 10;

  /** Spring-physics swing on drag-release.
   *  - `swingAngle` is an extra rotation delta added on top of the
   *    persisted `rotation` after the user lifts the mouse.
   *  - `swingVelocity` is its angular velocity in deg / frame.
   *  - At mouseup we kick the spring with the trailing pointer
   *    velocity (`velocityEma`); each frame Hooke pulls swingAngle
   *    back to 0 and damping bleeds energy until both are tiny.
   *  - Constants: stiffness 0.06 gives a ~12-frame natural period
   *    (~200ms at 60fps), damping 0.85 lets it oscillate twice
   *    before settling — feels paper-y, not bouncy. */
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
    return () => {
      window.removeEventListener("mousedown", onWindowDown);
      stopSwing();
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
    dragRotation = 0;
    // User grabbed the note mid-swing → kill the spring so the new
    // drag starts from a stable angle. Otherwise the in-flight swing
    // would fight the cumulative rotation math.
    stopSwing();
    velocityEma = 0;

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
    // Cumulative tilt: each pixel of horizontal travel adds DRAG_SCALE
    // degrees in the direction of motion. Holding the cursor still
    // keeps the rotation exactly where it is; sweeping right or left
    // builds it up further. Clamped so the combined persisted +
    // in-drag rotation never exceeds ±DRAG_ROTATION_MAX.
    const dx = e.clientX - lastMouseX;
    lastMouseX = e.clientX;
    // Track the trailing pointer velocity (smoothed) so we have it
    // ready as the swing's initial kick on mouseup.
    velocityEma = velocityEma * (1 - VELOCITY_ALPHA) + dx * VELOCITY_ALPHA;
    const proposed = dragRotation + dx * DRAG_SCALE;
    const minDelta = -DRAG_ROTATION_MAX - rotation;
    const maxDelta = DRAG_ROTATION_MAX - rotation;
    dragRotation = Math.max(minDelta, Math.min(maxDelta, proposed));
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
    if (dragRotation !== 0) {
      const next = Math.max(
        -DRAG_ROTATION_MAX,
        Math.min(DRAG_ROTATION_MAX, rotation + dragRotation),
      );
      dispatch("rotate", { id: note.id, rotation: next });
    }
    // Hand the trailing pointer velocity over to the swing physics.
    // Threshold so a careful slow release doesn't trigger a tiny
    // visible jitter; only a real flick wakes the spring.
    const initialKick = velocityEma * DRAG_SCALE;
    if (Math.abs(initialKick) > 0.3) {
      stopSwing(); // in case a previous swing was still in flight
      swingVelocity = initialKick;
      swingAngle = 0;
      swingRaf = requestAnimationFrame(tickSwing);
    }
    dragRotation = 0;
    velocityEma = 0;
  }

  /** Composite tilt rendered in CSS = static jitter + persisted user
   *  rotation + in-flight drag rotation + spring-swing overshoot.
   *  Clamped to a slightly wider band than the drag cap so the
   *  swing can momentarily overshoot the persisted rest angle
   *  without snapping. */
  $: displayedTilt = tilt + Math.max(
    -DRAG_ROTATION_MAX - 8,
    Math.min(DRAG_ROTATION_MAX + 8, rotation + dragRotation + swingAngle),
  );

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
  style="left: {x}px; top: {y}px; --tilt: {displayedTilt}deg; --grab-x: {grabXFrac * 100}%; --grab-y: {grabYFrac * 100}%;"
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
