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
