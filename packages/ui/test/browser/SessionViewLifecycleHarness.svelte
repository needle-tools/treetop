<script lang="ts">
  import SessionView from "../../src/SessionView.svelte";
  import { codexAppSource } from "../../src/storage";

  const threadId = "lifecycle-thread";
  const cwd = "/tmp/treetop-session-lifecycle";
</script>

<main class="session-lifecycle-stage">
  <SessionView
    agent="codex"
    source={codexAppSource(threadId)}
    resumeSessionId={threadId}
    wtPath={cwd}
    visualAppEnabled={true}
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
