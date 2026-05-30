/**
 * KVStore backed by the daemon's /api/prefs endpoint. Reads come from
 * an in-memory cache (synchronous, same interface as localStorage);
 * writes update the cache, localStorage, and fire a debounced PATCH
 * to the daemon.
 *
 * Lifecycle:
 *   1. main.ts calls `await initDaemonKV()` BEFORE mounting the app.
 *   2. That fetches /api/prefs, seeds localStorage with any daemon-side
 *      data (so native app inherits browser layout), and migrates the
 *      other direction if daemon is empty.
 *   3. App.svelte uses `getDaemonKV()` everywhere it used to pass
 *      `window.localStorage` to store constructors.
 */

import type { KVStore } from "./storage";
import { apiUrl } from "./api";

const MIGRATED_KEYS = [
  "supergit:notes-offsets",
  "supergit:notes-zorder",
  "supergit:openSessions",
  "supergit:commitsExpanded",
  "supergit:visibleWorktrees",
  "supergit:notesHidden",
  "supergit:dismissedShells",
  "supergit:dismissedSessions",
  "supergit:foldedRows",
  "supergit:summarize:lastModel",
  "supergit:fileBrowser:state",
  "supergit:fileBrowser:stars",
  "supergit:onboardingWalkthroughSeen",
  "supergit:commandTermSources",
] as const;

class DaemonKVStore implements KVStore {
  private cache: Record<string, string>;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPatch: Record<string, string> = {};

  constructor(initial: Record<string, string>) {
    this.cache = { ...initial };
  }

  getItem(key: string): string | null {
    return this.cache[key] ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    this.pendingPatch[key] = value;
    try {
      window.localStorage.setItem(key, value);
    } catch {}
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const patch = this.pendingPatch;
      this.pendingPatch = {};
      fetch(apiUrl("/api/prefs"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    }, 300);
  }
}

let instance: KVStore | null = null;

export async function initDaemonKV(): Promise<void> {
  let prefs: Record<string, string> = {};
  try {
    const res = await fetch(apiUrl("/api/prefs"));
    if (res.ok) prefs = await res.json();
  } catch {}

  const daemonHasData = Object.keys(prefs).length > 0;

  if (daemonHasData) {
    // Seed localStorage so the stores' initial load() sees daemon data.
    for (const [k, v] of Object.entries(prefs)) {
      try {
        window.localStorage.setItem(k, v as string);
      } catch {}
    }
  } else {
    // Daemon is empty — migrate localStorage to daemon.
    const patch: Record<string, string> = {};
    for (const key of MIGRATED_KEYS) {
      const val = window.localStorage.getItem(key);
      if (val !== null) {
        patch[key] = val;
        prefs[key] = val;
      }
    }
    if (Object.keys(patch).length > 0) {
      fetch(apiUrl("/api/prefs"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => {});
    }
  }

  instance = new DaemonKVStore(prefs);
}

export function getDaemonKV(): KVStore {
  return (
    instance ??
    (typeof window !== "undefined"
      ? window.localStorage
      : { getItem: () => null, setItem: () => {} })
  );
}
