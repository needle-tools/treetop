/**
 * Concrete picker providers — sessions and commits. Each provider
 * owns its data fetch + filter; the popover never touches /api/*.
 *
 * Sessions reuse the search dock's ranker (`scoreSession` in
 * sessionSearch.ts) and its display-title function so the @-mention
 * picker and the sessions list never disagree on what a row is
 * called or how relevant it is to the current query.
 *
 * Commits keep their own lightweight scorer (substring + ordered-
 * subsequence) — there's no shared dock for commits to align with.
 */

import type {
  PickItem,
  Provider,
  SearchScope,
} from "./mention-types";
import { scoreSession, sessionDisplayTitle, type AgentSession } from "./sessionSearch";

/** Per-URL in-flight + resolved cache. Picker re-renders are
 *  reactive on `scope` and `$recents`, which can flicker by identity
 *  even when nothing the user-visible changed; without this cache
 *  every render kicks off a fresh /api/agents + /api/commits hit
 *  and the popover feels laggy on every keystroke / focus change.
 *
 *  - In-flight: dedup concurrent callers onto a single Promise so we
 *    never have two parallel requests for the same URL.
 *  - Resolved: returned instantly while `now - ts < TTL`; after that
 *    the next caller refetches but the stale value is still served
 *    to anyone waiting on the in-flight slot.
 *  TTL is generous (5s) because sessions/commits move on the
 *  human-action timescale, not the per-frame one. Tests reach in
 *  via `clearFetchCache()` so they get a clean slate per case. */
const FETCH_TTL_MS = 5000;
interface CacheEntry<T> {
  ts: number;
  data: T;
}
const resolvedCache = new Map<string, CacheEntry<unknown>>();
const inflightCache = new Map<string, Promise<unknown>>();

async function fetchJsonCached<T>(url: string): Promise<T> {
  const now = Date.now();
  const hit = resolvedCache.get(url);
  if (hit && now - hit.ts < FETCH_TTL_MS) {
    return hit.data as T;
  }
  const existing = inflightCache.get(url);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const data = (await res.json()) as T;
    resolvedCache.set(url, { ts: Date.now(), data });
    return data;
  })()
    .finally(() => {
      inflightCache.delete(url);
    });
  inflightCache.set(url, p);
  return p as Promise<T>;
}

/** Test hook so each integration test starts with no warm cache. */
export function clearFetchCache(): void {
  resolvedCache.clear();
  inflightCache.clear();
}

/** Fuzzy score across one haystack. Higher = better match.
 *  - 0          : no match
 *  - 100        : exact whole-string match
 *  -  60–90     : substring; bonus if the substring starts at a word
 *                 boundary (start-of-string or after non-alphanumeric)
 *  -  10–50     : ordered subsequence; tighter spans score higher
 *  Empty query returns a flat 1 so callers can pass `""` to mean
 *  "everything matches" and then sort by recency.
 *
 *  Whitespace in the query is collapsed away, so "fix bug" matches
 *  "fixthebug" just as it matches "fix the bug". Lowercase
 *  comparison everywhere; smart-case can land later. */
export function fuzzyScore(haystack: string, query: string): number {
  if (query.length === 0) return 1;
  const h = haystack.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q.length === 0) return 1;

  // Exact substring path — by far the most common hit shape (user
  // typing a few characters of a session title or commit subject).
  const idx = h.indexOf(q);
  if (idx === 0) {
    return h.length === q.length ? 100 : 90;
  }
  if (idx > 0) {
    // Word-boundary bonus: "auth" matching " auth" or "Auth/refactor"
    // should beat "auth" matching "autohaul". The previous char is
    // what we look at — non-alphanumeric (space, dash, slash, dot)
    // counts as a boundary.
    const prev = h[idx - 1] ?? "";
    return /[a-z0-9]/.test(prev) ? 60 : 80;
  }

  // Subsequence fallback: every char of q appears in h in order.
  // We score by tightness (how close together the matched chars
  // sit) — tighter is closer to a substring miss-by-one-typo and
  // should rank above a stretched-thin match.
  let i = 0;
  let firstHit = -1;
  let lastHit = -1;
  for (let j = 0; j < h.length && i < q.length; j++) {
    if (h[j] === q[i]) {
      if (firstHit < 0) firstHit = j;
      lastHit = j;
      i++;
    }
  }
  if (i < q.length) return 0;
  const span = lastHit - firstHit + 1;
  // span === q.length means a perfect tight subsequence (basically
  // a hidden substring); each unit of slack drops the score 2
  // points down to a floor of 10.
  return Math.max(10, 50 - (span - q.length) * 2);
}

/** Compact relative-time formatter for the meta column. Returns
 *  "3m" / "2h" / "5d" / "2026-05" rather than the verbose
 *  "3 minutes ago" — the chip is space-constrained. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const dSec = Math.max(0, (now - t) / 1000);
  if (dSec < 60) return `${Math.floor(dSec)}s`;
  if (dSec < 3600) return `${Math.floor(dSec / 60)}m`;
  if (dSec < 86400) return `${Math.floor(dSec / 3600)}h`;
  if (dSec < 30 * 86400) return `${Math.floor(dSec / 86400)}d`;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function sessionToPickItem(s: AgentSession): PickItem {
  // Display layout (per user spec):
  //   icon     → agent brand mark (resolved from `agent`)
  //   label    → session title
  //   subtitle → "{N} msg" when we have a count (informational)
  //   meta     → relative age "{age}" (time since last message)
  // Agent lives on its own field so subtitle stays free for the
  // message-count text — previously the two were collapsing into one
  // slot, which is why the user couldn't see the time-since stamp.
  const msgCount = typeof s.messageCount === "number" ? s.messageCount : 0;
  return {
    providerId: "sessions",
    id: s.source,
    value: s.source,
    targetType: "session",
    agent: s.agent,
    label: sessionDisplayTitle(s),
    subtitle: msgCount > 0 ? `${msgCount} msg` : "",
    meta: relativeAge(s.lastActive),
  };
}

export const sessionsProvider: Provider = {
  id: "sessions",
  label: "Sessions",
  async search(
    query: string,
    scope: SearchScope,
    limit: number = 8,
  ): Promise<PickItem[]> {
    let all: AgentSession[];
    try {
      all = await fetchJsonCached<AgentSession[]>("/api/agents");
    } catch {
      return [];
    }
    // Strict worktree scope when provided — same scope the rest of
    // the picker is anchored to (commits already require it). Falls
    // back to repo scope, then global, only when no worktree was
    // passed. NO empty-set fallthrough to global: a Downloads-folder
    // note whose worktree has no sessions should show an empty list
    // rather than silently surfacing sister-repo sessions whose
    // titles look misleadingly similar to the user's current work
    // (one click → wrong focus → "this link doesn't work").
    const pool = scope.currentWorktreePath
      ? all.filter((s) =>
          typeof s.cwd === "string" &&
          (s.cwd === scope.currentWorktreePath ||
            s.cwd.startsWith(scope.currentWorktreePath! + "/")),
        )
      : scope.currentRepoPath
        ? all.filter((s) =>
            typeof s.cwd === "string" && s.cwd.startsWith(scope.currentRepoPath!),
          )
        : all;
    // Empty query: rank by recency. Non-empty: defer to scoreSession
    // (same fuzzy ranker the session-search popover uses) so the two
    // surfaces produce identical orderings for identical queries.
    const q = query.trim();
    const ranked = q
      ? pool
          .map((s) => ({ s, r: scoreSession(s, q) }))
          .filter((x) => x.r > 0)
          .sort((a, b) => {
            if (b.r !== a.r) return b.r - a.r;
            return Date.parse(b.s.lastActive) - Date.parse(a.s.lastActive);
          })
      : pool
          .map((s) => ({ s, r: 1 }))
          .sort((a, b) => Date.parse(b.s.lastActive) - Date.parse(a.s.lastActive));
    return ranked.slice(0, limit).map((x) => sessionToPickItem(x.s));
  },
};

interface CommitShape {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  time: string;
}

function commitToPickItem(c: CommitShape, provider?: string): PickItem {
  // Display layout: provider-mark · subject · author · time.
  // shortSha is intentionally omitted — the user has the full SHA
  // in `value` for round-trip, but the picker / chip surfaces are
  // about what HUMANS need to recognise the commit.
  return {
    providerId: "commits",
    id: c.sha,
    value: c.sha,
    targetType: "commit",
    label: c.subject,
    subtitle: c.author,
    meta: relativeAge(c.time),
    ...(provider ? { provider } : {}),
  };
}

export const commitsProvider: Provider = {
  id: "commits",
  label: "Commits",
  async search(
    query: string,
    scope: SearchScope,
    limit: number = 8,
  ): Promise<PickItem[]> {
    if (!scope.currentWorktreePath) return [];
    // The daemon's /api/commits is anchored to a worktree — we ask
    // for 100 commits and filter client-side. 100 is plenty for the
    // "find the commit I just made" use case; a future
    // server-side `?q=` can land if the dataset grows.
    let all: CommitShape[];
    try {
      all = await fetchJsonCached<CommitShape[]>(
        `/api/commits?path=${encodeURIComponent(scope.currentWorktreePath)}&limit=100`,
      );
    } catch {
      return [];
    }
    const ranked = all
      .map((c) => {
        const haystack = `${c.subject} ${c.shortSha} ${c.sha} ${c.author}`;
        return { c, r: fuzzyScore(haystack, query) };
      })
      .filter((x) => x.r > 0)
      .sort((a, b) => {
        if (b.r !== a.r) return b.r - a.r;
        return Date.parse(b.c.time) - Date.parse(a.c.time);
      })
      .slice(0, limit);
    return ranked.map((x) =>
      commitToPickItem(x.c, scope.currentRepoProvider),
    );
  },
};

/** Convenience bundle for call sites that just want "the standard
 *  two providers", in default order. Replaces a few lines of
 *  repetitive imports at every use. */
export const defaultProviders: Provider[] = [sessionsProvider, commitsProvider];
