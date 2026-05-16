/**
 * Browser-tab activity indicator. Two surfaces:
 *   - The favicon: a red dot (pulsing) when any open session is
 *     waiting for the user, or a rotating arc when at least one is
 *     mid-turn. Lets the user notice "an agent needs me" / "an agent
 *     is busy" from a different tab without having to click back.
 *   - The document title + <meta name="description"> /
 *     <meta property="og:description">: a compact breakdown of how
 *     many TUIs are waiting / working / idle. The tab strip itself
 *     truncates the title, but the hover tooltip (and any link
 *     unfurl) shows the full string.
 *
 * Idempotent: re-calling with the same state is cheap (it short-
 * circuits before touching the DOM). The first call lazily loads the
 * base favicon as an HTMLImageElement so subsequent updates just
 * redraw without another network fetch.
 */

const BASE_TITLE_FALLBACK = "supergit";
const BASE_FAVICON_HREF = "/needle-logo.svg";

let baseTitle: string | null = null;
let baseImage: HTMLImageElement | null = null;
let baseImageReady = false;
let lastCount = -1;
// One canvas + 2D context reused for every favicon redraw. Allocating
// a fresh 32×32 canvas per frame (we're at 20 fps whenever something
// is working/awaiting) churns GC and forces the browser to re-acquire
// a GPU-backed canvas each tick.
let sharedCanvas: HTMLCanvasElement | null = null;
let sharedCtx: CanvasRenderingContext2D | null = null;
function getCanvas(size: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!sharedCanvas) {
    sharedCanvas = document.createElement("canvas");
    sharedCanvas.width = size;
    sharedCanvas.height = size;
  }
  if (!sharedCtx) sharedCtx = sharedCanvas.getContext("2d");
  if (!sharedCtx) return null;
  sharedCtx.clearRect(0, 0, size, size);
  return sharedCtx;
}

export interface TabState {
  awaiting: number;
  working: number;
  idle: number;
}

export interface TabSession {
  state: "awaiting" | "working" | "idle";
  /** Human label — usually `manualTitle ?? title ?? branch`. Empty string
   *  is allowed; we fall back to the agent name. */
  name: string;
  /** e.g. "claude", "codex". Shown in parens after the name. */
  agent: string;
}

const NAME_LIMIT_PER_CATEGORY = 3;

let lastStateKey = "";
let currentState: TabState = { awaiting: 0, working: 0, idle: 0 };
let animationTimer: ReturnType<typeof setInterval> | null = null;
let animationStart = 0;

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
  if (state.idle > 0) parts.push(`${state.idle} idle`);
  const suffix = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
  return `${prefix}${base}${suffix}`;
}

/** Pure helper: the longer breakdown used for the meta description and
 *  the og:description tag (for link unfurls). */
export function descriptionForState(state: TabState): string {
  const total = state.awaiting + state.working + state.idle;
  if (total === 0) return "No active TUIs";
  const parts: string[] = [];
  if (state.awaiting > 0) parts.push(`${state.awaiting} waiting for input`);
  if (state.working > 0) parts.push(`${state.working} working`);
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
  const out: TabState = { awaiting: 0, working: 0, idle: 0 };
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
  // description reads naturally to a human.
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

function ensureBaseImage(onReady?: () => void): void {
  if (baseImage !== null) {
    if (baseImageReady && onReady) onReady();
    return;
  }
  if (typeof Image === "undefined") return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    baseImageReady = true;
    if (onReady) onReady();
    // Legacy path: a count-driven call came in while loading.
    if (lastCount > 0) drawBadge(lastCount);
    else if (lastCount === 0) clearBadge();
  };
  img.onerror = () => {
    // Couldn't load the base — fall back to "title only" badge mode.
    baseImage = null;
  };
  img.src = BASE_FAVICON_HREF;
  baseImage = img;
}

function getFaviconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  return link;
}

function drawBadge(count: number): void {
  if (!baseImage || !baseImageReady) return;
  const size = 32;
  const ctx = getCanvas(size);
  if (!ctx) return;
  try {
    ctx.drawImage(baseImage, 0, 0, size, size);
  } catch {
    return;
  }
  const r = 8;
  const cx = size - r - 0.5;
  const cy = r + 0.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#e34c3c";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.stroke();
  if (count >= 1 && count <= 9) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(count), cx, cy + 0.5);
  }
  const link = getFaviconLink();
  if (!link || !sharedCanvas) return;
  try {
    link.type = "image/png";
    link.href = sharedCanvas.toDataURL("image/png");
  } catch {
    // Tainted canvas (CORS) — leave the favicon alone, title still updates.
  }
}

function clearBadge(): void {
  const link = getFaviconLink();
  if (!link) return;
  link.type = "image/x-icon";
  link.href = "/favicon.ico";
}

function drawIndicator(state: TabState, tMs: number): void {
  const size = 32;
  const ctx = getCanvas(size);
  if (!ctx) return;
  // Everything below is driven by wall-clock time (seconds) so the
  // visible speed is independent of the redraw fps.
  const t = tMs / 1000;

  if (state.awaiting > 0) {
    // Base logo + pulsing red dot in the corner. Awaiting always
    // wins over working since "needs you" beats "busy".
    if (!baseImage || !baseImageReady) return;
    try {
      ctx.drawImage(baseImage, 0, 0, size, size);
    } catch {
      return;
    }
    // ~0.5 Hz pulse: alpha drifts 0.75 → 1.0.
    const pulse = (Math.sin(t * Math.PI) + 1) / 2;
    const alpha = 0.75 + 0.25 * pulse;
    const r = 8;
    const cx = size - r - 0.5;
    const cy = r + 0.5;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#e34c3c";
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
    ctx.stroke();
    if (state.awaiting >= 1 && state.awaiting <= 9) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(state.awaiting), cx, cy + 0.5);
    }
  } else if (state.working > 0) {
    // Working-only: replace the logo entirely with a full-favicon
    // rotating arc spinner so it reads as "busy" at tab-strip size.
    const cx = size / 2;
    const cy = size / 2;
    const r = 12;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(59, 130, 246, 0.2)";
    ctx.lineWidth = 4;
    ctx.stroke();
    // ~0.5 turns/sec; a 270° sweep gives a clear head/tail.
    const start = t * Math.PI; // π rad/sec = 0.5 turns/sec
    const sweep = Math.PI * 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + sweep);
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.stroke();
  }

  const link = getFaviconLink();
  if (!link || !sharedCanvas) return;
  try {
    link.type = "image/png";
    link.href = sharedCanvas.toDataURL("image/png");
  } catch {}
}

function stopAnimation(): void {
  if (animationTimer !== null) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
}

function startAnimation(): void {
  if (animationTimer !== null) return;
  if (typeof setInterval === "undefined") return;
  // 20 fps is smooth enough that the arc rotation reads as continuous
  // motion (the previous 6 fps was visibly steppy) while still keeping
  // the per-frame canvas → data-url → favicon swap cheap. Browsers
  // throttle this to ~1 Hz when the tab is hidden, which is exactly
  // what we want — the indicator still moves where the user can see it.
  animationStart = performance.now();
  animationTimer = setInterval(() => {
    drawIndicator(currentState, performance.now() - animationStart);
  }, 1000 / 20);
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

/** Apply the awaiting badge for `count` waiting sessions. Updates the
 *  document title prefix and the favicon. Safe to call repeatedly.
 *
 *  Kept for back-compat with callers that only track the awaiting
 *  count; prefer {@link updateTabIndicator} for the full state. */
export function updateAwaitingBadge(count: number): void {
  if (count === lastCount) return;
  lastCount = count;
  if (typeof document !== "undefined") {
    const base = ensureBaseTitle();
    document.title = titleForCount(base, count);
  }
  ensureBaseImage();
  if (count <= 0) {
    clearBadge();
    return;
  }
  if (baseImageReady) drawBadge(count);
}

/** Apply the full tab indicator for the given live sessions. Updates:
 *  - the document title (awaiting prefix + per-session breakdown with
 *    names and agents, since the tab hover tooltip shows the full
 *    title),
 *  - the meta description / og:description (for link unfurls),
 *  - the favicon (pulsing red dot when awaiting, rotating arc when
 *    only working, base icon otherwise).
 *
 *  Safe to call on every reactive tick — short-circuits when nothing
 *  has changed since the last call. */
export function updateTabIndicator(sessions: TabSession[]): void {
  const safe = sessions.filter(
    (s) => s.state === "awaiting" || s.state === "working" || s.state === "idle",
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
  if (key === lastStateKey) return;
  lastStateKey = key;
  currentState = counts;

  if (typeof document !== "undefined") {
    const base = ensureBaseTitle();
    document.title = titleForSessions(base, safe);
    const desc = descriptionForSessions(safe);
    setMeta("description", desc);
    setMeta("og:description", desc, true);
  }

  const needsAnimation = counts.awaiting > 0 || counts.working > 0;
  if (!needsAnimation) {
    stopAnimation();
    clearBadge();
    return;
  }
  ensureBaseImage(() =>
    drawIndicator(currentState, performance.now() - animationStart),
  );
  if (baseImageReady)
    drawIndicator(currentState, performance.now() - animationStart);
  startAnimation();
}
