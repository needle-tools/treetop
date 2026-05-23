<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import Popover from "./Popover.svelte";

  const dispatch = createEventDispatcher<{ pick: string; cancel: void }>();

  const EMOJIS: [string, string[]][] = [
    ["Smileys", ["😀","😂","🥹","😍","🤩","😎","🤔","🫡","🤯","🥳","😱","🫠","🔥","💀","👻","🤖"]],
    ["Hands",   ["👍","👎","👏","🙌","🤝","✌️","🤞","💪","🫶","👋","🖐️","☝️"]],
    ["Hearts",  ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","❤️‍🔥","💖","💝"]],
    ["Objects", ["⭐","✨","💡","🎯","🚀","⚡","🏆","🎉","🎸","🔑","🧪","🛠️","📌","📎","🏷️","🗑️"]],
    ["Nature",  ["🌱","🌳","🍀","🌸","🌊","☀️","🌙","⛈️","🐛","🦋","🐙","🦊"]],
    ["Symbols", ["✅","❌","⚠️","🚫","💬","💭","🔔","📣","🎵","♻️","🔒","🏁"]],
  ];

  function onPick(emoji: string) {
    dispatch("pick", emoji);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      dispatch("cancel");
    }
  }
</script>

<Popover variant="agents" extraClass="emoji-picker-popover">
  <span slot="head">Pick a sticker</span>
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div class="emoji-picker" on:keydown={onKeydown}>
    {#each EMOJIS as [category, emojis]}
      <div class="emoji-category">
        <span class="emoji-category-label">{category}</span>
        <div class="emoji-grid">
          {#each emojis as emoji}
            <button
              class="emoji-cell"
              type="button"
              on:click={() => onPick(emoji)}
              title={emoji}
            >{emoji}</button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</Popover>

<style>
  .emoji-picker {
    padding: 6px 8px 8px;
    max-height: 340px;
    overflow-y: auto;
  }
  .emoji-category {
    margin-bottom: 6px;
  }
  .emoji-category-label {
    display: block;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted, #888);
    margin-bottom: 2px;
    padding-left: 2px;
  }
  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 1px;
  }
  .emoji-cell {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    width: 36px;
    height: 36px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .emoji-cell:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  .emoji-cell:active {
    transform: scale(1.2);
  }
</style>
