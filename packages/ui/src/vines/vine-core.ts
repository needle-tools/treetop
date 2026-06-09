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

/** Persisted state: per-session observed lifetime, in ms. A session's
 *  "length" is how long we've watched it alive (while the tab is
 *  visible). source → ms. */
export type SourceAges = Record<string, number>;

/** Session growth 0..1: its observed lifetime over the "full" budget. */
export function growthFromMs(ms: number, fullMs: number): number {
  if (fullMs <= 0) return 1;
  return Math.max(0, Math.min(1, ms / fullMs));
}

/** Growth of one session source. */
export function sessionGrowth(
  store: SourceAges,
  source: string,
  fullMs: number,
): number {
  return growthFromMs(store[source] ?? 0, fullMs);
}

/** Add `dtMs` of observed time to each currently-present source, capped
 *  at the full budget so it doesn't grow without bound. Pure. */
export function accrueAges(
  store: SourceAges,
  present: string[],
  dtMs: number,
  capMs: number,
): SourceAges {
  if (dtMs <= 0 || present.length === 0) return store;
  const next: SourceAges = { ...store };
  for (const s of present) {
    next[s] = Math.min(capMs, (next[s] ?? 0) + dtMs);
  }
  return next;
}

/** A vine to draw this frame: a gap between two adjacent windows. Its
 *  length is the AVERAGE growth of the two sessions it sits between — a
 *  pure function of the (slowly-rising) session ages, so reordering
 *  windows never causes a sudden size change. */
export interface RenderVine {
  key: string;
  /** The two session sources it sits between. */
  a: string;
  b: string;
  seed: number;
  length: number; // 0..1
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

/**
 * Build the vines to draw this frame from the current panels + session
 * ages. One vine per gap between adjacent windows in a row; its length is
 * the AVERAGE of the two flanking sessions' growth. Because that's a pure
 * function of the (slowly-rising) session ages, reordering the windows
 * just re-pairs stable values — no size jump. Stable `key` (source pair)
 * so the overlay keeps DOM nodes + running leaf animations across syncs.
 */
export function buildVines(
  panels: Panel[],
  store: SourceAges,
  fullMs: number,
): RenderVine[] {
  const out: RenderVine[] = [];
  for (const [p, q] of adjacentPairs(panels)) {
    const key = pairKey(p.source, q.source);
    const length =
      (sessionGrowth(store, p.source, fullMs) +
        sessionGrowth(store, q.source, fullMs)) /
      2;
    out.push({
      key,
      a: p.source,
      b: q.source,
      seed: hashSeed(key),
      length,
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
  /** 0 = dark (near background, at the root) → 1 = bright (top, near the
   *  light). Biased by height with randomness, so brighter leaves get
   *  likelier toward the top — fakes depth. */
  light: number;
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
  amp2: number;
  phase2: number;
  freq2: number;
  lean: number;
}
function stemParams(seed: number): StemParams {
  const r = rng(seed);
  const amp = 10 + r() * 16;
  const phase = r() * Math.PI * 2;
  const freq = 1.8 + r() * 2.4;
  return {
    amp,
    phase,
    freq,
    // A second, faster/smaller harmonic makes the stem curl organically
    // instead of reading as one tidy sine wave.
    amp2: amp * (0.3 + r() * 0.45),
    phase2: r() * Math.PI * 2,
    freq2: freq * (1.7 + r() * 1.4),
    lean: (r() * 2 - 1) * 0.25,
  };
}
/** Stem x-offset at height fraction t (0 base → 1 tip). Anchored at x=0. */
function stemXAt(p: StemParams, t: number): number {
  return (
    (Math.sin(p.phase + p.freq * Math.PI * t) * p.amp +
      Math.sin(p.phase2 + p.freq2 * Math.PI * t) * p.amp2 +
      p.lean * p.amp * 2 * t) *
    t
  );
}

/** Leaf slots per stem of a given pixel height, so density (leaves/px)
 *  stays constant — taller vines get more leaves instead of stretching. */
export function leafCountFor(maxHeight: number, spacingPx = 15): number {
  return Math.max(2, Math.round(maxHeight / spacingPx));
}

/**
 * SVG path `d` for a vine's climbing stem, in the vine's local space
 * (x≈0 at the base, y=0 at the base, up to -stemHeight). The wiggle is a
 * seeded two-harmonic sinusoid sampled at a fixed pixel cadence (so it
 * doesn't stretch on tall stems) and smoothed with quadratic segments.
 */
export function stemPath(v: VineShape, maxHeight: number): string {
  const len = Math.max(0, Math.min(1, v.length));
  const h = maxHeight * len;
  if (h <= 0.5) return "";
  const p = stemParams(v.seed);
  const n = Math.max(3, Math.round(h / 14)); // sample every ~14px for curl
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    // Sample along the FULL-height curve up to the grown fraction, the
    // SAME mapping leaves use (stemXAt(u), -maxHeight·u) — so leaves
    // always sit on the trunk and growth reveals upward (no stretch).
    const u = (i / n) * len;
    pts.push([stemXAt(p, u), -maxHeight * u]);
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
 * above. Side, angle, scale and `light` are all seeded. `light` is biased
 * by height (t) so brighter leaves get likelier toward the top (depth);
 * the lowest leaves sit near the background colour.
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
    const jitterLight = r();
    if (t > v.length) continue;
    out.push({
      x: stemXAt(p, t) + side * 2, // sit on the stem, leaning outward
      y: -maxHeight * t,
      rot: side * (20 + jitterRot * 45),
      scale: 0.55 + jitterScale * 0.55,
      side,
      // mean rises with height; randomness lets some bright leaves sit
      // lower and vice-versa.
      light: Math.max(0, Math.min(1, t * 0.85 + (jitterLight - 0.5) * 0.7)),
    });
  }
  return out;
}
