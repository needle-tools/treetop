<script lang="ts">
  import { onMount } from "svelte";
  import { apiUrl } from "./api";
  import { registerSettings, settingValue } from "./settings-registry";
  export let active = false;
  let dialog: HTMLDialogElement;
  let installDialog: HTMLDialogElement;
  let installing = false,
    askedToInstall = false,
    installError = "";
  let installation = { supported: true, received: 0, total: 0, state: "idle" };
  let mounted = false,
    busy = false,
    error = "",
    reason = "Waiting for active work",
    lastCapture = 0;
  let generating = "";
  let days: Array<{
    day: string;
    frames: number;
    complete?: boolean;
    generatedAt?: number;
    error?: string;
  }> = [];
  let folder = "",
    encoder = true,
    supported = true;
  registerSettings({
    id: "timelapse",
    title: "Daily timelapse",
    order: 55,
    settings: [
      {
        key: "timelapse.enabled",
        label: "Record daily timelapses",
        type: "boolean",
        default: false,
        description:
          "Off by default. Save a JPEG of the foreground Treetop window every 10 seconds during active work. Visible terminal text and secrets are included. Export completed days 8 hours after their last screenshot, then remove JPEGs only after both MP4 variants succeed. Downloads an optional encoder on first use (about 20-30 MB). Windows native app required for capture.",
      },
      {
        key: "timelapse.folder",
        label: "Timelapse folder",
        type: "action",
        buttonLabel: "Open folder",
        onInvoke: openFolder,
      },
      {
        key: "timelapse.history",
        label: "Daily timelapses",
        type: "action",
        buttonLabel: "View recordings",
        onInvoke: () => {
          dialog.showModal();
          return refresh();
        },
      },
    ],
  });
  const enabled = settingValue("timelapse.enabled");
  $: if (!$enabled) {
    error = "";
    lastCapture = 0;
    askedToInstall = false;
  }
  $: if (mounted && $enabled) void refresh();
  async function refresh() {
    try {
      const r = await fetch(apiUrl("/api/timelapse"));
      if (!r.ok) throw new Error("Timelapse status is unavailable");
      const body = await r.json();
      days = body.days;
      folder = body.folder;
      encoder = body.encoder;
      supported = body.supported;
      const wasInstalling = installing;
      installation = body.installation ?? installation;
      installing = installation.state === "downloading";
      if (installation.state === "error")
        installError = body.installation.error;
      if (installation.state === "ready" && wasInstalling)
        installDialog.close();
      if ($enabled && !encoder && !askedToInstall) {
        askedToInstall = true;
        installDialog.showModal();
      }
    } catch (e) {
      error = String(e);
    }
  }
  async function installEncoder() {
    installing = true;
    installError = "";
    try {
      const r = await fetch(apiUrl("/api/timelapse/install"), {
        method: "POST",
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Encoder installation failed");
      await refresh();
    } catch (e) {
      installError = String(e);
      installing = false;
    }
  }
  async function cancelInstallation() {
    try {
      const r = await fetch(apiUrl("/api/timelapse/install/cancel"), {
        method: "POST",
      });
      if (!r.ok) throw new Error("Could not cancel encoder installation");
      await refresh();
      installError = "";
    } catch (e) {
      installError = String(e);
    }
  }
  async function generate(day: string, deleteFrames: boolean) {
    generating = day;
    error = "";
    try {
      const r = await fetch(apiUrl("/api/timelapse/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day, deleteFrames }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Timelapse generation failed");
      await refresh();
    } catch (e) {
      error = String(e);
    } finally {
      generating = "";
    }
  }
  async function openFolder() {
    try {
      const r = await fetch(apiUrl("/api/timelapse/open-folder"), {
        method: "POST",
      });
      if (!r.ok) throw new Error("Could not open the timelapse folder");
    } catch (e) {
      error = String(e);
    }
  }
  async function capture() {
    if (
      !$enabled ||
      !encoder ||
      installing ||
      !active ||
      busy ||
      document.hidden ||
      !document.hasFocus()
    )
      return;
    busy = true;
    try {
      const r = await fetch(apiUrl("/api/timelapse/capture"), {
        method: "POST",
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Timelapse capture failed");
      if (body.captured) {
        lastCapture = Date.now();
        reason = "Recording active work";
      } else reason = body.reason ?? "Waiting for active work";
      error = "";
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    mounted = true;
    const timer = setInterval(() => void capture(), 10_000);
    const progressTimer = setInterval(() => {
      if (installing) void refresh();
    }, 1000);
    return () => {
      mounted = false;
      clearInterval(timer);
      clearInterval(progressTimer);
    };
  });
  const video = (day: string, variant: string) =>
    apiUrl(
      `/api/timelapse/video?day=${encodeURIComponent(day)}&variant=${variant}`,
    );
</script>

{#if $enabled || error}
  <button
    class="record-indicator"
    class:recording={!!$enabled && active && !error && lastCapture > 0}
    class:failed={!!error}
    aria-label="Daily timelapses"
    title={(installing
      ? "Timelapse encoder is downloading in the background"
      : installError) ||
      error ||
      (!$enabled
        ? "Timelapse recording is off"
        : !supported
          ? "Capture requires the Windows native app"
          : reason)}
    on:click={() => {
      dialog.showModal();
      void refresh();
    }}><span aria-hidden="true">●</span></button
  >
{/if}
<dialog
  bind:this={dialog}
  on:click={(e) => {
    if (e.target === dialog) dialog.close();
  }}
  on:keydown={(e) => e.stopPropagation()}
>
  <header>
    <h2>Daily timelapses</h2>
    <button aria-label="Close timelapses" on:click={() => dialog.close()}
      >×</button
    >
  </header>
  <p>
    {$enabled ? "Recording is enabled" : "Recording is off"}. Captures stay on
    this computer.
  </p>
  <button on:click={openFolder}>Open timelapse folder</button>
  {#if folder}<small>{folder}</small>{/if}
  {#if !encoder}<p class="warning">
      {installing
        ? "The encoder is downloading in the background."
        : "Install the optional encoder to start recording. Existing screenshots are kept."}
      <button on:click={() => installDialog.showModal()}
        >{installing ? "View download" : "Install encoder..."}</button
      >
    </p>{/if}
  {#if error || installError}<p class="warning" role="alert">
      {error || installError}
    </p>{/if}
  {#each days as day}
    <section>
      <strong>{day.day}</strong><span>{day.frames} frames</span>
      {#if day.complete || day.generatedAt}<a
          href={video(day.day, "crisp")}
          target="_blank"
          rel="noreferrer">Crisp MP4</a
        ><a
          href={video(day.day, "motion-blur")}
          target="_blank"
          rel="noreferrer">Motion blur MP4</a
        >
      {:else}<span>Export 8 hours after last screenshot</span>{/if}
      {#if !day.complete && day.frames > 0}
        <div class="generate-actions">
          <button
            disabled={!encoder || !!generating}
            title="Create both MP4s and keep all screenshots"
            on:click={() => generate(day.day, false)}>Generate preview</button
          >
          <button
            disabled={!encoder || !!generating}
            title="Create both MP4s, then delete their screenshots only after both succeed"
            on:click={() => generate(day.day, true)}>Generate and delete</button
          >
          {#if generating === day.day}<span role="status">Generating...</span
            >{/if}
        </div>
      {/if}
      {#if day.error}<p class="warning">
          {day.error} · JPEGs retained for retry.
        </p>{/if}
    </section>
  {:else}<p>
      No recordings yet. {$enabled
        ? "The first screenshot will appear during active work."
        : "Enable recording in Settings to start."}
    </p>{/each}
</dialog>

<!-- Native dialog top layer keeps installation above Settings and other popovers. -->
<dialog
  bind:this={installDialog}
  aria-label="Install timelapse encoder"
  on:keydown|stopPropagation
>
  <header>
    <h2>Install timelapse encoder</h2>
    <button
      aria-label="Close encoder installer"
      on:click={() => installDialog.close()}>?</button
    >
  </header>
  <p>
    Download FFmpeg once to record and export timelapses. It stays on this
    computer and is reused after restarts. No administrator access is needed.
    Closing this dialog keeps the download running; Cancel download stops it.
  </p>
  <p>
    Download: about {Math.round((installation.total || 30000000) / 1000000)} MB from
    the
    <a
      href="https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1"
      target="_blank"
      rel="noreferrer">FFmpeg static release</a
    >. License and source notices are saved with the encoder.
  </p>
  {#if installing}
    <p role="status">
      Downloading encoder... {Math.round(installation.received / 1000000)} / {Math.round(
        installation.total / 1000000,
      )} MB
    </p>
    <progress max={installation.total || 1} value={installation.received}
    ></progress>
  {/if}
  {#if installError}<p class="warning" role="alert">{installError}</p>{/if}
  {#if !installation.supported}<p class="warning">
      One-click installation is available on Windows x64 and macOS.
    </p>{/if}
  <footer>
    {#if installing}
      <button on:click={cancelInstallation}>Cancel download</button>
      <button on:click={() => installDialog.close()}>Run in background</button>
    {:else}
      <button on:click={() => installDialog.close()}>Not now</button>
      <button disabled={!installation.supported} on:click={installEncoder}
        >Install encoder</button
      >
    {/if}
  </footer>
</dialog>

<style>
  .generate-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  progress {
    width: 100%;
  }
  .record-indicator {
    background: none;
    border: 0;
    padding: 0.25rem;
    color: #888;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .record-indicator.recording {
    color: #eb6868;
    animation: record-pulse 2s ease-in-out infinite;
  }
  .record-indicator.failed {
    color: #d6ac58;
  }
  @keyframes record-pulse {
    50% {
      opacity: 0.45;
    }
  }
  dialog {
    width: min(520px, calc(100vw - 40px));
    max-height: 80vh;
    overflow: auto;
    padding: 1.25rem;
    border: 1px solid var(--surface-2, #555);
    border-radius: 8px;
    background: var(--surface-1, #222);
    color: var(--text-1, #ddd);
  }
  dialog::backdrop {
    background: #0008;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0;
  }
  header button {
    background: none;
    border: 0;
    color: inherit;
    font-size: 1.2rem;
    cursor: pointer;
  }
  p,
  small {
    font-size: 0.8rem;
    color: var(--text-muted, #aaa);
    line-height: 1.5;
  }
  small {
    display: block;
    overflow-wrap: anywhere;
    margin-top: 0.5rem;
  }
  section {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--surface-2, #555);
    font-size: 0.85rem;
  }
  section strong {
    flex: 1;
  }
  section p {
    width: 100%;
    margin: 0;
  }
  a {
    color: var(--needle-green, #9dbe62);
  }
  .warning {
    color: #dbad67;
  }
</style>
