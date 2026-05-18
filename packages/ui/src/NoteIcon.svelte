<script lang="ts">
  /**
   * Sibling to AttachmentIcon for the "note" kind. Renders the
   * sticky-note glyph used in the per-row notes-list popover and any
   * other surface that wants to distinguish a plain note from a link
   * attachment at a glance. currentColor stroke so it inherits the
   * surrounding text colour the same way the add-link button's SVG
   * does.
   */
  export let size: number = 14;
</script>

<svg
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9z" />
  <path d="M14 3v6h6" />
  <line x1="8" y1="13" x2="16" y2="13" />
  <line x1="8" y1="17" x2="13" y2="17" />
</svg>
