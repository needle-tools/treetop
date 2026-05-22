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
import { PeerRegistry, type Peer } from "./peer-registry";

const SERVICE_TYPE = "supergit";

export interface DiscoveryOpts {
  port: number;
  id: string;
  label: string;
  version?: string;
}

export class PeerDiscovery {
  private bonjour: Bonjour | null = null;
  private service: ServiceType | null = null;
  private browser: BrowserType | null = null;
  readonly registry: PeerRegistry;

  constructor(private opts: DiscoveryOpts) {
    this.registry = new PeerRegistry({ selfId: opts.id });
  }

  /** Advertise ourselves and start browsing for other supergit
   *  daemons. Throws are swallowed — discovery is best-effort, the
   *  daemon must keep working even when the LAN has no mDNS at all. */
  start(): void {
    try {
      this.bonjour = new Bonjour();
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
    } catch (e) {
      console.warn(
        `supergit daemon: mDNS discovery disabled — ${
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
        this.bonjour?.destroy(() => resolve());
      } catch {
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
