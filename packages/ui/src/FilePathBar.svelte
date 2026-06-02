<script lang="ts">
  /**
   * The breadcrumb "filepath segment" of the file tree — a row of clickable
   * path crumbs (drive/dir/dir/…). Extracted from FileBrowser's address bar
   * so it can be reused wherever a path needs to be shown + navigated: the
   * file browser itself and the "add a folder on a remote daemon" dir picker.
   *
   * Pure presentation: it renders `breadcrumbs(path)` and calls `onCrumb`
   * with the absolute path of a clicked segment. Styling lives in the shared
   * styles/file-browser.css (.fb-crumb / .fb-sep / .fb-crumb-active).
   */
  import { breadcrumbs } from "./file-browser-utils";

  export let path: string;
  /** Navigate to the absolute path of a clicked crumb. */
  export let onCrumb: (path: string) => void;
  /** Highlight the last crumb as the active location. */
  export let active = true;

  $: crumbs = breadcrumbs(path);
</script>

{#each crumbs as crumb, i}
  {#if i > 0}<span class="fb-sep">/</span>{/if}
  <button
    class="fb-crumb"
    class:fb-crumb-active={active && i === crumbs.length - 1}
    on:click|stopPropagation={() => onCrumb(crumb.path)}
    on:dragstart|preventDefault
    title={crumb.path}>{crumb.name}</button
  >
{/each}
