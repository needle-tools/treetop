<script lang="ts">
  import SessionView from "../../src/SessionView.svelte";
  import { codexAppSource } from "../../src/storage";

  const threadId = "lifecycle-thread";
  const cwd = "/tmp/treetop-session-lifecycle";
  let working = false;
  let stopped = false;
  const terminal = new URLSearchParams(location.search).has("terminal");
  let attachTermId: string | undefined = terminal ? "test-terminal" : undefined;
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
  />
</main>

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
