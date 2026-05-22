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
}

export class PeerDiscovery {
  private bonjour: Bonjour | null = null;
  private service: ServiceType | null = null;
  private browser: BrowserType | null = null;
  private mdnsSocket: DgramSocket | null = null;
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
      // node_modules/bonjour-service/dist/lib/mdns-server.js. `socket`
      // injects our pre-built dgram; `interface` pins the outbound
      // multicast adapter (fixes the Windows multi-NIC case where
      // adverts otherwise went out on a WSL2 vEthernet instead of
      // the LAN); `reuseAddr` is kept as belt-and-braces in case a
      // future bonjour update stops honouring opts.socket.
      const mdnsOpts: Record<string, unknown> = {
        socket: this.mdnsSocket,
        reuseAddr: true,
      };
      if (this.opts.interfaceAddress) {
        mdnsOpts.interface = this.opts.interfaceAddress;
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
        },
      });
      this.browser = this.bonjour.find({ type: SERVICE_TYPE }, (svc) => {
        this.onUp(svc);
      });
      this.browser.on("up", (svc: ServiceType) => this.onUp(svc));
      this.browser.on("down", (svc: ServiceType) => this.onDown(svc));
      this.enabled = true;
    } catch (e) {
      console.error(
        `supergit daemon: mDNS discovery disabled (${process.platform}) — ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      try {
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
      version,
    });
  }

  private onDown(svc: ServiceType): void {
    const txt = (svc.txt ?? {}) as Record<string, unknown>;
    if (typeof txt.id === "string") this.registry.removePeer(txt.id);
  }
}
