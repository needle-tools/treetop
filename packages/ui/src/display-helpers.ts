/**
 * Pure display/formatting helpers extracted from App.svelte.
 * Behavior is pinned by App-characterization.test.ts.
 *
 * Every function here is pure: all inputs come from parameters, not
 * from App.svelte reactive state, stores, or module-level mutable vars.
 * Deps on imported types and small pure constants are fine.
 */

import type { AgentSession } from "./sessionSearch";

// ---------------------------------------------------------------------------
// sortBranches  (was App.svelte ~line 1140)
// ---------------------------------------------------------------------------

/** Sort a branch list. 'alpha' sorts lexicographically; 'recency' preserves
 *  the daemon's input order (committerdate-desc). */
export function sortBranches(
  list: string[],
  mode: "recency" | "alpha",
): string[] {
  if (mode === "alpha") return [...list].sort((a, b) => a.localeCompare(b));
  // Recency: daemon already returns these in committerdate-desc order.
  return list;
}

// ---------------------------------------------------------------------------
// wtHasRecentActivity  (was App.svelte ~line 2994)
// ---------------------------------------------------------------------------

export const ACTIVITY_WINDOW_MS = 10_000;

export function wtHasRecentActivity(
  w: { agents?: Array<{ lastActive?: string }> } | undefined | null,
  now: number,
): boolean {
  if (!w?.agents?.length) return false;
  for (const a of w.agents) {
    if (!a.lastActive) continue;
    const t = Date.parse(a.lastActive);
    if (Number.isFinite(t) && now - t < ACTIVITY_WINDOW_MS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// formatRelativeTime  (was App.svelte ~line 4025)
// ---------------------------------------------------------------------------

/** Human-friendly relative time for a session's `lastActive`. Mirrors
 *  the format used elsewhere in the dashboard so the import popover
 *  reads like the rest of the UI.
 *  The optional `now` parameter exists for deterministic testing; callers
 *  that omit it get the real wall-clock value. */
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const delta = now - then;
  const s = Math.round(delta / 1000);
  if (s < 60) return s <= 5 ? "just now" : `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// repoChipFg  (was App.svelte ~line 4145)
// ---------------------------------------------------------------------------

/** Pick a readable foreground for a `#rrggbb` chip background. Uses
 *  OKLCH lightness (perceptually uniform) instead of sRGB YIQ luma,
 *  so the flip-point between dark/light text matches what the eye
 *  actually sees — saturated yellows + cyans correctly read as
 *  "light" and get dark text, while mid blues correctly read as
 *  "dark" and get white text. Pipeline: sRGB → linear-sRGB → LMS
 *  (Björn Ottosson's matrix) → cbrt → OKLab L. Threshold 0.62 is
 *  the standard accessibility hinge. */
export function repoChipFg(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const v = parseInt(m[1]!, 16);
  const r8 = ((v >> 16) & 0xff) / 255;
  const g8 = ((v >> 8) & 0xff) / 255;
  const b8 = (v & 0xff) / 255;
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);
  const lL = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const mL = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const sL = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const L =
    0.2104542553 * Math.cbrt(lL) +
    0.793617785 * Math.cbrt(mL) -
    0.0040720468 * Math.cbrt(sL);
  return L >= 0.6 ? "#1a1a1a" : "#ffffff";
}

// ---------------------------------------------------------------------------
// fileManagerLabel / fileManagerIcon  (was App.svelte ~line 4807)
// ---------------------------------------------------------------------------

export function fileManagerLabel(): string {
  if (typeof navigator === "undefined") return "Files";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return "Finder";
  if (/Win/.test(ua)) return "Explorer";
  return "Files";
}

/** Pair of `fileManagerLabel`: pick the matching icon-registry key
 *  so the button shows the Finder face on macOS, the Explorer folder
 *  on Windows, and the generic folder elsewhere. */
export function fileManagerIcon(): string {
  if (typeof navigator === "undefined") return "files";
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return "finder";
  if (/Win/.test(ua)) return "explorer";
  return "files";
}

// ---------------------------------------------------------------------------
// remoteButtonLabel  (was App.svelte ~line 4839)
// ---------------------------------------------------------------------------

/** Minimal remote reference shape needed by remoteButtonLabel. */
export interface RemoteRef {
  name: string;
  url: string;
  webUrl: string | null;
  provider: string | null;
  host: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure",
  codeberg: "Codeberg",
  sourcehut: "sourcehut",
  gitea: "Gitea",
};

/** Button label for a remote: provider name when known, else the host.
 *  Suffixes the remote name when it's not the default `origin` so users
 *  with multiple remotes can tell `origin` from `upstream` at a glance. */
export function remoteButtonLabel(remote: RemoteRef): string {
  const base =
    (remote.provider ? PROVIDER_LABELS[remote.provider] : null) ??
    remote.host ??
    remote.name;
  return remote.name === "origin" ? base : `${base} (${remote.name})`;
}

// ---------------------------------------------------------------------------
// pushCount
// ---------------------------------------------------------------------------

/** Commits to push for a worktree's branch. Normally this is `ahead`
 *  (commits beyond the configured upstream). A branch with no upstream
 *  gets no ahead/behind from git, so the daemon fills `unpushed` instead
 *  — commits reachable from HEAD but from no remote-tracking ref. The
 *  two are mutually exclusive (the daemon only sets `unpushed` when
 *  there's no upstream, in which case `ahead` is 0), so a simple OR
 *  picks whichever applies. Returns 0 for a missing branch status. */
export function pushCount(
  bs: { ahead: number; unpushed?: number | null } | null | undefined,
): number {
  if (!bs) return 0;
  return bs.ahead || (bs.unpushed ?? 0);
}

// ---------------------------------------------------------------------------
// targetGlyph  (was App.svelte ~line 5245)
// ---------------------------------------------------------------------------

/** Type → glyph mapping for the per-row notes-list popover. Mirrors
 *  the same monochrome unicode set StickyNote uses for the link
 *  chip so the two surfaces stay visually consistent. */
export function targetGlyph(type: string | undefined): string {
  switch (type) {
    case "url":
      return "↗";
    case "commit":
      return "◆";
    case "session":
      return "▶";
    case "file":
      return "▤";
    case "command":
      return "⌁";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// notesListDisplay  (was App.svelte ~line 5266)
// ---------------------------------------------------------------------------

/** Display info for the per-row notes-list popover. Returns `text`
 *  empty when the row has nothing meaningful to show — link kind
 *  with no usable target *and* no body — so the caller can drop
 *  the row entirely instead of rendering a confusing "(empty)". */
export function notesListDisplay(n: {
  body: string;
  kind?: "note" | "link";
  target?: {
    type?: string;
    value?: string;
    label?: string;
    agent?: string;
    provider?: string;
    command?: string;
  };
}): {
  kind: "note" | "link";
  text: string;
  title: string;
  agent: string;
  provider: string;
  glyph: string;
} {
  const kind = n.kind === "link" ? "link" : "note";
  const excerpt = noteExcerpt(n.body);
  if (kind === "link") {
    const t = n.target ?? {};
    const text = (excerpt || t.label || t.command || t.value || "").trim();
    const title = [t.label, t.value, n.body].filter((s) => !!s).join("\n");
    return {
      kind,
      text,
      title,
      agent: t.agent ?? "",
      provider: t.provider ?? "",
      glyph: targetGlyph(t.type),
    };
  }
  return {
    kind,
    text: excerpt,
    title: n.body,
    agent: "",
    provider: "",
    glyph: "",
  };
}

// ---------------------------------------------------------------------------
// noteExcerpt  (was App.svelte ~line 5314)
// ---------------------------------------------------------------------------

/** First non-empty line of a note's body, trimmed to a length that
 *  fits comfortably inside the events popover's row. Falls back to
 *  empty string so the caller can decide between "Removed note" and
 *  "Removed note "blah"". */
export function noteExcerpt(body: string | undefined): string {
  if (!body) return "";
  const firstLine = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length <= 40) return trimmed;
  return trimmed.slice(0, 39) + "…";
}

// ---------------------------------------------------------------------------
// relTime  (was App.svelte ~line 5401)
// ---------------------------------------------------------------------------

/** The optional `now` parameter exists for deterministic testing; callers
 *  that omit it get the real wall-clock value. */
export function relTime(iso: string, now = Date.now()): string {
  const d = (now - Date.parse(iso)) / 1000;
  if (Number.isNaN(d)) return "";
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// clampSubject  (was App.svelte ~line 5470)
// ---------------------------------------------------------------------------

/** Per-subject character clamp inside the unpushed / unfetched
 *  commit tooltip. Pairs with `.tt-wide`'s `max-width: 96vw` so a
 *  long subject can use whatever horizontal room the viewport has
 *  before the CSS-side ellipsis on `.wt-tt-subject` kicks in.
 *  400 ≈ 2× the prior 200 cap — verbose conventional-commit
 *  subjects round-trip without getting cut short by the JS clamp
 *  before CSS even gets a chance to lay them out. */
export const COMMIT_SUBJECT_MAX = 400;

export function clampSubject(s: string): string {
  if (s.length <= COMMIT_SUBJECT_MAX) return s;
  return s.slice(0, COMMIT_SUBJECT_MAX - 1) + "…";
}

// ---------------------------------------------------------------------------
// sessionTooltip  (was App.svelte ~line 5520)
// ---------------------------------------------------------------------------

/** Build the multi-line tooltip for a session row in the agents
 *  popover: title → first user prompt → "[… N more messages …]" →
 *  last 3 (oldest-first). Falls back to the simple "last user
 *  message" shape when the daemon hasn't filled the richer fields
 *  yet (e.g. for codex, which doesn't expose them). */
export function sessionTooltip(sess: AgentSession): string {
  const headline = sess.manualTitle ?? sess.title ?? "(no title)";
  const first = sess.firstUserMessage;
  const last = sess.lastUserMessages ?? [];
  const count = sess.userMessageCount ?? 0;
  if (!first && last.length === 0) {
    // Codex / partial data: legacy single-message tooltip.
    return sess.lastUserMessage
      ? `${headline}\n\nMost recent user message:\n${sess.lastUserMessage}`
      : headline;
  }
  // Show first + last 3 without duplicating when they overlap. For
  // count ≤ 4 the first IS one of the "last 3", so we just print the
  // messages in order. For count > 4 we insert a [… N more …]
  // separator between the first and the tail.
  const tailExcludingFirst = first ? last.filter((m) => m !== first) : last;
  const lines: string[] = [headline];
  if (count <= 4) {
    // Print every captured message once, oldest-first.
    const all = first ? [first, ...tailExcludingFirst] : last;
    for (const m of all) lines.push("", m);
  } else {
    if (first) lines.push("", first);
    const skipped = count - 1 - tailExcludingFirst.length;
    if (skipped > 0) {
      lines.push(
        "",
        `[… ${skipped} more message${skipped === 1 ? "" : "s"} …]`,
      );
    }
    for (const m of tailExcludingFirst) lines.push("", m);
  }
  return lines.join("\n");
}
