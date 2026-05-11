<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  export let agent: "claude" | "codex" | "copilot" = "claude";
  export let source: string;
  export let onClose: () => void = () => {};

  interface NormalizedBlock {
    type:
      | "text"
      | "thinking"
      | "tool_use"
      | "tool_result"
      | "ide_context"
      | "system_reminder"
      | "command";
    text?: string;
    toolName?: string;
    toolInput?: unknown;
    toolUseId?: string;
    tagName?: string;
  }
  interface NormalizedMessage {
    role: "user" | "assistant" | "system" | "tool";
    blocks: NormalizedBlock[];
    timestamp?: string;
    id?: string;
  }
  interface NormalizedSession {
    agent: string;
    cwd: string;
    sessionId: string;
    startedAt?: string;
    endedAt?: string;
    messages: NormalizedMessage[];
  }

  let session: NormalizedSession | null = null;
  let loading = false;
  let error = "";
  let messagesEl: HTMLElement | null = null;

  async function load() {
    loading = true;
    error = "";
    try {
      const qs = new URLSearchParams({ source });
      const res = await fetch(`/api/session?${qs.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      session = await res.json();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function inputPreview(input: unknown): string {
    if (input === undefined) return "";
    if (typeof input === "string") return input;
    try {
      const s = JSON.stringify(input);
      return s.length > 200 ? s.slice(0, 200) + "…" : s;
    } catch {
      return String(input);
    }
  }

  $: if (source) {
    void load();
  }

  // Scroll to the latest message once the list is populated. Runs again on
  // any session change (e.g. switching to a different agent's session).
  $: if (session && messagesEl) {
    const el = messagesEl;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }

  // Live sync. We do two things in parallel so this works even if the
  // browser's EventSource buffers / drops:
  //   1. Subscribe to /api/stream and refetch on activity events matching
  //      this session's `source`.
  //   2. Poll every 5s as a fallback.
  // Both go through scheduleRefetch which debounces to 250ms.

  let refetchTimer: number | null = null;
  function scheduleRefetch() {
    if (refetchTimer !== null) return;
    refetchTimer = window.setTimeout(() => {
      refetchTimer = null;
      void load();
    }, 250);
  }

  let es: EventSource | null = null;
  let pollTimer: number | null = null;

  function handleActivity(evt: MessageEvent) {
    try {
      const data = JSON.parse(evt.data) as { source?: string };
      if (data.source === source) scheduleRefetch();
    } catch {
      // ignore malformed
    }
  }

  onMount(() => {
    es = new EventSource("/api/stream");
    es.addEventListener("activity", handleActivity);
    // Safety-net polling at 5s. Cheap (cached if unchanged), and rescues
    // us if the SSE listener is silently broken in this browser.
    pollTimer = window.setInterval(() => scheduleRefetch(), 5_000);
  });

  onDestroy(() => {
    if (es) {
      es.removeEventListener("activity", handleActivity);
      es.close();
    }
    if (pollTimer !== null) window.clearInterval(pollTimer);
    if (refetchTimer !== null) window.clearTimeout(refetchTimer);
  });
</script>

<div class="session">
  <header>
    <span class="agent-pill agent-{agent}">{agent}</span>
    {#if session}
      <span class="muted small">{session.messages.length} messages</span>
      {#if session.sessionId}
        <code class="muted small sid" title={session.sessionId}>
          {session.sessionId.slice(0, 8)}
        </code>
      {/if}
    {/if}
    <button class="close" on:click={onClose} title="Close">×</button>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {:else if loading && !session}
    <p class="muted small">Loading session…</p>
  {:else if session && session.messages.length === 0}
    <p class="muted small">No messages parsed from this session.</p>
  {:else if session}
    <ul class="messages" bind:this={messagesEl}>
      {#each session.messages as m}
        <li class="msg role-{m.role}">
          <div class="msg-head">
            <span class="role">{m.role}</span>
            {#if m.timestamp}
              <span class="muted small">{new Date(m.timestamp).toLocaleString()}</span>
            {/if}
          </div>
          {#each m.blocks as b}
            {#if b.type === "text"}
              <div class="block text">{b.text}</div>
            {:else if b.type === "thinking"}
              <div class="block thinking">
                <span class="tag-label">thinking</span>
                <span class="tag-body">{b.text}</span>
              </div>
            {:else if b.type === "tool_use"}
              <div class="block tool-use">
                <span class="tool-name">{b.toolName ?? "tool"}</span>
                <code class="tool-input">{inputPreview(b.toolInput)}</code>
              </div>
            {:else if b.type === "tool_result"}
              <div class="block tool-result">
                <span class="muted small">result</span>
                <pre>{b.text ?? ""}</pre>
              </div>
            {:else if b.type === "ide_context"}
              <div class="block ide-context" title={b.tagName}>
                <span class="tag-label">IDE · {b.tagName ?? "context"}</span>
                <span class="tag-body">{b.text}</span>
              </div>
            {:else if b.type === "system_reminder"}
              <div class="block sys-reminder" title={b.tagName}>
                <span class="tag-label">system reminder</span>
                <span class="tag-body">{b.text}</span>
              </div>
            {:else if b.type === "command"}
              <div class="block command" title={b.tagName}>
                <span class="tag-label">{b.tagName ?? "command"}</span>
                <span class="tag-body">{b.text}</span>
              </div>
            {/if}
          {/each}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .session {
    margin-top: 0.5rem;
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md);
    background: var(--surface-1);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2);
    /* Border was the same color as background; use a lighter shade so the
       split between header and messages is actually visible. */
    border-bottom: 1px solid var(--surface-3);
  }
  .agent-pill {
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    text-transform: lowercase;
    font-family: ui-monospace, monospace;
  }
  .agent-pill.agent-claude {
    background: var(--chip-purple-bg);
    color: var(--chip-purple-text);
  }
  .agent-pill.agent-codex {
    background: var(--chip-green-bg);
    color: var(--chip-green-text);
  }
  .agent-pill.agent-copilot {
    background: var(--chip-blue-bg);
    color: var(--chip-blue-text);
  }
  .sid {
    font-family: ui-monospace, monospace;
  }
  .close {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    padding: 0.1rem 0.5rem;
    font-size: 1rem;
    cursor: pointer;
  }
  .close:hover {
    background: var(--error-bg);
    color: var(--error-text);
  }
  .error {
    color: var(--error-text);
    padding: 0.5rem 0.75rem;
    margin: 0;
  }
  .muted {
    color: var(--text-muted);
  }
  .small {
    font-size: 0.75rem;
  }
  .messages {
    list-style: none;
    padding: 0.4rem 0.5rem;
    margin: 0;
    max-height: 50vh;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .msg {
    padding: 0.45rem 0.6rem;
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    border: 1px solid var(--surface-2);
    font-size: 0.82rem;
  }
  .msg.role-user {
    border-left: 3px solid var(--chip-blue-text);
  }
  .msg.role-assistant {
    border-left: 3px solid var(--chip-purple-text);
  }
  .msg-head {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-bottom: 0.3rem;
  }
  .role {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.7rem;
    color: var(--text-muted);
    font-weight: 600;
  }
  .block.text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .block.tool-use {
    margin-top: 0.3rem;
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    color: var(--chip-orange-text);
  }
  .tool-name {
    font-weight: 600;
  }
  .tool-input {
    color: var(--text-3);
    overflow-wrap: anywhere;
  }
  .block.tool-result {
    margin-top: 0.3rem;
  }
  .block.tool-result pre {
    margin: 0.2rem 0 0;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: var(--text-3);
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
  }
  .block.ide-context,
  .block.sys-reminder,
  .block.command {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
    font-size: 0.72rem;
    line-height: 1.4;
  }
  .tag-label {
    flex: 0 0 auto;
    font-family: ui-monospace, monospace;
    text-transform: lowercase;
    font-weight: 600;
    color: var(--text-muted);
  }
  .tag-body {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .block.ide-context {
    background: rgba(37, 99, 235, 0.08);
  }
  .block.ide-context .tag-label {
    color: var(--chip-blue-text);
  }
  .block.sys-reminder {
    background: rgba(217, 119, 6, 0.08);
  }
  .block.sys-reminder .tag-label {
    color: var(--chip-orange-text);
  }
  .block.command {
    background: rgba(22, 163, 74, 0.08);
  }
  .block.command .tag-label {
    color: var(--chip-green-text);
  }
  .block.thinking {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin-top: 0.25rem;
    padding: 0.25rem 0.5rem;
    background: rgba(160, 160, 160, 0.06);
    border-radius: var(--radius-sm);
    font-style: italic;
    color: var(--text-muted);
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .block.thinking .tag-body {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
</style>
