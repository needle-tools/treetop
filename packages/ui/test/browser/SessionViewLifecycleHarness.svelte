<script lang="ts">
  import SessionView from "../../src/SessionView.svelte";
  import { codexAppSource } from "../../src/storage";
  import type { SubagentParentContext } from "../../src/session-source-routing";

  let threadId = "lifecycle-thread";
  const cwd = "/tmp/treetop-session-lifecycle";
  let working = false;
  let stopped = false;
  const terminal = new URLSearchParams(location.search).has("terminal");
  let attachTermId: string | undefined = terminal ? "test-terminal" : undefined;
  let openedSubagentId = "";
  const lanes = new URLSearchParams(location.search).has("lanes");
  const verticalLanes =
    new URLSearchParams(location.search).get("lanes") === "vertical";
  const laneScrollBehavior = new URLSearchParams(location.search).has("smooth")
    ? "smooth"
    : "auto";
  let laneViewport: HTMLDivElement;
  let openedSubagentContext: SubagentParentContext | undefined;
  const parentTaskContext: SubagentParentContext | undefined = new URLSearchParams(location.search).has("parent-task")
    ? { sourceKind: "app-server", subagent: { id: threadId, action: "spawn", status: "running", nickname: "renderer_review", task: "Inspect **the entire renderer**.\n\nPreserve scrolling and subscriptions.", model: "gpt-6-astra", effort: "high" } }
    : undefined;
</script>

<div
  class:lane-viewport={lanes}
  class:sessions-strip={lanes && !verticalLanes}
  class:vertical-lanes={verticalLanes}
  bind:this={laneViewport}
>
  <main class="session-lifecycle-stage" data-working={working} data-stopped={stopped}>
    <SessionView
      agent="codex"
      source={codexAppSource(threadId)}
      resumeSessionId={threadId}
      wtPath={cwd}
      visualAppEnabled={true}
      visualAppStopped={stopped}
      {attachTermId}
      initialMode={terminal ? "terminal" : "read"}
      onTerminalStopped={() => { attachTermId = undefined; stopped = true; }}
      onWorkingChange={(value) => (working = value)}
      onStopVisualApp={() => (stopped = true)}
      onVisualResume={() => (stopped = false)}
      spawnReady={false}
      {parentTaskContext}
      onOpenSubagent={(subagentId, _surface, context) => { openedSubagentId = subagentId; openedSubagentContext = context; }}
    />
    <output data-opened-subagent>{openedSubagentId}</output>
    <output data-opened-subagent-context>{JSON.stringify(openedSubagentContext)}</output>
  </main>
  {#if lanes}<aside class="neighbor-lane">Neighboring lane</aside>{/if}
</div>
{#if lanes}
  <nav class="lane-navigation">
    <button
      onclick={() =>
        verticalLanes
          ? window.scrollTo({ top: 0, behavior: laneScrollBehavior })
          : laneViewport.scrollTo({ left: 0, behavior: laneScrollBehavior })}
      >Session lane</button
    >
    <button
      onclick={() =>
        verticalLanes
          ? window.scrollTo({ top: 1600, behavior: laneScrollBehavior })
          : laneViewport.scrollTo({ left: 1600, behavior: laneScrollBehavior })}
      >Neighbor lane</button
    >
  </nav>
{/if}
<button
  onclick={() =>
    (threadId =
      threadId === "lifecycle-thread"
        ? "other-lifecycle-thread"
        : "lifecycle-thread")}>Switch session</button
>

<style>
  :global(html),
  :global(body),
  :global(#app) {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
  }

  .session-lifecycle-stage {
    width: 760px;
    height: 560px;
    padding: 12px;
    box-sizing: border-box;
  }
  .lane-viewport {
    display: flex;
    width: 900px;
    overflow-x: auto;
  }
  .lane-viewport .session-lifecycle-stage {
    flex: 0 0 760px;
  }
  .neighbor-lane {
    flex: 0 0 1600px;
    height: 560px;
  }
  .vertical-lanes {
    display: block;
    overflow: visible;
  }
  .vertical-lanes .neighbor-lane {
    height: 1800px;
  }
  .lane-navigation {
    position: fixed;
    bottom: 0;
    left: 0;
  }
  :global(html:has(.vertical-lanes)),
  :global(body:has(.vertical-lanes)),
  :global(#app:has(.vertical-lanes)) {
    overflow: visible;
    height: auto;
  }
</style>
