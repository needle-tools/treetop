<script lang="ts">
  /**
   * Header "Inbox" pill + popover. One section per sender peer; each
   * section shows the last 5 messages (monospace + Copy button), a
   * Reply box, and a Mute dropdown. Reads /api/messages and
   * /api/peers (the latter to resolve host:port for replies to a
   * given peer id). Refresh is driven by App.svelte's SSE handler.
   */
  import { onDestroy, onMount } from "svelte";
  import { apiUrl } from "./api";
  import { marked } from "marked";
  import DOMPurify from "dompurify";
  import Popover from "./Popover.svelte";
  import {
    expandNoteBodyForTerminalPasteChunks,
    fetchTextAttachment,
    STAGE_PROMPT_EVENT,
  } from "./note-inline-attachments";
  import {
    messages,
    refreshMessages,
    sendMessage,
    deleteMsg,
    mutePeer,
    unmutePeer,
    unreadCount,
    recallLastRead,
    markInboxRead,
  } from "./messages-store";

  interface DiscoveredPeer {
    id: string;
    label: string;
    host: string;
    port: number;
    /** Browser-openable port for this peer's dashboard. In prod it
     *  matches `port`; in dev Vite is on a different port. Falls back
     *  to `port` on the daemon side when older peers don't advertise. */
    frontendPort?: number;
  }

  interface InboxRow {
    peer: { id: string; label: string };
    messages: import("./messages-store").StoredMessage[];
    online: boolean;
    muted: boolean;
    contact: DiscoveredPeer | null;
    unread: number;
    preview: string;
  }

  let open = false;
  let peers: DiscoveredPeer[] = [];
  let peersPoll: ReturnType<typeof setInterval> | null = null;
  /** Polls /api/messages on a slow cadence as a safety net for the
   *  SSE-driven refresh. The SSE handler in App.svelte normally
   *  keeps the store in sync; this catches the case where an SSE
   *  reconnect drops events or the broadcast was missed. */
  let messagesPoll: ReturnType<typeof setInterval> | null = null;
  /** While the popover is open, periodically re-stamp `lastReadAt`
   *  so messages that arrive WHILE viewing get marked read after a
   *  few seconds — no need to close + reopen to clear the badge. */
  let readStamper: ReturnType<typeof setInterval> | null = null;
  /** ISO timestamp of the last time the user opened the inbox.
   *  Anything received after this counts as unread for the badge. */
  let lastReadAt: string | null = recallLastRead();
  let expanded: Record<string, boolean> = {};
  let replyText: Record<string, string> = {};
  let sending: Record<string, boolean> = {};
  let sendError: Record<string, string> = {};
  /** Per-peer "Sent…" indicator timer id. When non-null we know to
   *  render the confirmation badge in the textbox corner for ~2s
   *  after a successful send. Cleared on next send to that peer. */
  let sentBadgeTimer: Record<string, ReturnType<typeof setTimeout> | null> = {};
  let sentBadge: Record<string, boolean> = {};
  /** Per-message "just copied" flag, keyed by message id. The copy
   *  button swaps to a checkmark for ~1.4s after a successful
   *  clipboard write so the click feels acknowledged. */
  let copied: Record<string, boolean> = {};
  let copiedTimer: Record<string, ReturnType<typeof setTimeout> | null> = {};
  let viewerPeerId: string | null = null;
  let openNote:
    | {
        peerId: string;
        msg: import("./messages-store").StoredMessage;
      }
    | null = null;

  $: count = unreadCount($messages, lastReadAt);

  // Unified rows: every peer the user can talk to — peers who've
  // messaged us (with history) and peers currently discovered on the
  // LAN (compose-only, ready to receive). Keyed by peer id so a peer
  // who's both online and has history appears once.
  $: rows = buildRows($messages.inbox, $messages.mutes, peers, lastReadAt);

  function computeUnread(
    msgs: import("./messages-store").StoredMessage[],
    readAt: string | null,
  ): number {
    if (!readAt) return msgs.filter((m) => m.direction !== "out").length;
    const cutoff = Date.parse(readAt);
    if (!Number.isFinite(cutoff)) return 0;
    let n = 0;
    for (const m of msgs) {
      if (m.direction === "out") continue;
      const ts = Date.parse(m.receivedAt);
      if (Number.isFinite(ts) && ts > cutoff) n++;
    }
    return n;
  }

  function computePreview(
    msgs: import("./messages-store").StoredMessage[],
  ): string {
    const latest = msgs[0];
    if (!latest) return "";
    const first = latest.body.split("\n")[0] ?? "";
    const prefix = latest.direction === "out" ? "You: " : "";
    const max = 60;
    if (prefix.length + first.length > max)
      return prefix + first.slice(0, max - prefix.length) + "...";
    return prefix + first;
  }

  function buildRows(
    inbox: {
      peer: { id: string; label: string };
      messages: import("./messages-store").StoredMessage[];
    }[],
    mutes: Record<string, string>,
    discovered: DiscoveredPeer[],
    readAt: string | null,
  ): InboxRow[] {
    const byId = new Map<string, InboxRow>();
    const byIdDiscovered = new Map<string, DiscoveredPeer>();
    for (const p of discovered) byIdDiscovered.set(p.id, p);
    for (const r of inbox) {
      const contact = byIdDiscovered.get(r.peer.id) ?? null;
      byId.set(r.peer.id, {
        peer: r.peer,
        messages: r.messages,
        online: contact !== null,
        muted: !!mutes[r.peer.id],
        contact,
        unread: computeUnread(r.messages, readAt),
        preview: computePreview(r.messages),
      });
    }
    for (const p of discovered) {
      if (byId.has(p.id)) continue;
      byId.set(p.id, {
        peer: { id: p.id, label: p.label },
        messages: [],
        online: true,
        muted: !!mutes[p.id],
        contact: p,
        unread: 0,
        preview: "",
      });
    }
    return [...byId.values()].sort((a, b) => {
      if (a.online && !b.online) return -1;
      if (!a.online && b.online) return 1;
      const ta = a.messages[0]?.receivedAt ?? "";
      const tb = b.messages[0]?.receivedAt ?? "";
      if (ta || tb) return tb.localeCompare(ta);
      return a.peer.label.localeCompare(b.peer.label);
    });
  }

  onMount(() => {
    void refreshMessages();
    void fetch("/api/identity")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { id?: string } | null) => {
        viewerPeerId = typeof body?.id === "string" ? body.id : null;
      })
      .catch(() => {});
    startMessagesPoll();
  });

  /** Start (or restart) the messages refresh interval. Two
   *  cadences:
   *   - open: 1.5s so a new message rendering inside the popover
   *     feels instant even when SSE drops an event.
   *   - closed: 7s as the slower badge-keeping pulse.
   *  Called from onMount and on every setOpen toggle. */
  function startMessagesPoll() {
    if (messagesPoll) clearInterval(messagesPoll);
    const interval = open ? 1500 : 7000;
    messagesPoll = setInterval(refreshMessages, interval);
  }

  async function refreshPeers() {
    try {
      const res = await fetch(apiUrl("/api/peers"));
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
      // Opening the inbox is the "I read it" moment for the badge.
      // Anything received after this timestamp counts as unread next
      // time around.
      lastReadAt = markInboxRead();
      // Poll peers while open so the "reply" state turns on/off if
      // a peer comes back online or drops.
      if (peersPoll) clearInterval(peersPoll);
      peersPoll = setInterval(refreshPeers, 3000);
      // While the popover stays open, treat the user as "watching"
      // and re-stamp lastReadAt every 5s. A message that arrives at
      // T+0 with the popover already open gets marked read at the
      // next stamp tick (within 5s), so the badge clears without
      // needing a close+reopen.
      if (readStamper) clearInterval(readStamper);
      readStamper = setInterval(() => {
        lastReadAt = markInboxRead();
      }, 5000);
    } else {
      if (peersPoll) {
        clearInterval(peersPoll);
        peersPoll = null;
      }
      if (readStamper) {
        clearInterval(readStamper);
        readStamper = null;
      }
    }
    // Bump the messages poll to a faster cadence while the popover
    // is open so new arrivals show up in the list within ~1.5s
    // even when the SSE 'message_received' event drops.
    startMessagesPoll();
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
    if (messagesPoll) clearInterval(messagesPoll);
    if (readStamper) clearInterval(readStamper);
  });

  function portal(node: HTMLElement) {
    const orig = node.parentNode;
    document.body.appendChild(node);
    return {
      destroy() {
        if (orig && orig.contains(node) === false) {
          try { node.remove(); } catch {}
        }
      },
    };
  }

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

  async function onCopy(msgId: string, body: string) {
    try {
      await navigator.clipboard.writeText(body);
      copied = { ...copied, [msgId]: true };
      const prior = copiedTimer[msgId];
      if (prior) clearTimeout(prior);
      copiedTimer = {
        ...copiedTimer,
        [msgId]: setTimeout(() => {
          copied = { ...copied, [msgId]: false };
          copiedTimer = { ...copiedTimer, [msgId]: null };
        }, 1400),
      };
    } catch {
      // older browsers — silently no-op; user can still select+copy.
    }
  }

  const MAX_DISPLAY_LINES = 2;
  function truncateBody(body: string): { text: string; truncated: boolean } {
    const lines = body.split("\n");
    if (lines.length <= MAX_DISPLAY_LINES)
      return { text: body, truncated: false };
    return {
      text: lines.slice(0, MAX_DISPLAY_LINES).join("\n") + "…",
      truncated: true,
    };
  }

  function notePayload(msg: import("./messages-store").StoredMessage) {
    if (msg.kind !== "note") return null;
    return msg.note ?? { body: msg.body, tags: ["message"] };
  }

  function renderNoteHtml(body: string): string {
    return DOMPurify.sanitize(marked.parse(body, { async: false }) as string);
  }

  function noteDragPayload(msg: import("./messages-store").StoredMessage): string {
    const note = notePayload(msg);
    return JSON.stringify({
      body: note?.body ?? msg.body,
      tags: note?.tags ?? ["message"],
      receiver: note?.receiver,
      sender: note?.sender,
    });
  }

  function onNoteDragStart(e: DragEvent, msg: import("./messages-store").StoredMessage): void {
    e.dataTransfer?.setData("application/x-supergit-inbox-note", noteDragPayload(msg));
    e.dataTransfer?.setData("text/plain", notePayload(msg)?.body ?? msg.body);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
  }

  function onViewerNoteDragStart(e: DragEvent, msg: import("./messages-store").StoredMessage): void {
    onNoteDragStart(e, msg);
    setTimeout(() => {
      if (openNote?.msg.id === msg.id) openNote = null;
    }, 0);
  }

  function openNoteMessage(peerId: string, msg: import("./messages-store").StoredMessage): void {
    if (msg.kind !== "note") return;
    openNote = { peerId, msg };
  }

  function onNoteKeydown(e: KeyboardEvent, peerId: string, msg: import("./messages-store").StoredMessage): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openNoteMessage(peerId, msg);
  }

  function senderLabel(msg: import("./messages-store").StoredMessage): string {
    const sender = notePayload(msg)?.sender;
    if (!sender || (sender.kind === "peer" && viewerPeerId && sender.id === viewerPeerId)) return "";
    return sender.label ?? sender.id;
  }

  function receiverLabel(msg: import("./messages-store").StoredMessage): string {
    const receiver = notePayload(msg)?.receiver;
    if (!receiver || (receiver.kind === "peer" && viewerPeerId && receiver.peerId === viewerPeerId)) return "";
    return receiver.label ?? receiver.sessionId ?? receiver.peerId ?? "";
  }

  function noteReadTarget(msg: import("./messages-store").StoredMessage): {
    source?: string;
    termId?: string;
    label: string;
  } | null {
    const receiver = notePayload(msg)?.receiver;
    if (!receiver?.source && !receiver?.terminalId) return null;
    return {
      source: receiver.source,
      termId: receiver.terminalId,
      label: receiver.label ?? receiver.sessionId ?? receiver.source ?? "session",
    };
  }

  async function readNoteMessage(msg: import("./messages-store").StoredMessage): Promise<void> {
    const note = notePayload(msg);
    const target = noteReadTarget(msg);
    if (!note || !target) return;
    const chunks = await expandNoteBodyForTerminalPasteChunks(
      note.body,
      fetchTextAttachment,
      { omitTargetSessionSource: target.source },
    );
    if (!chunks.some((chunk) => chunk.trim())) return;
    window.dispatchEvent(
      new CustomEvent(STAGE_PROMPT_EVENT, {
        detail: { source: target.source, termId: target.termId, chunks },
      }),
    );
    open = false;
  }

  let deleting: Record<string, boolean> = {};

  async function onDelete(peerId: string, messageId: string) {
    if (deleting[messageId]) return;
    deleting = { ...deleting, [messageId]: true };
    await deleteMsg(peerId, messageId);
    deleting = { ...deleting, [messageId]: false };
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
      // Show a quick "Sent…" ack in the same corner where the send
      // icon was — the icon disappears once the textarea empties, so
      // this slot is free. Auto-clears after 2s.
      sentBadge = { ...sentBadge, [peerId]: true };
      const prior = sentBadgeTimer[peerId];
      if (prior) clearTimeout(prior);
      sentBadgeTimer = {
        ...sentBadgeTimer,
        [peerId]: setTimeout(() => {
          sentBadge = { ...sentBadge, [peerId]: false };
          sentBadgeTimer = { ...sentBadgeTimer, [peerId]: null };
        }, 2000),
      };
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

  function toggleExpanded(peerId: string) {
    expanded = { ...expanded, [peerId]: !expanded[peerId] };
  }

  function isExpanded(peerId: string, idx: number): boolean {
    if (peerId in expanded) return expanded[peerId];
    return idx === 0;
  }
</script>

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
      <path
        d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"
      ></path>
    </svg>
    Inbox
    {#if count > 0}
      <span class="count inbox-unread-count">{count}</span>
    {/if}
  </button>
  {#if open}
    <Popover variant="actions" extraClass="inbox-popover" unclamped>
      <span slot="head">Messages</span>
      {#if rows.length === 0}
        <p class="muted small nopad">
          No peers discovered on this network yet, and nobody's sent you
          anything. Once another supergit instance comes online on your LAN
          it'll show up here.
        </p>
      {:else}
        <ul class="inbox-list">
          {#each rows as row, idx (row.peer.id)}
            {@const ex = isExpanded(row.peer.id, idx)}
            <li class="inbox-row" class:inbox-row-muted={row.muted}>
              <button
                type="button"
                class="inbox-head"
                on:click|stopPropagation={() => toggleExpanded(row.peer.id)}
              >
                <svg
                  class="inbox-chevron"
                  class:inbox-chevron-open={ex}
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                  ><polyline points="9 18 15 12 9 6"></polyline></svg
                >
                <span
                  class="inbox-status-dot"
                  class:inbox-status-online={row.online}
                  title={row.online ? "Online" : "Offline"}
                ></span>
                <div class="inbox-peer-id">
                  <span class="inbox-peer-label">
                    {row.peer.label}
                    {#if row.unread > 0}
                      <span class="inbox-peer-unread">{row.unread}</span>
                    {/if}
                  </span>
                  {#if !ex && row.preview}
                    <span class="inbox-preview">{row.preview}</span>
                  {/if}
                </div>
                <span class="inbox-head-meta">
                  {#if row.messages.length > 0}
                    <span class="inbox-head-time"
                      >{relTime(row.messages[0].receivedAt)}</span
                    >
                  {/if}
                </span>
              </button>

              <div class="inbox-expanded" class:inbox-collapsed={!ex}>
                {#if row.contact}
                  {@const fp = row.contact.frontendPort ?? row.contact.port}
                  <div class="inbox-peer-detail">
                    <a
                      class="inbox-peer-host"
                      href={`http://${row.contact.host}:${fp}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open this peer's dashboard (daemon API on :${row.contact.port})`}
                    >
                      {row.contact.host}:{fp} ↗
                    </a>
                    {#if row.muted}
                      <button
                        type="button"
                        class="inbox-mute-btn inbox-muted"
                        on:click={() => onMute(row.peer.id, null)}
                        title="Unmute this peer">muted · unmute</button
                      >
                    {:else if row.messages.length > 0}
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
                  </div>
                {:else}
                  {#if row.muted}
                    <div class="inbox-peer-detail">
                      <span
                        class="inbox-offline"
                        title="Peer isn't currently advertising on the LAN"
                        >offline</span
                      >
                      <button
                        type="button"
                        class="inbox-mute-btn inbox-muted"
                        on:click={() => onMute(row.peer.id, null)}
                        title="Unmute this peer">muted · unmute</button
                      >
                    </div>
                  {:else if row.messages.length > 0}
                    <div class="inbox-peer-detail">
                      <span
                        class="inbox-offline"
                        title="Peer isn't currently advertising on the LAN"
                        >offline</span
                      >
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
                    </div>
                  {/if}
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
                  {#if (replyText[row.peer.id] ?? "").trim().length > 0 && row.online}
                    <button
                      type="button"
                      class="inbox-send-icon"
                      on:click|stopPropagation={() => onSend(row.peer.id)}
                      disabled={sending[row.peer.id]}
                      title={sending[row.peer.id] ? "Sending…" : "Send (Enter)"}
                      aria-label="Send"
                    >
                      {#if sending[row.peer.id]}
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          class="inbox-send-spinning"
                          aria-hidden="true"
                        >
                          <circle
                            cx="12"
                            cy="12"
                            r="9"
                            stroke-dasharray="42"
                            stroke-dashoffset="20"
                          ></circle>
                        </svg>
                      {:else}
                        <svg
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
                          <path d="M22 2 11 13"></path>
                          <path d="m22 2-7 20-4-9-9-4 20-7z"></path>
                        </svg>
                      {/if}
                    </button>
                  {:else if sentBadge[row.peer.id]}
                    <span class="inbox-sent-badge" aria-live="polite"
                      >Sent ✓</span
                    >
                  {/if}
                </div>
                {#if sendError[row.peer.id]}
                  <p class="inbox-err small" role="alert">
                    {sendError[row.peer.id]}
                  </p>
                {/if}

                {#if row.messages.length > 0}
                  <ul class="inbox-msgs">
                    {#each row.messages as msg (msg.id)}
                      {@const readTarget = noteReadTarget(msg)}
                      <li
                        class="inbox-msg"
                        class:inbox-msg-sent={msg.direction === "out"}
                      >
                        <pre
                          class="inbox-body"
                          class:inbox-body-sent={msg.direction ===
                            "out"}>{#if msg.direction === "out"}<svg
                              class="inbox-msg-dir inbox-msg-dir-out"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2.4"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-label="Sent"
                              ><line x1="5" y1="12" x2="19" y2="12" /><polyline
                                points="12 5 19 12 12 19"
                              /></svg
                            >{:else}<svg
                              class="inbox-msg-dir inbox-msg-dir-in"
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2.4"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-label="Received"
                              ><line x1="19" y1="12" x2="5" y2="12" /><polyline
                                points="12 19 5 12 12 5"
                              /></svg
                            >{/if} {truncateBody(msg.body).text}</pre>
                        <button
                          type="button"
                          class="inbox-copy-icon"
                          class:inbox-copy-icon-copied={copied[msg.id]}
                          on:click|stopPropagation={() =>
                            onCopy(msg.id, msg.body)}
                          title={copied[msg.id]
                            ? "Copied"
                            : "Copy full message"}
                          aria-label={copied[msg.id] ? "Copied" : "Copy"}
                        >
                          {#if copied[msg.id]}
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2.4"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                          {:else}
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
                              <rect
                                x="9"
                                y="9"
                                width="13"
                                height="13"
                                rx="2"
                                ry="2"
                              ></rect>
                              <path
                                d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                              ></path>
                            </svg>
                          {/if}
                        </button>
                        <span class="inbox-msg-footer">
                          <span class="inbox-msg-time muted small"
                            >{msg.direction === "out" ? "sent" : "received"}
                            {relTime(
                              msg.direction === "out"
                                ? msg.sentAt
                                : msg.receivedAt,
                            )}</span
                          >
                          {#if msg.kind === "note" && msg.direction !== "out"}
                            <button
                              type="button"
                              class="inbox-read-btn"
                              disabled={!readTarget}
                              on:click|stopPropagation={() =>
                                void readNoteMessage(msg)}
                              title={readTarget
                                ? `Paste into ${readTarget.label}`
                                : "No target session for this note"}
                            >
                              Read
                            </button>
                          {/if}
                          <button
                            type="button"
                            class="inbox-delete-icon"
                            on:click|stopPropagation={() =>
                              onDelete(row.peer.id, msg.id)}
                            disabled={deleting[msg.id]}
                            title="Delete message"
                            aria-label="Delete"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <polyline points="3 6 5 6 21 6"></polyline>
                              <path
                                d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
                              ></path>
                            </svg>
                          </button>
                        </span>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </Popover>
  {/if}
</div>

<style>
  .inbox-icon {
    flex: 0 0 auto;
    opacity: 0.85;
  }
  /* Bright notification-style badge — the same orange-red email
     clients use for unread counts. Overrides the default .count
     pill (which is a subtle muted-border style) so unread inbox
     items are impossible to miss. */
  .inbox-unread-count {
    background: #ef4444;
    color: #fff;
    border-color: #ef4444;
    padding: 0.15em 0.4em;
    font-weight: 600;
  }
  .inbox-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 360px;
    max-width: 460px;
  }
  .inbox-row {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid
      color-mix(in srgb, var(--text-muted) 14%, transparent);
  }
  .inbox-row:last-child {
    border-bottom: none;
  }
  .inbox-row-muted {
    opacity: 0.6;
  }
  .inbox-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.2rem;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
    width: 100%;
    border-radius: 4px;
  }
  .inbox-head:hover {
    background: color-mix(in srgb, var(--text-muted) 8%, transparent);
  }
  .inbox-chevron {
    flex: 0 0 auto;
    color: var(--text-muted);
    opacity: 0.6;
    transition: transform 0.15s ease;
  }
  .inbox-chevron-open {
    transform: rotate(90deg);
  }
  .inbox-peer-id {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    min-width: 0;
    flex: 1 1 auto;
  }
  .inbox-peer-label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-weight: 600;
    font-size: 0.82rem;
    color: var(--text-1, inherit);
  }
  .inbox-status-dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--text-muted) 35%, transparent);
  }
  .inbox-status-online {
    background: #2ecc71;
  }
  .inbox-peer-unread {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.1em;
    padding: 0 0.3em;
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1.35;
    background: #ef4444;
    color: #fff;
    border-radius: 999px;
  }
  .inbox-preview {
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 280px;
  }
  .inbox-head-meta {
    flex: 0 0 auto;
    font-size: 0.68rem;
    color: var(--text-muted);
  }
  .inbox-head-time {
    white-space: nowrap;
  }
  .inbox-expanded {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0 0.2rem 0.6rem 1.5rem;
  }
  .inbox-collapsed {
    display: none;
  }
  .inbox-peer-detail {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.72rem;
  }
  .inbox-peer-host {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.7rem;
    color: var(--text-muted);
    text-decoration: none;
    word-break: break-all;
  }
  .inbox-peer-host:hover {
    color: var(--text-1, inherit);
    text-decoration: underline;
  }
  .inbox-offline {
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    font-size: 0.7rem;
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
  /* Sent messages: visually distinct from received via a brand-tinted
     left border + slightly lighter background, mirroring the
     chat-bubble convention. Stays subtle so the popover doesn't read
     as a chat client. */
  .inbox-body-sent {
    background: color-mix(in srgb, var(--brand) 8%, var(--surface-2));
    border-color: color-mix(in srgb, var(--brand) 35%, transparent);
    border-left-width: 3px;
  }
  .inbox-msg {
    /* Body + meta stacked; the direction arrow lives inline INSIDE
       the body now (Svelte template prepends it as a sibling text
       node before {msg.body}). */
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .inbox-body {
    box-sizing: border-box;
    display: block;
    width: 100%;
    margin: 0;
    padding: 0.45rem 1.7rem 0.45rem 0.55rem;
    background: color-mix(in srgb, var(--surface-2) 50%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-muted) 18%, transparent);
    border-radius: 4px;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.76rem;
    line-height: 1.4;
    color: var(--text-1, inherit);
    text-align: left;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    user-select: text;
  }
  button.inbox-body {
    appearance: none;
  }
  .inbox-note-card {
    box-sizing: border-box;
    width: 100%;
    padding: 0.55rem 0.65rem 0.65rem;
    border: 0;
    border-radius: 4px 4px 10px 4px;
    background:
      repeating-linear-gradient(
        to bottom,
        rgba(0, 0, 0, 0) 0,
        rgba(0, 0, 0, 0) 18px,
        rgba(0, 0, 0, 0.035) 18px,
        rgba(0, 0, 0, 0.035) 19px
      ),
      linear-gradient(180deg, #fff4a8 0%, #ffec80 100%);
    color: #2a2516;
    box-shadow:
      0 1px 1px rgba(0, 0, 0, 0.18),
      0 7px 18px -12px rgba(0, 0, 0, 0.42);
    cursor: zoom-in;
    font-family: -apple-system, "Caveat", "Comic Neue", "Patrick Hand",
      "Marker Felt", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.35;
    text-align: left;
  }
  .inbox-note-card:hover {
    box-shadow:
      0 1px 1px rgba(0, 0, 0, 0.2),
      0 12px 28px -16px rgba(0, 0, 0, 0.5);
  }
  .inbox-note-card:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--brand) 55%, transparent);
    outline-offset: 2px;
  }
  .inbox-note-card-body {
    max-height: 7.5rem;
    overflow: hidden;
  }
  .inbox-note-card-body :global(p) {
    margin: 0 0 0.35em;
  }
  .inbox-note-card-body :global(p:last-child) {
    margin-bottom: 0;
  }
  /* Direction marker rendered INLINE inside `<pre>` as the first
     thing on the line. `vertical-align: middle` centres it against
     the surrounding text's x-height (close enough to "centred with
     the line" without a per-pixel calibration), and a touch of
     right margin separates it from the first character. */
  .inbox-msg-dir {
    vertical-align: middle;
    margin-right: 0.2rem;
    color: var(--text-muted);
    opacity: 0.8;
  }
  .inbox-msg-dir-out {
    color: color-mix(in srgb, var(--brand) 80%, var(--text-muted));
    opacity: 1;
  }
  .inbox-copy-icon {
    position: absolute;
    top: 0.3rem;
    right: 0.3rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0.7;
  }
  .inbox-copy-icon:hover {
    color: var(--text-1, inherit);
    background: color-mix(in srgb, var(--text-muted) 18%, transparent);
    opacity: 1;
  }
  .inbox-msg-footer {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    align-self: flex-end;
  }
  .inbox-delete-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.2rem;
    height: 1.2rem;
    padding: 0;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0.6;
  }
  .inbox-delete-icon:hover {
    color: #c0392b;
    opacity: 1;
  }
  .inbox-delete-icon:disabled {
    opacity: 0.3;
    cursor: progress;
  }
  .inbox-read-btn {
    padding: 0.12rem 0.42rem;
    border: 1px solid color-mix(in srgb, var(--text-muted) 32%, transparent);
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.68rem;
    cursor: pointer;
  }
  .inbox-read-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--text-muted) 14%, transparent);
    color: var(--text-1, inherit);
  }
  .inbox-read-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .inbox-msg-time {
    font-size: 0.7rem;
  }
  .inbox-reply {
    position: relative;
    margin-top: 0.2rem;
  }
  .inbox-reply-input {
    box-sizing: border-box;
    width: 100%;
    font: inherit;
    font-size: 0.78rem;
    line-height: 1.4;
    /* Right padding clears the embedded send icon when it appears. */
    padding: 0.35rem 1.9rem 0.35rem 0.5rem;
    background: var(--surface-1, transparent);
    border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    border-radius: 4px;
    color: inherit;
    /* User asked for non-resizable — keep the popover layout stable
       and avoid the corner grip badly overlapping the send icon. */
    resize: none;
    min-height: 2.2rem;
  }
  .inbox-reply-input:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--text-muted) 50%, transparent);
    outline-offset: 1px;
  }
  /* Send button as an icon embedded inside the textarea, only
     rendered when there's actual content to send. No background by
     default — the icon sits on the same surface as the textarea.
     Hover tints it with the brand colour so it still reads as a
     button. */
  .inbox-send-icon {
    position: absolute;
    right: 0.35rem;
    bottom: 0.35rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border-radius: 4px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .inbox-send-icon:hover:not(:disabled) {
    color: var(--brand);
    background: color-mix(in srgb, var(--brand) 12%, transparent);
  }
  .inbox-send-icon:disabled {
    opacity: 0.5;
    cursor: progress;
  }
  /* "Sent ✓" badge — drop-in for the send-icon slot once a message
     went out. Muted text, no background, fades quietly. */
  .inbox-sent-badge {
    position: absolute;
    right: 0.55rem;
    bottom: 0.5rem;
    font-size: 0.7rem;
    color: color-mix(in srgb, #2ecc71 80%, var(--text-muted));
    pointer-events: none;
    user-select: none;
  }
  .inbox-send-spinning {
    animation: inbox-spin 0.9s linear infinite;
    transform-origin: center;
  }
  @keyframes inbox-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .inbox-err {
    margin: 0;
    color: #c0392b;
  }
  .inbox-note-large-view {
    width: min(36rem, calc(100vw - 4rem));
    min-height: auto;
    cursor: grab;
  }
  .inbox-note-large-view .sticky-body {
    max-height: min(22rem, 48vh);
  }
  .inbox-note-media-modal {
    width: min(42rem, calc(100vw - 2rem));
  }
</style>
