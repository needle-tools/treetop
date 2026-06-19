<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import EmojiPicker from "./EmojiPicker.svelte";

  export let rowKey: string;
  export let notesVisible = true;
  export let noteTitle = "Pin a sticky note";
  export let linkTitle = "Pin a link";
  export let emojiOpen = false;

  const dispatch = createEventDispatcher<{
    toggleNotes: void;
    add: { kind: "note" | "link" | "emoji"; body?: string; originRect: DOMRect };
    toggleEmoji: void;
    closeEmoji: void;
  }>();

  function add(kind: "note" | "link", el: HTMLElement) {
    dispatch("add", { kind, originRect: el.getBoundingClientRect() });
  }
</script>

<span class="note-add-stack">
  <slot />
  <button
    class="new-wt notes-toggle"
    class:active={notesVisible}
    title={notesVisible ? "Hide this row's sticky notes" : "Show this row's sticky notes"}
    on:click|stopPropagation={() => dispatch("toggleNotes")}>notes</button
  >
  <button
    class="new-wt notes-add"
    title={noteTitle}
    on:click|stopPropagation={(e) => add("note", e.currentTarget as HTMLElement)}
    >+</button
  >
  <button
    class="new-wt notes-add notes-add-link"
    title={linkTitle}
    on:click|stopPropagation={(e) => add("link", e.currentTarget as HTMLElement)}
    aria-label="Add link"
  >
    <svg
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path
        d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
      />
      <path
        d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
      />
    </svg>
  </button>
  <span class="emoji-picker-anchor" data-emoji-picker-anchor={rowKey}>
    <button
      class="new-wt notes-add notes-add-emoji"
      title="Add sticker"
      on:click|stopPropagation={() => dispatch("toggleEmoji")}
      aria-label="Add sticker"
    >
      <svg
        viewBox="0 0 24 24"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <circle cx="9" cy="9" r="1" />
        <circle cx="15" cy="9" r="1" />
        <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      </svg>
    </button>
    {#if emojiOpen}
      <EmojiPicker
        on:pick={(e) => {
          const btn = document.querySelector(
            `[data-emoji-picker-anchor="${CSS.escape(rowKey)}"] .notes-add-emoji`,
          ) as HTMLElement | null;
          dispatch("add", {
            kind: "emoji",
            body: e.detail,
            originRect: btn?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
          });
        }}
        on:cancel={() => dispatch("closeEmoji")}
      />
    {/if}
  </span>
</span>
