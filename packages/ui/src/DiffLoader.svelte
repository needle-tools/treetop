<script lang="ts">
  /** Fetches a single-file diff for hover previews. Rendering itself
   *  stays in the shared Diff component so all diff surfaces use the
   *  same layout, indentation, and colour rules. */

  import { apiUrl } from "./api";
  import Diff from "./Diff.svelte";

  export let worktreePath: string;
  export let file: string;
  export let kind: "workdir" | "staged" | "untracked";
  /** Optional commit SHA. When present, render this file's diff inside
   *  that commit instead of the working-tree/index diff. */
  export let sha: string | undefined = undefined;
  /** Owning daemon for this worktree. Undefined ⇒ local daemon
   *  (byte-identical behaviour). Set for remote daemon folder rows. */
  export let daemonId: string | undefined = undefined;

  let state: "loading" | "ready" | "error" = "loading";
  let diffText = "";

  /** Reactive fetch. Re-runs when any of {worktreePath, file, kind} change
   *  so the popup re-renders when the user moves between rows without
   *  the parent having to tear down the component. */
  $: void load(worktreePath, file, kind, sha);

  async function load(
    wt: string,
    f: string,
    k: typeof kind,
    commitSha: string | undefined,
  ): Promise<void> {
    state = "loading";
    diffText = "";
    try {
      const params = new URLSearchParams(
        commitSha
          ? { path: wt, sha: commitSha, file: f, context: "0" }
          : {
              path: wt,
              file: f,
              kind: k,
              context: "0",
            },
      );
      const endpoint = commitSha ? "/api/commit-file-diff" : "/api/file-diff";
      const r = await fetch(apiUrl(`${endpoint}?${params.toString()}`, daemonId));
      if (!r.ok) {
        state = "error";
        return;
      }
      const text = await r.text();
      // Capture the values we were called with so a late-arriving
      // response can't overwrite the UI when the user has already
      // moved to a different file (avoids stale flicker).
      if (wt !== worktreePath || f !== file || k !== kind || commitSha !== sha)
        return;
      diffText = text;
      state = "ready";
    } catch {
      state = "error";
    }
  }
</script>

{#if state === "loading"}
  <span class="fd-muted">Loading diff…</span>
{:else if state === "error"}
  <span class="fd-muted">Couldn't load diff.</span>
{:else if diffText.trim().length === 0}
  <span class="fd-muted">No textual changes.</span>
{:else}
  <Diff text={diffText} compact />
{/if}

<style>
  .fd-muted {
    color: var(--text-muted, #8a8a8a);
    font-style: italic;
    font-size: 0.65rem;
  }
  :global(.file-diff-popup .diff),
  :global(.commit-file-changes-tooltip .diff) {
    max-height: min(22rem, 44vh);
    border: none;
    border-radius: 0;
    background: transparent;
    overscroll-behavior: contain;
  }
</style>
