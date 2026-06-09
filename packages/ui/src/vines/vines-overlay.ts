/**
 * Imperative vines overlay — all the side effects the pure core
 * (vine-core.ts) avoids: DOM, observing the session columns, the activity
 * tick, cursor "wind", and persistence.
 *
 * Model (see vine-core.ts): growth is per-REPO and accrues from real work
 * (active-session time, weighted by how many windows). It's persisted, so
 * vines survive across days and reappear at their saved lushness whenever
 * the repo has windows again. We just draw the repo's current growth as a
 * vine in each gap between its adjacent session windows.
 *
 * Perf rules:
 *  - pointer-events:none — never intercepts terminal input.
 *  - Growth is a slow interval tick (seconds), NOT a rAF loop.
 *  - The only high-frequency input (pointermove) is rAF-throttled and
 *    writes ONE CSS var (`--wind`); sway is a composited CSS transform.
 *  - We read the DOM (column rects) but never mutate the app's DOM.
 */

import {
  buildVines,
  accrue,
  growthOf,
  repoIntensities,
  stemPath,
  leaves,
  type Panel,
  type GrowthStore,
  type RenderVine,
} from "./vine-core";

const STORE_KEY = "vines:v2"; // v2 = per-repo activity growth
const TICK_MS = 2000; // activity accrual + reconcile cadence
const SAVE_EVERY_MS = 15_000; // persistence throttle
const DT_CLAMP_MS = 4 * TICK_MS; // ignore huge gaps (sleep/throttle)
// Active-session time (at unit intensity) for a repo to reach full. ~24h
// of focused work → with a couple of windows and a few hours a day, that's
// roughly a week of real use.
const DEFAULT_FULL_ACTIVE_MS = 24 * 60 * 60 * 1000;

const COL_SELECTOR = ".session-col[data-session-source]";
const SVGNS = "http://www.w3.org/2000/svg";
const LEAF_D = "M0 0 C -4.5 -4 -4.5 -11 0 -15 C 4.5 -11 4.5 -4 0 0 Z";

const QUERY = (() => {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
})();

/** `?vinesspeed=N` accrues growth N× faster (demos). */
const SPEED = (() => {
  const n = Number(QUERY.get("vinesspeed"));
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

/** Active-time budget to reach full growth. */
const FULL_ACTIVE_MS = DEFAULT_FULL_ACTIVE_MS;

/** `?vinesgrow=0..1` pre-seeds a repo's growth so vines are visible
 *  immediately (simulates prior work). 0 = off. */
const PRESEED = (() => {
  const n = Number(QUERY.get("vinesgrow"));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
})();

interface VineNodes {
  posG: SVGGElement;
  windG: SVGGElement;
  stem: SVGPathElement;
  leafLayer: SVGGElement;
  renderedLeaves: number;
  lastD: string;
}

// Stable per-row-strip group id so vines only connect columns in the same
// worktree row. Keyed on the strip element.
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

function repoOf(el: HTMLElement): string {
  return el.closest("[data-repo-id]")?.getAttribute("data-repo-id") ?? "";
}

function scanPanels(): Panel[] {
  const out: Panel[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(COL_SELECTOR)) {
    const source = el.dataset.sessionSource;
    if (!source) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    out.push({
      source,
      repo: repoOf(el),
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

function load(): GrowthStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as GrowthStore;
    if (!obj || typeof obj !== "object") return {};
    const clean: GrowthStore = {};
    for (const [repo, g] of Object.entries(obj)) {
      if (g && typeof (g as any).activeMs === "number") {
        clean[repo] = { activeMs: (g as any).activeMs };
      }
    }
    return clean;
  } catch {
    return {};
  }
}

function save(store: GrowthStore) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // storage full/disabled — vines just won't persist; no harm.
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

  let store: GrowthStore = load();
  let vines: RenderVine[] = [];
  const nodes = new Map<string, VineNodes>();
  const seededRepos = new Set<string>(); // PRESEED applied once per repo
  let lastTick = Date.now();
  let lastSave = Date.now();
  let destroyed = false;

  /** Accrue activity for the repos currently on screen, rebuild the vines
   *  from the panels + growth, and repaint. The single place layout +
   *  growth meet. `accrueDt` is 0 for pure layout syncs (scroll/resize). */
  function syncAndGrow(accrueDt: number) {
    const panels = scanPanels();
    const intensities = repoIntensities(panels);

    // Demo pre-seed: make a repo look already-worked the first time we see
    // it, so vines are visible without waiting.
    if (PRESEED > 0) {
      for (const repo of intensities.keys()) {
        if (repo && !seededRepos.has(repo)) {
          seededRepos.add(repo);
          const want = PRESEED * FULL_ACTIVE_MS;
          if ((store[repo]?.activeMs ?? 0) < want) {
            store = { ...store, [repo]: { activeMs: want } };
          }
        }
      }
    }

    if (accrueDt > 0) {
      store = accrue(store, intensities, accrueDt * SPEED);
    }
    vines = buildVines(panels, store, FULL_ACTIVE_MS);
    render();
  }

  // ── geometry sync (scroll/resize/mutation): reposition, no accrual ────
  let syncQueued = false;
  function queueSync() {
    if (syncQueued || destroyed) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      if (!destroyed) syncAndGrow(0);
    });
  }

  // ── activity tick (seconds apart) ────────────────────────────────────
  const tick = setInterval(() => {
    if (destroyed) return;
    const now = Date.now();
    // Only credit time while the tab is visible — that's "active work".
    const dt =
      document.visibilityState === "visible"
        ? Math.min(now - lastTick, DT_CLAMP_MS)
        : 0;
    lastTick = now;
    syncAndGrow(dt);
    if (now - lastSave > SAVE_EVERY_MS) {
      save(store);
      lastSave = now;
    }
  }, TICK_MS);

  // ── render: build/patch SVG per vine ─────────────────────────────────
  function render() {
    const alive = new Set(vines.map((v) => v.key));
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

  function createVineNodes(v: RenderVine): VineNodes {
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

  function patchLeaves(v: RenderVine, n: VineNodes, maxH: number) {
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
      path.style.animationDelay = `${((i * 0.7 + (leaf.side > 0 ? 0.35 : 0)) % 4).toFixed(2)}s`;
      anchor.appendChild(path);
      n.leafLayer.appendChild(anchor);
    }
    while (n.leafLayer.childElementCount > ls.length && n.leafLayer.lastChild) {
      n.leafLayer.removeChild(n.leafLayer.lastChild);
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
  const onHide = () => save(store);
  window.addEventListener("pagehide", onHide);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") save(store);
    else lastTick = Date.now(); // don't credit hidden time as work
  };
  document.addEventListener("visibilitychange", onVisibility);

  // first paint
  syncAndGrow(0);

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
      save(store);
      root.remove();
      nodes.clear();
    },
  };
}

function vineMaxHeight(v: RenderVine): number {
  const colH = Math.max(0, v.baseY - v.topY);
  return Math.max(70, Math.min(240, colH * 0.5));
}
