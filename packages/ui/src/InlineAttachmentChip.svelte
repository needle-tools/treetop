<script lang="ts">
  import AttachmentIcon from "./AttachmentIcon.svelte";
  import {
    inlineAttachmentLabel,
    type InlineAttachment,
  } from "./note-inline-attachments";

  export let attachment: InlineAttachment;
  export let raw = "";
  export let selected = false;
  export let draggable = false;
  export let onOpen: () => void = () => {};
  export let onMerge: () => void = () => {};
  export let onDragStart: (event: DragEvent) => void = () => {};

  $: label = inlineAttachmentLabel(attachment);
  $: meta = attachment.kind === "image"
    ? [attachment.mimeType, attachment.size ? `${attachment.size} bytes` : ""]
        .filter(Boolean)
        .join(" · ")
    : attachment.kind === "text"
      ? attachment.source?.types?.join(", ") ?? ""
      : attachment.kind === "link"
        ? attachment.target.type
        : "";
  $: glyph = attachment.kind === "text" ? "T"
    : attachment.kind === "image" ? "▤"
    : attachment.kind === "emoji" ? "☺"
    : attachment.kind === "note" ? "✎"
    : "↗";
</script>

<span
  class="inline-attachment-chip"
  class:selected
  role="group"
  {draggable}
  data-inline-attachment-raw={raw}
  on:dragstart={onDragStart}
>
  <button
    type="button"
    class="inline-attachment-main attach-row"
    title="View attachment"
    on:click|stopPropagation={onOpen}
  >
    <span class="inline-attachment-icon attach-row-icon" aria-hidden="true">
      <AttachmentIcon glyph={glyph} size={14} />
    </span>
    <span class="inline-attachment-label attach-row-label">{label}</span>
    {#if meta}
      <span class="inline-attachment-meta attach-row-meta">{meta}</span>
    {/if}
  </button>
  {#if attachment.kind === "text" || attachment.kind === "note"}
    <button
      type="button"
      class="inline-attachment-action"
      title="Merge attachment into note text"
      aria-label="Merge attachment into note text"
      on:click|stopPropagation={onMerge}
    >↩</button>
  {/if}
</span>
