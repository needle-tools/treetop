/**
 * Recent picks for the mention picker. One list per provider, deduped
 * by (provider × value), most-recent-first, capped at CAP entries
 * so localStorage stays bounded.
 *
 * The store deliberately stores the FULL PickItem (not just the
 * value) so the popover can render a recent without re-hitting the
 * network — e.g. show "abc1234 · fix the foo · 2d · marcel" even
 * before /api/commits responds. The trade-off is staleness: if a
 * session's title gets edited, the recent shows the old title until
 * the user re-picks it. Acceptable for a UI hint.
 *
 * Storage is keyed by `STORAGE_KEY` (one workspace = one bucket).
 * If the future grows a per-workspace recents requirement, the key
 * can take a workspace suffix; nothing else changes.
 */

import { writable, type Writable } from "svelte/store";
import type { PickItem, ProviderId } from "./mention-types";

export const STORAGE_KEY = "supergit:mentions-recents";
/** Bump when the PickItem shape changes in a way that would render
 *  stale entries incorrectly (e.g. subtitle field changed meaning).
 *  On a version mismatch we wipe — these are recency hints, not
 *  load-bearing data, so a clean slate is cheaper than a migration. */
const VERSION_KEY = "supergit:mentions-recents-version";
const CURRENT_VERSION = 2;
export const CAP = 12;

type RecentsState = Partial<Record<ProviderId, PickItem[]>>;

function loadRaw(): RecentsState {
  if (typeof localStorage === "undefined") return {};
  try {
    const stored = localStorage.getItem(VERSION_KEY);
    if (stored !== String(CURRENT_VERSION)) {
      // Wipe stale entries from a previous PickItem shape and write
      // the new version stamp so the next read short-circuits.
      localStorage.removeItem(STORAGE_KEY);
      localStorage.setItem(VERSION_KEY, String(CURRENT_VERSION));
      return {};
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Defensive shape check — older versions of supergit may have
    // written a different schema here, and we shouldn't blow up an
    // unrelated UI just because a key is malformed.
    const out: RecentsState = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) {
        out[k as ProviderId] = v.filter(
          (item): item is PickItem =>
            !!item &&
            typeof item === "object" &&
            typeof (item as PickItem).id === "string" &&
            typeof (item as PickItem).value === "string",
        );
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveRaw(state: RecentsState): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota or private-mode failure — recents are non-essential, drop silently.
  }
}

/** Single shared store so the picker, recents lists, and any future
 *  "remove from recents" UI all reactively agree. */
export const recents: Writable<RecentsState> = writable(loadRaw());

/** Push a pick to the front of its provider's recents list, deduped
 *  by value within the provider. Pure dedup-and-cap math is exported
 *  as `dedupAndCap` so the test suite can exercise it without
 *  touching the store. */
export function pushRecent(item: PickItem): void {
  recents.update((state) => {
    const next: RecentsState = { ...state };
    const existing = next[item.providerId] ?? [];
    next[item.providerId] = dedupAndCap(item, existing);
    saveRaw(next);
    return next;
  });
}

/** Drop a single entry (by value) from a provider's recents — used
 *  by the popover's future "remove from recents" affordance. Not
 *  surfaced yet but the function is here so the store stays the
 *  single owner of the data shape. */
export function removeRecent(providerId: ProviderId, value: string): void {
  recents.update((state) => {
    const list = state[providerId];
    if (!list) return state;
    const filtered = list.filter((it) => it.value !== value);
    if (filtered.length === list.length) return state;
    const next = { ...state, [providerId]: filtered };
    saveRaw(next);
    return next;
  });
}

/** Pure dedup + cap, factored out so we can unit-test the math
 *  without a DOM/store. New item goes to the front; any prior entry
 *  with the same `value` is removed; the result is sliced to CAP. */
export function dedupAndCap(item: PickItem, existing: PickItem[]): PickItem[] {
  const withoutDup = existing.filter((it) => it.value !== item.value);
  return [item, ...withoutDup].slice(0, CAP);
}
