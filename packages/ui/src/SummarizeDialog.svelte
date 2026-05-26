<script lang="ts">
  /**
   * Modal dialog that ships a session through a local Ollama model
   * and streams the summary back. Opened from SessionView's burger
   * menu via `summarize-dialog.ts`'s store, the same pattern
   * `ConfirmDialog` uses.
   *
   * States walked through in one open:
   *   probing  → look up cached summary + installed models in parallel
   *   cached   → an unstale summary exists; show it with Copy/Refresh/Delete
   *   stale    → summary exists but the source has new turns
   *   install  → no model installed; offer to `ollama pull` a small one
   *   pulling  → SSE progress lines from `ollama pull`
   *   ready    → no summary, model picked; user clicks Generate
   *   running  → SSE chunks from /api/sessions/summarize accumulating
   *   error    → terminal state, show the error and a Retry
   *
   * The state-machine flag is `state`; transitions are local to this
   * component so the surrounding session column doesn't have to
   * juggle them.
   */
  import { onDestroy, onMount } from "svelte";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import { activeSummarize } from "./summarize-dialog";

  marked.setOptions({ breaks: true, gfm: true });

  type State = "probing" | "cached" | "install" | "pulling" | "ready" | "running" | "error";

  interface Frontmatter {
    source: string;
    agent: string;
    sessionId?: string;
    model: string;
    sourceMtimeMs: number;
    generatedAt: string;
    includedMessages: number;
    totalMessages: number;
    truncatedMessages: number;
    estimatedTokens: number;
    elapsedMs: number;
  }
  interface CachedResponse {
    summary: { frontmatter: Frontmatter; body: string } | null;
    stale?: boolean;
  }
  interface ModelInfo {
    name: string;
    size?: number;
    parameterSize?: string;
  }

  /** Default suggestion if no model is installed. Configurable via
   *  the daemon's SUPERGIT_SUMMARIZE_DEFAULT env var (the picker
   *  prefers a value from there when present). */
  const DEFAULT_MODEL_TO_INSTALL = "llama3.2:3b";

  let state: State = "probing";
  let source = "";
  let models: ModelInfo[] = [];
  let cached: { frontmatter: Frontmatter; body: string } | null = null;
  let stale = false;
  /** Live body — either the cached body, or what we've streamed so far. */
  let body = "";
  /** Diagnostics for the footer once we have any. */
  let meta: {
    model?: string;
    totalMessages?: number;
    includedMessages?: number;
    truncatedMessages?: number;
    estimatedTokens?: number;
    elapsedMs?: number;
  } | null = null;
  let chosenModel = "";
  let errorMsg = "";
  let pullLines: string[] = [];
  let copyFlash = false;
  let aborter: AbortController | null = null;

  $: req = $activeSummarize;
  $: if (req) {
    void open(req.source);
  }

  function smallestNonEmbed(list: ModelInfo[]): string | undefined {
    const usable = list.filter((m) => {
      const name = m.name.toLowerCase();
      return !name.endsWith("-embed") && !name.endsWith(":embed");
    });
    if (usable.length === 0) return undefined;
    usable.sort((a, b) => (a.size ?? Number.MAX_SAFE_INTEGER) - (b.size ?? Number.MAX_SAFE_INTEGER));
    return usable[0]?.name;
  }

  function pickDefault(list: ModelInfo[]): string | undefined {
    const remembered = localStorage.getItem("supergit:summarize:lastModel");
    if (remembered && list.some((m) => m.name === remembered)) return remembered;
    if (list.some((m) => m.name === DEFAULT_MODEL_TO_INSTALL)) {
      return DEFAULT_MODEL_TO_INSTALL;
    }
    return smallestNonEmbed(list);
  }

  async function open(src: string): Promise<void> {
    source = src;
    state = "probing";
    body = "";
    cached = null;
    stale = false;
    meta = null;
    errorMsg = "";
    pullLines = [];
    chosenModel = "";

    const qs = new URLSearchParams({ source: src });
    const [cachedRes, modelsRes] = await Promise.allSettled([
      fetch(`/api/sessions/summarize?${qs.toString()}`).then((r) => r.json() as Promise<CachedResponse>),
      fetch(`/api/ollama/models`).then((r) => r.json() as Promise<{ models?: ModelInfo[] }>),
    ]);
    models = (modelsRes.status === "fulfilled" ? modelsRes.value.models ?? [] : []) ?? [];
    const cachedBody = cachedRes.status === "fulfilled" ? cachedRes.value : null;
    if (cachedBody && cachedBody.summary) {
      cached = cachedBody.summary;
      stale = cachedBody.stale === true;
      body = cached.body;
      meta = {
        model: cached.frontmatter.model,
        totalMessages: cached.frontmatter.totalMessages,
        includedMessages: cached.frontmatter.includedMessages,
        truncatedMessages: cached.frontmatter.truncatedMessages,
        estimatedTokens: cached.frontmatter.estimatedTokens,
        elapsedMs: cached.frontmatter.elapsedMs,
      };
      chosenModel = cached.frontmatter.model;
      state = "cached";
      return;
    }
    if (models.length === 0) {
      state = "install";
      return;
    }
    chosenModel = pickDefault(models) ?? models[0]?.name ?? "";
    state = "ready";
  }

  function close(): void {
    aborter?.abort();
    activeSummarize.set(null);
  }

  function onOverlayKeydown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    }
  }

  async function copySummary(): Promise<void> {
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body);
      copyFlash = true;
      setTimeout(() => (copyFlash = false), 1200);
    } catch {
      // user-visible failure surface is omitted — clipboard denial
      // is rare on localhost and the user can still select+copy.
    }
  }

  async function deleteSummary(): Promise<void> {
    if (!source) return;
    const qs = new URLSearchParams({ source });
    await fetch(`/api/sessions/summarize?${qs.toString()}`, { method: "DELETE" });
    // After delete, drop back to ready (or install if no models).
    cached = null;
    stale = false;
    body = "";
    meta = null;
    if (models.length === 0) state = "install";
    else state = "ready";
  }

  async function runSummary(): Promise<void> {
    if (!chosenModel || !source) return;
    state = "running";
    body = "";
    errorMsg = "";
    localStorage.setItem("supergit:summarize:lastModel", chosenModel);
    aborter = new AbortController();
    try {
      const res = await fetch("/api/sessions/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, model: chosenModel }),
        signal: aborter.signal,
      });
      if (!res.ok || !res.body) {
        errorMsg = `HTTP ${res.status} ${res.statusText}`;
        state = "error";
        return;
      }
      await consumeSse(res.body);
      // On clean SSE close, reload the cached payload so the
      // "cached" view reflects the same data the server persisted.
      const qs = new URLSearchParams({ source });
      const refresh = await fetch(`/api/sessions/summarize?${qs.toString()}`)
        .then((r) => r.json() as Promise<CachedResponse>)
        .catch(() => null);
      if (refresh?.summary) {
        cached = refresh.summary;
        stale = refresh.stale === true;
      }
      // `state` may have been mutated to "error" by handleSseFrame's
      // closure during the stream — cast widens the narrowed type
      // so the comparison stays correct.
      if ((state as State) !== "error") state = "cached";
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      errorMsg = e instanceof Error ? e.message : String(e);
      state = "error";
    }
  }

  async function consumeSse(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        handleSseFrame(frame);
      }
    }
  }

  function handleSseFrame(frame: string): void {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "meta") {
      meta = payload as typeof meta;
    } else if (event === "chunk") {
      body += (payload as { delta?: string }).delta ?? "";
    } else if (event === "done") {
      const p = payload as { elapsedMs?: number };
      meta = { ...(meta ?? {}), elapsedMs: p.elapsedMs };
    } else if (event === "error") {
      errorMsg = (payload as { message?: string }).message ?? "Ollama error";
      state = "error";
    }
  }

  async function installAndRun(): Promise<void> {
    state = "pulling";
    pullLines = [];
    errorMsg = "";
    aborter = new AbortController();
    try {
      const res = await fetch("/api/ollama/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: DEFAULT_MODEL_TO_INSTALL }),
        signal: aborter.signal,
      });
      if (!res.ok || !res.body) {
        errorMsg = `Install failed (HTTP ${res.status} ${res.statusText})`;
        state = "error";
        return;
      }
      await consumePullSse(res.body);
      if ((state as State) === "error") return;
      // Re-fetch the models list so the picker reflects the install.
      const list = await fetch(`/api/ollama/models`)
        .then((r) => r.json() as Promise<{ models?: ModelInfo[] }>)
        .catch(() => ({ models: [] as ModelInfo[] }));
      models = list.models ?? [];
      chosenModel = DEFAULT_MODEL_TO_INSTALL;
      await runSummary();
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      errorMsg = e instanceof Error ? e.message : String(e);
      state = "error";
    }
  }

  async function consumePullSse(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          const payload = JSON.parse(data) as { line?: string; message?: string };
          if (event === "progress" && payload.line) {
            pullLines = [...pullLines, payload.line].slice(-20);
          } else if (event === "error") {
            errorMsg = payload.message ?? "ollama pull failed";
            state = "error";
            return;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  function md(text: string): string {
    if (!text) return "";
    return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
  }

  function formatTokens(n: number | undefined): string {
    if (typeof n !== "number") return "—";
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  }

  function formatElapsed(ms: number | undefined): string {
    if (typeof ms !== "number") return "—";
    return `${(ms / 1000).toFixed(1)}s`;
  }

  onDestroy(() => {
    aborter?.abort();
  });
</script>

<svelte:window on:keydown={onOverlayKeydown} />

{#if req}
  <div class="overlay" on:click={close} role="presentation">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="summarize-title"
      on:click|stopPropagation
    >
      <header class="header">
        <h2 id="summarize-title">Summarize with Ollama</h2>
        <button type="button" class="close" on:click={close} aria-label="Close">×</button>
      </header>

      {#if state === "probing"}
        <div class="body status">Loading…</div>
      {:else if state === "install"}
        <div class="body">
          <p>
            No local Ollama model is installed. Install
            <code>{DEFAULT_MODEL_TO_INSTALL}</code> (~2 GB)?
          </p>
          <p class="muted">
            Models run entirely on your machine; nothing leaves it.
          </p>
        </div>
        <footer class="actions">
          <button type="button" class="btn" on:click={close}>Cancel</button>
          <button type="button" class="btn primary" on:click={installAndRun}>Install &amp; summarize</button>
        </footer>
      {:else if state === "pulling"}
        <div class="body pulling">
          <p class="muted">Downloading <code>{DEFAULT_MODEL_TO_INSTALL}</code>…</p>
          <pre class="log">{pullLines.join("\n")}</pre>
        </div>
        <footer class="actions">
          <button type="button" class="btn" on:click={close}>Cancel — already-downloaded chunks are kept</button>
        </footer>
      {:else if state === "ready" || state === "running" || state === "cached" || state === "error"}
        <div class="picker">
          <label>
            Model
            <select bind:value={chosenModel} disabled={state === "running"}>
              {#each models as m (m.name)}
                <option value={m.name}>{m.name}{m.parameterSize ? ` · ${m.parameterSize}` : ""}</option>
              {/each}
            </select>
          </label>
          {#if state === "cached" && stale}
            <span class="badge stale" title="Source session has new turns since this summary was generated">Stale</span>
          {:else if state === "cached"}
            <span class="badge ok">Cached</span>
          {/if}
        </div>
        <div class="body summary">
          {#if state === "error"}
            <p class="error">{errorMsg}</p>
          {:else if body}
            {@html md(body)}
          {:else if state === "running"}
            <p class="muted">Generating…</p>
          {:else}
            <p class="muted">Click <strong>Generate</strong> to summarize {meta?.totalMessages ?? "this session"}.</p>
          {/if}
        </div>
        {#if meta}
          <div class="meta">
            {#if meta.includedMessages !== undefined && meta.totalMessages !== undefined}
              Summarized {meta.includedMessages} / {meta.totalMessages} messages
            {/if}
            {#if meta.truncatedMessages !== undefined && meta.truncatedMessages > 0}
              · {meta.truncatedMessages} clipped
            {/if}
            {#if meta.estimatedTokens !== undefined}
              · ~{formatTokens(meta.estimatedTokens)} tokens
            {/if}
            {#if meta.elapsedMs !== undefined}
              · {formatElapsed(meta.elapsedMs)}
            {/if}
          </div>
        {/if}
        <footer class="actions">
          <button type="button" class="btn" on:click={close}>Close</button>
          {#if state === "cached" || state === "error"}
            <button type="button" class="btn" on:click={deleteSummary} disabled={!cached}>Delete</button>
            <button type="button" class="btn" on:click={copySummary} disabled={!body}>
              {copyFlash ? "✓ Copied" : "Copy"}
            </button>
            <button type="button" class="btn primary" on:click={runSummary} disabled={!chosenModel}>
              {cached ? "Refresh" : "Generate"}
            </button>
          {:else if state === "running"}
            <button type="button" class="btn" on:click={() => { aborter?.abort(); state = "ready"; }}>Stop</button>
          {:else}
            <button type="button" class="btn primary" on:click={runSummary} disabled={!chosenModel}>Generate</button>
          {/if}
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }
  .dialog {
    width: min(680px, 92vw);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: var(--surface-1);
    color: var(--text-1, inherit);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.7rem 1rem;
    border-bottom: 1px solid var(--surface-2);
  }
  .header h2 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .close {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-size: 1.2rem;
    cursor: pointer;
    line-height: 1;
  }
  .close:hover { color: var(--text-1); }
  .picker {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--surface-2);
    font-size: 0.82rem;
  }
  .picker label {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
  }
  .picker select {
    background: var(--surface-2);
    color: inherit;
    border: 1px solid var(--surface-3, var(--surface-2));
    border-radius: var(--radius-sm, 4px);
    padding: 0.2rem 0.4rem;
    font: inherit;
    font-size: 0.82rem;
  }
  .badge {
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    border: 1px solid transparent;
  }
  .badge.ok {
    background: color-mix(in srgb, var(--status-clean, #2ecc71) 22%, transparent);
    color: var(--status-clean, #2ecc71);
    border-color: color-mix(in srgb, var(--status-clean, #2ecc71) 35%, transparent);
  }
  .badge.stale {
    background: color-mix(in srgb, #d9822b 22%, transparent);
    color: #d9822b;
    border-color: color-mix(in srgb, #d9822b 35%, transparent);
  }
  .body {
    flex: 1 1 auto;
    overflow: auto;
    padding: 0.9rem 1rem;
    font-size: 0.88rem;
    line-height: 1.55;
  }
  .body.status { color: var(--text-muted); }
  .body p { margin: 0 0 0.7rem; }
  .body .muted { color: var(--text-muted); }
  .body .error { color: #e74c3c; }
  .body code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--surface-2);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
  .summary :global(p) { margin: 0 0 0.7rem; }
  .summary :global(ul),
  .summary :global(ol) { margin: 0 0 0.7rem 1.2rem; }
  .summary :global(li) { margin: 0.15rem 0; }
  .pulling .log {
    background: var(--surface-2);
    color: var(--text-2, var(--text-muted));
    border-radius: var(--radius-sm, 4px);
    padding: 0.5rem 0.7rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    max-height: 14rem;
    overflow: auto;
    white-space: pre-wrap;
  }
  .meta {
    padding: 0.4rem 1rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    border-top: 1px solid var(--surface-2);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.7rem 1rem;
    border-top: 1px solid var(--surface-2);
  }
  .btn {
    font: inherit;
    font-size: 0.82rem;
    padding: 0.35rem 0.8rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .btn.primary {
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .btn.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text-muted) 30%, transparent);
  }
</style>
