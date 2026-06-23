/**
 * Polls `/api/peers` and chimes when a new LAN peer (another supergit
 * daemon discovered via mDNS) joins.
 *
 * Two dedup layers:
 *  - in-memory `knownKeys` — every previously-seen peer in this tab
 *    is suppressed, including all peers visible at startup (we seed
 *    the set on first response so a reload doesn't replay every
 *    already-online peer).
 *  - per-host 60-minute localStorage cooldown — if the same host
 *    appears within an hour (e.g. it dropped + came back), we stay
 *    silent. Outlives reloads so two tabs aren't louder than one.
 */

import { apiUrl } from "./api";
import { play } from "./sound";

interface PeerEntry {
  id: string;
  host: string;
  port: number;
  label?: string;
}

interface PeersResponse {
  peers?: PeerEntry[];
}

const POLL_INTERVAL_MS = 15_000;
const PER_HOST_COOLDOWN_MS = 60 * 60 * 1000;
const HOST_COOLDOWN_KEY = (host: string) =>
  `supergit.peer-connect-last.${host}`;

let timer: ReturnType<typeof setInterval> | null = null;
let knownKeys: Set<string> | null = null;
let tickInFlight: Promise<void> | null = null;
let tickAgain = false;

function peerKey(p: PeerEntry): string {
  return `${p.id}:${p.host}:${p.port}`;
}

function hostCooldownActive(host: string): boolean {
  try {
    const last = Number(localStorage.getItem(HOST_COOLDOWN_KEY(host))) || 0;
    return Date.now() - last < PER_HOST_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function stampHost(host: string): void {
  try {
    localStorage.setItem(HOST_COOLDOWN_KEY(host), String(Date.now()));
  } catch {
    // localStorage unavailable — still play, just no persisted dedup
  }
}

async function runTick(): Promise<void> {
  let peers: PeerEntry[] = [];
  try {
    const res = await fetch(apiUrl("/api/peers"));
    if (!res.ok) return;
    const body = (await res.json()) as PeersResponse;
    peers = body.peers ?? [];
  } catch {
    return;
  }
  // First response: seed the set without playing anything. We don't
  // want to chime once per already-connected peer on every page load.
  if (knownKeys === null) {
    knownKeys = new Set(peers.map(peerKey));
    return;
  }
  const next = new Set<string>();
  for (const p of peers) {
    const k = peerKey(p);
    next.add(k);
    if (knownKeys.has(k)) continue;
    if (!p.host) continue;
    if (hostCooldownActive(p.host)) continue;
    stampHost(p.host);
    play("lan-peer-connect");
  }
  knownKeys = next;
}

function tick(): Promise<void> {
  if (tickInFlight) {
    tickAgain = true;
    return tickInFlight;
  }
  tickInFlight = (async () => {
    try {
      do {
        tickAgain = false;
        await runTick();
      } while (tickAgain);
    } finally {
      tickInFlight = null;
    }
  })();
  return tickInFlight;
}

export function startPeerWatcher(): void {
  if (timer) return;
  // Kick off immediately so the seed-set is established quickly,
  // then settle into the regular cadence.
  void tick();
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
}

export function stopPeerWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  knownKeys = null;
}
