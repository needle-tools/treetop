<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { marked } from "marked";
  import ToolIcon from "./ToolIcon.svelte";

  marked.setOptions({ breaks: true, gfm: true });

  function md(text: string | undefined): string {
    if (!text) return "";
    return marked.parse(text, { async: false }) as string;
  }

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
      | "command"
      | "marker";
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
  let lastLoadedAt = 0;
  let pollCount = 0;

  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      const qs = new URLSearchParams({ source });
      const res = await fetch(`/api/session?${qs.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const next = (await res.json()) as NormalizedSession;
      // Force a new identity for the messages array so Svelte's
      // reactivity definitely picks it up.
      session = { ...next, messages: [...next.messages] };
      lastLoadedAt = Date.now();
      pollCount += 1;
      console.debug(
        `[SessionView] poll #${pollCount}: ${session.messages.length} messages`,
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function relTimeFromNow(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 2) return "just now";
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  }

  function roleLabel(role: string): string {
    if (role !== "assistant") return role;
    if (agent === "claude") return "Claude";
    if (agent === "codex") return "Codex";
    if (agent === "copilot") return "Copilot";
    return "assistant";
  }

  function inputPreview(input: unknown): string {
    if (input === undefined) return "";
    let s: string;
    if (typeof input === "string") s = input;
    else {
      try {
        s = JSON.stringify(input);
      } catch {
        s = String(input);
      }
    }
    // Collapse all whitespace so multiline Bash heredocs fit on one line.
    s = s.replace(/\s+/g, " ").trim();
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
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

  // Live sync: dead-simple polling. Every 2s, refetch /api/session.
  // load() guards against overlapping calls and forces a new identity for
  // the messages array so Svelte's reactivity always re-renders. SSE was
  // proving fragile through Vite's proxy; this path is boring and works.

  let pollTimer: number | null = null;

  onMount(() => {
    pollTimer = window.setInterval(() => void load(), 2_000);
  });

  onDestroy(() => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
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
      {#if lastLoadedAt}
        <span
          class="muted small"
          title={`Polled ${pollCount}× since open`}
        >• updated {relTimeFromNow(lastLoadedAt)}</span>
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
            <span
              class="role"
              class:assistant={m.role === "assistant"}
              class:brand-claude={m.role === "assistant" && agent === "claude"}
              class:brand-codex={m.role === "assistant" && agent === "codex"}
              class:brand-copilot={m.role === "assistant" && agent === "copilot"}
            >
              {#if m.role === "assistant" && agent === "claude"}
                <img class="agent-icon" src="/agents/claude.svg" alt="" />
              {:else if m.role === "assistant" && agent === "codex"}
                <span class="agent-icon agent-icon-codex" aria-hidden="true"></span>
              {/if}
              {roleLabel(m.role)}
            </span>
            {#if m.timestamp}
              <span class="muted small">{new Date(m.timestamp).toLocaleString()}</span>
            {/if}
          </div>
          {#each m.blocks as b}
            {#if b.type === "text"}
              <div class="block text md">{@html md(b.text)}</div>
            {:else if b.type === "thinking"}
              <div class="block thinking">
                <span class="tag-label">thinking</span>
                <div class="tag-body md">{@html md(b.text)}</div>
              </div>
            {:else if b.type === "tool_use"}
              <div class="block tool-use">
                <ToolIcon name={b.toolName} />
                <span class="tool-name">{b.toolName ?? "tool"}</span>
                <code class="tool-input" title={inputPreview(b.toolInput)}>
                  {inputPreview(b.toolInput)}
                </code>
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
            {:else if b.type === "marker"}
              <div class="block marker">{b.text}</div>
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
    background: var(--chip-orange-bg);
    color: var(--chip-orange-text);
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
  /* Role differentiation is via the .role label text now; no left bar. */
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
  /* For assistant rows we render the proper agent name (Claude/Codex/...).
     Keep the typographic shape but ditch uppercase so the brand name reads
     as itself, and colour it by brand. */
  .role.assistant {
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.8rem;
  }
  .role.brand-claude {
    color: var(--chip-orange-text);
  }
  .role .agent-icon {
    width: 1em;
    height: 1em;
    vertical-align: -0.12em;
    margin-right: 0.35em;
  }
  /* Codex icon is a PNG-in-SVG too; use it as a CSS mask so the visible
     pixels are painted with currentColor (i.e. the assistant row's brand
     green). Stays in sync with the role colour without re-exporting the
     SVG. */
  .role .agent-icon.agent-icon-codex {
    display: inline-block;
    background-color: currentColor;
    -webkit-mask: url("/agents/codex.svg") no-repeat center / contain;
    mask: url("/agents/codex.svg") no-repeat center / contain;
  }
  .role.brand-codex {
    color: var(--chip-green-text);
  }
  .role.brand-copilot {
    color: var(--chip-blue-text);
  }
  .block.text {
    word-break: break-word;
  }

  /* Markdown rendering. Keep elements quiet enough for a chat density
     (small margins, subtle code chips). */
  .md :global(p) {
    margin: 0.35em 0;
  }
  .md :global(p:first-child) {
    margin-top: 0;
  }
  .md :global(p:last-child) {
    margin-bottom: 0;
  }
  .md :global(code) {
    background: var(--surface-2);
    padding: 0.05em 0.35em;
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.92em;
  }
  .md :global(pre) {
    background: var(--surface-0);
    padding: 0.55em 0.75em;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0.45em 0;
    font-size: 0.82em;
    border: 1px solid var(--surface-2);
  }
  .md :global(pre code) {
    background: transparent;
    padding: 0;
    font-size: inherit;
  }
  .md :global(ul),
  .md :global(ol) {
    padding-left: 1.4em;
    margin: 0.4em 0;
  }
  .md :global(li) {
    margin: 0.15em 0;
  }
  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4) {
    margin: 0.6em 0 0.3em;
    font-weight: 600;
    line-height: 1.3;
  }
  .md :global(h1) {
    font-size: 1.15em;
  }
  .md :global(h2) {
    font-size: 1.05em;
  }
  .md :global(h3),
  .md :global(h4) {
    font-size: 1em;
  }
  .md :global(blockquote) {
    border-left: 2px solid var(--surface-3);
    padding-left: 0.65em;
    color: var(--text-muted);
    margin: 0.4em 0;
  }
  .md :global(a) {
    color: var(--brand);
    text-decoration: none;
  }
  .md :global(a:hover) {
    text-decoration: underline;
  }
  .md :global(hr) {
    border: 0;
    border-top: 1px solid var(--surface-2);
    margin: 0.5em 0;
  }
  .md :global(img) {
    max-width: 100%;
    max-height: 30vh;
    width: auto;
    height: auto;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    display: block;
    margin: 0.4em 0;
    /* alt-text shown if the image fails to load — keep it compact */
    font-size: 0.78em;
    color: var(--text-muted);
  }
  .md :global(table) {
    border-collapse: collapse;
    margin: 0.4em 0;
  }
  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--surface-2);
    padding: 0.25em 0.5em;
    text-align: left;
  }
  .md :global(th) {
    background: var(--surface-2);
    font-weight: 600;
  }
  .block.tool-use {
    margin-top: 0.3rem;
    display: flex;
    gap: 0.45rem;
    align-items: center;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    color: var(--text-3);
    min-width: 0;
  }
  .tool-name {
    color: var(--text-2);
    flex: 0 0 auto;
  }
  .tool-input {
    color: var(--text-muted);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .block.marker {
    margin-top: 0.2rem;
    font-style: italic;
    font-size: 0.75rem;
    color: var(--text-faint);
  }
</style>
