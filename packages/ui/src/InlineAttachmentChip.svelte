<script lang="ts">
  import AttachmentIcon from "./AttachmentIcon.svelte";
  import {
    inlineAttachmentLabel,
    type InlineAttachment,
  } from "./note-inline-attachments";

  export let attachment: InlineAttachment;
  export let selected = false;
  export let onOpen: () => void = () => {};
  export let onMerge: () => void = () => {};

  $: label = inlineAttachmentLabel(attachment);
  $: meta = attachment.kind === "image"
    ? [attachment.mimeType, attachment.size ? `${attachment.size} bytes` : ""]
        .filter(Boolean)
        .join(" · ")
    : attachment.source?.types?.join(", ") ?? "";
</script>

<span class="inline-attachment-chip" class:selected>
  <button
    type="button"
    class="inline-attachment-main attach-row"
    title={attachment.kind === "text" ? "View pasted content" : "View image attachment"}
    on:click|stopPropagation={onOpen}
  >
    <span class="inline-attachment-icon attach-row-icon" aria-hidden="true">
      <AttachmentIcon glyph={attachment.kind === "text" ? "T" : "▤"} size={14} />
    </span>
    <span class="inline-attachment-label attach-row-label">{label}</span>
    {#if meta}
      <span class="inline-attachment-meta attach-row-meta">{meta}</span>
    {/if}
  </button>
  {#if attachment.kind === "text"}
    <button
      type="button"
      class="inline-attachment-action"
      title="Merge pasted content into note text"
      aria-label="Merge pasted content into note text"
      on:click|stopPropagation={onMerge}
    >↩</button>
  {/if}
</span>
