<script lang="ts">
  import { onDestroy } from "svelte";
  import VisualTranscript from "./VisualTranscript.svelte";
  import {
    codexReplayItemsUntil,
    parseCodexReplayTextAsync,
    type ParsedCodexReplay,
  } from "./codex-replay-lab";

  let replay: ParsedCodexReplay | null = null;
  let fileName = "";
  let stepIndex = 0;
  let playing = false;
  let playTimer: ReturnType<typeof setInterval> | null = null;
  let parseError = "";
  let loading = false;
  let loadingLabel = "";
  let loadingParsed = 0;
  let loadingTotal: number | undefined;
  let loadRequestId = 0;
  let messagesEl: HTMLElement | null = null;
  let openWorkFoldoutKeys = new Set<string>();
  let openWorkEntryKeys = new Set<string>();
  let expandedThinkingWorkKeys = new Set<string>();

  $: stepCount = replay?.steps.length ?? 0;
  $: clampedStepIndex = Math.min(stepIndex, stepCount);
  $: items = replay ? codexReplayItemsUntil(replay, clampedStepIndex) : [];
  $: active = !!replay && replay.mode === "rpc" && clampedStepIndex < stepCount;
  $: currentStep = replay?.steps[clampedStepIndex - 1];
  $: loadingPercent =
    loadingTotal && loadingTotal > 0
      ? Math.min(100, Math.round((loadingParsed / loadingTotal) * 100))
      : undefined;

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
    playing = false;
    try {
      const parsed = await parseCodexReplayTextAsync(text, {
        onProgress: (progress) => {
          if (requestId !== loadRequestId) return;
          loadingLabel = progress.label;
          loadingParsed = progress.parsed;
          loadingTotal = progress.total;
        },
      });
      if (requestId !== loadRequestId) return;
      replay = parsed;
      fileName = name;
      stepIndex = replay.steps.length;
      parseError = "";
      openWorkFoldoutKeys = new Set();
      openWorkEntryKeys = new Set();
      expandedThinkingWorkKeys = new Set();
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
    fileName = "";
    stepIndex = 0;
    playing = false;
    parseError = "";
    loading = false;
    loadingLabel = "";
    loadingParsed = 0;
    loadingTotal = undefined;
    openWorkFoldoutKeys = new Set();
    openWorkEntryKeys = new Set();
    expandedThinkingWorkKeys = new Set();
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) void loadFiles(e.dataTransfer.files);
  }

  function togglePlay(): void {
    playing = !playing;
    if (playing && stepIndex >= stepCount) stepIndex = 0;
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
        stepIndex += 1;
      }, 180);
    }
  }

  onDestroy(() => {
    if (playTimer) clearInterval(playTimer);
  });
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

  {#if loading}
    <div class="replay-drop replay-loading" role="status" aria-live="polite">
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
      <span>RPC frames, normalized events, and Codex session JSONL work.</span>
      {#if parseError}<small>{parseError}</small>{/if}
    </div>
  {:else}
    <div class="replay-stage">
      <div class="replay-stage-meta">
        <strong>{fileName}</strong>
        <span>{clampedStepIndex} / {stepCount} steps</span>
        <span>{replay.mode === "transcript" ? "Transcript" : "RPC replay"}</span
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
      {#if replay.mode === "rpc"}
        <div class="replay-timeline">
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
            bind:value={stepIndex}
            aria-label="Replay time"
          />
          <span>{clampedStepIndex}/{stepCount}</span>
        </div>
      {/if}
    </div>
  {/if}
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

  .replay-loading progress {
    width: min(460px, 62vw);
    accent-color: var(--accent, #9ad45f);
  }

  .replay-stage {
    min-height: 0;
    height: 100%;
    display: grid;
    grid-template-rows: auto 1fr auto;
    border: 1px solid var(--border, #303030);
    border-radius: 12px;
    overflow: hidden;
    background: var(--panel-bg, #181818);
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
    grid-template-columns: auto 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 12px;
    border-top: 1px solid var(--border, #303030);
    background: color-mix(in srgb, var(--panel-bg, #181818), black 12%);
  }

  .replay-play {
    min-width: 72px;
    min-height: 34px;
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 999px;
    color: inherit;
    background: var(--button-bg, #252525);
  }

  .replay-timeline input {
    width: 100%;
  }
</style>
