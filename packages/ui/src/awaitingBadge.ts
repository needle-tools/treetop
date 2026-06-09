/**
 * Browser-tab activity indicator. Surfaces (all cheap, text-only):
 *   - The document title: a `(N)` prefix when sessions are waiting plus a
 *     compact "N waiting, N working, …" breakdown. The tab strip truncates
 *     it, but the hover tooltip shows the full string.
 *   - <meta name="description"> / <meta property="og:description">: a
 *     per-session breakdown for link unfurls.
 *   - The native dock badge (macOS / WKWebView) via `navigator.setAppBadge`.
 *
 * NOTE: this module used to ALSO paint an animated favicon (a canvas drawn
 * + `toDataURL("image/png")` ~20×/s). A perf trace (2026-06-09) showed that
 * loop's `toDataURL` + DOMParser work as a steady renderer cost for zero
 * benefit the title/dock badge don't already provide, so it was removed
 * entirely — the favicon is now the static `/favicon.svg` and nothing here
 * touches it. See plans/performance.md ("favicon spinner removed").
 *
 * Idempotent: re-calling with the same state short-circuits before touching
 * the DOM.
 */

const BASE_TITLE_FALLBACK = "supergit";

let baseTitle: string | null = null;

export interface TabState {
  awaiting: number;
  working: number;
  /** Sessions whose AI finished a turn the user hasn't focused yet.
   *  A subset of "idle from the agent's perspective" that's worth
   *  surfacing because the user has new output to look at. */
  unread: number;
  /** Sessions that are quiet AND already read — nothing to do. */
  idle: number;
}

export interface TabSession {
  state: "awaiting" | "working" | "unread" | "idle";
  /** Human label — usually `manualTitle ?? title ?? branch`. Empty string
   *  is allowed; we fall back to the agent name. */
  name: string;
  /** e.g. "claude", "codex". Shown in parens after the name. */
  agent: string;
}

const NAME_LIMIT_PER_CATEGORY = 3;

let lastStateKey = "";
let currentState: TabState = { awaiting: 0, working: 0, unread: 0, idle: 0 };
/** Dev-only override. When non-null, {@link updateTabIndicator} ignores
 *  the sessions it's called with and uses these instead. Set via the
 *  `window.__supergitFavicon` helper exposed below. */
let forcedSessions: TabSession[] | null = null;

/** When on, every state change routes through `console.log` so you can
 *  watch the indicator's decisions in devtools. Opt in by visiting the
 *  page with `?favicon-debug=1`. */
const debugEnabled =
  typeof window !== "undefined" &&
  !!window.location?.search?.includes("favicon-debug=1");
if (debugEnabled && typeof console !== "undefined") {
  console.log("[favicon] debug ON");
}

function dbg(...args: unknown[]): void {
  if (!debugEnabled) return;
  // console.log (not .debug) so it shows up at the default devtools
  // filter level — .debug is hidden unless the user flips Console
  // > Verbose, which is too much friction for "I turned it on, I
  // expect to see logs".
  console.log("[favicon]", ...args);
}

/** Pure helper: produce the title string for a given awaiting count. */
export function titleForCount(base: string, count: number): string {
  if (count <= 0) return base;
  return `(${count}) ${base}`;
}

/** Pure helper: build the document title for a given tab state. The
 *  awaiting-count prefix matches the legacy behaviour so the tab strip
 *  still flashes "(N) " when attention is needed; the suffix is what
 *  the hover tooltip ends up showing. */
export function titleForState(base: string, state: TabState): string {
  const prefix = state.awaiting > 0 ? `(${state.awaiting}) ` : "";
  const parts: string[] = [];
  if (state.awaiting > 0) parts.push(`${state.awaiting} waiting`);
  if (state.working > 0) parts.push(`${state.working} working`);
  if (state.unread > 0) parts.push(`${state.unread} unread`);
  if (state.idle > 0) parts.push(`${state.idle} idle`);
  const suffix = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  return `${prefix}${base}${suffix}`;
}

/** Pure helper: the longer breakdown used for the meta description and
 *  the og:description tag (for link unfurls). */
export function descriptionForState(state: TabState): string {
  const total = state.awaiting + state.working + state.unread + state.idle;
  if (total === 0) return "No active TUIs";
  const parts: string[] = [];
  if (state.awaiting > 0) parts.push(`${state.awaiting} waiting for input`);
  if (state.working > 0) parts.push(`${state.working} working`);
  if (state.unread > 0) parts.push(`${state.unread} unread`);
  if (state.idle > 0) parts.push(`${state.idle} idle`);
  return parts.join(", ");
}

function labelFor(s: TabSession): string {
  const name = s.name.trim();
  if (!name) return s.agent;
  return `${name} (${s.agent})`;
}

function joinWithLimit(items: string[], limit: number): string {
  if (items.length <= limit) return items.join(", ");
  const extra = items.length - limit;
  return `${items.slice(0, limit).join(", ")} +${extra}`;
}

function summarize(sessions: TabSession[]): TabState {
  const out: TabState = { awaiting: 0, working: 0, unread: 0, idle: 0 };
  for (const s of sessions) out[s.state]++;
  return out;
}

/** Pure helper: like {@link titleForState} but folds in per-session
 *  names and agents so the tab tooltip is actually useful. Browser tab
 *  titles are single-line — Chrome/Safari/Firefox collapse `\n` — so
 *  we pack everything onto one line and cap each category at
 *  {@link NAME_LIMIT_PER_CATEGORY} with a `+N` suffix to keep it sane. */
export function titleForSessions(base: string, sessions: TabSession[]): string {
  if (sessions.length === 0) return base;
  const awaiting = sessions.filter((s) => s.state === "awaiting");
  const working = sessions.filter((s) => s.state === "working");
  const unread = sessions.filter((s) => s.state === "unread");
  const idle = sessions.filter((s) => s.state === "idle");

  const prefix = awaiting.length > 0 ? `(${awaiting.length}) ` : "";

  const parts: string[] = [];
  if (awaiting.length > 0) {
    parts.push(
      `waiting: ${joinWithLimit(awaiting.map(labelFor), NAME_LIMIT_PER_CATEGORY)}`,
    );
  }
  if (working.length > 0) {
    parts.push(
      `working: ${joinWithLimit(working.map(labelFor), NAME_LIMIT_PER_CATEGORY)}`,
    );
  }
  // Unread sessions ARE actionable (the AI finished and the user
  // hasn't looked yet), so show names like waiting/working — not
  // just a count.
  if (unread.length > 0) {
    parts.push(
      `unread: ${joinWithLimit(unread.map(labelFor), NAME_LIMIT_PER_CATEGORY)}`,
    );
  }
  // Idle sessions aren't actionable — just show the count so the
  // attention-relevant categories get the screen real estate.
  if (idle.length > 0) parts.push(`${idle.length} idle`);

  const suffix = parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
  return `${prefix}${base}${suffix}`;
}

/** Pure helper: the meta-description form. We have more room here
 *  (Slack/iMessage previews truncate around ~200 chars) so we list
 *  every session by name + state, idle ones included. */
export function descriptionForSessions(sessions: TabSession[]): string {
  if (sessions.length === 0) return "No active TUIs";
  const counts = descriptionForState(summarize(sessions));
  // Normalise the internal "awaiting" state name to "waiting" so the
  // description reads naturally to a human. Other state words ("working",
  // "unread", "idle") already read fine as-is.
  const stateWord = (s: TabSession) =>
    s.state === "awaiting" ? "waiting" : s.state;
  const details = sessions
    .map((s) => `${labelFor(s)} ${stateWord(s)}`)
    .join(", ");
  return `${counts} · ${details}`;
}

function ensureBaseTitle(): string {
  if (baseTitle === null) {
    // Strip any prefix already on the title from a previous run (e.g.
    // a quick reload-while-awaiting) so we don't stack "(2) (2) ".
    // Also drop the " — …" breakdown suffix this module appends.
    const current = typeof document !== "undefined" ? document.title : "";
    baseTitle =
      current.replace(/^\(\d+\)\s+/, "").replace(/\s+—\s+.*$/, "") ||
      BASE_TITLE_FALLBACK;
  }
  return baseTitle;
}

function setMeta(name: string, content: string, useProperty = false): void {
  if (typeof document === "undefined") return;
  const selector = useProperty
    ? `meta[property="${name}"]`
    : `meta[name="${name}"]`;
  let meta = document.querySelector<HTMLMetaElement>(selector);
  if (!meta) {
    meta = document.createElement("meta");
    if (useProperty) meta.setAttribute("property", name);
    else meta.setAttribute("name", name);
    document.head.appendChild(meta);
  }
  if (meta.content !== content) meta.content = content;
}

/** Apply the awaiting badge for `count` waiting sessions — updates the
 *  document title prefix. Safe to call repeatedly.
 *
 *  Kept for back-compat with callers that only track the awaiting count;
 *  prefer {@link updateTabIndicator} for the full state. */
export function updateAwaitingBadge(count: number): void {
  if (typeof document === "undefined") return;
  document.title = titleForCount(ensureBaseTitle(), count);
}

/** Apply the full tab indicator for the given live sessions. Updates the
 *  document title (awaiting prefix + per-session breakdown), the meta
 *  description / og:description (for link unfurls), and the native dock
 *  badge. Safe to call on every reactive tick — short-circuits when
 *  nothing has changed since the last call. */
export function updateTabIndicator(sessions: TabSession[]): void {
  if (forcedSessions !== null) sessions = forcedSessions;
  const safe = sessions.filter(
    (s) =>
      s.state === "awaiting" ||
      s.state === "working" ||
      s.state === "unread" ||
      s.state === "idle",
  );
  const counts = summarize(safe);
  // The cache key needs to invalidate on any change that affects the
  // rendered title — including renames and agent swaps — not just count
  // shifts, otherwise renaming an active session wouldn't refresh the
  // tab title.
  const key = safe
    .map((s) => `${s.state}:${s.agent}:${s.name}`)
    .sort()
    .join("|");
  if (key === lastStateKey) {
    dbg("updateTabIndicator (skipped, unchanged)", { counts });
    return;
  }
  dbg("updateTabIndicator", {
    counts,
    forced: forcedSessions !== null,
    sessions: safe,
  });
  lastStateKey = key;
  currentState = counts;

  if (typeof document !== "undefined") {
    const base = ensureBaseTitle();
    document.title = titleForSessions(base, safe);
    const desc = descriptionForSessions(safe);
    setMeta("description", desc);
    setMeta("og:description", desc, true);
  }

  // Native app dock badge (macOS). setAppBadge works in Safari/WKWebView
  // and sets the red badge on the dock icon — same as Discord/Slack.
  // clearAppBadge removes it when nothing needs attention.
  const badgeCount = counts.awaiting + counts.unread;
  try {
    if (badgeCount > 0) (navigator as any).setAppBadge?.(badgeCount);
    else (navigator as any).clearAppBadge?.();
  } catch {}
}

/** Dev-only console helper. From the page console:
 *    __supergitFavicon.force({ unread: 2 })       // "(0)…" title + dock badge
 *    __supergitFavicon.force({ working: 1 })      // "… working" title
 *    __supergitFavicon.force({ awaiting: 3 })     // "(3) …" title + dock badge
 *    __supergitFavicon.clear()                    // resume real session state
 *    __supergitFavicon.peek()                     // see what the indicator is using
 *  Drives the title / meta / dock badge (the favicon itself is static now).
 *  Lets you eyeball each state without waiting for a matching real session. */
if (typeof window !== "undefined") {
  const w = window as unknown as Record<string, unknown>;
  w.__supergitFavicon = {
    force(partial: Partial<TabState>): TabSession[] {
      const counts: TabState = {
        awaiting: Math.max(0, (partial.awaiting ?? 0) | 0),
        working: Math.max(0, (partial.working ?? 0) | 0),
        unread: Math.max(0, (partial.unread ?? 0) | 0),
        idle: Math.max(0, (partial.idle ?? 0) | 0),
      };
      const mock: TabSession[] = [];
      for (const state of ["awaiting", "working", "unread", "idle"] as const) {
        for (let i = 0; i < counts[state]; i++) {
          mock.push({ state, name: `mock-${state}-${i + 1}`, agent: "mock" });
        }
      }
      forcedSessions = mock;
      lastStateKey = ""; // bust the short-circuit so the next call repaints
      updateTabIndicator([]);
      return mock;
    },
    clear(): void {
      forcedSessions = null;
      lastStateKey = "";
      // Force a reactive recompute by setting the title to something
      // mid-call; the App's `$:` block will then push the real state.
      currentState = { awaiting: 0, working: 0, unread: 0, idle: 0 };
    },
    peek(): { forced: TabSession[] | null; state: TabState } {
      return { forced: forcedSessions, state: { ...currentState } };
    },
  };
}
