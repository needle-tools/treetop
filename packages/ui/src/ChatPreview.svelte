<script lang="ts">
  /**
   * Renders a "what's happening in this session" preview — the last
   * few user/assistant messages plus inline tool chips and "+N
   * messages" gap pills. Pure presentation: a parent passes in the
   * already-built `items` list (use `buildPreviewItems` from
   * `preview-action.ts`) plus the agent kind so role labels can show
   * the right brand icon.
   *
   * Originally extracted from `SessionDock.svelte`'s side panel so
   * the same look can be reused for linked-session cards and the
   * hover preview on the "sessions in this worktree" list, without
   * forking the bubble styles.
   */
  import ToolIcon from "./ToolIcon.svelte";
  import type {
    PreviewAction,
    PreviewGap,
    PreviewMsg,
  } from "./preview-action";

  type PreviewItem = PreviewMsg | PreviewGap | PreviewAction;

  /** Items to render. `undefined` means "not loaded yet" → show the
   *  spinner when `loading` is true, otherwise nothing. An empty
   *  array means "loaded, but no messages" → the empty state. */
  export let items: PreviewItem[] | undefined = undefined;
  /** Drives the agent icon next to assistant role captions. */
  export let agent: "claude" | "codex" | "copilot" | "ollama" | "shell" | undefined = undefined;
  /** Surfaces a spinner row when items are not yet cached. */
  export let loading: boolean = false;

  function snippet(text: string): string {
    if (text.length <= 240) return text;
    return text.slice(0, 239) + "…";
  }

  function relTime(iso?: string): string {
    if (!iso) return "";
    const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return "just now";
    if (s < 120) return "1 minute ago";
    if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
    if (s < 7200) return "1 hour ago";
    if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
    if (s < 172800) return "yesterday";
    return `${Math.floor(s / 86400)} days ago`;
  }
</script>

<div class="chat-preview">
  {#if items}
    {#if items.length === 0}
      <div class="chat-preview-empty muted">No messages yet.</div>
    {:else}
      {#each items as item}
        {#if item.kind === "action"}
          <div class="chat-preview-action">
            <ToolIcon name={item.toolName} />
            <span class="chat-preview-action-name">{item.toolName}</span>
            {#if item.detail}
              <span class="chat-preview-action-detail">{item.detail}</span>
            {/if}
          </div>
        {:else if item.kind === "msg"}
          <div
            class="chat-preview-msg chat-preview-role-{item.role}"
            class:chat-preview-older={item.role === "assistant" && item.older}
          >
            <span class="chat-preview-head">
              <span class="chat-preview-role">
                {#if item.role === "assistant" && (agent === "claude" || agent === "codex")}
                  <img
                    class="chat-preview-agent-icon"
                    src="/agents/{agent}.svg"
                    alt=""
                    aria-hidden="true"
                  />
                {/if}
                {item.role === "assistant" ? (agent ?? "assistant") : item.role}
              </span>
              {#if item.timestamp}
                <span class="chat-preview-time">· {relTime(item.timestamp)}</span>
              {/if}
            </span>
            <span class="chat-preview-text">{snippet(item.text)}</span>
          </div>
        {:else}
          <div class="chat-preview-gap">+ {item.count} message{item.count === 1 ? "" : "s"}</div>
        {/if}
      {/each}
    {/if}
  {:else if loading}
    <div class="chat-preview-loading">
      <span class="chat-preview-spinner" aria-hidden="true"></span>
    </div>
  {/if}
</div>

<style>
  /* Two parallel chat-bubble palettes, both derived from existing
     dark-theme tokens. Override any of these eight tokens at the
     `.chat-preview` root (or `:root`) to retune without touching
     block-specific rules.
       User bubble  — brand-tinted dark surface, bright text.
       AI / tool    — light surface (inverted from the page bg)
                      so AI messages "pop" off the dashboard. */
  .chat-preview {
    --chat-preview-user-bg: color-mix(in oklch, var(--brand, #60b74c) 18%, var(--surface-0, #23261d));
    --chat-preview-user-border: var(--text-muted, #888);
    --chat-preview-user-text: var(--text-1, #e8e8e8);
    --chat-preview-user-role: color-mix(in oklch, var(--brand, #60b74c) 70%, var(--text-1, #e8e8e8));

    --chat-preview-ai-bg: var(--text-1, #e8e8e8);
    --chat-preview-ai-border: var(--text-muted, #888);
    --chat-preview-ai-text: var(--surface-0, #23261d);

    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--text-1, #e8e8e8);
    text-align: left;
    /* Flex column so children (msg bubbles + the gap pill) can
       choose their own horizontal alignment via `align-self`. */
    display: flex;
    flex-direction: column;
  }

  /* Chat-style preview: each message becomes a soft bubble. Each role
     has its own tint so a glance reads as a conversation rather than
     a flat list. */
  .chat-preview-msg {
    display: flex;
    flex-direction: column;
    max-width: 85%;
    margin: 0 0 0.45rem 0;
    padding: 0.35rem 0.5rem 0.4rem 0.5rem;
    border-radius: 0.6rem;
    /* Tight inner spacing so role + text read as one bubble. */
    gap: 0.1rem;
  }
  .chat-preview-msg:last-child {
    margin-bottom: 0;
  }
  .chat-preview-role-user {
    background: var(--chat-preview-user-bg);
    border: 1px solid var(--chat-preview-user-border);
    color: var(--chat-preview-user-text);
  }
  .chat-preview-role-assistant {
    background: var(--chat-preview-ai-bg);
    border: 1px solid var(--chat-preview-ai-border);
    color: var(--chat-preview-ai-text);
  }
  .chat-preview-role-assistant .chat-preview-role {
    color: var(--chat-preview-ai-text);
    font-weight: 700;
  }
  .chat-preview-role-assistant .chat-preview-time {
    color: color-mix(in oklch, var(--chat-preview-ai-text) 85%, transparent);
  }
  /* Older assistant turns sit before the latest user prompt and are
     shown as context only — fade the bubble so the eye lands on the
     current exchange first. Per-channel color-mix toward transparent
     (not `opacity`) keeps the layer flat: no compositing stack on
     top of the host's transparent panel background, and the dimmed
     bubble can still mix correctly with whatever sits behind the
     preview panel. */
  .chat-preview-msg.chat-preview-older {
    /* Mix the bubble's light surface toward the dark page background
       rather than toward `transparent` — keeps the bubble fully
       opaque (readable against any layer behind the panel) but
       drops its contrast so it reads as muted context. The text
       channel mixes too so the type doesn't punch out over the
       darker surface. */
    background: color-mix(in oklch, var(--chat-preview-ai-bg) 55%, var(--surface-0, #23261d));
    border-color: color-mix(in oklch, var(--chat-preview-ai-border) 50%, var(--surface-0, #23261d));
    color: color-mix(in oklch, var(--chat-preview-ai-text) 65%, var(--surface-0, #23261d));
  }
  .chat-preview-msg.chat-preview-older .chat-preview-role,
  .chat-preview-msg.chat-preview-older .chat-preview-time {
    color: color-mix(in oklch, var(--chat-preview-ai-text) 65%, var(--surface-0, #23261d));
  }
  .chat-preview-head {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35em;
    align-self: flex-start;
  }
  .chat-preview-agent-icon {
    width: 0.9em;
    height: 0.9em;
    vertical-align: -0.15em;
    margin-right: 0.2em;
  }
  .chat-preview-role {
    text-transform: uppercase;
    font-size: 0.58rem;
    letter-spacing: 0.06em;
    color: var(--text-muted, #9a9aa0);
  }
  .chat-preview-time {
    font-size: 0.58rem;
    color: var(--text-2, #d0d0d0);
  }
  .chat-preview-role-user .chat-preview-role {
    color: var(--chat-preview-user-role);
  }
  .chat-preview-text {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .chat-preview-loading,
  .chat-preview-empty {
    font-style: italic;
    padding: 0.2rem 0;
  }
  .chat-preview-loading {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .chat-preview-spinner {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 2px solid color-mix(in oklch, var(--text-muted, #888) 35%, transparent);
    border-top-color: var(--text-1, #e8e8e8);
    animation: chat-preview-spin 0.8s linear infinite;
  }
  @keyframes chat-preview-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .chat-preview-spinner { animation: none; }
  }
  /* "Now:" action chip — shares the AI bubble's inverted palette
     so tool messages read as the same visual family as the AI
     bubbles they sit between. */
  .chat-preview-action {
    align-self: flex-start;
    max-width: 85%;
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.45rem;
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm, 4px);
    background: var(--chat-preview-ai-bg);
    border: 1px solid var(--chat-preview-ai-border);
    font-family: ui-monospace, monospace;
    font-size: 0.66rem;
    color: var(--chat-preview-ai-text);
    overflow: hidden;
  }
  .chat-preview-action :global(.tool-icon) {
    width: 1em;
    height: 1em;
    flex: 0 0 auto;
    /* Heavier stroke than the default 2 — thin SVG lines read
       lighter than text at the same colour, so bump the stroke
       to match the surrounding bold tool name visually. */
    stroke-width: 2.6;
  }
  .chat-preview-action-name {
    color: var(--chat-preview-ai-text);
    font-weight: 600;
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .chat-preview-action-detail {
    color: color-mix(in oklch, var(--chat-preview-ai-text) 80%, transparent);
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chat-preview-gap {
    align-self: flex-start;
    width: fit-content;
    text-align: left;
    margin: 0.1rem 0 0.4rem 0;
    font-size: 0.62rem;
    color: color-mix(in oklch, var(--chat-preview-ai-text) 90%, transparent);
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-sm, 4px);
    background: var(--chat-preview-ai-bg);
    border: 1px solid var(--chat-preview-ai-border);
  }
</style>
