/**
 * Fuzzy matcher behind the session search popover. Operates on fields
 * the daemon already includes per session (title, manualTitle, the
 * first user prompt, the last user prompt(s)) — never reads the
 * transcript.
 *
 * Scoring leans heavily on which field matched:
 *   - title / manualTitle  -> 100 (the strongest "what is this chat")
 *   - firstUserMessage     ->  50 (what kicked it off)
 *   - lastUserMessage      ->  35 (what the user said most recently)
 *   - lastUserMessages[]   ->  25 (older prompts in the tail)
 *   - sessionId            ->   8 (paste-id-into-search workflow)
 *
 * Within a field, an exact substring outranks a subsequence-fuzzy
 * match. Score 0 means "no hit anywhere" and the row is dropped.
 */

export interface AgentSession {
  agent: "claude" | "codex" | "copilot" | "ollama" | "shell";
  cwd: string;
  lastActive: string;
  source: string;
  sessionId?: string;
  title?: string;
  manualTitle?: string;
  aiTitle?: string;
  lastUserMessage?: string;
  firstUserMessage?: string;
  lastUserMessages?: string[];
  userMessageCount?: number;
  messageCount?: number;
  recentMessageCount?: number;
  lastMessageTs?: string;
  contextTokens?: number;
  contextTokensExact?: boolean;
  model?: string;
  importedFrom?: string;
  importedAt?: string;
}

const W_TITLE = 100;
const W_FIRST = 50;
const W_LAST = 35;
const W_TAIL = 25;
const W_SID = 8;
const SUBSTRING_BONUS = 1.6;

/** Lowercase-subsequence match. Returns true iff every char of `q`
 *  appears in `h` in order (chars between are ignored). */
function subsequenceMatch(haystack: string, query: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < query.length; j++) {
    if (haystack[j] === query[i]) i++;
  }
  return i === query.length;
}

function fieldScore(haystack: string | undefined, q: string): number {
  if (!haystack) return 0;
  const h = haystack.toLowerCase();
  if (h.includes(q)) return SUBSTRING_BONUS;
  if (subsequenceMatch(h, q)) return 1;
  return 0;
}

export function scoreSession(s: AgentSession, rawQuery: string): number {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return 1;
  let score = 0;
  const titleHit = Math.max(
    fieldScore(s.title, q),
    fieldScore(s.manualTitle, q),
    fieldScore(s.aiTitle, q),
  );
  score += titleHit * W_TITLE;
  score += fieldScore(s.firstUserMessage, q) * W_FIRST;
  score += fieldScore(s.lastUserMessage, q) * W_LAST;
  if (s.lastUserMessages) {
    let best = 0;
    for (const m of s.lastUserMessages) {
      const f = fieldScore(m, q);
      if (f > best) best = f;
    }
    score += best * W_TAIL;
  }
  score += fieldScore(s.sessionId, q) * W_SID;
  return score;
}

/** What to show for a session anywhere the UI surfaces "this chat" —
 *  the session-search popover, the @-mention picker, inline sticky-link
 *  chips, inline @-mentions inside notes. One precedence for all of
 *  them so the picker never shows a label that disagrees with what the
 *  sessions list right below it shows. Matches the visible logic in
 *  `SessionSearchList.svelte` exactly. */
export function sessionDisplayTitle(s: AgentSession): string {
  const manual = (s.manualTitle ?? "").trim();
  if (manual) return manual;
  // No user-set name, but a cached Ollama summary produced a title —
  // prefer it over message/auto-summary fallbacks (mirrors the row
  // render order in SessionSearchList.svelte).
  const ai = (s.aiTitle ?? "").trim();
  if (ai) return ai;
  // Shell sessions don't get an agent-side title; the captured
  // command is the natural "what is this" stand-in.
  if (s.agent === "shell") {
    const cmd = (s.lastUserMessage ?? "").trim();
    if (cmd) return cmd;
  }
  // Chat sessions: prefer the user's most recent message over the
  // agent's auto-summary — what the user actually said reads more
  // immediately than the auto-summary.
  const lum = (s.lastUserMessage ?? "").trim();
  if (lum) return lum;
  const t = (s.title ?? "").trim();
  if (t) return t;
  const fum = (s.firstUserMessage ?? "").trim();
  if (fum) return fum;
  return s.sessionId ? `session ${s.sessionId.slice(0, 8)}` : "(untitled)";
}

/** Rank sessions by most-recent activity, newest first → a
 *  `source → position` map. Used to snapshot the no-query list order the
 *  moment the picker opens, so later re-renders can reproduce that exact
 *  order even as `lastActive` ticks forward underneath. */
export function activityRank(sessions: AgentSession[]): Map<string, number> {
  const ranked = [...sessions].sort(
    (a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive),
  );
  return new Map(ranked.map((s, i) => [s.source, i]));
}

/** Stable activity order for the no-query session list.
 *
 *  The picker opens, then its `sessions` keep updating as `lastActive`
 *  ticks (polling / SSE). Re-sorting live makes rows jump under the
 *  cursor mid-hover. So we order against a rank snapshotted at open time
 *  (`openRank` from `activityRank`) instead of the live timestamps.
 *  Sessions that appear after open (absent from the rank) sort after the
 *  known ones, most-recent-first among themselves. Pure — does not
 *  mutate the input. */
export function orderByOpenActivity(
  sessions: AgentSession[],
  openRank: Map<string, number>,
): AgentSession[] {
  return [...sessions].sort((a, b) => {
    const ra = openRank.get(a.source);
    const rb = openRank.get(b.source);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return Date.parse(b.lastActive) - Date.parse(a.lastActive);
  });
}

/** A session active within this window of open time floats into the
 *  "working on this right now" tier, above starred items. */
export const RECENT_ACTIVITY_MS = 30 * 60 * 1000;

/** Sources active within `windowMs` of `now` → the recency tier. Captured
 *  at open time (with `now = Date.now()` then) so the tier is frozen and a
 *  session crossing the window boundary mid-hover doesn't jump tiers. */
export function recentlyActiveSources(
  sessions: AgentSession[],
  now: number,
  windowMs: number = RECENT_ACTIVITY_MS,
): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) {
    const t = Date.parse(s.lastActive);
    if (!Number.isNaN(t) && now - t <= windowMs) out.add(s.source);
  }
  return out;
}

/** Final no-query ordering for the picker, in three tiers:
 *    1. recently active (within the recency window at open)
 *    2. starred (not recently active)
 *    3. everything else
 *  Each tier is in open-time activity order. `openRank` and
 *  `recentSources` are both snapshotted at open, so tiers don't reshuffle
 *  under the cursor as `lastActive` ticks. A session that is both recent
 *  and starred lands in the recent tier — recency wins. Pure. */
export function orderNoQuery(
  sessions: AgentSession[],
  openRank: Map<string, number>,
  recentSources: Set<string>,
  starredSources: Set<string>,
): AgentSession[] {
  const ordered = orderByOpenActivity(sessions, openRank);
  if (recentSources.size === 0 && starredSources.size === 0) return ordered;
  const recent: AgentSession[] = [];
  const starred: AgentSession[] = [];
  const rest: AgentSession[] = [];
  for (const s of ordered) {
    if (recentSources.has(s.source)) recent.push(s);
    else if (starredSources.has(s.source)) starred.push(s);
    else rest.push(s);
  }
  return [...recent, ...starred, ...rest];
}

/** Filter + rank a session list against a query string. Empty/whitespace
 *  query short-circuits to the original list (no copy, no sort). */
export function filterSessions(
  sessions: AgentSession[],
  rawQuery: string,
): AgentSession[] {
  const q = rawQuery.trim();
  if (!q) return sessions;
  const scored: { s: AgentSession; score: number }[] = [];
  for (const s of sessions) {
    const score = scoreSession(s, q);
    if (score > 0) scored.push({ s, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Date.parse(b.s.lastActive) - Date.parse(a.s.lastActive);
  });
  return scored.map((x) => x.s);
}
