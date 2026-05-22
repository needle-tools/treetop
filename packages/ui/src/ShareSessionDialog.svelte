<script lang="ts">
  /**
   * Sender-side "Share session in local network" dialog. Subscribes to `activeShare`;
   * renders a modal that lets the user pick a peer (host:port input
   * for v1; mDNS peer discovery lands in a later slice) and send the
   * session.
   *
   * Posts to /api/sessions/send. On 202 the daemon stripped + redacted
   * the JSONL and shipped it to the peer; the dialog reports how many
   * tool_results were stripped and how many likely secrets were
   * redacted so the user has a clear "what just left this machine"
   * receipt.
   */
  import { activeShare, closeShare, rememberPeer, recallPeer } from "./share-session-dialog";

  let peerInput = "";
  let includeToolOutputs = false;
  let sending = false;
  let result:
    | { kind: "idle" }
    | { kind: "ok"; offerId: string; strippedCount: number; redactions: Array<{ kind: string; count: number }> }
    | { kind: "error"; message: string } = { kind: "idle" };

  // Reset state every time the dialog opens with a fresh source so
  // a previous send's success/error message doesn't carry over.
  let lastSource: string | null = null;
  $: if ($activeShare && $activeShare.source !== lastSource) {
    lastSource = $activeShare.source;
    peerInput = recallPeer();
    includeToolOutputs = false;
    sending = false;
    result = { kind: "idle" };
  }
  $: if (!$activeShare) lastSource = null;

  function parsePeer(value: string): { host: string; port: number } | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // Accept "host:port" or "host port" — be forgiving.
    const m = trimmed.match(/^([^\s:]+)[\s:]+(\d+)$/);
    if (!m) return null;
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: m[1]!, port };
  }

  $: parsedPeer = parsePeer(peerInput);
  $: canSend = !!parsedPeer && !!$activeShare && !sending;

  async function send() {
    if (!$activeShare || !parsedPeer || sending) return;
    sending = true;
    result = { kind: "idle" };
    try {
      const res = await fetch("/api/sessions/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: $activeShare.source,
          peerHost: parsedPeer.host,
          peerPort: parsedPeer.port,
          includeToolOutputs,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { offerId?: string; strippedCount?: number; redactions?: Array<{ kind: string; count: number }>; error?: string }
        | null;
      if (res.status !== 202) {
        result = {
          kind: "error",
          message: body?.error ?? `HTTP ${res.status}`,
        };
        return;
      }
      rememberPeer(`${parsedPeer.host}:${parsedPeer.port}`);
      result = {
        kind: "ok",
        offerId: body?.offerId ?? "",
        strippedCount: body?.strippedCount ?? 0,
        redactions: body?.redactions ?? [],
      };
    } catch (e) {
      result = { kind: "error", message: e instanceof Error ? e.message : String(e) };
    } finally {
      sending = false;
    }
  }

  function onKeydown(ev: KeyboardEvent) {
    if (!$activeShare) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeShare();
    } else if (ev.key === "Enter" && canSend) {
      ev.preventDefault();
      void send();
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if $activeShare}
  <div
    class="share-overlay"
    on:click={closeShare}
    on:keydown|stopPropagation
    role="presentation"
  >
    <div
      class="share-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-title"
      on:click|stopPropagation
    >
      <h2 id="share-title" class="share-title">Share session in local network</h2>
      <p class="share-blurb">
        Ship this session to another supergit on your LAN. Tool outputs
        are stripped and common secrets (GitHub, npm, Stripe, AWS, …)
        are redacted before send.
      </p>

      <label class="share-field">
        <span class="share-label">Peer (host:port)</span>
        <input
          type="text"
          class="share-input"
          placeholder="192.168.1.42:27787"
          bind:value={peerInput}
          autocomplete="off"
          spellcheck="false"
        />
      </label>

      <label class="share-check">
        <input type="checkbox" bind:checked={includeToolOutputs} />
        <span class="share-check-text">
          <span class="share-check-label">Send the full transcript</span>
          <span class="share-check-help">
            Off (recommended): tool outputs are dropped and known secret
            formats (GitHub, Stripe, AWS, …) are masked before send.
            On: nothing is removed — useful when the receiver needs the
            exact command output you got.
          </span>
        </span>
      </label>

      {#if result.kind === "error"}
        <p class="share-result share-err" role="alert">{result.message}</p>
      {:else if result.kind === "ok"}
        <p class="share-result share-ok">
          Offer sent.
          {#if !includeToolOutputs}
            Stripped {result.strippedCount} tool output{result.strippedCount === 1 ? "" : "s"}{#if result.redactions.length > 0},
            redacted {result.redactions.reduce((n, r) => n + r.count, 0)} likely secret{result.redactions.reduce((n, r) => n + r.count, 0) === 1 ? "" : "s"}
            ({result.redactions.map((r) => `${r.count}× ${r.kind}`).join(", ")}){/if}.
          {/if}
        </p>
      {/if}

      <div class="share-buttons">
        <button type="button" class="share-btn share-cancel" on:click={closeShare}>
          {result.kind === "ok" ? "Close" : "Cancel"}
        </button>
        <button
          type="button"
          class="share-btn share-send"
          disabled={!canSend}
          on:click={send}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .share-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    backdrop-filter: blur(2px);
  }
  .share-dialog {
    min-width: 380px;
    max-width: min(520px, 92vw);
    background: var(--surface-1);
    color: var(--text, inherit);
    border: 1px solid var(--surface-2);
    border-radius: var(--radius-md, 8px);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .share-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }
  .share-blurb {
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .share-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
  }
  .share-label {
    color: var(--text-muted);
  }
  .share-input {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.4rem 0.55rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: color-mix(in srgb, var(--surface-2) 50%, transparent);
    color: inherit;
  }
  .share-input:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--text-muted) 60%, transparent);
    outline-offset: 1px;
  }
  .share-check {
    display: flex;
    align-items: flex-start;
    text-align: left;
    gap: 0.6rem;
    font-size: 0.8rem;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.55rem 0.6rem;
    background: color-mix(in srgb, var(--surface-2) 35%, transparent);
    border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
    border-radius: 4px;
  }
  .share-check:hover,
  .share-check:focus-within {
    background: color-mix(in srgb, var(--surface-2) 55%, transparent);
    border-color: color-mix(in srgb, var(--text-muted) 40%, transparent);
  }
  /* Optically align the 16px checkbox with the first line of the
     two-line label (bold header + smaller help text). */
  .share-check input[type="checkbox"] {
    margin-top: 1px;
  }
  .share-check-text {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    flex: 1;
  }
  .share-check-label {
    color: var(--text-1, inherit);
    font-weight: 500;
  }
  .share-check-help {
    color: var(--text-muted);
    font-size: 0.75rem;
    line-height: 1.4;
  }
  .share-result {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.4;
    padding: 0.5rem 0.6rem;
    border-radius: 4px;
  }
  .share-ok {
    background: color-mix(in srgb, #2ecc71 18%, transparent);
    color: color-mix(in srgb, #2ecc71 80%, var(--text));
  }
  .share-err {
    background: color-mix(in srgb, #c0392b 22%, transparent);
    color: #fff;
  }
  .share-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.2rem;
  }
  .share-btn {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.35rem 0.85rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 40%, transparent);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .share-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .share-cancel:hover,
  .share-cancel:focus-visible {
    background: color-mix(in srgb, var(--chip-default-bg) 45%, transparent);
    outline: none;
  }
  .share-send {
    background: color-mix(in srgb, var(--text-muted) 22%, transparent);
  }
  .share-send:hover:not(:disabled),
  .share-send:focus-visible:not(:disabled) {
    background: color-mix(in srgb, var(--text-muted) 35%, transparent);
    outline: none;
  }
</style>
