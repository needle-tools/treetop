<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { aheadAged } from "./ahead-age";
  import ChangedFilesTooltipBody from "./ChangedFilesTooltipBody.svelte";
  import { clampSubject, pushBadgeDanger, pushCount, relTime } from "./display-helpers";
  import type { BranchStatus, FileStatus, WtSummary } from "./repo-types";
  import StatusBadge from "./StatusBadge.svelte";
  import Tooltip from "./Tooltip.svelte";

  const dispatch = createEventDispatcher<{
    loadSummary: { path: string };
    push: { path: string };
    pull: { path: string };
  }>();

  export let path: string;
  export let branchStatus: BranchStatus | null | undefined = null;
  export let fileStatus: FileStatus = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  export let summary: WtSummary | "loading" | undefined = undefined;
  export let daemonId: string | undefined = undefined;
  export let debug = false;
  export let pulsateDebug = false;
  export let pushBusy = false;
  export let pullBusy = false;

  const COMMIT_TOOLTIP_LIMIT = 10;

  $: ahead = pushCount(branchStatus);
  $: behind = branchStatus?.behind ?? 0;
  $: dirty = fileStatus.staged + fileStatus.unstaged + fileStatus.untracked;
  $: dirtyWarn = dirty > 3 || (fileStatus.dirtyLines ?? 0) > 200;

  function aheadTooltip(b: BranchStatus | null | undefined): string {
    const count = pushCount(b);
    const noun = count === 1 ? "commit" : "commits";
    const base = b?.upstream
      ? `${count} ${noun} to push -> ${b.upstream}`
      : `${count} ${noun} on no remote`;
    if (!b?.aheadOldestTime) return base;
    return `${base} - oldest ${relTime(b.aheadOldestTime)}`;
  }

  function showSummary() {
    dispatch("loadSummary", { path });
  }
</script>

{#if debug}
  <span class="status-badge-debug-row">
    <StatusBadge ahead={1} behind={0} dirty={0} pulsate={pulsateDebug} />
    <StatusBadge ahead={0} behind={1} dirty={0} />
  </span>
{:else}
  {#if ahead > 0}
    <Tooltip variant="wide" onShow={showSummary}>
      <span slot="trigger" class="status-badge-trigger">
        <StatusBadge
          {ahead}
          danger={pushBadgeDanger(branchStatus)}
          pulsate={branchStatus ? aheadAged(branchStatus) : false}
          onClick={() => dispatch("push", { path })}
          busy={pushBusy}
          title={branchStatus?.upstream
            ? `Push ${ahead} commit${ahead === 1 ? "" : "s"} to ${branchStatus.upstream}`
            : `${ahead} commit${ahead === 1 ? "" : "s"} on no remote - set an upstream to push`}
        />
      </span>
      <span slot="content" class="wt-tt-content">
        <div class="wt-tt-section-head">{aheadTooltip(branchStatus)}</div>
        {#if summary === undefined || summary === "loading"}
          <span class="muted small">Loading commits...</span>
        {:else if summary.unpushedCommits && summary.unpushedCommits.length > 0}
          <div class="wt-tt-commits">
            {#each summary.unpushedCommits.slice(0, COMMIT_TOOLTIP_LIMIT) as c}
              <span class="wt-tt-sha">{c.sha.slice(0, 7)}</span>
              <span class="wt-tt-author" title={c.author ?? ""}>{c.author ?? ""}</span>
              <span class="wt-tt-date">{c.date ? relTime(c.date) : ""}</span>
              <span class="wt-tt-subject" title={c.subject}>{clampSubject(c.subject)}</span>
            {/each}
          </div>
          {#if summary.unpushedCommits.length > COMMIT_TOOLTIP_LIMIT}
            <div class="wt-tt-more">
              +{summary.unpushedCommits.length - COMMIT_TOOLTIP_LIMIT} more
            </div>
          {/if}
        {/if}
      </span>
    </Tooltip>
  {/if}

  {#if behind > 0}
    <Tooltip variant="wide" onShow={showSummary}>
      <span slot="trigger" class="status-badge-trigger">
        <StatusBadge
          {behind}
          onClick={() => dispatch("pull", { path })}
          busy={pullBusy}
          title={`Pull ${behind} commit${behind === 1 ? "" : "s"} from ${branchStatus?.upstream ?? "upstream"}`}
        />
      </span>
      <span slot="content" class="wt-tt-content">
        <div class="wt-tt-section-head">
          {behind} commit{behind === 1 ? "" : "s"} to pull from {branchStatus?.upstream ?? "upstream"}
        </div>
        {#if summary === undefined || summary === "loading"}
          <span class="muted small">Loading commits...</span>
        {:else if summary.unfetchedCommits && summary.unfetchedCommits.length > 0}
          <div class="wt-tt-commits">
            {#each summary.unfetchedCommits.slice(0, COMMIT_TOOLTIP_LIMIT) as c}
              <span class="wt-tt-sha">{c.sha.slice(0, 7)}</span>
              <span class="wt-tt-author" title={c.author ?? ""}>{c.author ?? ""}</span>
              <span class="wt-tt-date">{c.date ? relTime(c.date) : ""}</span>
              <span class="wt-tt-subject" title={c.subject}>{clampSubject(c.subject)}</span>
            {/each}
          </div>
          {#if summary.unfetchedCommits.length > COMMIT_TOOLTIP_LIMIT}
            <div class="wt-tt-more">
              +{summary.unfetchedCommits.length - COMMIT_TOOLTIP_LIMIT} more
            </div>
          {/if}
        {/if}
      </span>
    </Tooltip>
  {/if}

  {#if dirty > 0}
    <Tooltip variant="wide" onShow={showSummary}>
      <span slot="trigger" class="status-badge-trigger">
        <StatusBadge {dirty} warn={dirtyWarn} />
      </span>
      <span slot="content" class="wt-tt-content">
        <ChangedFilesTooltipBody {summary} worktreePath={path} {daemonId} />
      </span>
    </Tooltip>
  {/if}

  {#if ahead === 0 && behind === 0 && dirty === 0 && branchStatus?.upstream}
    <span
      class="status-badge status-badge-sync"
      title="In sync with {branchStatus.upstream}"
    >
      <svg
        class="sync-check-icon"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><polyline points="3.5 8.5 6.5 11.5 12.5 5" /></svg
      >
    </span>
  {/if}
{/if}
