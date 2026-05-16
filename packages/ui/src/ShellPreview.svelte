<script lang="ts">
  /**
   * Terminal-style preview of a shell session — the last N captured
   * commands rendered as `$ <line>` rows with a dim relative timestamp.
   * Counterpart to ChatPreview for the "sessions in this worktree"
   * hover panel; same fixed-position dock, just different content for
   * non-agent rows.
   *
   * Pure presentation. Parent fetches `/api/shell-transcript` and
   * hands in the already-sliced tail of cmd entries.
   */
  import type { ShellCmd } from "./shellPreviewTypes";

  /** Tail of cmd entries, oldest → newest. `undefined` means
   *  "not loaded yet" → spinner when `loading` is true. An empty
   *  array → "no commands captured yet". */
  export let cmds: ShellCmd[] | undefined = undefined;
  export let loading: boolean = false;

  function relTime(iso?: string): string {
    if (!iso) return "";
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (Number.isNaN(s)) return "";
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
</script>

<div class="shell-preview">
  {#if cmds}
    {#if cmds.length === 0}
      <div class="shell-preview-empty muted">No commands captured yet.</div>
    {:else}
      {#each cmds as c}
        <div class="shell-preview-row">
          <span class="shell-preview-prompt" aria-hidden="true">$</span>
          <span class="shell-preview-line">{c.line}</span>
          <span class="shell-preview-time">{relTime(c.ts)}</span>
        </div>
      {/each}
    {/if}
  {:else if loading}
    <div class="shell-preview-loading">
      <span class="shell-preview-spinner" aria-hidden="true"></span>
    </div>
  {/if}
</div>

<style>
  /* Match the popover list's chrome — same surface, border, radius —
     so the hover dock visually reads as a continuation of the list
     rather than a separate widget with its own palette. */
  .shell-preview {
    font-family: ui-monospace, monospace;
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--text-1);
    background: var(--surface-1);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    padding: 0.45rem 0.6rem;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .shell-preview-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 0.4rem;
    min-width: 0;
  }
  .shell-preview-prompt {
    color: color-mix(in oklch, var(--brand, #60b74c) 80%, var(--text-1));
    font-weight: 700;
  }
  .shell-preview-line {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .shell-preview-time {
    color: var(--text-muted);
    font-size: 0.62rem;
    white-space: nowrap;
  }
  .shell-preview-empty {
    font-style: italic;
  }
  .shell-preview-loading {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .shell-preview-spinner {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 2px solid color-mix(in oklch, var(--text-muted) 35%, transparent);
    border-top-color: var(--text-1);
    animation: shell-preview-spin 0.8s linear infinite;
  }
  @keyframes shell-preview-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .shell-preview-spinner { animation: none; }
  }
</style>
