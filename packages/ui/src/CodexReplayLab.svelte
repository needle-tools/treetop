<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import SessionView from "./SessionView.svelte";
  import { formatByteSize } from "./context-tokens";
  import { codexAppSource } from "./storage";
  import { installIdleTracker } from "./ui-idle";
  import {
    loadModelsDevPricing,
    type ModelsDevPricingSnapshot,
  } from "@treetop/nicifier";
  import {
    analyzeCodexReplayTurns,
    collectCodexReplayDirectoryFiles,
    createCodexReplaySessionTransport,
    createCodexReplayViewModel,
    filterCodexReplaySessions,
    filterCodexReplaySessionsByModel,
    formatReplayCost,
    formatReplayClock,
    formatReplayDuration,
    formatReplayTokenCount,
    inspectCodexReplayFilePrefix,
    listCodexReplayModels,
    listCodexReplaySessionModels,
    parseCodexReplayBlobAsync,
    parseCodexReplaySessionFixture,
    REPLAY_SESSION_LOCATIONS,
    replayDurationMs,
    replayElapsedMsAtStep,
    replayPlaybackTiming,
    replaySourceProgressAtStep,
    replayStepIndexAtElapsedMs,
    summarizeCodexReplaySessions,
    summarizeCodexReplayPricingUsage,
    setCodexReplayPlaybackStep,
    sortCodexReplaySessions,
    type CodexReplayPlaybackState,
    type CodexReplaySessionFilter,
    type CodexReplaySessionFixture,
    type CodexReplaySessionTransport,
    type CodexReplaySessionSelection,
    type CodexReplaySessionSort,
    type CodexReplayMessage,
    type ReplayPlaybackRate,
    type CodexReplayDirectoryFile,
    type CodexReplayDirectoryHandleLike,
    type CodexReplayTranscriptSession,
    type CodexReplayViewModel,
    type ParsedCodexReplay,
  } from "./codex-replay-lab";

  let fixture: CodexReplaySessionFixture | null = null;
  let transport: CodexReplaySessionTransport | null = null;
  let localReplay: ParsedCodexReplay | null = null;
  let localPlayback: CodexReplayPlaybackState | null = null;
  let fileName = "";
  let stepIndex = 0;
  let scrubStepIndex = 0;
  let replayGeneration = 0;
  let playing = false;
  let playTimer: ReturnType<typeof setInterval> | null = null;
  let playbackRate: ReplayPlaybackRate = "time:10";
  let playbackCursorMs = 0;
  let parseError = "";
  let loading = false;
  let loadingLabel = "";
  let loadRequestId = 0;
  let sessions: ReplaySessionIndexEntry[] = [];
  let recordingsLoading = false;
  let recordingsError = "";
  let daemonAvailable: boolean | undefined;
  let selectedThreadId = "";
  let sessionFilter: CodexReplaySessionFilter = "all";
  let sessionQuery = "";
  let sessionSelection: CodexReplaySessionSelection = "recent";
  let transcriptSession: ReplaySessionIndexEntry | null = null;
  let transcriptSessionOverride: CodexReplayTranscriptSession | undefined;
  let analysisCollapsed = false;
  let analysisMessages: readonly CodexReplayMessage[] = [];
  let modelsDevPricing: ModelsDevPricingSnapshot | undefined;
  let fileInput: HTMLInputElement | null = null;
  let folderInput: HTMLInputElement | null = null;
  let helpDialog: HTMLDialogElement | null = null;
  let localFile = false;
  let localWarnings: string[] = [];
  let dragActive = false;
  let sessionListMode: "daemon" | "directory" = "daemon";
  let directoryLabel = "";
  let directoryStatus = "";
  let directoryGeneration = 0;
  let directoryFiles = new Map<string, CodexReplayDirectoryFile>();

  $: stepCount = transport?.stepCount ?? localReplay?.steps.length ?? 0;
  $: playbackTimeline = localReplay
    ? localReplay
    : fixture
      ? { steps: fixture.events.map((event) => ({ at: event.receivedAt })) }
      : null;
  $: replayTotalMs = playbackTimeline ? replayDurationMs(playbackTimeline) : 0;
  $: replayCurrentMs = playbackTimeline
    ? playbackRate.startsWith("time:")
      ? playbackCursorMs
      : replayElapsedMsAtStep(playbackTimeline, scrubStepIndex)
    : 0;
  $: replaySourceProgress = localReplay
    ? replaySourceProgressAtStep(localReplay, stepIndex)
    : { exact: true };
  $: replayModel = [...analysisMessages]
    .reverse()
    .find((message) => message.model)?.model;
  $: replayPricingUsage = summarizeCodexReplayPricingUsage(analysisMessages);
  $: turnAnalysis = analyzeCodexReplayTurns(analysisMessages, {
    defaultModel: replayModel,
    modelsDev: modelsDevPricing,
  });
  $: sessionCounts = summarizeCodexReplaySessions(sessions);
  $: sessionModels = listCodexReplaySessionModels(sessions);
  $: selectedSessionModel = sessionSelection.startsWith("model:")
    ? sessionSelection.slice("model:".length)
    : undefined;
  $: visibleSessions = sortCodexReplaySessions(
    filterCodexReplaySessionsByModel(
      filterCodexReplaySessions(sessions, sessionFilter).filter((entry) => {
        const query = sessionQuery.trim().toLowerCase();
        return (
          !query ||
          entry.title.toLowerCase().includes(query) ||
          entry.threadId.toLowerCase().includes(query) ||
          entry.transcript?.path.toLowerCase().includes(query)
        );
      }),
      selectedSessionModel,
    ),
    (selectedSessionModel
      ? "recent"
      : sessionSelection) as CodexReplaySessionSort,
  );

  function installFixture(
    nextFixture: CodexReplaySessionFixture,
    name: string,
    initialStep = 0,
  ): void {
    localReplay = null;
    localPlayback = null;
    fixture = nextFixture;
    transport = createCodexReplaySessionTransport(nextFixture, initialStep);
    fileName = name;
    stepIndex = initialStep;
    scrubStepIndex = initialStep;
    playbackCursorMs = replayElapsedMsAtStep(
      { steps: nextFixture.events.map((event) => ({ at: event.receivedAt })) },
      initialStep,
    );
    replayGeneration += 1;
  }

  function installTranscriptReplay(
    view: CodexReplayViewModel,
    options: { localFile: boolean; warnings?: string[] } = {
      localFile: false,
    },
  ): void {
    fixture = null;
    transport = null;
    localReplay = view.replay;
    localPlayback = view.playback;
    transcriptSession = view.entry;
    transcriptSessionOverride = view.session;
    stepIndex = view.playback.stepIndex;
    scrubStepIndex = view.playback.stepIndex;
    playbackCursorMs = replayElapsedMsAtStep(
      view.replay,
      view.playback.stepIndex,
    );
    analysisMessages = view.playback.messages;
    localFile = options.localFile;
    localWarnings = options.warnings ?? view.replay.warnings;
    replayGeneration += 1;
  }

  async function fetchRecordings(): Promise<void> {
    sessionListMode = "daemon";
    sessionSelection = "recent";
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
      if (sessionListMode !== "daemon") return;
      daemonAvailable = true;
      sessions = body.sessions ?? [];
    } catch (err) {
      if (sessionListMode === "daemon") {
        daemonAvailable = false;
        recordingsError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      recordingsLoading = false;
    }
  }

  async function loadSession(entry: ReplaySessionIndexEntry): Promise<void> {
    if (entry.directoryKey) {
      const reference = directoryFiles.get(entry.directoryKey);
      if (!reference) return;
      try {
        selectedThreadId = entry.threadId;
        await loadDroppedFile(await reference.handle.getFile(), { entry });
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
      }
      return;
    }
    const requestId = ++loadRequestId;
    loading = true;
    loadingLabel = "Loading session";
    selectedThreadId = entry.threadId;
    fileName = entry.title;
    parseError = "";
    fixture = null;
    transport = null;
    localReplay = null;
    localPlayback = null;
    transcriptSession = null;
    transcriptSessionOverride = undefined;
    analysisMessages = [];
    localFile = false;
    localWarnings = [];
    stopPlayback();
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
      if (entry.rpcFrameCount === 0 && entry.transcript) {
        if (!body.transcriptSession) {
          throw new Error("Replay response has no transcript session");
        }
        installTranscriptReplay(
          createCodexReplayViewModel({
            session: body.transcriptSession,
            title: body.session.title,
            mtimeMs: body.session.mtimeMs,
            source: body.session.transcript?.path ?? entry.transcript.path,
            fileSizeBytes: body.session.transcript?.size,
          }),
        );
        selectedThreadId = entry.threadId;
        return;
      }
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

  async function loadDroppedFile(
    file: File,
    options: { entry?: ReplaySessionIndexEntry } = {},
  ): Promise<void> {
    const requestId = ++loadRequestId;
    loading = true;
    loadingLabel = "Reading local JSONL";
    fileName = options.entry?.title ?? file.name;
    parseError = "";
    fixture = null;
    transport = null;
    localReplay = null;
    localPlayback = null;
    transcriptSession = null;
    transcriptSessionOverride = undefined;
    analysisMessages = [];
    selectedThreadId = options.entry?.threadId ?? "";
    stopPlayback();
    localFile = true;
    localWarnings = [];
    try {
      const replay = await parseCodexReplayBlobAsync(file, {
        onProgress: ({ parsed, total }) => {
          if (requestId !== loadRequestId) return;
          const percent = total ? Math.round((parsed / total) * 100) : 0;
          loadingLabel = `Reading local JSONL · ${percent}%`;
        },
      });
      if (requestId !== loadRequestId) return;
      const view = createCodexReplayViewModel({
        replay,
        title: options.entry?.title ?? file.name,
        mtimeMs: file.lastModified,
        fileSizeBytes: file.size,
      });
      const messages = view.playback.messages;
      if (!messages.length) {
        throw new Error(
          "No displayable Codex or Claude messages found in this file",
        );
      }
      installTranscriptReplay(view, {
        localFile: true,
        warnings: replay.warnings,
      });
      if (options.entry?.directoryKey) {
        sessions = sessions.map((entry) =>
          entry.directoryKey === options.entry?.directoryKey
            ? {
                ...entry,
                models: listCodexReplayModels(messages),
                transcript: {
                  ...entry.transcript!,
                  lineCount: replay.lineCount,
                  lineCountExact: true,
                },
              }
            : entry,
        );
      }
      selectedThreadId = options.entry?.threadId ?? "";
    } catch (err) {
      if (requestId !== loadRequestId) return;
      parseError = err instanceof Error ? err.message : String(err);
      transcriptSession = null;
      transcriptSessionOverride = undefined;
    } finally {
      if (requestId === loadRequestId) {
        loading = false;
        loadingLabel = "";
      }
    }
  }

  function onFileInput(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) void loadDroppedFile(file);
  }

  async function chooseFolder(): Promise<void> {
    const picker = (
      window as typeof window & {
        showDirectoryPicker?: () => Promise<CodexReplayDirectoryHandleLike>;
      }
    ).showDirectoryPicker;
    if (!picker) {
      folderInput?.click();
      return;
    }
    try {
      const root = await picker.call(window);
      await loadDirectory(
        root.name,
        await collectCodexReplayDirectoryFiles(root),
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      recordingsError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onFolderInput(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []).filter((file) =>
      file.name.toLowerCase().endsWith(".jsonl"),
    );
    input.value = "";
    if (!files.length) return;
    const rootName = files[0]?.webkitRelativePath.split("/")[0] || "folder";
    await loadDirectory(
      rootName,
      files.map((file) => ({
        relativePath: file.webkitRelativePath || file.name,
        handle: {
          kind: "file",
          name: file.name,
          getFile: async () => file,
        },
      })),
    );
  }

  async function loadDirectory(
    label: string,
    references: CodexReplayDirectoryFile[],
  ): Promise<void> {
    const generation = ++directoryGeneration;
    sessionListMode = "directory";
    sessionFilter = "all";
    sessionSelection = "recent";
    directoryLabel = label;
    directoryStatus = `Indexing ${references.length.toLocaleString()} files`;
    recordingsError = "";
    recordingsLoading = false;
    const fileMap = new Map(
      references.map((reference) => [reference.relativePath, reference]),
    );
    directoryFiles = fileMap;
    const entries: ReplaySessionIndexEntry[] = [];
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(8, Math.max(1, references.length)) },
      async () => {
        while (nextIndex < references.length) {
          const reference = references[nextIndex++];
          if (!reference) continue;
          const file = await reference.handle.getFile();
          entries.push({
            threadId: `directory:${reference.relativePath}`,
            title: file.name.replace(/\.jsonl$/i, ""),
            mtimeMs: file.lastModified,
            rpcRecordingCount: 0,
            rpcFrameCount: 0,
            hasTranscript: true,
            directoryKey: reference.relativePath,
            transcript: {
              path: reference.relativePath,
              size: file.size,
            },
          });
        }
      },
    );
    await Promise.all(workers);
    if (generation !== directoryGeneration) return;
    sessions = entries.sort(
      (a, b) => b.mtimeMs - a.mtimeMs || a.title.localeCompare(b.title),
    );
    directoryStatus = `Finding names · 0/${entries.length.toLocaleString()}`;
    void enrichDirectoryNames(generation, entries);
  }

  async function enrichDirectoryNames(
    generation: number,
    entries: ReplaySessionIndexEntry[],
  ): Promise<void> {
    let nextIndex = 0;
    let completed = 0;
    const updates = new Map<string, Partial<ReplaySessionIndexEntry>>();
    const flush = () => {
      if (generation !== directoryGeneration || updates.size === 0) return;
      sessions = sessions.map((entry) => {
        const update = updates.get(entry.directoryKey ?? "");
        return update ? { ...entry, ...update } : entry;
      });
      updates.clear();
    };
    const workers = Array.from(
      { length: Math.min(4, Math.max(1, entries.length)) },
      async () => {
        while (nextIndex < entries.length) {
          const entry = entries[nextIndex++];
          const reference = entry?.directoryKey
            ? directoryFiles.get(entry.directoryKey)
            : undefined;
          if (!entry || !reference || generation !== directoryGeneration)
            return;
          try {
            const overview = await inspectCodexReplayFilePrefix(
              await reference.handle.getFile(),
            );
            if (overview) {
              updates.set(reference.relativePath, {
                agent: overview.agent,
                models: overview.models,
                ...(overview.title ? { title: overview.title } : {}),
                transcript: {
                  ...entry.transcript!,
                  cwd: overview.cwd,
                  lineCount: overview.lineCount,
                  lineCountExact: overview.lineCountExact,
                },
              });
            }
          } catch {
            // Keep the filename fallback for an unreadable/non-session JSONL.
          }
          completed += 1;
          if (updates.size >= 24 || completed === entries.length) flush();
          if (generation === directoryGeneration) {
            directoryStatus = `Finding names · ${completed.toLocaleString()}/${entries.length.toLocaleString()}`;
          }
        }
      },
    );
    await Promise.all(workers);
    flush();
    if (generation === directoryGeneration) {
      directoryStatus = `${entries.length.toLocaleString()} sessions · sampled without full reads`;
    }
  }

  function onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dragActive = true;
  }

  function onDragLeave(event: DragEvent): void {
    if (event.currentTarget !== event.target) return;
    dragActive = false;
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    dragActive = false;
    const file = event.dataTransfer?.files[0];
    if (file) void loadDroppedFile(file);
  }

  function clearReplay(): void {
    loadRequestId += 1;
    fixture = null;
    transport = null;
    localReplay = null;
    localPlayback = null;
    transcriptSession = null;
    transcriptSessionOverride = undefined;
    analysisMessages = [];
    fileName = "";
    stepIndex = 0;
    scrubStepIndex = 0;
    playbackCursorMs = 0;
    stopPlayback();
    parseError = "";
    selectedThreadId = "";
    loading = false;
    loadingLabel = "";
    localFile = false;
    localWarnings = [];
  }

  function togglePlay(): void {
    if (playing) {
      stopPlayback();
      return;
    }
    if (stepIndex >= stepCount) {
      setReplayStep(0);
      playbackCursorMs = 0;
    }
    playing = true;
    startPlaybackTimer();
  }

  function receiveSessionMessages(
    messages: readonly CodexReplayMessage[],
  ): void {
    analysisMessages = messages;
  }

  function setReplayStep(nextStepIndex: number): void {
    if (localReplay && localPlayback && transcriptSessionOverride) {
      const next = Math.min(stepCount, Math.max(0, Math.floor(nextStepIndex)));
      if (next < stepIndex) replayGeneration += 1;
      localPlayback = setCodexReplayPlaybackStep(localPlayback, next);
      const messages = localPlayback.messages;
      transcriptSessionOverride = {
        ...transcriptSessionOverride,
        endedAt: [...messages].reverse().find((message) => message.timestamp)
          ?.timestamp,
        messages,
      };
      analysisMessages = messages;
      stepIndex = next;
      scrubStepIndex = next;
      return;
    }
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
    seekReplayStep(scrubStepIndex);
  }

  function seekReplayStep(nextStepIndex: number): void {
    setReplayStep(nextStepIndex);
    playbackCursorMs = playbackTimeline
      ? replayElapsedMsAtStep(playbackTimeline, stepIndex)
      : 0;
    if (playing) startPlaybackTimer();
  }

  function stopPlayback(): void {
    playing = false;
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
    }
  }

  function startPlaybackTimer(): void {
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    if (!playing || !playbackTimeline) return;
    const timeline = playbackTimeline;
    const timing = replayPlaybackTiming(playbackRate);
    if (timing.mode === "steps") {
      playTimer = setInterval(() => {
        if (stepIndex >= stepCount) {
          stopPlayback();
          return;
        }
        const next = stepIndex + 1;
        setReplayStep(next);
        playbackCursorMs = replayElapsedMsAtStep(timeline, next);
        if (next >= stepCount) stopPlayback();
      }, timing.tickMs);
      return;
    }

    let previousTick = performance.now();
    playTimer = setInterval(() => {
      const now = performance.now();
      playbackCursorMs = Math.min(
        replayTotalMs,
        playbackCursorMs + (now - previousTick) * timing.multiplier,
      );
      previousTick = now;
      const targetStep = replayStepIndexAtElapsedMs(timeline, playbackCursorMs);
      if (targetStep !== stepIndex) setReplayStep(targetStep);
      if (playbackCursorMs >= replayTotalMs) stopPlayback();
    }, 50);
  }

  function setPlaybackRate(event: Event): void {
    playbackRate = (event.currentTarget as HTMLSelectElement)
      .value as ReplayPlaybackRate;
    playbackCursorMs = playbackTimeline
      ? replayElapsedMsAtStep(playbackTimeline, stepIndex)
      : 0;
    if (playing) startPlaybackTimer();
  }

  onDestroy(() => {
    directoryGeneration += 1;
    stopPlayback();
  });

  onMount(() => {
    const uninstallIdleTracker = installIdleTracker();
    void fetchRecordings();
    void loadModelsDevPricing().then((snapshot) => {
      modelsDevPricing = snapshot;
    });
    return uninstallIdleTracker;
  });

  interface ReplaySessionIndexEntry {
    agent?: "codex" | "claude";
    models?: string[];
    threadId: string;
    title: string;
    mtimeMs: number;
    rpcRecordingCount: number;
    rpcFrameCount: number;
    hasTranscript: boolean;
    directoryKey?: string;
    transcript?: {
      path: string;
      messageCount?: number;
      cwd?: string;
      size?: number;
      lineCount?: number;
      lineCountExact?: boolean;
    };
  }

  interface ReplaySessionReadResponse {
    ok: boolean;
    session: ReplaySessionIndexEntry;
    recordingText: string;
    transcriptSession?: CodexReplayTranscriptSession;
    error?: string;
  }
</script>

{#snippet replayTimeline()}
  <div class="replay-timeline">
    <div class="replay-step-buttons" aria-label="Replay steps">
      <button
        class="replay-step"
        on:click={() => seekReplayStep(0)}
        disabled={stepIndex <= 0}
      >
        Start
      </button>
      <button
        class="replay-step"
        on:click={() => seekReplayStep(stepIndex - 1)}
        disabled={stepIndex <= 0}
      >
        -1
      </button>
      <button
        class="replay-step replay-step-primary"
        on:click={() => seekReplayStep(stepIndex + 1)}
        disabled={stepIndex >= stepCount}
      >
        +1 step
      </button>
      <button
        class="replay-step"
        on:click={() => {
          setReplayStep(stepCount);
          playbackCursorMs = replayTotalMs;
          stopPlayback();
        }}
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
    <select
      value={playbackRate}
      on:change={setPlaybackRate}
      aria-label="Playback speed"
    >
      <optgroup label="Time based">
        <option value="time:1">1× realtime</option>
        <option value="time:10">10× realtime</option>
      </optgroup>
      <optgroup label="Step based">
        <option value="steps:1">1 step/s</option>
        <option value="steps:2">2 steps/s</option>
        <option value="steps:5">5 steps/s</option>
        <option value="steps:20">20 steps/s</option>
      </optgroup>
    </select>
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
    <span class="replay-clock"
      >{formatReplayClock(replayCurrentMs)} / {formatReplayClock(replayTotalMs)}
      · {scrubStepIndex}/{stepCount}</span
    >
  </div>
{/snippet}

<div
  class="replay-lab"
  class:drag-active={dragActive}
  role="region"
  aria-label="Treetop Replay Lab"
  on:dragover={onDragOver}
  on:dragleave={onDragLeave}
  on:drop={onDrop}
>
  <header class="replay-lab-header">
    <div>
      <h1>Treetop Replay Lab</h1>
      <p>
        Drop a Codex or Claude JSONL file, open a session folder, or inspect an
        available recorded session.
      </p>
    </div>
    <div class="replay-actions">
      {#if localWarnings.length}
        <span class="replay-warning" title={localWarnings.join("\n")}
          >{localWarnings.length} parse
          {localWarnings.length === 1 ? "warning" : "warnings"}</span
        >
      {/if}
      <input
        bind:this={fileInput}
        class="replay-file-input"
        type="file"
        accept=".jsonl,.json,application/json,application/x-ndjson"
        on:change={onFileInput}
      />
      <input
        bind:this={folderInput}
        class="replay-file-input"
        type="file"
        multiple
        webkitdirectory
        on:change={(event) => void onFolderInput(event)}
      />
      <button
        type="button"
        class="replay-open"
        on:click={() => fileInput?.click()}
      >
        Open JSONL
      </button>
      <button type="button" class="replay-open" on:click={chooseFolder}>
        Open folder
      </button>
      <button
        type="button"
        class="replay-help"
        aria-haspopup="dialog"
        on:click={() => helpDialog?.showModal()}
      >
        Help
      </button>
      <button
        type="button"
        class="replay-clear"
        disabled={!fixture &&
          !transcriptSession &&
          !parseError &&
          !loading &&
          !fileName}
        on:click={clearReplay}
      >
        Clear
      </button>
    </div>
  </header>

  <dialog bind:this={helpDialog} class="replay-help-dialog">
    <div class="replay-help-heading">
      <div>
        <h2>Finding session files</h2>
        <p>
          Choose any session JSONL below, then open or drop it into Replay Lab.
        </p>
      </div>
      <button
        type="button"
        aria-label="Close help"
        on:click={() => helpDialog?.close()}>×</button
      >
    </div>
    <div class="replay-help-platforms">
      {#each REPLAY_SESSION_LOCATIONS as location}
        <section>
          <h3>{location.platform}</h3>
          <strong>Codex</strong>
          {#each location.codex as path}<code>{path}</code>{/each}
          <strong>Claude Code</strong>
          {#each location.claude as path}<code>{path}</code>{/each}
        </section>
      {/each}
    </div>
    <p class="replay-help-note">
      The Claude project folder is your working-directory path encoded with
      dashes. Your browser reads a selected file locally; Replay Lab does not
      upload it.
    </p>
  </dialog>

  <div class="replay-workspace">
    <aside class="replay-browser" aria-label="Replay sessions">
      <div class="replay-browser-title">
        <strong
          >{sessionListMode === "directory" ? directoryLabel : "Sessions"}
          <span>{sessionCounts.total}</span></strong
        >
        <button
          type="button"
          on:click={fetchRecordings}
          disabled={recordingsLoading}
        >
          {sessionListMode === "directory" ? "Server" : "Refresh"}
        </button>
      </div>
      {#if sessionListMode === "directory"}
        <div class="replay-browser-counts" aria-label="Folder indexing status">
          <span>{directoryStatus}</span>
        </div>
      {:else}
        <div class="replay-browser-counts" aria-label="Replay coverage">
          <span>RPC {sessionCounts.rpc}</span>
          <span>Transcript {sessionCounts.transcript}</span>
          <span>Both {sessionCounts.both}</span>
        </div>
      {/if}
      <div class="replay-browser-controls">
        <input
          class="replay-browser-search"
          type="search"
          placeholder="Search sessions"
          aria-label="Search sessions"
          bind:value={sessionQuery}
        />
        <select
          bind:value={sessionSelection}
          aria-label="Sort or filter sessions"
        >
          <optgroup label="Sort by">
            <option value="recent">Recent</option>
            <option value="size">File size</option>
            <option value="lines">Lines</option>
            <option value="name">Name</option>
          </optgroup>
          {#if sessionModels.length}
            <optgroup label="Models">
              {#each sessionModels as model}
                <option value={`model:${model}`}>{model}</option>
              {/each}
            </optgroup>
          {/if}
        </select>
      </div>
      {#if sessionListMode === "daemon"}
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
          <button
            type="button"
            role="tab"
            aria-selected={sessionFilter === "transcript-only"}
            class:selected={sessionFilter === "transcript-only"}
            on:click={() => (sessionFilter = "transcript-only")}
            >Transcript only {sessionCounts.transcriptOnly}</button
          >
        </div>
      {/if}
      {#if recordingsLoading}
        <span class="replay-browser-muted">Loading sessions...</span>
      {:else if recordingsError}
        <span
          class:replay-browser-error={daemonAvailable !== false}
          class:replay-browser-muted={daemonAvailable === false}
          >Drop a JSONL file to begin.</span
        >
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
              {#if entry.models?.length}
                <span class="replay-session-id" title={entry.models.join(", ")}
                  >{entry.models.join(" · ")}</span
                >
              {:else if !entry.directoryKey}
                <span class="replay-session-id">{entry.threadId}</span>
              {/if}
              <span class="replay-session-coverage">
                {#if entry.directoryKey}
                  {#if entry.transcript?.size !== undefined}
                    <span>{formatByteSize(entry.transcript.size)}</span>
                  {/if}
                  {#if entry.transcript?.lineCount !== undefined}
                    <span
                      >{entry.transcript.lineCountExact
                        ? ""
                        : "~"}{entry.transcript.lineCount.toLocaleString()}
                      lines</span
                    >
                  {/if}
                {:else}
                  <span>RPC {entry.rpcFrameCount}</span>
                {/if}
                {#if !entry.directoryKey}
                  {#if entry.hasTranscript}
                    <span
                      >Transcript{entry.transcript?.messageCount
                        ? ` ${entry.transcript.messageCount}`
                        : ""}</span
                    >
                  {:else}
                    <span>RPC only</span>
                  {/if}
                {/if}
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </aside>

    <main
      class="replay-main"
      class:analysis-collapsed={analysisCollapsed}
      class:no-analysis={!fileName}
    >
      <div class="replay-session-area">
        {#if loading}
          <div
            class="replay-drop replay-loading"
            role="status"
            aria-live="polite"
          >
            <strong>{loadingLabel || "Loading replay"}</strong>
            {#if fileName}<span>{fileName}</span>{/if}
            <progress></progress>
          </div>
        {:else if transcriptSession?.transcript}
          <div
            class="replay-stage"
            class:replay-transcript-stage={!localReplay}
          >
            <div class="replay-production-session">
              {#key `${transcriptSession.threadId}:${replayGeneration}`}
                <SessionView
                  agent={transcriptSessionOverride?.agent ?? "codex"}
                  source={localFile ? "" : transcriptSession.transcript.path}
                  resumeSessionId={transcriptSession.threadId}
                  wtPath={transcriptSession.transcript.cwd ?? ""}
                  manualTitleOverride={transcriptSession.title}
                  model={replayModel}
                  pricingUsage={replayPricingUsage}
                  pricingUsageExact={replayPricingUsage.length > 0}
                  totalMessageCount={analysisMessages.length}
                  fileSizeBytes={replaySourceProgress.fileSizeBytes}
                  fileLineCount={replaySourceProgress.lineCount}
                  fileStatsExact={replaySourceProgress.exact}
                  {transcriptSessionOverride}
                  renderOnly={true}
                  visualAppEnabled={false}
                  spawnReady={false}
                  onClose={localFile ? clearReplay : () => {}}
                  onMessagesChange={receiveSessionMessages}
                />
              {/key}
            </div>
            {#if localReplay}
              {@render replayTimeline()}
            {/if}
          </div>
        {:else if !fixture || !transport}
          <div class="replay-drop" role="region" aria-label="Replay status">
            <strong>Drop a Codex or Claude JSONL file here</strong>
            <span>or select an available recorded session.</span>
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
                  onMessagesChange={receiveSessionMessages}
                />
              {/key}
            </div>
            {@render replayTimeline()}
          </div>
        {/if}
      </div>
      {#if fileName}
        <aside class="replay-analysis" aria-label="Turn analysis">
          <button
            type="button"
            class="replay-analysis-toggle"
            title={analysisCollapsed
              ? "Expand turn analysis"
              : "Collapse turn analysis"}
            aria-label={analysisCollapsed
              ? "Expand turn analysis"
              : "Collapse turn analysis"}
            on:click={() => (analysisCollapsed = !analysisCollapsed)}
            >{analysisCollapsed ? "‹" : "›"}</button
          >
          {#if !analysisCollapsed}
            <div class="replay-analysis-content">
              <header class="replay-analysis-header">
                <strong>Turns</strong>
                <span>
                  {turnAnalysis.issueTurnCount}/{turnAnalysis.turns.length} turns
                  flagged ·
                  {formatReplayCost(turnAnalysis.totalEstimatedCostUsd)} total
                </span>
              </header>
              {#if !turnAnalysis.turns.length}
                <span class="replay-analysis-empty">No turn data</span>
              {:else}
                <div class="replay-turn-map">
                  {#each turnAnalysis.turns as turn}
                    <article
                      class="replay-turn"
                      class:has-issues={turn.issues.length > 0}
                      title={turn.issues.length
                        ? turn.issues
                            .map((issue) => `${issue.label}: ${issue.detail}`)
                            .join("\n")
                        : turn.label}
                    >
                      <div class="replay-turn-heading">
                        <span>{turn.index + 1}</span>
                        <strong>{turn.label}</strong>
                      </div>
                      <div class="replay-turn-heat" aria-hidden="true">
                        <span
                          style={`--turn-heat:${Math.max(4, Math.round(turn.heat * 100))}%`}
                        ></span>
                      </div>
                      <div class="replay-turn-metrics">
                        {#if turn.durationMs !== undefined}
                          <span>{formatReplayDuration(turn.durationMs)}</span>
                        {/if}
                        {#if turn.toolCallCount > 0}
                          <span>{turn.toolCallCount} tools</span>
                        {/if}
                        {#if turn.outputTokens > 0}
                          <span
                            >{formatReplayTokenCount(turn.outputTokens)} out</span
                          >
                        {/if}
                        {#if turn.estimatedCostUsd !== undefined}
                          <span>{formatReplayCost(turn.estimatedCostUsd)}</span>
                        {/if}
                        {#if turn.tokensPerSecond !== undefined}
                          <span>{turn.tokensPerSecond.toFixed(1)} tok/s</span>
                        {/if}
                      </div>
                      {#if turn.issues.length}
                        <div class="replay-turn-issues">
                          {#each turn.issues as issue}
                            <span>{issue.label}</span>
                          {/each}
                        </div>
                      {/if}
                    </article>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </aside>
      {/if}
    </main>
  </div>
</div>

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

  .replay-lab.drag-active::after {
    content: "Drop JSONL to inspect";
    position: fixed;
    z-index: 1000;
    inset: 12px;
    display: grid;
    place-items: center;
    border: 2px dashed var(--accent, #7dd3fc);
    border-radius: 16px;
    color: var(--text, #f0f0f0);
    background: color-mix(in srgb, var(--bg, #151515) 88%, transparent);
    font-size: 20px;
    font-weight: 700;
    pointer-events: none;
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

  .replay-warning {
    color: var(--warning, #fbbf24);
    font-size: 12px;
  }

  .replay-clear,
  .replay-open,
  .replay-help {
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

  .replay-clear,
  .replay-open,
  .replay-help {
    font: inherit;
  }

  .replay-help-dialog {
    width: min(680px, calc(100vw - 32px));
    padding: 20px;
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 14px;
    color: var(--text, #f0f0f0);
    background: var(--panel-bg, #181818);
    box-shadow: 0 24px 80px rgb(0 0 0 / 55%);
  }

  .replay-help-dialog::backdrop {
    background: rgb(0 0 0 / 68%);
  }

  .replay-help-heading {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
  }

  .replay-help-heading h2,
  .replay-help-platforms h3 {
    margin: 0;
  }

  .replay-help-heading p,
  .replay-help-note {
    margin: 5px 0 0;
    color: var(--muted, #aaa);
    font-size: 13px;
  }

  .replay-help-heading button {
    width: 32px;
    height: 32px;
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 50%;
    color: inherit;
    background: var(--button-bg, #252525);
    font: inherit;
    font-size: 20px;
    cursor: pointer;
  }

  .replay-help-platforms {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-top: 18px;
  }

  .replay-help-platforms section {
    min-width: 0;
    display: grid;
    gap: 8px;
    padding: 14px;
    border: 1px solid var(--border, #303030);
    border-radius: 10px;
    background: color-mix(in srgb, var(--button-bg, #252525), transparent 30%);
  }

  .replay-help-platforms strong {
    margin-top: 5px;
    font-size: 12px;
  }

  .replay-help-platforms code {
    overflow-wrap: anywhere;
    color: var(--accent, #9ad45f);
    font-size: 12px;
  }

  @media (max-width: 720px) {
    .replay-help-platforms {
      grid-template-columns: 1fr;
    }
  }

  .replay-file-input {
    display: none;
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

  .replay-main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 310px;
    gap: 10px;
  }

  .replay-main.analysis-collapsed {
    grid-template-columns: minmax(0, 1fr) 36px;
  }

  .replay-main.no-analysis {
    grid-template-columns: minmax(0, 1fr);
  }

  .replay-session-area {
    min-width: 0;
    min-height: 0;
  }

  .replay-analysis {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--border, #303030);
    border-radius: 8px;
    background: var(--panel-bg, #181818);
  }

  .replay-analysis-toggle {
    position: absolute;
    z-index: 1;
    top: 8px;
    right: 7px;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 50%;
    color: inherit;
    background: var(--button-bg, #252525);
    font: inherit;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .replay-analysis-content {
    height: 100%;
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 0;
  }

  .replay-analysis-header {
    min-height: 42px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 40px 0 12px;
    border-bottom: 1px solid var(--border, #303030);
  }

  .replay-analysis-header span,
  .replay-analysis-empty {
    color: var(--muted, #999);
    font-size: 12px;
  }

  .replay-analysis-empty {
    padding: 12px;
  }

  .replay-turn-map {
    min-height: 0;
    overflow: auto;
    padding: 8px;
  }

  .replay-turn {
    display: grid;
    gap: 5px;
    margin-bottom: 5px;
    padding: 8px;
    border-left: 2px solid transparent;
    background: color-mix(in srgb, var(--button-bg, #252525), transparent 35%);
  }

  .replay-turn.has-issues {
    border-left-color: #ff765f;
  }

  .replay-turn-heading {
    min-width: 0;
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 5px;
    align-items: baseline;
  }

  .replay-turn-heading span,
  .replay-turn-metrics {
    color: var(--muted, #999);
    font-size: 11px;
  }

  .replay-turn-heading strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }

  .replay-turn-heat {
    height: 5px;
    overflow: hidden;
    background: #292d27;
  }

  .replay-turn-heat span {
    display: block;
    width: var(--turn-heat);
    height: 100%;
    background: linear-gradient(90deg, #73b95b, #e6bd4a 62%, #ff675b);
  }

  .replay-turn-metrics,
  .replay-turn-issues {
    display: flex;
    flex-wrap: wrap;
    gap: 3px 8px;
  }

  .replay-turn-issues span {
    padding: 2px 5px;
    border: 1px solid color-mix(in srgb, #ff765f, transparent 55%);
    border-radius: 4px;
    color: #ffad91;
    background: color-mix(in srgb, #ff765f, transparent 88%);
    font-size: 10px;
  }

  .replay-browser {
    display: grid;
    grid-template-rows: auto auto auto auto 1fr;
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
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px;
    padding: 8px;
    border-bottom: 1px solid var(--border, #303030);
  }

  .replay-browser-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px;
    margin: 8px 8px 0;
  }

  .replay-browser-search,
  .replay-browser-controls select {
    min-width: 0;
    padding: 7px 9px;
    border: 1px solid var(--border, #3a3a3a);
    border-radius: 6px;
    color: inherit;
    background: var(--button-bg, #252525);
    font: inherit;
  }

  .replay-browser-controls select {
    max-width: 7.5rem;
    font-size: 12px;
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

  .replay-transcript-stage {
    grid-template-rows: 1fr;
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
    grid-template-columns: auto auto auto minmax(140px, 1fr) auto;
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
  .replay-step,
  .replay-timeline select {
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

  .replay-timeline select {
    min-width: 118px;
    padding: 0 10px;
    font-size: 12px;
  }

  .replay-clock {
    color: var(--muted, #999);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
