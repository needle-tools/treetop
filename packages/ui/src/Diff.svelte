<script lang="ts">
  import { parseDiff, type DiffLine } from "./diff";

  export let text: string = "";
  export let lines: DiffLine[] | null = null;
  export let label = "";
  export let copyText = "";
  export let copyable = false;
  export let compact = false;
  $: rendered = lines ?? parseDiff(text);
  $: effectiveCopyText =
    copyText || (lines ? rendered.map((line) => line.text).join("\n") : text);
  $: showHead = !!label || copyable;

  async function copyDiff(): Promise<void> {
    if (!effectiveCopyText) return;
    try {
      await navigator.clipboard.writeText(effectiveCopyText);
    } catch {
      // Clipboard permissions are best-effort in browser contexts.
    }
  }
</script>

<div class="diff" class:compact role="document">
  {#if showHead}
    <div class="diff-head">
      {#if label}<span class="diff-lang">{label}</span>{/if}
      {#if copyable}
        <button
          type="button"
          class="diff-copy"
          aria-label="Copy diff"
          title="Copy diff"
          on:click={copyDiff}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2"></rect>
            <path d="M5 15V6a2 2 0 0 1 2-2h9"></path>
          </svg>
        </button>
      {/if}
    </div>
  {/if}
  <div class="diff-lines">
    {#each rendered as line}
      <div class="line {line.kind}">
        <span class="text">{line.text || " "}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .diff {
    background: var(--surface-0);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-sm);
    font-family: ui-monospace, monospace;
    font-size: var(--fs-md);
    line-height: 1.45;
    max-height: 80vh;
    overflow: auto;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }
  .diff.compact {
    font-size: 0.78rem;
    line-height: 1.42;
    max-height: min(24rem, 44vh);
  }
  .diff-head {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
    padding: 0.3rem 0.45rem 0.18rem 0.75rem;
    background: var(--surface-0);
    color: var(--text-muted);
  }
  .diff-lang {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.86em;
  }
  .diff-copy {
    display: inline-grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .diff-copy:hover,
  .diff-copy:focus-visible {
    background: var(--surface-2);
    color: var(--text-1);
  }
  .diff-copy svg {
    width: 0.95rem;
    height: 0.95rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .diff-lines {
    padding: 0.35rem 0;
  }
  .diff-head + .diff-lines {
    padding-top: 0.12rem;
  }
  .line {
    padding: 0 0.75rem;
    white-space: pre;
  }
  .line.add {
    background: var(--diff-add-bg);
    color: var(--diff-add-text);
  }
  .line.remove {
    background: var(--diff-remove-bg);
    color: var(--diff-remove-text);
  }
  .line.hunk {
    color: var(--diff-hunk-text);
    background: var(--diff-hunk-bg);
    padding-top: 0.18rem;
    padding-bottom: 0.18rem;
    margin-top: 0.3rem;
  }
  .line.file {
    color: var(--diff-file-text);
    background: var(--diff-file-bg);
    font-weight: 600;
    padding-top: 0.3rem;
    padding-bottom: 0.3rem;
    margin-top: 0.5rem;
    border-top: 1px solid var(--surface-2);
  }
  .line.meta {
    color: var(--text-muted);
  }
  .line.context {
    color: var(--text-3);
  }
  .line.commit-header {
    color: var(--diff-commit-text);
    font-weight: 600;
    background: var(--diff-commit-bg);
    padding-top: 0.3rem;
    padding-bottom: 0.3rem;
  }
  .line.commit-meta {
    color: var(--text-muted);
  }
  .line.untracked-header {
    color: var(--chip-orange-text);
    font-weight: 600;
  }
  .line.untracked-file {
    color: var(--chip-orange-text);
  }
</style>
