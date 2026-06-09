/**
 * Pure in-memory registry of LAN peers discovered via mDNS. The mDNS
 * wrapper feeds it `addPeer` / `removePeer` events; HTTP routes read
 * `peers()` to render the Share dialog peer list.
 *
 * Two responsibilities only:
 *   - dedup by `(id, port)` (bonjour can report the same service
 *     through multiple interfaces — same uuid + port in TXT records,
 *     different hostnames). Note `(id, port)`, not `id` alone:
 *     siblings on the same host (dev daemon on 7777 + prod daemon on
 *     27787) share one workspace identity file and therefore one id,
 *     so collapsing by id alone hid one of them from every receiver
 *     on the LAN. Composite key lets both coexist.
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
  /** Result of the most recent active HTTP liveness probe (see
   *  PeerDiscovery.runHealthCheck). `undefined` until the first probe
   *  runs. Surfaced via /api/peers?diag=1 so a flaky peer is
   *  diagnosable without tailing logs. */
  lastProbeOk?: boolean;
  /** ISO timestamp of the most recent liveness probe attempt. */
  lastProbeAt?: string;
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

/** Composite key. `id` alone isn't enough because dev + prod daemons
 *  on the same host share one workspace identity. Including port lets
 *  both adverts coexist in the registry. */
function key(id: string, port: number): string {
  return `${id}:${port}`;
}

export class PeerRegistry {
  private byKey = new Map<string, Peer>();
  private selfId: string;
  /** Pending soft-remove timers keyed by `(id, port)`. An incoming
   *  `addPeer` for the same key cancels the timer so the peer
   *  survives the missed-announcement hiccup. */
  private removeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: RegistryOpts) {
    this.selfId = opts.selfId;
  }

  /** Late-bind the self id. Identity loads asynchronously at daemon
   *  startup; the registry exists before that so the bonjour browser
   *  has somewhere to deliver events. Once the id is known, this call
   *  also removes every entry that turns out to be us — including
   *  sibling daemons on the same host that share our id. */
  setSelfId(id: string): void {
    this.selfId = id;
    if (!id) return;
    for (const [k, p] of this.byKey) {
      if (p.id === id) {
        this.byKey.delete(k);
        const t = this.removeTimers.get(k);
        if (t) {
          clearTimeout(t);
          this.removeTimers.delete(k);
        }
      }
    }
  }

  addPeer(
    peer: Omit<Peer, "lastSeen" | "frontendPort"> & { frontendPort?: number },
  ): void {
    if (!peer.id || !peer.host || !peer.port || !peer.label) return;
    if (peer.id === this.selfId) return;
    const k = key(peer.id, peer.port);
    // Cancel any pending removal — the peer's still talking to us.
    const pending = this.removeTimers.get(k);
    if (pending) {
      clearTimeout(pending);
      this.removeTimers.delete(k);
    }
    this.byKey.set(k, {
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
   *  `port` is required: removal targets a specific `(id, port)`
   *  pair, not every advert from that id, so a dev daemon going down
   *  doesn't take its sibling prod daemon's entry with it. */
  removePeer(id: string, port: number, opts: { graceMs?: number } = {}): void {
    const k = key(id, port);
    const graceMs = opts.graceMs ?? 0;
    if (graceMs <= 0) {
      this.byKey.delete(k);
      const t = this.removeTimers.get(k);
      if (t) {
        clearTimeout(t);
        this.removeTimers.delete(k);
      }
      return;
    }
    // Already scheduled — don't reset the timer (otherwise repeated
    // 'down' events from bonjour would keep deferring the removal
    // forever).
    if (this.removeTimers.has(k)) return;
    this.removeTimers.set(
      k,
      setTimeout(() => {
        this.byKey.delete(k);
        this.removeTimers.delete(k);
      }, graceMs),
    );
  }

  /** Record the result of an active liveness probe against a peer.
   *  No-op if the peer is no longer in the registry (it may have been
   *  removed between snapshot and probe completion). */
  markProbe(id: string, port: number, ok: boolean, at: string): void {
    const peer = this.byKey.get(key(id, port));
    if (!peer) return;
    peer.lastProbeOk = ok;
    peer.lastProbeAt = at;
  }

  /** Snapshot — caller may mutate without affecting the registry. */
  peers(): Peer[] {
    return Array.from(this.byKey.values());
  }
}

/** Append `:${frontendPort}` to the label of every peer that collides
 *  with another peer on label alone. The collision group is what the
 *  user actually sees as ambiguous in the Share dialog / inbox — most
 *  often it's the dev + prod siblings from a single host (same
 *  `<username>@<hostname>` label, different ports). Peers with a
 *  unique label keep their advertised label untouched.
 *
 *  Pure: returns a new array, doesn't mutate the input.
 */
export function disambiguatePeerLabels(peers: Peer[]): Peer[] {
  const counts = new Map<string, number>();
  for (const p of peers) {
    counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  }
  return peers.map((p) =>
    (counts.get(p.label) ?? 0) > 1
      ? { ...p, label: `${p.label}:${p.frontendPort}` }
      : p,
  );
}

export { DEFAULT_REMOVE_GRACE_MS };
