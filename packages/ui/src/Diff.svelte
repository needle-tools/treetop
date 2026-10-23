<script lang="ts">
  import {
    diffAssetContentUrl,
    diffAssetKind,
    parseDiff,
    parseDiffStructured,
    withoutSingleFileDiffHeader,
    type DiffAssetSourceKind,
    type DiffLine,
  } from "./diff";
  import { apiUrl } from "./api";

  export let text: string = "";
  export let lines: DiffLine[] | null = null;
  export let label = "";
  export let copyText = "";
  export let copyable = false;
  export let compact = false;
  export let hideSingleFileHeader = false;
  /** Optional git source. Supplying it upgrades browser-renderable image
   * files from binary/text placeholders to a shared before/after preview. */
  export let worktreePath: string | undefined = undefined;
  export let filePath: string | undefined = undefined;
  export let oldFilePath: string | undefined = undefined;
  export let sourceKind: DiffAssetSourceKind | undefined = undefined;
  export let sha: string | undefined = undefined;
  export let daemonId: string | undefined = undefined;
  export let assetVersion: string | number | undefined = undefined;
  export let beforeAvailable: boolean | undefined = undefined;
  export let afterAvailable: boolean | undefined = undefined;
  $: rawRendered = lines ?? parseDiff(text);
  $: rendered = hideSingleFileHeader
    ? withoutSingleFileDiffHeader(rawRendered)
    : rawRendered;
  $: effectiveCopyText =
    copyText || (lines ? rendered.map((line) => line.text).join("\n") : text);
  $: showHead = !!label || copyable;
  $: structuredFile = text ? parseDiffStructured(text).files[0] : undefined;
  $: assetKind = filePath ? diffAssetKind(filePath) : null;
  $: canShowAsset = !!(
    assetKind &&
    worktreePath &&
    filePath &&
    sourceKind
  );
  $: showBefore = beforeAvailable ?? !structuredFile?.isNew;
  $: showAfter = afterAvailable ?? !structuredFile?.isDeleted;
  $: beforeSrc =
    canShowAsset && showBefore
      ? apiUrl(
          diffAssetContentUrl({
            worktreePath: worktreePath!,
            file: filePath!,
            oldFile: oldFilePath,
            kind: sourceKind!,
            side: "before",
            sha,
            version: assetVersion,
          }),
          daemonId,
        )
      : null;
  $: afterSrc =
    canShowAsset && showAfter
      ? apiUrl(
          diffAssetContentUrl({
            worktreePath: worktreePath!,
            file: filePath!,
            oldFile: oldFilePath,
            kind: sourceKind!,
            side: "after",
            sha,
            version: assetVersion,
          }),
          daemonId,
        )
      : null;
  $: showText = !canShowAsset || assetKind === "svg";
  let failedBeforeSrc: string | null = null;
  let failedAfterSrc: string | null = null;

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
  {#if canShowAsset}
    <div class="diff-images" class:single={!beforeSrc || !afterSrc}>
      {#if beforeSrc}
        <figure>
          <figcaption>Before</figcaption>
          {#if failedBeforeSrc === beforeSrc}
            <span class="diff-image-unavailable">Not available</span>
          {:else}
            <span class="image-frame image-frame-media">
              <img
                src={beforeSrc}
                alt={`Before ${filePath}`}
                on:error={() => (failedBeforeSrc = beforeSrc)}
              />
            </span>
          {/if}
        </figure>
      {/if}
      {#if afterSrc}
        <figure>
          <figcaption>After</figcaption>
          {#if failedAfterSrc === afterSrc}
            <span class="diff-image-unavailable">Not available</span>
          {:else}
            <span class="image-frame image-frame-media">
              <img
                src={afterSrc}
                alt={`After ${filePath}`}
                on:error={() => (failedAfterSrc = afterSrc)}
              />
            </span>
          {/if}
        </figure>
      {/if}
    </div>
  {/if}
  {#if showText}
    <div class="diff-lines">
      {#each rendered as line}
        <div class="line {line.kind}">
          <span class="text">{line.text || " "}</span>
        </div>
      {/each}
    </div>
  {/if}
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
  .diff-images {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
    padding: 0.5rem;
    min-width: 0;
  }
  .diff-images.single {
    grid-template-columns: minmax(0, 1fr);
  }
  .diff-images figure {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    gap: 0.25rem;
    min-width: 0;
    margin: 0;
  }
  .diff-images figcaption {
    color: var(--text-muted);
    font-size: var(--fs-sm);
  }
  .diff-images .image-frame {
    width: 100%;
    max-width: none;
  }
  .diff-images .image-frame img {
    width: 100%;
    max-width: 100%;
    max-height: min(52vh, 34rem);
  }
  .diff-image-unavailable {
    display: grid;
    place-items: center;
    min-height: 5rem;
    color: var(--text-muted);
    border: 1px dashed var(--surface-3);
    border-radius: var(--radius-sm);
    font-size: var(--fs-sm);
  }
  .diff-images + .diff-lines {
    border-top: 1px solid var(--surface-2);
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
