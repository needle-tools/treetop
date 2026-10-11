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
  let openedSubagentContext: SubagentParentContext | undefined;
  const parentTaskContext: SubagentParentContext | undefined = new URLSearchParams(location.search).has("parent-task")
    ? { sourceKind: "app-server", subagent: { id: threadId, action: "spawn", status: "running", nickname: "renderer_review", task: "Inspect **the entire renderer**.\n\nPreserve scrolling and subscriptions.", model: "gpt-6-astra", effort: "high" } }
    : undefined;
</script>

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
</style>
