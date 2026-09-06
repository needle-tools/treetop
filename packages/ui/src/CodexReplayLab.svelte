<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import SessionView from "./SessionView.svelte";
  import { codexAppSource } from "./storage";
  import {
    createCodexReplaySessionTransport,
    filterCodexReplaySessions,
    parseCodexReplaySessionFixture,
    summarizeCodexReplaySessions,
    type CodexReplaySessionFilter,
    type CodexReplaySessionFixture,
    type CodexReplaySessionTransport,
  } from "./codex-replay-lab";

  let fixture: CodexReplaySessionFixture | null = null;
  let transport: CodexReplaySessionTransport | null = null;
  let fileName = "";
  let stepIndex = 0;
  let scrubStepIndex = 0;
  let replayGeneration = 0;
  let playing = false;
  let playTimer: ReturnType<typeof setInterval> | null = null;
  let parseError = "";
  let loading = false;
  let loadingLabel = "";
  let loadRequestId = 0;
  let sessions: ReplaySessionIndexEntry[] = [];
  let recordingsLoading = false;
  let recordingsError = "";
  let selectedThreadId = "";
  let sessionFilter: CodexReplaySessionFilter = "both";

  $: stepCount = transport?.stepCount ?? 0;
  $: sessionCounts = summarizeCodexReplaySessions(sessions);
  $: visibleSessions = filterCodexReplaySessions(sessions, sessionFilter);

  function installFixture(
    nextFixture: CodexReplaySessionFixture,
    name: string,
    initialStep = 0,
  ): void {
    fixture = nextFixture;
    transport = createCodexReplaySessionTransport(nextFixture, initialStep);
    fileName = name;
    stepIndex = initialStep;
    scrubStepIndex = initialStep;
    replayGeneration += 1;
  }

  async function fetchRecordings(): Promise<void> {
    recordingsLoading = true;
    recordingsError = "";
    try {
      const res = await fetch("/api/codex-app/recordings");
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        sessions?: ReplaySessionIndexEntry[];
        error?: string;
      } | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      sessions = body.sessions ?? [];
    } catch (err) {
      recordingsError = err instanceof Error ? err.message : String(err);
    } finally {
      recordingsLoading = false;
    }
  }

  async function loadSession(entry: ReplaySessionIndexEntry): Promise<void> {
    const requestId = ++loadRequestId;
    loading = true;
    loadingLabel = "Loading session";
    selectedThreadId = entry.threadId;
    fileName = entry.title;
    parseError = "";
    fixture = null;
    transport = null;
    playing = false;
    try {
      const params = new URLSearchParams({ threadId: entry.threadId });
      const res = await fetch(`/api/codex-app/recordings/read?${params}`);
      const body = (await res
        .json()
        .catch(() => null)) as ReplaySessionReadResponse | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      if (requestId !== loadRequestId) return;
      installFixture(
        parseCodexReplaySessionFixture(body.recordingText, entry.threadId),
        body.session.title,
      );
      selectedThreadId = entry.threadId;
    } catch (err) {
      if (requestId !== loadRequestId) return;
      parseError = err instanceof Error ? err.message : String(err);
    } finally {
      if (requestId === loadRequestId) {
        loading = false;
        loadingLabel = "";
      }
    }
  }

  function clearReplay(): void {
    loadRequestId += 1;
    fixture = null;
    transport = null;
    fileName = "";
    stepIndex = 0;
    scrubStepIndex = 0;
    playing = false;
    parseError = "";
    selectedThreadId = "";
    loading = false;
    loadingLabel = "";
  }

  function togglePlay(): void {
    playing = !playing;
    if (playing && stepIndex >= stepCount) setReplayStep(0);
  }

  function setReplayStep(nextStepIndex: number): void {
    if (!fixture || !transport) return;
    const next = Math.min(stepCount, Math.max(0, Math.floor(nextStepIndex)));
    if (next < stepIndex) {
      transport = createCodexReplaySessionTransport(fixture, next);
      replayGeneration += 1;
    } else {
      transport.setStep(next);
    }
    stepIndex = next;
    scrubStepIndex = next;
  }

  function onScrubInput(event: Event): void {
    scrubStepIndex = Number((event.currentTarget as HTMLInputElement).value);
  }

  function commitScrub(): void {
    setReplayStep(scrubStepIndex);
  }

  $: {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
    }
    if (playing && fixture) {
      playTimer = setInterval(() => {
        if (stepIndex >= stepCount) {
          playing = false;
          return;
        }
        setReplayStep(stepIndex + 1);
      }, 180);
    }
  }

  onDestroy(() => {
    if (playTimer) clearInterval(playTimer);
  });

  onMount(() => {
    void fetchRecordings();
  });

  interface ReplaySessionIndexEntry {
    threadId: string;
    title: string;
    mtimeMs: number;
    rpcRecordingCount: number;
    rpcFrameCount: number;
    hasTranscript: boolean;
    transcript?: { messageCount?: number };
  }

  interface ReplaySessionReadResponse {
    ok: boolean;
    session: ReplaySessionIndexEntry;
    recordingText: string;
    error?: string;
  }
</script>

<section class="replay-lab">
  <header class="replay-lab-header">
    <div>
      <h1>Codex App Replay Lab</h1>
      <p>
        Recorded app-server traffic rendered by Treetop's production session
        component.
      </p>
    </div>
    <div class="replay-actions">
      <button
        type="button"
        class="replay-clear"
        disabled={!fixture && !parseError && !loading && !fileName}
        on:click={clearReplay}
      >
        Clear
      </button>
    </div>
  </header>

  <div class="replay-workspace">
    <aside
      class="replay-browser"
      aria-label="Recorded Codex app-server sessions"
    >
      <div class="replay-browser-title">
        <strong>Sessions <span>{sessionCounts.total}</span></strong>
        <button
          type="button"
          on:click={fetchRecordings}
          disabled={recordingsLoading}
        >
          Refresh
        </button>
      </div>
      <div class="replay-browser-counts" aria-label="Replay coverage">
        <span>RPC {sessionCounts.rpc}</span>
        <span>Transcript {sessionCounts.transcript}</span>
        <span>Both {sessionCounts.both}</span>
      </div>
      <div
        class="replay-browser-filters"
        role="tablist"
        aria-label="Filter sessions"
      >
        <button
          type="button"
          role="tab"
          aria-selected={sessionFilter === "all"}
          class:selected={sessionFilter === "all"}
          on:click={() => (sessionFilter = "all")}
          >All {sessionCounts.total}</button
        >
        <button
          type="button"
          role="tab"
          aria-selected={sessionFilter === "both"}
          class:selected={sessionFilter === "both"}
          on:click={() => (sessionFilter = "both")}
          >Both {sessionCounts.both}</button
        >
        <button
          type="button"
          role="tab"
          aria-selected={sessionFilter === "rpc-only"}
          class:selected={sessionFilter === "rpc-only"}
          on:click={() => (sessionFilter = "rpc-only")}
          >RPC only {sessionCounts.rpcOnly}</button
        >
      </div>
      {#if recordingsLoading}
        <span class="replay-browser-muted">Loading sessions...</span>
      {:else if recordingsError}
        <span class="replay-browser-error">{recordingsError}</span>
      {:else if !sessions.length}
        <span class="replay-browser-muted">No replay sessions found.</span>
      {:else if !visibleSessions.length}
        <span class="replay-browser-muted">No sessions match this filter.</span>
      {:else}
        <div class="replay-recording-list">
          {#each visibleSessions as entry (entry.threadId)}
            <button
              type="button"
              class:selected={selectedThreadId === entry.threadId}
              title={entry.threadId}
              on:click={() => loadSession(entry)}
            >
              <span class="replay-recording-name">{entry.title}</span>
              <span class="replay-session-id">{entry.threadId}</span>
              <span class="replay-session-coverage">
                <span>RPC {entry.rpcFrameCount}</span>
                {#if entry.hasTranscript}
                  <span
                    >Transcript{entry.transcript?.messageCount
                      ? ` ${entry.transcript.messageCount}`
                      : ""}</span
                  >
                {:else}
                  <span>RPC only</span>
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </aside>

    <main class="replay-main">
      {#if loading}
        <div class="replay-drop replay-loading" role="status" aria-live="polite">
          <strong>{loadingLabel || "Loading replay"}</strong>
          {#if fileName}<span>{fileName}</span>{/if}
          <progress></progress>
        </div>
      {:else if !fixture || !transport}
        <div class="replay-drop" role="region" aria-label="Replay status">
          <strong>Select a recorded session</strong>
          <span>The selected recording will load through Treetop's SessionView.</span>
          {#if parseError}<small>{parseError}</small>{/if}
        </div>
      {:else}
        <div class="replay-stage">
          <div class="replay-production-session">
            {#key replayGeneration}
              <SessionView
                agent="codex"
                source={codexAppSource(fixture.threadId)}
                resumeSessionId={fixture.threadId}
                wtPath={fixture.cwd}
                manualTitleOverride={fileName}
                visualAppEnabled={true}
                codexAppTransport={transport}
                spawnReady={false}
              />
            {/key}
          </div>
          <div class="replay-timeline">
            <div class="replay-step-buttons" aria-label="Replay steps">
              <button
                class="replay-step"
                on:click={() => setReplayStep(0)}
                disabled={stepIndex <= 0}
              >
                Start
              </button>
              <button
                class="replay-step"
                on:click={() => setReplayStep(stepIndex - 1)}
                disabled={stepIndex <= 0}
              >
                -1
              </button>
              <button
                class="replay-step replay-step-primary"
                on:click={() => setReplayStep(stepIndex + 1)}
                disabled={stepIndex >= stepCount}
              >
                +1 step
              </button>
              <button
                class="replay-step"
                on:click={() => setReplayStep(stepCount)}
                disabled={stepIndex >= stepCount}
              >
                End
              </button>
            </div>
            <button
              class="replay-play"
              on:click={togglePlay}
              aria-label={playing ? "Pause replay" : "Play replay"}
            >
              {playing ? "Pause" : "Play"}
            </button>
            <input
              type="range"
              min="0"
              max={stepCount}
              step="1"
              value={scrubStepIndex}
              on:input={onScrubInput}
              on:change={commitScrub}
              aria-label="Replay time"
            />
            <span>{scrubStepIndex}/{stepCount}</span>
          </div>
        </div>
      {/if}
    </main>
  </div>
</section>

<style>
  .replay-lab {
    height: 100vh;
    display: grid;
    grid-template-rows: auto 1fr;
    gap: 14px;
    padding: 18px;
    box-sizing: border-box;
    overflow: hidden;
    color: var(--text, #f0f0f0);
    background: var(--bg, #151515);
  }

  .replay-lab-header {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
  }

  .replay-lab-header h1 {
    margin: 0;
    font-size: 20px;
  }

  .replay-lab-header p {
    margin: 4px 0 0;
    color: var(--muted, #999);
    font-size: 13px;
  }

  .replay-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .replay-clear {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-height: 34px;
    padding: 0 12px;
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 999px;
    background: var(--button-bg, #252525);
    cursor: pointer;
    white-space: nowrap;
  }

  .replay-clear {
    font: inherit;
  }

  .replay-clear:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .replay-drop {
    border: 1px dashed var(--border, #444);
    border-radius: 12px;
    display: grid;
    place-content: center;
    gap: 8px;
    text-align: center;
    min-height: 420px;
    color: var(--muted, #aaa);
  }

  .replay-drop strong {
    color: var(--text, #f0f0f0);
    font-size: 18px;
  }

  .replay-drop small {
    color: var(--danger, #ff8f8f);
  }

  .replay-workspace {
    min-height: 0;
    display: grid;
    grid-template-columns: 300px minmax(0, 1fr);
    gap: 14px;
    overflow: hidden;
  }

  .replay-browser,
  .replay-main {
    min-height: 0;
    overflow: hidden;
  }

  .replay-browser {
    display: grid;
    grid-template-rows: auto auto auto 1fr;
    border: 1px solid var(--border, #303030);
    border-radius: 12px;
    background: var(--panel-bg, #181818);
  }

  .replay-browser-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border, #303030);
  }

  .replay-browser-title button {
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 999px;
    color: inherit;
    background: var(--button-bg, #252525);
    font: inherit;
    font-size: 12px;
  }

  .replay-browser-title strong span,
  .replay-browser-counts {
    color: var(--muted, #999);
    font-size: 12px;
    font-weight: 400;
  }

  .replay-browser-counts {
    display: flex;
    gap: 10px;
    padding: 8px 12px 0;
  }

  .replay-browser-filters {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    padding: 8px;
    border-bottom: 1px solid var(--border, #303030);
  }

  .replay-browser-filters button {
    min-width: 0;
    min-height: 28px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--muted, #aaa);
    background: transparent;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .replay-browser-filters button.selected {
    border-color: var(--border, #3a3a3a);
    color: var(--text, #f0f0f0);
    background: var(--button-bg, #252525);
  }

  .replay-recording-list {
    min-height: 0;
    overflow: auto;
    padding: 8px;
  }

  .replay-recording-list button {
    width: 100%;
    display: grid;
    gap: 3px;
    margin: 0 0 4px;
    padding: 9px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    color: inherit;
    background: transparent;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .replay-recording-list button:hover,
  .replay-recording-list button.selected {
    background: color-mix(in srgb, var(--accent, #9ad45f), transparent 88%);
    border-color: color-mix(in srgb, var(--accent, #9ad45f), transparent 55%);
  }

  .replay-recording-list button span:not(.replay-recording-name),
  .replay-browser-muted,
  .replay-browser-error {
    color: var(--muted, #999);
    font-size: 12px;
  }

  .replay-recording-name {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    font-weight: 700;
  }

  .replay-session-id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .replay-session-coverage {
    display: flex;
    gap: 8px;
  }

  .replay-browser-muted,
  .replay-browser-error {
    padding: 12px;
  }

  .replay-browser-error {
    color: var(--danger, #ff8f8f);
  }

  .replay-loading progress {
    width: min(460px, 62vw);
    accent-color: var(--accent, #9ad45f);
  }

  .replay-stage {
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: 1fr auto;
    border: 1px solid var(--border, #303030);
    border-radius: 12px;
    overflow: hidden;
    background: var(--panel-bg, #181818);
  }

  .replay-production-session {
    min-height: 0;
    overflow: hidden;
  }

  .replay-production-session :global(.session) {
    height: 100%;
  }

  .replay-timeline {
    display: grid;
    grid-template-columns: auto auto minmax(140px, 1fr) auto;
    gap: 12px;
    align-items: center;
    padding: 12px;
    border-top: 1px solid var(--border, #303030);
    background: color-mix(in srgb, var(--panel-bg, #181818), black 12%);
  }

  .replay-step-buttons {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .replay-play,
  .replay-step {
    min-width: 72px;
    min-height: 34px;
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 999px;
    color: inherit;
    background: var(--button-bg, #252525);
    font: inherit;
    cursor: pointer;
  }

  .replay-step {
    min-width: 0;
    padding: 0 10px;
  }

  .replay-step-primary {
    border-color: color-mix(in srgb, var(--accent, #9ad45f), white 18%);
  }

  .replay-play:disabled,
  .replay-step:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .replay-timeline input {
    width: 100%;
  }
</style>
