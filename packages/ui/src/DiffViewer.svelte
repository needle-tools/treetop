<script lang="ts">
  import { parseDiffStructured, extractCommitHeader } from "./diff";
  import Diff from "./Diff.svelte";

  export let text: string = "";
  /** Hide the commit-header line even if one is present in the text. */
  export let showCommitHeader: boolean = true;

  $: parsed = parseDiffStructured(text);
  $: commit = showCommitHeader ? extractCommitHeader(text) : null;

  let selected = 0;
  $: if (selected >= parsed.files.length) selected = 0;

  function flagFor(f: (typeof parsed.files)[number]): string {
    if (f.isNew) return "A";
    if (f.isDeleted) return "D";
    if (f.isRename) return "R";
    if (f.isBinary) return "B";
    return "M";
  }
</script>

{#if commit}
  <div class="commit-header">
    <code class="sha" title={commit.sha}>{commit.shortSha}</code>
    {#if commit.subject}
      <span class="subject">{commit.subject}</span>
    {/if}
    {#if commit.author}
      <span class="author">— {commit.author}</span>
    {/if}
  </div>
{/if}

{#if parsed.untrackedFiles.length > 0}
  <div class="untracked-list">
    <span class="muted">Untracked:</span>
    {#each parsed.untrackedFiles as p}
      <code>{p}</code>
    {/each}
  </div>
{/if}

{#if parsed.files.length === 0}
  {#if parsed.untrackedFiles.length === 0}
    <p class="muted small">Nothing to show.</p>
  {/if}
{:else}
  <div class="viewer">
    <aside class="file-list">
      {#each parsed.files as f, i}
        <button
          class="file-btn"
          class:active={selected === i}
          on:click={() => (selected = i)}
          title={f.oldPath && f.oldPath !== f.path
            ? `${f.oldPath} → ${f.path}`
            : f.path}
        >
          <span class="file-flag flag-{flagFor(f)}">{flagFor(f)}</span>
          <span class="file-path">{f.path}</span>
          <span class="file-stats">
            {#if f.added > 0}<span class="add">+{f.added}</span>{/if}
            {#if f.removed > 0}<span class="rem">-{f.removed}</span>{/if}
            {#if f.isBinary}<span class="muted">bin</span>{/if}
          </span>
        </button>
      {/each}
    </aside>
    <div class="file-panel">
      {#if parsed.files[selected]}
        <Diff lines={parsed.files[selected].lines} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .commit-header {
    display: flex;
    gap: 0.4rem;
    align-items: flex-start;
    /* Body tier — same token as `.diff` and `.file-btn` so the
       history list, commit header, and diff lines all stay aligned. */
    font-size: var(--fs-md);
    line-height: 1.35;
    padding: 0.25rem 0.5rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    margin-bottom: 0.4rem;
    min-width: 0;
  }
  .commit-header .sha {
    font-family: ui-monospace, monospace;
    color: var(--selected-text);
    flex: 0 0 auto;
  }
  .commit-header .subject {
    flex: 1;
    color: var(--text-2);
    min-width: 0;
    /* Clamp to two lines + ellipsis */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .commit-header .author {
    white-space: nowrap;
    color: var(--text-muted);
    flex: 0 0 auto;
  }
  .untracked-list {
    margin: 0 0 0.5rem 0;
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    align-items: baseline;
    font-size: var(--fs-md);
  }
  .untracked-list code {
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
    padding: 0.05rem 0.4rem;
    border-radius: var(--radius-sm);
    font-family: ui-monospace, monospace;
  }
  .viewer {
    display: grid;
    grid-template-columns: minmax(180px, 260px) 1fr;
    gap: 0.5rem;
    min-width: 0;
  }
  @media (max-width: 700px) {
    .viewer {
      grid-template-columns: 1fr;
    }
  }
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    padding: 0.25rem;
    max-height: 80vh;
    overflow: auto;
    min-width: 0;
  }
  .file-btn {
    display: grid;
    grid-template-columns: 18px 1fr auto;
    align-items: center;
    gap: 0.4rem;
    padding: 0.32rem 0.45rem;
    background: transparent;
    border: 0;
    color: var(--text-3);
    border-radius: var(--radius-sm);
    cursor: pointer;
    text-align: left;
    font-size: var(--fs-md);
    font-family: ui-monospace, monospace;
    min-width: 0;
  }
  .file-btn:hover {
    background: var(--surface-2);
  }
  .file-btn.active {
    background: var(--selected-bg);
    color: var(--selected-text);
  }
  .file-flag {
    text-align: center;
    font-weight: 600;
    color: var(--text-faint);
    font-size: var(--fs-sm);
  }
  .file-flag.flag-A {
    color: var(--status-clean);
  }
  .file-flag.flag-D {
    color: var(--status-dirty);
  }
  .file-flag.flag-R {
    color: var(--chip-purple-text);
  }
  .file-flag.flag-B {
    color: var(--chip-grey-text);
  }
  .file-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    direction: rtl;
    text-align: left;
  }
  .file-stats {
    display: inline-flex;
    gap: 0.35rem;
    font-size: var(--fs-sm);
  }
  .file-stats .add {
    color: var(--status-clean);
  }
  .file-stats .rem {
    color: var(--status-dirty);
  }
  .file-panel {
    min-width: 0;
  }
  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: var(--fs-md);
  }
</style>
