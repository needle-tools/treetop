<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { marked } from "marked";
  import ToolIcon from "./ToolIcon.svelte";

  marked.setOptions({ breaks: true, gfm: true });

  // Make every link open in a new tab. We're a desktop-style dashboard —
  // following a link inside the chat panel would replace the whole UI.
  // Applies to both [text](url) and bare-URL autolinks (gfm enables those).
  marked.use({
    renderer: {
      link(token: { href: string; title?: string | null; text: string }) {
        const href = token.href ?? "";
        const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
        return `<a href="${escapeAttr(href)}"${title} target="_blank" rel="noopener noreferrer">${token.text}</a>`;
      },
    },
  });

  function escapeAttr(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function md(text: string | undefined): string {
    if (!text) return "";
    // Claude wraps pasted/screenshotted attachments as
    //   [Image: source: /abs/path/to/file.png]
    // Convert those to markdown images pointing at /api/image so they
    // render inline in the chat (with our 30vh height cap).
    const processed = text.replace(
      /\[Image:\s*source:\s*([^\]]+?\.(?:png|jpe?g|gif|webp|svg|bmp))\s*\]/gi,
      (_match, filePath) => {
        const url = `/api/image?path=${encodeURIComponent(filePath.trim())}`;
        return `![pasted image](${url})`;
      },
    );
    return marked.parse(processed, { async: false }) as string;
  }

  export let agent: "claude" | "codex" | "copilot" = "claude";
  export let source: string;
  export let onClose: () => void = () => {};
  export let onDragStart: (e: DragEvent) => void = () => {};

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
  // Track whether we've already shown a session at least once. First render
  // = scroll to bottom. Subsequent renders = only auto-scroll if the user
  // was already near the bottom (so polling can't snatch them away when
  // they've scrolled up to read history).
  let hasRenderedOnce = false;

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

  function relTimeFromIso(iso: string): string {
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 120) return "1 minute ago";
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return "1 hour ago";
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    if (s < 172800) return "yesterday";
    return `${Math.floor(s / 86400)} days ago`;
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

  // Scroll-to-bottom policy:
  //   - First render (right after open or after switching sessions): jump
  //     to the newest message so you see "now".
  //   - Subsequent renders (the 2-second poll): only scroll if the user is
  //     already pinned near the bottom. If they've scrolled up to read
  //     history, we must not yank them back down.
  $: if (session && messagesEl) {
    const el = messagesEl;
    const NEAR = 64;
    const wasNearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
    const shouldStick = !hasRenderedOnce || wasNearBottom;
    if (shouldStick) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
    hasRenderedOnce = true;
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
  <header draggable="true" on:dragstart={(e) => onDragStart(e)}>
    <div class="header-main">
      <span class="agent-pill agent-{agent}">{agent}</span>
      <div class="header-content">
        {#if session}
          <span class="muted small">{session.messages.length} messages</span>
          {#if session.sessionId}
            <code class="muted small sid" title={session.sessionId}>
              {session.sessionId.slice(0, 8)}
            </code>
          {/if}
          {#if session.endedAt}
            <span
              class="muted small last-activity"
              title={`Last message ${new Date(session.endedAt).toLocaleString()}\nPolled ${pollCount}× since open${lastLoadedAt ? ` (most recent ${relTimeFromNow(lastLoadedAt)})` : ""}`}
            >last activity {relTimeFromIso(session.endedAt)}</span>
          {/if}
        {/if}
      </div>
    </div>
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
                <!-- Inlined so fill="currentColor" inherits the assistant
                     row's brand-green colour. Real vector this time
                     (codex2.svg) — single path. -->
                <svg
                  class="agent-icon agent-svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M22.282 9.821a6 6 0 0 0-.516-4.91 6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9 6.05 6.05 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206 6 6 0 0 0 3.997-2.9 6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023-.141-.085-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" />
                </svg>
              {/if}
              {roleLabel(m.role)}
            </span>
            {#if m.timestamp}
              <span
                class="muted small"
                title={new Date(m.timestamp).toLocaleString()}
              >
                {relTimeFromIso(m.timestamp)}
              </span>
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
    /* Outer header: keeps the × pinned to the right at any width. The
       wrappable items live in .header-main inside, so when the column
       gets narrow, last-activity flows onto a new row under the count
       — but × stays put. */
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    background: var(--surface-2);
    border-bottom: 1px solid var(--surface-3);
    cursor: grab;
    user-select: none;
  }
  header:active {
    cursor: grabbing;
  }
  .header-main {
    /* 2-column grid: agent pill stays in column 1; everything else
       (messages count, sid, last-activity) wraps inside column 2. So when
       last-activity bumps to a new row it aligns under "122 messages" —
       not under the agent pill. */
    flex: 1 1 0;
    min-width: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: start;
    gap: 0 0.5rem;
    line-height: 1.1;
  }
  .header-main > .agent-pill {
    align-self: start;
  }
  .header-content {
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.15rem 0.5rem;
    line-height: 1.1;
  }
  .header-content > * {
    /* Each item's own text doesn't wrap; the item itself can wrap to a
       new flex row inside .header-content when the column is tight. */
    white-space: nowrap;
    flex: 0 0 auto;
    line-height: 1.1;
  }
  .header-content .last-activity {
    /* last-activity is the longest item, so it's the one that wraps
       first when space runs out. flex: 1 1 auto lets it stretch on
       its row before wrapping. */
    flex: 1 1 auto;
  }
  header .close {
    flex: 0 0 auto;
    align-self: flex-start;
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
    background: var(--chip-codex-bg);
    color: var(--chip-codex-text);
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
  .role .agent-icon.agent-svg {
    /* Inline-SVG icon: fill="currentColor" inherits the role's text color. */
    display: inline-block;
  }
  .role.brand-codex {
    color: var(--chip-codex-text);
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
