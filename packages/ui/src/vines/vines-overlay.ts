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
  grownLength,
  stemPath,
  leaves,
  type Panel,
  type Vine,
} from "./vine-core";

const STORE_KEY = "vines:v1";
const TICK_MS = 2000; // growth + reconcile cadence
const SAVE_EVERY_MS = 15_000; // persistence throttle
const FULL_MS = 15 * 60 * 1000; // a vine reaches full length over ~15 min
const COL_SELECTOR = ".session-col[data-session-source]";
const SVGNS = "http://www.w3.org/2000/svg";
const LEAF_D = "M0 0 C -4.5 -4 -4.5 -11 0 -15 C 4.5 -11 4.5 -4 0 0 Z";

interface VineNodes {
  posG: SVGGElement; // viewport placement (translate)
  windG: SVGGElement; // wind rotation (--wind)
  stem: SVGPathElement;
  leafLayer: SVGGElement;
  renderedLeaves: number;
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
  let lastGrow = Date.now();
  let lastSave = Date.now();
  let destroyed = false;

  // ── geometry sync (cheap; just re-reads rects + repositions groups) ──
  let syncQueued = false;
  function queueSync() {
    if (syncQueued || destroyed) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      syncLayout();
    });
  }
  function syncLayout() {
    if (destroyed) return;
    const panels = scanPanels();
    vines = reconcile(vines, panels, Date.now());
    render();
  }

  // ── growth tick (seconds apart) ──────────────────────────────────────
  const tick = setInterval(() => {
    if (destroyed) return;
    const now = Date.now();
    const dt = now - lastGrow;
    lastGrow = now;
    if (document.visibilityState === "visible") {
      let changed = false;
      for (const v of vines) {
        const next = grownLength(v.length, dt, FULL_MS);
        if (next !== v.length) {
          v.length = next;
          changed = true;
        }
      }
      // Reconcile too, so panels that appeared/disappeared between
      // observer events are still picked up.
      vines = reconcile(vines, scanPanels(), now);
      if (changed || true) render();
    }
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
      n.stem.setAttribute("d", d);
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
    const n: VineNodes = { posG, windG, stem, leafLayer, renderedLeaves: 0 };
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
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save(vines);
    else lastGrow = Date.now(); // don't credit hidden time as growth
  });

  // first paint
  syncLayout();

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
      save(vines);
      root.remove();
      nodes.clear();
    },
  };
}
