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
  import { onDestroy } from "svelte";
  import { apiUrl } from "./api";
  import {
    activeShare,
    closeShare,
    rememberPeer,
    recallPeer,
  } from "./share-session-dialog";

  interface DiscoveredPeer {
    id: string;
    label: string;
    host: string;
    /** Daemon HTTP API port — used as the destination for the
     *  /api/sessions/offer POST (and pre-filled into the manual
     *  host:port input below the peer list). */
    port: number;
    /** Browser-openable port for this peer's dashboard. In prod it
     *  matches `port`; in dev Vite serves the UI on a separate port.
     *  Falls back to `port` on the daemon side when older peers don't
     *  advertise this field. */
    frontendPort?: number;
    version?: string;
    lastSeen?: string;
  }

  interface PeerDiscoveryStatus {
    enabled: boolean;
    interfaceAddress: string | null;
    port: number;
    initError: string | null;
    platform: string;
  }

  let peerInput = "";
  // Two independent privacy toggles. Defaults match the daemon's
  // conservative stance: tool outputs stripped, secrets redacted.
  let includeToolOutputs = false;
  let redactSecrets = true;
  let sending = false;
  let result:
    | { kind: "idle" }
    | {
        kind: "ok";
        offerId: string;
        toolOutputs: "stripped" | "included";
        strippedCount: number;
        secrets: "redacted" | "raw";
        redactions: Array<{ kind: string; count: number }>;
      }
    | { kind: "error"; message: string } = { kind: "idle" };

  // mDNS-discovered peers, refreshed on a short interval while the
  // dialog is open. Empty list is the common state when nothing else
  // on the LAN is running supergit — manual host:port input below is
  // always available regardless.
  let peers: DiscoveredPeer[] = [];
  // Composite `${id}:${port}` — matches the each-block key. Selecting
  // by `id` alone would light up dev+prod siblings together since they
  // share one workspace identity. See peer-registry.ts.
  let selectedPeerKey: string | null = null;
  let peersPoll: ReturnType<typeof setInterval> | null = null;
  let discoveryStatus: PeerDiscoveryStatus | null = null;

  async function refreshPeers() {
    try {
      const res = await fetch(apiUrl("/api/peers?diag=1"));
      if (!res.ok) return;
      const body = (await res.json()) as {
        peers?: DiscoveredPeer[];
        discovery?: PeerDiscoveryStatus;
      };
      peers = body.peers ?? [];
      discoveryStatus = body.discovery ?? null;
    } catch {
      // best-effort — discovery isn't load-bearing, manual input wins.
    }
  }

  $: lanInfo = (() => {
    if (!discoveryStatus) {
      return {
        kind: "unknown",
        title: "Checking LAN discovery",
        text: "Looking up whether this supergit is advertising on your local network. You can still use host:port below.",
      };
    }
    if (
      discoveryStatus.initError &&
      discoveryStatus.initError !== "peer discovery not initialized"
    ) {
      return {
        kind: "error",
        title: "LAN discovery did not start",
        text: discoveryStatus.initError,
      };
    }
    if (!discoveryStatus.enabled) {
      return {
        kind: "off",
        title: "LAN discovery is off",
        text: "This supergit is not advertising on the local network, so peers cannot be discovered automatically. Use the LAN button in the header to enable it, or enter host:port below.",
      };
    }
    return {
      kind: "on",
      title: "LAN discovery is on",
      text: discoveryStatus.interfaceAddress
        ? `Listening on ${discoveryStatus.interfaceAddress}:${discoveryStatus.port}. No other supergit peers have been discovered yet.`
        : "This supergit is advertising on your local network. No other supergit peers have been discovered yet.",
    };
  })();

  // Reset state every time the dialog opens with a fresh source so
  // a previous send's success/error message doesn't carry over.
  let lastSource: string | null = null;
  $: if ($activeShare && $activeShare.source !== lastSource) {
    lastSource = $activeShare.source;
    peerInput = recallPeer();
    selectedPeerKey = null;
    includeToolOutputs = false;
    redactSecrets = true;
    sending = false;
    result = { kind: "idle" };
    discoveryStatus = null;
    void refreshPeers();
    // Poll while open; 3s is short enough to feel live, long enough
    // not to spam the daemon. Cleared on close + onDestroy below.
    if (peersPoll) clearInterval(peersPoll);
    peersPoll = setInterval(refreshPeers, 3000);
  }
  $: if (!$activeShare) {
    lastSource = null;
    if (peersPoll) {
      clearInterval(peersPoll);
      peersPoll = null;
    }
  }
  onDestroy(() => {
    if (peersPoll) clearInterval(peersPoll);
  });

  function pickPeer(p: DiscoveredPeer) {
    selectedPeerKey = `${p.id}:${p.port}`;
    peerInput = `${p.host}:${p.port}`;
  }

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
      const res = await fetch(apiUrl("/api/sessions/send"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: $activeShare.source,
          peerHost: parsedPeer.host,
          peerPort: parsedPeer.port,
          includeToolOutputs,
          redactSecrets,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        offerId?: string;
        toolOutputs?: "stripped" | "included";
        strippedCount?: number;
        secrets?: "redacted" | "raw";
        redactions?: Array<{ kind: string; count: number }>;
        error?: string;
      } | null;
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
        toolOutputs:
          body?.toolOutputs ?? (includeToolOutputs ? "included" : "stripped"),
        strippedCount: body?.strippedCount ?? 0,
        secrets: body?.secrets ?? (redactSecrets ? "redacted" : "raw"),
        redactions: body?.redactions ?? [],
      };
    } catch (e) {
      result = {
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      };
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
      <h2 id="share-title" class="share-title">
        Share session in local network
      </h2>
      <p class="share-blurb">
        Ship this session to another supergit on your LAN. Tool outputs are
        stripped and common secrets (GitHub, npm, Stripe, AWS, …) are redacted
        before send.
      </p>

      <div class="share-field">
        <span class="share-label">Peers on this network</span>
        {#if peers.length > 0}
          <ul class="share-peers">
            <!-- Composite key: dev + prod daemons on the same host share
                 one workspace identity (same `id`) but advertise on
                 different ports. Keying on `id` alone would crash with
                 `each_key_duplicate`. See peer-registry.ts. -->
            {#each peers as p (`${p.id}:${p.port}`)}
              <button
                type="button"
                class="share-peer"
                class:share-peer-selected={selectedPeerKey ===
                  `${p.id}:${p.port}`}
                on:click={() => pickPeer(p)}
              >
                <span class="share-peer-label">{p.label}</span>
                <span
                  class="share-peer-host"
                  title={`Open ${p.label}'s dashboard (daemon API on :${p.port})`}
                >
                  {p.host}:{p.frontendPort ?? p.port}
                </span>
              </button>
            {/each}
          </ul>
        {:else}
          <div
            class="share-lan-info"
            class:share-lan-info-on={lanInfo.kind === "on"}
            class:share-lan-info-off={lanInfo.kind === "off"}
            class:share-lan-info-error={lanInfo.kind === "error"}
            role={lanInfo.kind === "error" ? "alert" : "status"}
          >
            <span class="share-lan-info-title">{lanInfo.title}</span>
            <span class="share-lan-info-text">{lanInfo.text}</span>
          </div>
        {/if}
      </div>

      <label class="share-field">
        <span class="share-label">Or enter host:port</span>
        <input
          type="text"
          class="share-input"
          placeholder="192.168.1.42:27787"
          bind:value={peerInput}
          on:input={() => {
            selectedPeerKey = null;
          }}
          autocomplete="off"
          spellcheck="false"
        />
      </label>

      <label class="share-check">
        <input type="checkbox" bind:checked={includeToolOutputs} />
        <span class="share-check-text">
          <span class="share-check-label">Include tool outputs</span>
          <span class="share-check-help">
            Off (recommended): tool result blocks are stripped before send. On:
            the full transcript (env dumps, file contents, command output) goes
            through as-is.
          </span>
        </span>
      </label>

      <label class="share-check">
        <input type="checkbox" bind:checked={redactSecrets} />
        <span class="share-check-text">
          <span class="share-check-label">Strip recognised secrets</span>
          <span class="share-check-help">
            On (recommended): keys matching known formats (GitHub, npm, Stripe,
            AWS, Anthropic, OpenAI, JWT, PEM, …) get redacted. Off: the
            transcript is shipped verbatim.
          </span>
        </span>
      </label>

      {#if result.kind === "error"}
        <p class="share-result share-err" role="alert">{result.message}</p>
      {:else if result.kind === "ok"}
        <p class="share-result share-ok">
          Offer sent.
          {#if result.toolOutputs === "stripped"}
            Stripped {result.strippedCount} tool output{result.strippedCount ===
            1
              ? ""
              : "s"}.
          {:else}
            Tool outputs included.
          {/if}
          {#if result.secrets === "redacted" && result.redactions.length > 0}
            Redacted {result.redactions.reduce((n, r) => n + r.count, 0)} likely secret{result.redactions.reduce(
              (n, r) => n + r.count,
              0,
            ) === 1
              ? ""
              : "s"}
            ({result.redactions
              .map((r) => `${r.count}× ${r.kind}`)
              .join(", ")}).
          {:else if result.secrets === "raw"}
            Secrets NOT redacted.
          {/if}
        </p>
      {/if}

      <div class="share-buttons">
        <button
          type="button"
          class="share-btn share-cancel"
          on:click={closeShare}
        >
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
  .share-peers {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 180px;
    overflow-y: auto;
  }
  .share-peer {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.45rem 0.6rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
    background: color-mix(in srgb, var(--surface-2) 35%, transparent);
    color: inherit;
    font: inherit;
    cursor: pointer;
    text-align: left;
  }
  .share-peer:hover {
    background: color-mix(in srgb, var(--surface-2) 60%, transparent);
    border-color: color-mix(in srgb, var(--text-muted) 50%, transparent);
  }
  .share-peer-selected {
    border-color: var(
      --brand,
      color-mix(in srgb, var(--text-muted) 70%, transparent)
    );
    background: color-mix(in srgb, var(--brand) 14%, transparent);
  }
  /* Defined AFTER `.share-peer:hover` so it wins on equal specificity
     when hovering a selected row — otherwise the muted hover would
     strip the brand tint and the row looks unselected mid-hover. */
  .share-peer-selected:hover {
    background: color-mix(in srgb, var(--brand) 22%, transparent);
    border-color: var(
      --brand,
      color-mix(in srgb, var(--text-muted) 70%, transparent)
    );
  }
  .share-peer-label {
    font-weight: 500;
    color: var(--text-1, inherit);
  }
  .share-peer-host {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.72rem;
    color: var(--text-muted);
  }
  .share-lan-info {
    margin: 0;
    padding: 0.5rem 0.6rem;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--text-muted) 18%, transparent);
    background: color-mix(in srgb, var(--surface-2) 25%, transparent);
    color: var(--text-muted);
    font-size: 0.75rem;
    line-height: 1.4;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .share-lan-info-on {
    border-color: color-mix(in srgb, #2ecc71 35%, transparent);
    background: color-mix(in srgb, #2ecc71 10%, transparent);
  }
  .share-lan-info-off {
    border-color: color-mix(in srgb, #f1c40f 35%, transparent);
    background: color-mix(in srgb, #f1c40f 10%, transparent);
  }
  .share-lan-info-error {
    border-color: color-mix(in srgb, #c0392b 45%, transparent);
    background: color-mix(in srgb, #c0392b 14%, transparent);
    color: color-mix(in srgb, #fff 88%, var(--text));
  }
  .share-lan-info-title {
    color: var(--text-1, inherit);
    font-weight: 600;
  }
  .share-lan-info-text {
    color: inherit;
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
