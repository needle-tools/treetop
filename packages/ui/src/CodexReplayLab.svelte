<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import VisualTranscript from "./VisualTranscript.svelte";
  import {
    createCodexReplayPlayback,
    filterCodexReplaySessions,
    parseCodexReplayTextAsync,
    setCodexReplayPlaybackStep,
    summarizeCodexReplaySessions,
    type CodexReplayPlaybackState,
    type CodexReplaySessionFilter,
    type ParsedCodexReplay,
  } from "./codex-replay-lab";

  let replay: ParsedCodexReplay | null = null;
  let playback: CodexReplayPlaybackState | null = null;
  let fileName = "";
  let stepIndex = 0;
  let scrubStepIndex = 0;
  let playing = false;
  let playTimer: ReturnType<typeof setInterval> | null = null;
  let parseError = "";
  let loading = false;
  let loadingLabel = "";
  let loadingParsed = 0;
  let loadingTotal: number | undefined;
  let loadRequestId = 0;
  let messagesEl: HTMLElement | null = null;
  let transcriptMessagesEl: HTMLElement | null = null;
  let openWorkFoldoutKeys = new Set<string>();
  let openWorkEntryKeys = new Set<string>();
  let expandedThinkingWorkKeys = new Set<string>();
  let transcriptOpenWorkFoldoutKeys = new Set<string>();
  let transcriptOpenWorkEntryKeys = new Set<string>();
  let transcriptExpandedThinkingWorkKeys = new Set<string>();
  let transcriptReplay: ParsedCodexReplay | null = null;
  let transcriptPlayback: CodexReplayPlaybackState | null = null;
  let transcriptFileName = "";
  let transcriptTruncated = false;
  let sessions: ReplaySessionIndexEntry[] = [];
  let recordingsLoading = false;
  let recordingsError = "";
  let selectedThreadId = "";
  let sessionFilter: CodexReplaySessionFilter = "both";

  $: stepCount = replay?.steps.length ?? 0;
  $: clampedStepIndex = playback?.stepIndex ?? 0;
  $: items = playback?.items ?? [];
  $: transcriptItems = transcriptPlayback?.items ?? [];
  $: active = !!replay && replay.mode === "rpc" && clampedStepIndex < stepCount;
  $: currentStep = replay?.steps[clampedStepIndex - 1];
  $: renderedMessageCount = playback?.renderedMessageCount ?? 0;
  $: totalMessageCount = playback?.totalMessageCount ?? 0;
  $: loadingPercent =
    loadingTotal && loadingTotal > 0
      ? Math.min(100, Math.round((loadingParsed / loadingTotal) * 100))
      : undefined;
  $: sessionCounts = summarizeCodexReplaySessions(sessions);
  $: visibleSessions = filterCodexReplaySessions(sessions, sessionFilter);

  function installReplay(parsed: ParsedCodexReplay, name: string): void {
    replay = parsed;
    playback = createCodexReplayPlayback(parsed);
    fileName = name;
    stepIndex = playback.stepIndex;
    scrubStepIndex = playback.stepIndex;
    openWorkFoldoutKeys = new Set();
    openWorkEntryKeys = new Set();
    expandedThinkingWorkKeys = new Set();
  }

  async function parseReplay(
    text: string,
    requestId: number,
    reportProgress: boolean,
  ): Promise<ParsedCodexReplay | null> {
    const parsed = await parseCodexReplayTextAsync(text, {
      onProgress: reportProgress
        ? (progress) => {
            if (requestId !== loadRequestId) return;
            loadingLabel = progress.label;
            loadingParsed = progress.parsed;
            loadingTotal = progress.total;
          }
        : undefined,
    });
    return requestId === loadRequestId ? parsed : null;
  }

  async function loadReplayText(
    text: string,
    name = "Dropped replay",
  ): Promise<void> {
    const requestId = ++loadRequestId;
    loading = true;
    loadingLabel = "Reading file";
    loadingParsed = 0;
    loadingTotal = undefined;
    fileName = name;
    parseError = "";
    replay = null;
    playback = null;
    transcriptReplay = null;
    transcriptPlayback = null;
    transcriptFileName = "";
    transcriptTruncated = false;
    playing = false;
    try {
      const parsed = await parseReplay(text, requestId, true);
      if (!parsed) return;
      installReplay(parsed, name);
      selectedThreadId = "";
      parseError = "";
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
    loadingParsed = 0;
    loadingTotal = undefined;
    selectedThreadId = entry.threadId;
    fileName = entry.title;
    parseError = "";
    replay = null;
    playback = null;
    transcriptReplay = null;
    transcriptPlayback = null;
    transcriptFileName = "";
    transcriptTruncated = false;
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
      const parsed = await parseReplay(body.recordingText, requestId, true);
      if (!parsed) return;
      installReplay(parsed, `${body.session.title} · RPC`);
      if (body.transcriptText) {
        const parsedTranscript = await parseReplay(
          body.transcriptText,
          requestId,
          false,
        );
        if (!parsedTranscript) return;
        transcriptReplay = parsedTranscript;
        transcriptPlayback = createCodexReplayPlayback(parsedTranscript, {
          stepIndex: parsedTranscript.steps.length,
        });
        transcriptFileName = `${body.session.title} · Transcript`;
        transcriptTruncated = body.transcriptTruncated === true;
        transcriptOpenWorkFoldoutKeys = new Set();
        transcriptOpenWorkEntryKeys = new Set();
        transcriptExpandedThinkingWorkKeys = new Set();
      }
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

  async function loadFiles(files: FileList | File[]): Promise<void> {
    const file = files[0];
    if (!file) return;
    await loadReplayText(await file.text(), file.name);
  }

  function clearReplay(): void {
    loadRequestId += 1;
    replay = null;
    playback = null;
    fileName = "";
    stepIndex = 0;
    scrubStepIndex = 0;
    playing = false;
    parseError = "";
    transcriptReplay = null;
    transcriptPlayback = null;
    transcriptFileName = "";
    transcriptTruncated = false;
    selectedThreadId = "";
    loading = false;
    loadingLabel = "";
    loadingParsed = 0;
    loadingTotal = undefined;
    openWorkFoldoutKeys = new Set();
    openWorkEntryKeys = new Set();
    expandedThinkingWorkKeys = new Set();
    transcriptOpenWorkFoldoutKeys = new Set();
    transcriptOpenWorkEntryKeys = new Set();
    transcriptExpandedThinkingWorkKeys = new Set();
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) void loadFiles(e.dataTransfer.files);
  }

  function togglePlay(): void {
    playing = !playing;
    if (playing && stepIndex >= stepCount) setReplayStep(0);
  }

  function setReplayStep(nextStepIndex: number): void {
    if (!replay) return;
    playback = setCodexReplayPlaybackStep(
      playback ?? createCodexReplayPlayback(replay),
      nextStepIndex,
    );
    stepIndex = playback.stepIndex;
    scrubStepIndex = playback.stepIndex;
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
    if (playing && replay) {
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
    transcriptText?: string;
    transcriptTruncated?: boolean;
    error?: string;
  }
</script>

<svelte:window on:dragover|preventDefault on:drop={onDrop} />

<section class="replay-lab">
  <header class="replay-lab-header">
    <div>
      <h1>Codex App Replay Lab</h1>
      <p>
        Drop an app-server RPC replay to scrub playback, or a Codex session
        JSONL to inspect the transcript surface.
      </p>
    </div>
    <div class="replay-actions">
      <button
        type="button"
        class="replay-clear"
        disabled={!replay && !parseError && !loading && !fileName}
        on:click={clearReplay}
      >
        Clear
      </button>
      <label class="replay-open">
        <input
          type="file"
          accept=".json,.jsonl,application/json,application/x-ndjson,text/plain"
          on:change={(e) => {
            const input = e.currentTarget as HTMLInputElement;
            if (input.files) void loadFiles(input.files);
            input.value = "";
          }}
        />
        Open replay
      </label>
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
        <div
          class="replay-drop replay-loading"
          role="status"
          aria-live="polite"
        >
          <strong>{loadingLabel || "Loading replay"}</strong>
          {#if fileName}<span>{fileName}</span>{/if}
          {#if loadingPercent !== undefined}
            <progress max="100" value={loadingPercent}></progress>
            <span>{loadingPercent}%</span>
          {:else}
            <progress></progress>
          {/if}
        </div>
      {:else if !replay}
        <div
          class="replay-drop"
          role="region"
          aria-label="Drop Codex replay or transcript"
          on:dragover|preventDefault
          on:drop={onDrop}
        >
          <strong>Drop replay JSON or JSONL here</strong>
          <span
            >RPC frames, normalized events, and Codex session JSONL work.</span
          >
          {#if parseError}<small>{parseError}</small>{/if}
        </div>
      {:else}
        <div class="replay-stage" class:has-comparison={!!transcriptReplay}>
          <div class="replay-compare">
            <section class="replay-pane">
              <div class="replay-stage-meta">
                <strong>{fileName}</strong>
                <span>{clampedStepIndex} / {stepCount} steps</span>
                {#if totalMessageCount > renderedMessageCount}
                  <span
                    >showing latest {renderedMessageCount} / {totalMessageCount} messages</span
                  >
                {/if}
                <span
                  >{replay.mode === "transcript"
                    ? "Transcript"
                    : "RPC replay"}</span
                >
                {#if currentStep}<span>{currentStep.label}</span>{/if}
                {#if replay.warnings.length}
                  <span>{replay.warnings.length} skipped rows</span>
                {/if}
              </div>
              <div class="replay-transcript" bind:this={messagesEl}>
                <VisualTranscript
                  agent="codex"
                  daemonId={undefined}
                  {items}
                  transcriptSurface="read"
                  {active}
                  {messagesEl}
                  sessionCwd=""
                  {openWorkFoldoutKeys}
                  {openWorkEntryKeys}
                  {expandedThinkingWorkKeys}
                />
              </div>
            </section>

            {#if transcriptReplay}
              <section class="replay-pane">
                <div class="replay-stage-meta">
                  <strong>{transcriptFileName}</strong>
                  <span>{transcriptReplay.steps.length} steps</span>
                  <span>Transcript</span>
                  {#if transcriptTruncated}<span>latest recorded window</span
                    >{/if}
                  {#if transcriptReplay.warnings.length}
                    <span>{transcriptReplay.warnings.length} skipped rows</span>
                  {/if}
                </div>
                <div class="replay-transcript" bind:this={transcriptMessagesEl}>
                  <VisualTranscript
                    agent="codex"
                    daemonId={undefined}
                    items={transcriptItems}
                    transcriptSurface="read"
                    active={false}
                    messagesEl={transcriptMessagesEl}
                    sessionCwd=""
                    openWorkFoldoutKeys={transcriptOpenWorkFoldoutKeys}
                    openWorkEntryKeys={transcriptOpenWorkEntryKeys}
                    expandedThinkingWorkKeys={transcriptExpandedThinkingWorkKeys}
                  />
                </div>
              </section>
            {/if}
          </div>
          <div class="replay-timeline">
            <div class="replay-step-buttons" aria-label="Replay steps">
              <button
                class="replay-step"
                on:click={() => setReplayStep(0)}
                disabled={clampedStepIndex <= 0}
              >
                Start
              </button>
              <button
                class="replay-step"
                on:click={() => setReplayStep(clampedStepIndex - 1)}
                disabled={clampedStepIndex <= 0}
              >
                -1
              </button>
              <button
                class="replay-step replay-step-primary"
                on:click={() => setReplayStep(clampedStepIndex + 1)}
                disabled={clampedStepIndex >= stepCount}
              >
                +1 step
              </button>
              <button
                class="replay-step"
                on:click={() => setReplayStep(stepCount)}
                disabled={clampedStepIndex >= stepCount}
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

  .replay-open,
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

  .replay-open input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
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

  .replay-compare {
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    overflow: hidden;
  }

  .has-comparison .replay-compare {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .replay-pane {
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto 1fr;
    overflow: hidden;
  }

  .replay-pane + .replay-pane {
    border-left: 1px solid var(--border, #303030);
  }

  .replay-stage-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border, #303030);
    color: var(--muted, #aaa);
    font-size: 13px;
  }

  .replay-stage-meta strong {
    color: var(--text, #f0f0f0);
  }

  .replay-transcript {
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 18px 20px 96px;
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
