<script lang="ts">
  import { parseDiff } from "./diff";

  export let text: string = "";
  $: lines = parseDiff(text);
</script>

<div class="diff" role="document">
  {#each lines as line}
    <div class="line {line.kind}">
      <span class="text">{line.text || " "}</span>
    </div>
  {/each}
</div>

<style>
  .diff {
    background: var(--surface-0);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-sm);
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    line-height: 1.45;
    max-height: 80vh;
    overflow: auto;
    padding: 0.35rem 0;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
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
