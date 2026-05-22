/**
 * Pure in-memory registry of LAN peers discovered via mDNS. The mDNS
 * wrapper feeds it `addPeer` / `removePeer` events; HTTP routes read
 * `peers()` to render the Share dialog peer list.
 *
 * Two responsibilities only:
 *   - dedup by `id` (bonjour can report the same service through
 *     multiple interfaces — same uuid in TXT records, different
 *     hostnames),
 *   - filter out our own advertisement (selfId).
 *
 * Decoupled from `bonjour-service` so the daemon can run in test
 * environments without mDNS, and so the logic is unit-testable.
 */

export interface Peer {
  /** Stable uuid from the peer's TXT record. Survives daemon restarts;
   *  changing this would make the peer appear "new" to everyone else. */
  id: string;
  label: string;
  host: string;
  /** Daemon HTTP API port — what supergit-internal traffic
   *  (session offers, message send) hits. */
  port: number;
  /** Port the user opens in a browser to see this peer's dashboard.
   *  In prod that matches `port`; in dev Vite serves the UI elsewhere
   *  (conventionally 7779). Falls back to `port` when the advertising
   *  peer didn't provide it (older daemons). */
  frontendPort: number;
  version?: string;
  /** ISO timestamp of the last time this peer's advertisement was
   *  observed (or refreshed). The UI can hide stale entries if it
   *  cares, but bonjour fires 'down' events reliably enough that we
   *  don't actively expire by time. */
  lastSeen: string;
}

export interface RegistryOpts {
  /** Our own daemon's peer id. Any addPeer with this id is dropped on
   *  the floor — that's how we filter out the echo of our own
   *  advertisement that bonjour sees on most platforms. Empty string
   *  is allowed during the brief window between PeerRegistry
   *  construction and identity-file load on daemon startup. */
  selfId: string;
}

/** How long to keep a peer visible after bonjour fires a `'down'`
 *  event for it. bonjour-service emits `'down'` aggressively — a
 *  single missed multicast announcement can trigger it even though
 *  the peer is still alive and will re-announce on its next cycle
 *  (~30-60s). Without this grace, peers flicker offline → online
 *  every time the LAN drops a packet. */
const DEFAULT_REMOVE_GRACE_MS = 60_000;

export class PeerRegistry {
  private byId = new Map<string, Peer>();
  private selfId: string;
  /** Pending soft-remove timers keyed by peer id. An incoming
   *  `addPeer` for the same id cancels the timer so the peer survives
   *  the missed-announcement hiccup. */
  private removeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: RegistryOpts) {
    this.selfId = opts.selfId;
  }

  /** Late-bind the self id. Identity loads asynchronously at daemon
   *  startup; the registry exists before that so the bonjour browser
   *  has somewhere to deliver events. Once the id is known, this call
   *  also removes any peer that turns out to be us. */
  setSelfId(id: string): void {
    this.selfId = id;
    if (id) this.byId.delete(id);
  }

  addPeer(peer: Omit<Peer, "lastSeen" | "frontendPort"> & { frontendPort?: number }): void {
    if (!peer.id || !peer.host || !peer.port || !peer.label) return;
    if (peer.id === this.selfId) return;
    // Cancel any pending removal — the peer's still talking to us.
    const pending = this.removeTimers.get(peer.id);
    if (pending) {
      clearTimeout(pending);
      this.removeTimers.delete(peer.id);
    }
    this.byId.set(peer.id, {
      ...peer,
      // Default to the daemon port for back-compat with older
      // advertising peers that didn't ship a frontendPort TXT field.
      frontendPort: peer.frontendPort ?? peer.port,
      lastSeen: new Date().toISOString(),
    });
  }

  /** Schedule (or immediately do) the removal of a peer.
   *  `opts.graceMs` defers actual removal — used by the bonjour
   *  wrapper on `'down'` events to absorb missed announcements.
   *  Default behaviour (no grace) is immediate, kept so existing
   *  callers + tests work unchanged. */
  removePeer(
    id: string,
    opts: { graceMs?: number } = {},
  ): void {
    const graceMs = opts.graceMs ?? 0;
    if (graceMs <= 0) {
      this.byId.delete(id);
      const t = this.removeTimers.get(id);
      if (t) {
        clearTimeout(t);
        this.removeTimers.delete(id);
      }
      return;
    }
    // Already scheduled — don't reset the timer (otherwise repeated
    // 'down' events from bonjour would keep deferring the removal
    // forever).
    if (this.removeTimers.has(id)) return;
    this.removeTimers.set(
      id,
      setTimeout(() => {
        this.byId.delete(id);
        this.removeTimers.delete(id);
      }, graceMs),
    );
  }

  /** Snapshot — caller may mutate without affecting the registry. */
  peers(): Peer[] {
    return Array.from(this.byId.values());
  }
}

export { DEFAULT_REMOVE_GRACE_MS };
