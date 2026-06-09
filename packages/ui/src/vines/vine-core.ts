/**
 * Pure, framework-free logic for the vines overlay.
 *
 * No DOM, no Svelte, no timers — everything here is deterministic and
 * unit-tested (packages/ui/test/vines.test.ts). The imperative overlay
 * (vines-overlay.ts) owns all the side effects (DOM, observers, the tick)
 * and leans on these helpers.
 *
 * MODEL (v2): a vine's *growth* is a property of the REPO/worktree, not of
 * the session windows it's drawn between. Growth accrues from real work —
 * time spent with sessions open in that repo, weighted by how many — and
 * is persisted per repo. So vines survive across days and reappear at
 * their saved lushness whenever you open windows in that repo again. The
 * windows are just *where* we render the repo's current growth: one vine
 * per gap between adjacent session columns in the repo's row.
 *
 * This whole `vines/` folder is self-contained and opt-in.
 */

/** A live session window/panel, reduced to what vines care about. */
export interface Panel {
  /** Stable identity — the column's `data-session-source`. */
  source: string;
  /** The repo this window belongs to (`data-repo-id`). Growth is keyed
   *  on this — it's what persists across days. */
  repo: string;
  /** Row group (worktree strip) — vines only connect panels in the SAME
   *  group, never across rows. */
  group?: string;
  /** Centre x (used only for left→right ordering). */
  cx: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Persisted, per-repo growth state. `activeMs` is accumulated weighted
 *  active-session time; growth is derived from it. */
export interface RepoGrowth {
  activeMs: number;
}

/** repoId → growth. This is the whole persisted state. */
export type GrowthStore = Record<string, RepoGrowth>;

/** A vine to draw this frame: a gap between two adjacent windows, whose
 *  length is the repo's current growth. Rebuilt from panels each sync;
 *  the overlay keeps stable DOM nodes per `key`. */
export interface RenderVine {
  key: string;
  repo: string;
  seed: number;
  length: number; // 0..1, from the repo's growth
  ax: number;
  bx: number;
  baseY: number;
  topY: number;
}

/** Order-independent key for a pair of sources. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/** FNV-1a 32-bit hash → a stable non-negative seed for a string. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG, floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Adjacent (left, right) panel pairs in on-screen x order, WITHIN a row
 *  group. Panels in different groups are never paired, so a vine never
 *  bridges two separate worktree rows. */
export function adjacentPairs(panels: Panel[]): [Panel, Panel][] {
  const g = (p: Panel) => p.group ?? "";
  const sorted = [...panels].sort((p, q) =>
    g(p) === g(q) ? p.cx - q.cx : g(p) < g(q) ? -1 : 1,
  );
  const out: [Panel, Panel][] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (g(sorted[i]) === g(sorted[i + 1])) {
      out.push([sorted[i], sorted[i + 1]]);
    }
  }
  return out;
}

/** How many windows each repo currently has on screen — the "intensity"
 *  that weights growth (more parallel work → faster), clamped so a wall
 *  of windows doesn't run away. */
export function repoIntensities(panels: Panel[], cap = 4): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of panels) counts.set(p.repo, (counts.get(p.repo) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const [repo, n] of counts) out.set(repo, Math.min(cap, n));
  return out;
}

/**
 * Accrue weighted active time onto each currently-active repo. Pure:
 * returns a new store. `dtMs` should be the (clamped) real time elapsed
 * since the last accrual while the tab was visible — idle/hidden time is
 * simply never passed in, so it doesn't count as work.
 */
export function accrue(
  store: GrowthStore,
  intensities: Map<string, number>,
  dtMs: number,
): GrowthStore {
  if (dtMs <= 0 || intensities.size === 0) return store;
  const next: GrowthStore = { ...store };
  for (const [repo, intensity] of intensities) {
    const prev = next[repo]?.activeMs ?? 0;
    next[repo] = { activeMs: prev + dtMs * intensity };
  }
  return next;
}

/** Repo growth 0..1: accumulated active time over the "full" budget. */
export function growthOf(
  store: GrowthStore,
  repo: string,
  fullActiveMs: number,
): number {
  if (fullActiveMs <= 0) return 1;
  const a = store[repo]?.activeMs ?? 0;
  return Math.max(0, Math.min(1, a / fullActiveMs));
}

/**
 * Build the vines to draw this frame from the current panels + growth.
 * One vine per gap between adjacent windows in a row; its length is the
 * repo's growth. Stable `key` (source pair) so the overlay can keep DOM
 * nodes — and their running leaf animations — across syncs.
 */
export function buildVines(
  panels: Panel[],
  store: GrowthStore,
  fullActiveMs: number,
): RenderVine[] {
  const out: RenderVine[] = [];
  for (const [p, q] of adjacentPairs(panels)) {
    const key = pairKey(p.source, q.source);
    out.push({
      key,
      repo: p.repo, // same group ⇒ same repo
      seed: hashSeed(key),
      length: growthOf(store, p.repo, fullActiveMs),
      ax: p.right,
      bx: q.left,
      baseY: Math.max(p.bottom, q.bottom),
      topY: Math.min(p.top, q.top),
    });
  }
  return out;
}

// ── geometry ─────────────────────────────────────────────────────────

/** A single leaf placed along the stem (vine-local coords, base at 0,0). */
export interface Leaf {
  x: number;
  y: number;
  rot: number; // degrees
  scale: number;
  side: number; // -1 left / +1 right
}

/** Just the bits of a vine the geometry needs. */
export interface VineShape {
  seed: number;
  length: number;
}

/** How far up the gap a vine reaches at its current growth, in px. */
export function stemHeight(v: VineShape, maxHeight: number): number {
  return maxHeight * v.length;
}

/** Per-vine stem character, fully derived from the seed so every vine is
 *  unique: a sinusoidal sway with its own amplitude, phase, frequency and
 *  a slight constant lean. Shared by stemPath + leaves so leaves sit on
 *  the stem. */
interface StemParams {
  amp: number;
  phase: number;
  freq: number;
  lean: number;
}
function stemParams(seed: number): StemParams {
  const r = rng(seed);
  return {
    amp: 7 + r() * 16,
    phase: r() * Math.PI * 2,
    freq: 1.2 + r() * 1.9,
    lean: (r() * 2 - 1) * 0.22,
  };
}
/** Stem x-offset at height fraction t (0 base → 1 tip). Anchored at x=0. */
function stemXAt(p: StemParams, t: number): number {
  return (Math.sin(p.phase + p.freq * Math.PI * t) * p.amp + p.lean * p.amp * 2 * t) * t;
}

/** Leaf slots per stem of a given pixel height, so density (leaves/px)
 *  stays constant — taller vines get more leaves instead of stretching. */
export function leafCountFor(maxHeight: number, spacingPx = 26): number {
  return Math.max(2, Math.round(maxHeight / spacingPx));
}

/**
 * SVG path `d` for a vine's climbing stem, in the vine's local space
 * (x≈0 at the base, y=0 at the base, up to -stemHeight). The wiggle is a
 * seeded sinusoid sampled at a fixed pixel cadence (so it doesn't stretch
 * on tall stems) and smoothed with quadratic segments.
 */
export function stemPath(v: VineShape, maxHeight: number): string {
  const h = stemHeight(v, maxHeight);
  if (h <= 0.5) return "";
  const p = stemParams(v.seed);
  const n = Math.max(2, Math.round(h / 22)); // sample every ~22px
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([stemXAt(p, t), -h * t]);
  }
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
  return d;
}

/**
 * Leaves along the stem. `maxLeaves` slots (default scales with height for
 * constant density) sit at FIXED height fractions and are revealed once
 * growth passes them — so existing leaves never shift; new ones appear
 * above. Side, angle and scale are all seeded, so no two vines share a
 * leaf pattern. Leaves attach to the actual stem curve.
 */
export function leaves(
  v: VineShape,
  maxHeight: number,
  maxLeaves = leafCountFor(maxHeight),
): Leaf[] {
  const p = stemParams(v.seed);
  const r = rng((v.seed ^ 0x9e3779b9) >>> 0);
  const out: Leaf[] = [];
  for (let i = 0; i < maxLeaves; i++) {
    const t = (i + 0.5) / maxLeaves;
    // Pull jitter every iteration so a slot's look is stable regardless
    // of how many are currently revealed.
    const side = r() < 0.5 ? -1 : 1;
    const jitterRot = r();
    const jitterScale = r();
    if (t > v.length) continue;
    out.push({
      x: stemXAt(p, t) + side * 2, // sit on the stem, leaning outward
      y: -maxHeight * t,
      rot: side * (20 + jitterRot * 45),
      scale: 0.55 + jitterScale * 0.55,
      side,
    });
  }
  return out;
}
