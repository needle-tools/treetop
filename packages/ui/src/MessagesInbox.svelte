<script lang="ts">
  /**
   * Header "Inbox" pill + popover. One section per sender peer; each
   * section shows the last 5 messages (monospace + Copy button), a
   * Reply box, and a Mute dropdown. Reads /api/messages and
   * /api/peers (the latter to resolve host:port for replies to a
   * given peer id). Refresh is driven by App.svelte's SSE handler.
   */
  import { onDestroy, onMount } from "svelte";
  import Popover from "./Popover.svelte";
  import {
    messages,
    refreshMessages,
    sendMessage,
    mutePeer,
    unmutePeer,
    totalCount,
  } from "./messages-store";

  interface DiscoveredPeer {
    id: string;
    label: string;
    host: string;
    port: number;
  }

  interface InboxRow {
    peer: { id: string; label: string };
    messages: import("./messages-store").StoredMessage[];
    online: boolean;
    muted: boolean;
  }

  let open = false;
  let peers: DiscoveredPeer[] = [];
  let peersPoll: ReturnType<typeof setInterval> | null = null;
  let replyText: Record<string, string> = {};
  let sending: Record<string, boolean> = {};
  let sendError: Record<string, string> = {};

  $: count = totalCount($messages);

  // Unified rows: every peer the user can talk to — peers who've
  // messaged us (with history) and peers currently discovered on the
  // LAN (compose-only, ready to receive). Keyed by peer id so a peer
  // who's both online and has history appears once.
  $: rows = buildRows($messages.inbox, $messages.mutes, peers);

  function buildRows(
    inbox: { peer: { id: string; label: string }; messages: import("./messages-store").StoredMessage[] }[],
    mutes: Record<string, string>,
    discovered: DiscoveredPeer[],
  ): InboxRow[] {
    const byId = new Map<string, InboxRow>();
    for (const r of inbox) {
      byId.set(r.peer.id, {
        peer: r.peer,
        messages: r.messages,
        online: discovered.some((p) => p.id === r.peer.id),
        muted: !!mutes[r.peer.id],
      });
    }
    for (const p of discovered) {
      if (byId.has(p.id)) continue;
      byId.set(p.id, {
        peer: { id: p.id, label: p.label },
        messages: [],
        online: true,
        muted: !!mutes[p.id],
      });
    }
    return [...byId.values()].sort((a, b) => {
      // Peers with messages bubble to the top, sorted by most recent
      // received message; the rest fall in alphabetic-by-label order.
      const aHas = a.messages.length > 0;
      const bHas = b.messages.length > 0;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      if (aHas && bHas) {
        const ta = a.messages[0]?.receivedAt ?? "";
        const tb = b.messages[0]?.receivedAt ?? "";
        return tb.localeCompare(ta);
      }
      return a.peer.label.localeCompare(b.peer.label);
    });
  }

  onMount(() => {
    void refreshMessages();
  });

  async function refreshPeers() {
    try {
      const res = await fetch("/api/peers");
      if (!res.ok) return;
      const body = (await res.json()) as { peers?: DiscoveredPeer[] };
      peers = body.peers ?? [];
    } catch {
      // best-effort
    }
  }

  function setOpen(next: boolean) {
    open = next;
    if (open) {
      void refreshMessages();
      void refreshPeers();
      // Poll peers while open so the "reply" state turns on/off if
      // a peer comes back online or drops.
      if (peersPoll) clearInterval(peersPoll);
      peersPoll = setInterval(refreshPeers, 3000);
    } else if (peersPoll) {
      clearInterval(peersPoll);
      peersPoll = null;
    }
  }
  function toggleOpen() {
    setOpen(!open);
  }
  function onDocClick(ev: MouseEvent) {
    if (!open) return;
    const t = ev.target as HTMLElement | null;
    if (t?.closest(".inbox-anchor")) return;
    setOpen(false);
  }
  onDestroy(() => {
    if (peersPoll) clearInterval(peersPoll);
  });

  function peerOnline(peerId: string): DiscoveredPeer | null {
    return peers.find((p) => p.id === peerId) ?? null;
  }

  function relTime(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return "";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(iso).toLocaleDateString();
  }

  async function onCopy(body: string) {
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      // older browsers — silently no-op; user can still select+copy.
    }
  }

  async function onSend(peerId: string) {
    const live = peerOnline(peerId);
    const text = (replyText[peerId] ?? "").trim();
    if (!live || !text || sending[peerId]) return;
    sending = { ...sending, [peerId]: true };
    sendError = { ...sendError, [peerId]: "" };
    const r = await sendMessage(live.host, live.port, text);
    sending = { ...sending, [peerId]: false };
    if (r.ok) {
      replyText = { ...replyText, [peerId]: "" };
    } else {
      sendError = { ...sendError, [peerId]: r.error };
    }
  }

  function onReplyKey(ev: KeyboardEvent, peerId: string) {
    // Enter sends; Shift-Enter inserts a newline. Cheap, matches
    // chat conventions, no separate Send button needed for the
    // keyboard-first path.
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void onSend(peerId);
    }
  }

  async function onMute(peerId: string, minutes: number | null) {
    if (minutes === null) {
      await unmutePeer(peerId);
    } else {
      await mutePeer(peerId, minutes);
    }
  }
</script>

<style>
  .inbox-icon {
    flex: 0 0 auto;
    opacity: 0.85;
  }
  .inbox-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    min-width: 360px;
    max-width: 460px;
  }
  .inbox-row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-bottom: 0.85rem;
    border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .inbox-row:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }
  .inbox-row-muted {
    opacity: 0.6;
  }
  .inbox-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
  }
  .inbox-peer-label {
    font-weight: 600;
    font-size: 0.82rem;
    color: var(--text-1, inherit);
  }
  .inbox-head-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.7rem;
    color: var(--text-muted);
  }
  .inbox-offline {
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
  }
  .inbox-mute-select,
  .inbox-mute-btn {
    font: inherit;
    font-size: 0.72rem;
    padding: 0.15rem 0.45rem;
    border: 1px solid color-mix(in srgb, var(--text-muted) 35%, transparent);
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .inbox-mute-btn.inbox-muted {
    background: color-mix(in srgb, #d35400 18%, transparent);
    color: color-mix(in srgb, #d35400 90%, var(--text));
  }
  .inbox-msgs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .inbox-msg {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .inbox-body {
    margin: 0;
    padding: 0.45rem 0.55rem;
    background: color-mix(in srgb, var(--surface-2) 50%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-muted) 18%, transparent);
    border-radius: 4px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.76rem;
    line-height: 1.4;
    color: var(--text-1, inherit);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .inbox-msg-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.7rem;
  }
  .inbox-copy {
    font: inherit;
    font-size: 0.7rem;
    padding: 0.1rem 0.45rem;
    border-radius: 3px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .inbox-copy:hover {
    color: var(--text-1, inherit);
    border-color: color-mix(in srgb, var(--text-muted) 60%, transparent);
  }
  .inbox-reply {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.2rem;
  }
  .inbox-reply-input {
    flex: 1;
    font: inherit;
    font-size: 0.78rem;
    line-height: 1.4;
    padding: 0.35rem 0.5rem;
    background: var(--surface-1, transparent);
    border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    border-radius: 4px;
    color: inherit;
    resize: vertical;
    min-height: 2.2rem;
  }
  .inbox-reply-input:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--text-muted) 50%, transparent);
    outline-offset: 1px;
  }
  .inbox-send {
    font: inherit;
    font-size: 0.78rem;
    padding: 0.3rem 0.7rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    background: color-mix(in srgb, var(--text-muted) 20%, transparent);
    color: inherit;
    cursor: pointer;
    align-self: flex-end;
  }
  .inbox-send:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text-muted) 35%, transparent);
  }
  .inbox-send:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .inbox-err {
    margin: 0;
    color: #c0392b;
  }
</style>

<svelte:window on:click={onDocClick} />

<div class="actions-anchor inbox-anchor">
  <button
    class="actions-btn"
    class:open
    on:click={toggleOpen}
    title={count > 0
      ? `${count} message${count === 1 ? "" : "s"} from other supergit peers`
      : "Messages from other supergit peers on your LAN"}
  >
    <!-- Inbox tray icon (lucide "inbox"). Inline SVG so it picks up
         currentColor and we don't pull a sprite dependency. -->
    <svg
      class="inbox-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
    </svg>
    Inbox
    {#if count > 0}
      <span class="count">{count}</span>
    {/if}
  </button>
  {#if open}
    <Popover variant="actions" extraClass="inbox-popover" unclamped>
      <span slot="head">Messages</span>
      {#if rows.length === 0}
        <p class="muted small nopad">
          No peers discovered on this network yet, and nobody's sent
          you anything. Once another supergit instance comes online
          on your LAN it'll show up here.
        </p>
      {:else}
        <ul class="inbox-list">
          {#each rows as row (row.peer.id)}
            <li class="inbox-row" class:inbox-row-muted={row.muted}>
              <div class="inbox-head">
                <span class="inbox-peer-label">{row.peer.label}</span>
                <span class="inbox-head-meta">
                  {#if !row.online}
                    <span class="inbox-offline" title="Peer isn't currently advertising on the LAN — you can't send right now.">offline</span>
                  {/if}
                  {#if row.muted}
                    <button
                      type="button"
                      class="inbox-mute-btn inbox-muted"
                      on:click={() => onMute(row.peer.id, null)}
                      title="Unmute this peer"
                    >muted · unmute</button>
                  {:else if row.messages.length > 0}
                    <!-- Mute only makes sense once someone has actually
                         sent us something; for compose-only peers we
                         hide the control to keep the row tidy. -->
                    <select
                      class="inbox-mute-select"
                      title="Mute this peer"
                      on:change={(e) => {
                        const v = (e.target as HTMLSelectElement).value;
                        (e.target as HTMLSelectElement).value = "";
                        if (v) onMute(row.peer.id, Number(v));
                      }}
                    >
                      <option value="">Mute ▾</option>
                      <option value="15">15 min</option>
                      <option value="60">1 hour</option>
                      <option value="1440">24 hours</option>
                    </select>
                  {/if}
                </span>
              </div>

              {#if row.messages.length > 0}
                <ul class="inbox-msgs">
                  {#each row.messages as msg (msg.id)}
                    <li class="inbox-msg">
                      <pre class="inbox-body">{msg.body}</pre>
                      <div class="inbox-msg-meta">
                        <span class="muted small">{relTime(msg.receivedAt)}</span>
                        <button
                          type="button"
                          class="inbox-copy"
                          on:click={() => onCopy(msg.body)}
                          title="Copy to clipboard"
                        >Copy</button>
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}

              <div class="inbox-reply">
                <textarea
                  class="inbox-reply-input"
                  placeholder={row.online
                    ? row.messages.length > 0
                      ? `Reply to ${row.peer.label}…`
                      : `Send to ${row.peer.label}…`
                    : "Peer offline — can't send right now"}
                  rows="2"
                  bind:value={replyText[row.peer.id]}
                  disabled={!row.online || sending[row.peer.id]}
                  on:keydown={(e) => onReplyKey(e, row.peer.id)}
                ></textarea>
                <button
                  type="button"
                  class="inbox-send"
                  on:click={() => onSend(row.peer.id)}
                  disabled={!row.online || !((replyText[row.peer.id] ?? "").trim()) || sending[row.peer.id]}
                >{sending[row.peer.id] ? "Sending…" : "Send"}</button>
              </div>
              {#if sendError[row.peer.id]}
                <p class="inbox-err small" role="alert">{sendError[row.peer.id]}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </Popover>
  {/if}
</div>
