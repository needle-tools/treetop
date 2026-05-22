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

export class PeerRegistry {
  private byId = new Map<string, Peer>();
  private selfId: string;

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
    this.byId.set(peer.id, {
      ...peer,
      // Default to the daemon port for back-compat with older
      // advertising peers that didn't ship a frontendPort TXT field.
      frontendPort: peer.frontendPort ?? peer.port,
      lastSeen: new Date().toISOString(),
    });
  }

  removePeer(id: string): void {
    this.byId.delete(id);
  }

  /** Snapshot — caller may mutate without affecting the registry. */
  peers(): Peer[] {
    return Array.from(this.byId.values());
  }
}
