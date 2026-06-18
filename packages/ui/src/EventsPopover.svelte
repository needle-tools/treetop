<script lang="ts">
  import { createEventDispatcher, onDestroy } from "svelte";
  import Popover from "./Popover.svelte";
  import { apiUrl } from "./api";
  import { errorKindLabel, eventToText } from "./event-format";
  import { relTime } from "./display-helpers";
  import type { FrontendErrorEntry } from "./errors";
  export let errorEntries: FrontendErrorEntry[];
  const dispatch = createEventDispatcher();
  /** id -> true when the user has expanded its stack trace inline. */
  let errorExpanded: Record<string, boolean> = {};
  function toggleErrorExpanded(id: string) {
    errorExpanded = { ...errorExpanded, [id]: !errorExpanded[id] };
  }
  /** id of the event whose Copy button is flashing "Copied". */
  let copiedErrorId: string | null = null;
  let copiedErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let analyzeBusy = false;
  let analyzeJson = "";
  let analyzeError = "";
  let analyzeCopied = false;
  let analyzeCopiedTimer: ReturnType<typeof setTimeout> | null = null;
  function flashCopied(id: string) {
    copiedErrorId = id;
    if (copiedErrorTimer) clearTimeout(copiedErrorTimer);
    copiedErrorTimer = setTimeout(() => {
      copiedErrorId = null;
      copiedErrorTimer = null;
    }, 1200);
  }
  function flashAnalyzeCopied() {
    analyzeCopied = true;
    if (analyzeCopiedTimer) clearTimeout(analyzeCopiedTimer);
    analyzeCopiedTimer = setTimeout(() => {
      analyzeCopied = false;
      analyzeCopiedTimer = null;
    }, 1200);
  }
  /** Robust clipboard write — the async Clipboard API is silently
   *  rejected in WebView2 / strict-Permissions contexts even under a
   *  trusted gesture, so we fall back to a transient offscreen textarea
   *  + execCommand("copy"). Same pattern as TerminalView.svelte. Only
   *  flash "Copied" once a write actually lands. */
  function copyText(text: string, onCopied: () => void, label: string) {
    const tryLegacy = (): boolean => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText =
          "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(ta);
        const prev = document.activeElement as HTMLElement | null;
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        try {
          prev?.focus();
        } catch {
          /* best-effort restore */
        }
        return ok;
      } catch {
        return false;
      }
    };
    const writeText = navigator.clipboard?.writeText;
    if (writeText) {
      writeText.call(navigator.clipboard, text).then(onCopied, () => {
        if (tryLegacy()) onCopied();
        else console.warn(`supergit: clipboard write failed (${label})`);
      });
      return;
    }
    if (tryLegacy()) onCopied();
    else console.warn(`supergit: clipboard write failed (${label})`);
  }
  function copyError(e: FrontendErrorEntry) {
    copyText(eventToText(e), () => flashCopied(e.id), "event copy");
  }
  function copyAnalyzeJson() {
    if (!analyzeJson) return;
    copyText(analyzeJson, flashAnalyzeCopied, "diagnostic analyze copy");
  }
  async function analyzeServer() {
    if (analyzeBusy) return;
    analyzeBusy = true;
    analyzeError = "";
    try {
      const res = await fetch(apiUrl("/api/debug/analyze"), {
        cache: "no-cache",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          body && typeof body.error === "string"
            ? body.error
            : `/api/debug/analyze: ${res.status}`,
        );
      }
      analyzeJson = JSON.stringify(body, null, 2);
    } catch (err) {
      analyzeError = err instanceof Error ? err.message : String(err);
    } finally {
      analyzeBusy = false;
    }
  }
  // Preserve the SSE error_clear behavior locally: when the list empties
  // (cleared via Clear button or the daemon's error_clear broadcast),
  // drop the stale expand-state — mirrors App's old `errorExpanded = {}`.
  $: if (errorEntries.length === 0) errorExpanded = {};
  onDestroy(() => {
    if (copiedErrorTimer) clearTimeout(copiedErrorTimer);
    if (analyzeCopiedTimer) clearTimeout(analyzeCopiedTimer);
  });
</script>

<Popover variant="actions" extraClass="events-popover" unclamped>
  <svelte:fragment slot="head">
    Events
    {#if errorEntries.length > 0}
      <button
        class="undo events-clear"
        on:click={() => dispatch("clear")}
        title="Clear the recorded error log">Clear</button
      >
    {/if}
  </svelte:fragment>
  {#if errorEntries.length === 0}
    <p class="muted small nopad">No errors. 🎉</p>
  {:else}
    <ul class="events err-list">
      {#each errorEntries.slice(0, 50) as e (e.id)}
        <li>
          <div
            class="err-row"
            class:expanded={errorExpanded[e.id]}
            role="button"
            tabindex="0"
            on:click={() => toggleErrorExpanded(e.id)}
            on:keydown={(ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                toggleErrorExpanded(e.id);
              }
            }}
          >
            <span class="err-kind err-kind-{e.kind}">{errorKindLabel(e)}</span>
            <span class="err-msg" title={e.message}>
              {e.message}
              {#if e.count && e.count > 1}
                <span class="err-count" title={`${e.count} occurrences`}
                  >× {e.count}</span
                >
              {/if}
            </span>
            <button
              class="err-copy"
              title="Copy this event to the clipboard"
              on:click|stopPropagation={() => copyError(e)}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path
                  d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                />
              </svg>
              {copiedErrorId === e.id ? "Copied" : "Copy"}
            </button>
            <span class="muted ev-time">{relTime(e.timestamp)}</span>
          </div>
          {#if errorExpanded[e.id]}
            <div class="err-detail">
              <div class="err-meta">
                <span
                  class="actor actor-{e.source === 'daemon'
                    ? 'supergit'
                    : 'user'}">{e.source}</span
                >
                {#if e.method || e.route}
                  <code class="err-route">{e.method ?? ""} {e.route ?? ""}</code
                  >
                {/if}
                {#if e.status !== undefined}
                  <span class="err-status">{e.status}</span>
                {/if}
              </div>
              {#if e.stack}
                <pre class="err-stack">{e.stack}</pre>
              {/if}
              {#if e.extra && Object.keys(e.extra).length > 0}
                <pre class="err-stack">{JSON.stringify(e.extra, null, 2)}</pre>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <div class="events-analyze">
    <div class="events-analyze-actions">
      <button
        class="undo events-analyze-btn"
        disabled={analyzeBusy}
        on:click={analyzeServer}
        title="Collect and log a bounded daemon diagnostic JSON report"
      >
        {analyzeBusy ? "Analyzing..." : "Analyze"}
      </button>
      {#if analyzeJson}
        <button
          class="err-copy events-analyze-copy"
          on:click={copyAnalyzeJson}
          title="Copy the diagnostic JSON"
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {analyzeCopied ? "Copied" : "Copy JSON"}
        </button>
      {/if}
    </div>
    {#if analyzeError}
      <p class="muted small events-analyze-error">{analyzeError}</p>
    {/if}
    {#if analyzeJson}
      <pre class="events-analyze-json">{analyzeJson}</pre>
    {/if}
  </div>
</Popover>
