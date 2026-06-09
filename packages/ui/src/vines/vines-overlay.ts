/**
 * Imperative vines overlay — all the side effects the pure core
 * (vine-core.ts) deliberately avoids: DOM construction, observing the
 * session columns, the slow growth tick, cursor "wind", and persistence.
 *
 * Design / perf rules (see plans/performance.md for why these matter):
 *   - The overlay is `pointer-events: none` so it never intercepts input
 *     to the terminals it floats over.
 *   - Growth is a slow interval tick (seconds apart), NOT a rAF loop.
 *     Per tick we only touch the handful of vines whose length changed.
 *   - The only high-frequency input (pointermove) is rAF-throttled and
 *     writes ONE CSS custom property (`--wind`); leaf sway itself is a
 *     CSS keyframe transform (composited), never JS-driven per frame.
 *   - We read the DOM (column rects) but never mutate the app's DOM —
 *     the overlay is our own detached node appended to <body>.
 */

import {
  reconcile,
  growthForAge,
  stemPath,
  leaves,
  type Panel,
  type Vine,
} from "./vine-core";

const STORE_KEY = "vines:v1";
const TICK_MS = 2000; // growth + reconcile cadence
const SAVE_EVERY_MS = 15_000; // persistence throttle
const DEFAULT_FULL_MS = 7 * 24 * 60 * 60 * 1000; // ~1 week to full

const QUERY = (() => {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
})();

/** Time for a vine to reach full length. `?vinesspeed=N` divides it by N
 *  (e.g. 1000 → a few seconds) for demos; clamped so it can't be instant. */
function resolveFullMs(): number {
  const n = Number(QUERY.get("vinesspeed"));
  if (Number.isFinite(n) && n > 0) return Math.max(2000, DEFAULT_FULL_MS / n);
  return DEFAULT_FULL_MS;
}
const FULL_MS = resolveFullMs();

/** `?vinesgrow=0..1` pre-ages freshly-born vines so they're already partly
 *  grown — simulates prior usage/growth so you can see vines immediately
 *  instead of waiting. 0 = off (normal slow growth from scratch). */
const PRESEED = (() => {
  const n = Number(QUERY.get("vinesgrow"));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
})();

// Stable per-row-strip group id, so vines only connect columns in the
// same worktree row (see adjacentPairs). Keyed on the strip element.
let stripSeq = 0;
const stripIds = new WeakMap<Element, string>();
function groupOf(el: HTMLElement): string {
  const strip = el.closest("[data-wt-strip]");
  if (!strip) return "";
  const attr = strip.getAttribute("data-wt-strip");
  if (attr) return attr;
  let id = stripIds.get(strip);
  if (!id) {
    id = `strip-${stripSeq++}`;
    stripIds.set(strip, id);
  }
  return id;
}
const COL_SELECTOR = ".session-col[data-session-source]";
const SVGNS = "http://www.w3.org/2000/svg";
const LEAF_D = "M0 0 C -4.5 -4 -4.5 -11 0 -15 C 4.5 -11 4.5 -4 0 0 Z";

interface VineNodes {
  posG: SVGGElement; // viewport placement (translate)
  windG: SVGGElement; // wind rotation (--wind)
  stem: SVGPathElement;
  leafLayer: SVGGElement;
  renderedLeaves: number;
  lastD: string;
}

interface Persisted {
  key: string;
  a: string;
  b: string;
  seed: number;
  bornAt: number;
  length: number;
  ax: number;
  bx: number;
  baseY: number;
  topY: number;
}

function vineMaxHeight(v: Vine): number {
  const colH = Math.max(0, v.baseY - v.topY);
  return Math.max(70, Math.min(240, colH * 0.5));
}

function scanPanels(): Panel[] {
  const out: Panel[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(COL_SELECTOR)) {
    const source = el.dataset.sessionSource;
    if (!source) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; // hidden/unmounted
    out.push({
      source,
      group: groupOf(el),
      cx: r.left + r.width / 2,
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
    });
  }
  return out;
}

function load(): Vine[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as Persisted[];
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (v) => v && typeof v.key === "string" && typeof v.length === "number",
    );
  } catch {
    return [];
  }
}

function save(vines: Vine[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(vines));
  } catch {
    // storage full / disabled — vines just won't persist; no harm.
  }
}

export function createVinesOverlay(): { destroy: () => void } {
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const root = document.createElement("div");
  root.className = "vines-overlay";
  if (reduceMotion) root.classList.add("vines-reduced");
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "vines-svg");
  root.appendChild(svg);
  document.body.appendChild(root);

  let vines: Vine[] = load();
  const nodes = new Map<string, VineNodes>();
  // Keys we've already seen, so PRESEED only pre-ages genuinely NEW vines
  // (loaded vines keep their real, persisted bornAt).
  const knownKeys = new Set(vines.map((v) => v.key));
  let lastSave = Date.now();
  let destroyed = false;

  /** Reconcile against the current panels, pre-age any brand-new vines
   *  (demo only), then derive every vine's length from its wall-clock age
   *  and repaint. The single place layout + growth meet. */
  function reconcileAndGrow(now: number) {
    vines = reconcile(vines, scanPanels(), now);
    for (const v of vines) {
      if (!knownKeys.has(v.key)) {
        if (PRESEED > 0) v.bornAt = now - PRESEED * FULL_MS;
        knownKeys.add(v.key);
      }
      v.length = growthForAge(v.bornAt, now, FULL_MS);
    }
    render();
  }

  // ── geometry sync (cheap; re-reads rects, repositions, regrows) ──────
  let syncQueued = false;
  function queueSync() {
    if (syncQueued || destroyed) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      if (!destroyed) reconcileAndGrow(Date.now());
    });
  }

  // ── growth tick (seconds apart; growth is age-based so hidden/closed
  //    time still counts — that's how vines survive across days) ─────────
  const tick = setInterval(() => {
    if (destroyed) return;
    const now = Date.now();
    reconcileAndGrow(now);
    if (now - lastSave > SAVE_EVERY_MS) {
      save(vines);
      lastSave = now;
    }
  }, TICK_MS);

  // ── render: build/patch SVG per vine ─────────────────────────────────
  function render() {
    const alive = new Set(vines.map((v) => v.key));
    // drop nodes for vines that no longer exist
    for (const [key, n] of nodes) {
      if (!alive.has(key)) {
        n.posG.remove();
        nodes.delete(key);
      }
    }
    for (const v of vines) {
      let n = nodes.get(v.key);
      if (!n) n = createVineNodes(v);
      const cx = (v.ax + v.bx) / 2;
      n.posG.setAttribute("transform", `translate(${cx.toFixed(1)} ${v.baseY.toFixed(1)})`);
      const maxH = vineMaxHeight(v);
      const d = stemPath(v, maxH);
      if (d !== n.lastD) {
        n.stem.setAttribute("d", d);
        n.lastD = d;
      }
      patchLeaves(v, n, maxH);
    }
  }

  function createVineNodes(v: Vine): VineNodes {
    const posG = document.createElementNS(SVGNS, "g");
    posG.setAttribute("class", "vine");
    const windG = document.createElementNS(SVGNS, "g");
    windG.setAttribute("class", "vine-wind");
    const stem = document.createElementNS(SVGNS, "path");
    stem.setAttribute("class", "vine-stem");
    const leafLayer = document.createElementNS(SVGNS, "g");
    leafLayer.setAttribute("class", "vine-leaves");
    windG.appendChild(stem);
    windG.appendChild(leafLayer);
    posG.appendChild(windG);
    svg.appendChild(posG);
    const n: VineNodes = { posG, windG, stem, leafLayer, renderedLeaves: 0, lastD: "" };
    nodes.set(v.key, n);
    return n;
  }

  // Append only newly-revealed leaves (slots are stable, so existing leaf
  // nodes — and their running sway animations — are never recreated).
  function patchLeaves(v: Vine, n: VineNodes, maxH: number) {
    const ls = leaves(v, maxH);
    for (let i = n.renderedLeaves; i < ls.length; i++) {
      const leaf = ls[i];
      const anchor = document.createElementNS(SVGNS, "g");
      anchor.setAttribute(
        "transform",
        `translate(${leaf.x.toFixed(1)} ${leaf.y.toFixed(1)}) rotate(${leaf.rot.toFixed(1)}) scale(${leaf.scale.toFixed(2)})`,
      );
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("class", "vine-leaf");
      path.setAttribute("d", LEAF_D);
      // Stagger the sway so the canopy doesn't pulse in unison.
      path.style.animationDelay = `${((i * 0.7 + (leaf.side > 0 ? 0.35 : 0)) % 4).toFixed(2)}s`;
      anchor.appendChild(path);
      n.leafLayer.appendChild(anchor);
    }
    if (ls.length < n.renderedLeaves) {
      // growth never shrinks, but be safe if state was tampered with
      while (n.leafLayer.lastChild && n.leafLayer.childElementCount > ls.length) {
        n.leafLayer.removeChild(n.leafLayer.lastChild);
      }
    }
    n.renderedLeaves = ls.length;
  }

  // ── cursor "wind": one CSS var, rAF-throttled ────────────────────────
  let windQueued = false;
  let lastClientX = 0;
  function onPointerMove(e: PointerEvent) {
    lastClientX = e.clientX;
    if (windQueued) return;
    windQueued = true;
    requestAnimationFrame(() => {
      windQueued = false;
      // Map cursor X across the viewport to a gentle ±4deg sway.
      const f = (lastClientX / Math.max(1, window.innerWidth)) * 2 - 1;
      root.style.setProperty("--wind", `${(f * 4).toFixed(2)}deg`);
    });
  }

  // ── observers + listeners ────────────────────────────────────────────
  const ro = new ResizeObserver(queueSync);
  ro.observe(document.body);
  const mo = new MutationObserver(queueSync);
  mo.observe(document.body, { childList: true, subtree: true });
  const onScroll = () => queueSync();
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  window.addEventListener("resize", queueSync, { passive: true });
  if (!reduceMotion) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
  }
  const onHide = () => save(vines);
  window.addEventListener("pagehide", onHide);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") save(vines);
    else queueSync(); // catch up growth on return (age-based)
  };
  document.addEventListener("visibilitychange", onVisibility);

  // first paint
  reconcileAndGrow(Date.now());

  return {
    destroy() {
      destroyed = true;
      clearInterval(tick);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", onScroll, { capture: true } as any);
      window.removeEventListener("resize", queueSync as any);
      window.removeEventListener("pointermove", onPointerMove as any);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      save(vines);
      root.remove();
      nodes.clear();
    },
  };
}
