/**
 * mDNS-based peer discovery. Wraps `bonjour-service` so the rest of
 * the daemon talks to a tiny class with `start` / `stop` / `peers`,
 * and the pure `PeerRegistry` does the dedup + self-filter logic.
 *
 * Service shape:
 *   - type:     `_supergit._tcp.local`
 *   - port:     daemon's HTTP port
 *   - txt:      { id, label, version }
 *
 * `id` is the load-bearing field — it's how other peers dedupe our
 * advertisement across interfaces and filter out their own echo.
 * `label` is what the UI renders. `version` is informational.
 *
 * Failure mode: if bonjour throws at construction (no IPv4 interfaces,
 * platform-level mDNS daemon missing, port collision, …), we log and
 * keep going with an empty peer list. The Share dialog still works
 * via the manual host:port fallback.
 */

// `bonjour-service` is a CommonJS package that exposes the class via
// `export =`, so we import the default and reach into the inner
// module for the Service type. Both are runtime values that we also
// use as types — the helpers below alias them as types only.
import Bonjour from "bonjour-service";
import type BrowserType from "bonjour-service/dist/lib/browser";
import type ServiceType from "bonjour-service/dist/lib/service";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import { PeerRegistry, type Peer } from "./peer-registry";

const SERVICE_TYPE = "supergit";

export interface DiscoveryOpts {
  port: number;
  id: string;
  label: string;
  version?: string;
  /** IPv4 address of the network interface multicast traffic should
   *  use. On hosts with multiple adapters (Windows boxes with WSL2 /
   *  Hyper-V / VPN virtual switches, multi-homed Macs) bonjour
   *  otherwise picks one of them based on routing-table ordering —
   *  often a virtual switch, so the advert never reaches the LAN.
   *  Caller derives this via `findLocalIp()`; passing `undefined`
   *  falls back to bonjour's default selection. */
  interfaceAddress?: string;
  /** Port the user can hit in a browser to open this peer's
   *  dashboard. In prod the daemon serves the UI itself and this
   *  equals `port`; in dev Vite serves the UI separately so it's a
   *  different port (conventionally 7779). The Share dialog and
   *  inbox surface this as an "Open dashboard" link. */
  frontendPort?: number;
}

export class PeerDiscovery {
  private bonjour: Bonjour | null = null;
  private service: ServiceType | null = null;
  private browser: BrowserType | null = null;
  private mdnsSocket: DgramSocket | null = null;
  /** Active HTTP liveness check. mDNS `'down'` events are advisory
   *  (and aggressive), and a daemon that dies hard never emits one
   *  at all, so we also probe each known peer's /api/identity
   *  periodically. Two consecutive failures = remove. */
  private healthCheck: ReturnType<typeof setInterval> | null = null;
  private failedHealthChecks = new Map<string, number>();
  /** Diagnostic set to true after a successful start. Stays false when
   *  bonjour init failed (logged separately) so the UI could surface
   *  "mDNS unavailable" later if we want. */
  enabled = false;
  readonly registry: PeerRegistry;

  constructor(private opts: DiscoveryOpts) {
    this.registry = new PeerRegistry({ selfId: opts.id });
  }

  /** Advertise ourselves and start browsing for other supergit
   *  daemons. Throws are surfaced via `console.error` (previously
   *  `console.warn` — too easy to miss in a noisy log) but never
   *  rethrown: the daemon must keep working when the LAN has no mDNS
   *  at all (corporate network, container, port collision). */
  start(): void {
    try {
      // We build the multicast UDP socket ourselves so we can set
      // BOTH `reuseAddr` AND `reusePort`. multicast-dns (the lib
      // bonjour-service wraps) only sets `reuseAddr`, which is
      // sufficient on Linux but NOT on macOS: a second daemon on the
      // same host hits EADDRINUSE on UDP 5353 unless SO_REUSEPORT is
      // also set. Symptom this fixed: Mac dev daemon (port 7777)
      // ran fine, Mac prod daemon (port 27787) started but its
      // bonjour silently never received any packets and never
      // advertised, so the other machine on the LAN saw only dev.
      //
      // `reusePort` is Linux/macOS only — Windows's WSASocketW lacks
      // the equivalent and Node throws ENOTSUP if we set it. On
      // Windows we fall back to reuseAddr alone (which works fine
      // because Windows is more permissive about SO_REUSEADDR than
      // BSD-derived stacks). Node's dgram exposes `reusePort` from
      // v18.14; Bun supports it too.
      const socketOpts: { type: "udp4"; reuseAddr: boolean; reusePort?: boolean } = {
        type: "udp4",
        reuseAddr: true,
      };
      if (process.platform !== "win32") {
        socketOpts.reusePort = true;
      }
      this.mdnsSocket = createSocket(socketOpts);
      this.mdnsSocket.on("error", (err) => {
        console.error(
          `supergit daemon: mDNS socket error (${process.platform}) — ${err.message}`,
        );
      });

      // multicast-dns options flow through Bonjour's constructor →
      // Server → multicast-dns(opts) — see
      // node_modules/bonjour-service/dist/lib/mdns-server.js.
      //   - `socket` injects our pre-built dgram (gets SO_REUSEPORT
      //     handling above).
      //   - `interface` pins the outbound multicast adapter and the
      //     addMembership() call to the LAN interface (fixes the
      //     Windows multi-NIC WSL2 case where adverts otherwise went
      //     out on a vEthernet adapter).
      //   - `bind` is the bind-time IP for the UDP socket.
      //     multicast-dns defaults to `opts.bind || opts.interface`,
      //     which means setting `interface` ALSO pins the bind to a
      //     specific unicast IP. That's the right thing on Windows
      //     (multicast reception requires bind to the interface IP
      //     there) but the WRONG thing on macOS/BSD, which filters
      //     incoming multicast (destined for 224.0.0.251) away from
      //     a socket bound to a non-multicast unicast IP.
      //     So on macOS we force bind to 0.0.0.0 — addMembership()
      //     still scopes the membership to the right interface.
      //     Symptom this gated fix: macOS's own mDNSResponder saw
      //     every peer on the LAN, but our bonjour browser saw
      //     none; meanwhile Windows worked fine with the existing
      //     interface-IP bind.
      //   - `reuseAddr` is kept as belt-and-braces in case a future
      //     bonjour update stops honouring opts.socket.
      const mdnsOpts: Record<string, unknown> = {
        socket: this.mdnsSocket,
        reuseAddr: true,
      };
      if (this.opts.interfaceAddress) {
        mdnsOpts.interface = this.opts.interfaceAddress;
      }
      if (process.platform === "darwin") {
        mdnsOpts.bind = "0.0.0.0";
      }
      // The TS types restrict the constructor's first arg to
      // ServiceConfig, but at runtime mdns options pass through.
      // The second arg is an errorCallback bonjour invokes when its
      // probe / publish / advertise pipeline hits an error — used to
      // be silently rethrown, now logged.
      this.bonjour = new Bonjour(mdnsOpts as never, (err: Error) => {
        console.error(
          `supergit daemon: mDNS publish/probe error (${process.platform}) — ${err.message}`,
        );
      });
      // The mDNS service name has to be unique on the LAN per
      // (type, name) pair — two supergit daemons on the same box (or
      // two laptops with the same user@host) would otherwise collide
      // and the second advert would be rejected with "Service name
      // is already in use on the network". The TXT records carry the
      // human label and id verbatim, so this suffix only affects the
      // raw mDNS record name; the UI never sees it.
      const serviceName = `${this.opts.label} [${this.opts.id.slice(0, 8)}]`;
      this.service = this.bonjour.publish({
        name: serviceName,
        type: SERVICE_TYPE,
        port: this.opts.port,
        txt: {
          id: this.opts.id,
          label: this.opts.label,
          version: this.opts.version ?? "",
          // frontendPort is the *user-visible* port (where the
          // browser dashboard lives). In prod that matches the
          // daemon API port; in dev Vite serves the UI elsewhere.
          // Stringify because TXT values are byte strings.
          frontendPort: String(this.opts.frontendPort ?? this.opts.port),
        },
      });
      this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (svc) => {
        this.onUp(svc);
      });
      this.browser.on("up", (svc: ServiceType) => this.onUp(svc));
      this.browser.on("down", (svc: ServiceType) => this.onDown(svc));
      this.enabled = true;
      // Active liveness probe — see field comment above. 30s cadence
      // catches "daemon died hard" within ~60s (two failures), which
      // a missing bonjour 'down' event would never tell us about.
      this.healthCheck = setInterval(() => {
        void this.runHealthCheck();
      }, 30_000);
    } catch (e) {
      console.error(
        `supergit daemon: mDNS discovery disabled (${process.platform}) — ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /** Probe each known peer's /api/identity once. A peer that fails
   *  the probe twice in a row gets removed without grace — bonjour
   *  may never fire 'down' for a daemon that died hard (kill -9,
   *  network drop, sleep), so we can't rely on it for liveness.
   *  Successful probes clear the failure counter. */
  private async runHealthCheck(): Promise<void> {
    const known = this.registry.peers();
    await Promise.all(
      known.map(async (peer) => {
        const url = `http://${peer.host}:${peer.port}/api/identity`;
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 3000);
          const res = await fetch(url, { signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // Reachable — clear any pending failure count.
          this.failedHealthChecks.delete(peer.id);
        } catch {
          const fails = (this.failedHealthChecks.get(peer.id) ?? 0) + 1;
          if (fails >= 2) {
            this.registry.removePeer(peer.id, peer.port);
            this.failedHealthChecks.delete(peer.id);
          } else {
            this.failedHealthChecks.set(peer.id, fails);
          }
        }
      }),
    );
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      try {
        if (this.healthCheck) {
          clearInterval(this.healthCheck);
          this.healthCheck = null;
        }
        this.failedHealthChecks.clear();
        this.browser?.stop();
        this.service?.stop?.(() => {});
        this.bonjour?.destroy(() => {
          try {
            this.mdnsSocket?.close();
          } catch {}
          this.mdnsSocket = null;
          this.enabled = false;
          resolve();
        });
      } catch {
        try {
          this.mdnsSocket?.close();
        } catch {}
        this.mdnsSocket = null;
        this.enabled = false;
        resolve();
      }
    });
  }

  peers(): Peer[] {
    return this.registry.peers();
  }

  private onUp(svc: ServiceType): void {
    const txt = (svc.txt ?? {}) as Record<string, unknown>;
    const id = typeof txt.id === "string" ? txt.id : "";
    const label = typeof txt.label === "string" ? txt.label : svc.name;
    const version = typeof txt.version === "string" ? txt.version : undefined;
    // frontendPort comes back as a string from TXT records — parse to
    // number and fall back to the daemon port when absent / malformed
    // (older daemons didn't advertise this field).
    let frontendPort: number | undefined;
    if (typeof txt.frontendPort === "string") {
      const n = Number(txt.frontendPort);
      if (Number.isInteger(n) && n > 0 && n < 65536) frontendPort = n;
    }
    const host =
      (Array.isArray(svc.addresses) &&
        svc.addresses.find((a: string) => !a.includes(":"))) ||
      svc.host ||
      "";
    if (!id || !host) return;
    this.registry.addPeer({
      id,
      label,
      host,
      port: svc.port,
      frontendPort,
      version,
    });
  }

  private onDown(svc: ServiceType): void {
    const txt = (svc.txt ?? {}) as Record<string, unknown>;
    // bonjour-service emits `'down'` aggressively — a missed multicast
    // announcement is enough to fire it even when the peer is still
    // alive. Defer the removal so a follow-up `'up'` (the peer's
    // next periodic re-announce) cancels it and the UI doesn't
    // flicker offline → online over a single dropped packet.
    if (typeof txt.id === "string" && typeof svc.port === "number") {
      this.registry.removePeer(txt.id, svc.port, { graceMs: 60_000 });
    }
  }
}
