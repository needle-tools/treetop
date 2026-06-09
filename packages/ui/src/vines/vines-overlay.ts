/**
 * Imperative vines overlay — DOM, observing the session columns, the
 * activity tick, and persistence. The pure model lives in vine-core.ts.
 *
 * STICKING: each vine SVG is injected INTO its `.sessions-strip` (the
 * horizontally-scrolling row of session windows) and positioned in the
 * strip's CONTENT coordinates. So the vines are part of the scrollable
 * content and move natively with the panels — both when the row scrolls
 * horizontally and when the page scrolls vertically. No scroll listener,
 * no JS chasing, no lag/"float". We only re-measure on layout changes
 * (resize / columns added or removed) and on the slow growth tick.
 *
 * Growth (see vine-core.ts) is per-REPO and accrues from real work
 * (active-session time weighted by window count); persisted across days.
 *
 * Perf rules: pointer-events:none (never intercepts terminal input);
 * growth is a seconds-apart interval, not a rAF loop; leaf sway is a
 * composited CSS transform; no cursor interaction; we never mutate the
 * app's own DOM except setting `position: relative` on a strip that's
 * static (restored on teardown) so our absolute SVG can anchor to it.
 */

import {
  buildVines,
  accrue,
  repoIntensities,
  stemPath,
  leaves,
  type Panel,
  type GrowthStore,
  type RenderVine,
} from "./vine-core";

const STORE_KEY = "vines:v2"; // per-repo activity growth
const TICK_MS = 2000;
const SAVE_EVERY_MS = 15_000;
const DT_CLAMP_MS = 4 * TICK_MS;
const DEFAULT_FULL_ACTIVE_MS = 24 * 60 * 60 * 1000; // ~24h active → full

const STRIP_SELECTOR = ".sessions-strip";
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
const SPEED = (() => {
  const n = Number(QUERY.get("vinesspeed") ?? QUERY.get("vinespeed"));
  return Number.isFinite(n) && n > 0 ? n : 1;
})();
const FULL_ACTIVE_MS = DEFAULT_FULL_ACTIVE_MS;
const PRESEED = (() => {
  const n = Number(QUERY.get("vinesgrow"));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
})();
const DEBUG = QUERY.has("vinesdebug");

interface VineNodes {
  posG: SVGGElement;
  stem: SVGPathElement;
  leafLayer: SVGGElement;
  renderedLeaves: number;
  lastD: string;
}

interface StripState {
  svg: SVGSVGElement;
  nodes: Map<string, VineNodes>;
  /** True if we set inline position:relative (so we can restore it). */
  setPosition: boolean;
}

function repoOf(el: HTMLElement): string {
  return el.closest("[data-repo-id]")?.getAttribute("data-repo-id") ?? "";
}

function vineMaxHeight(v: RenderVine): number {
  const colH = Math.max(0, v.baseY - v.topY);
  return Math.max(80, Math.min(420, colH * 0.62));
}

function load(): GrowthStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as GrowthStore;
    if (!obj || typeof obj !== "object") return {};
    const clean: GrowthStore = {};
    for (const [repo, g] of Object.entries(obj)) {
      if (g && typeof (g as { activeMs?: unknown }).activeMs === "number") {
        clean[repo] = { activeMs: (g as { activeMs: number }).activeMs };
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
    /* best-effort */
  }
}

export function createVinesOverlay(): { destroy: () => void } {
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  let store: GrowthStore = load();
  const strips = new Map<HTMLElement, StripState>();
  const seededRepos = new Set<string>();
  let lastTick = Date.now();
  let lastSave = Date.now();
  let destroyed = false;

  // ── measure one strip's columns in STRIP-LOCAL content coordinates ───
  function panelsForStrip(strip: HTMLElement): Panel[] {
    const sr = strip.getBoundingClientRect();
    const out: Panel[] = [];
    for (const col of strip.querySelectorAll<HTMLElement>(COL_SELECTOR)) {
      const source = col.dataset.sessionSource;
      if (!source) continue;
      const cr = col.getBoundingClientRect();
      if (cr.width === 0 && cr.height === 0) continue;
      // viewport delta + scroll offset = position in scroll content,
      // stable regardless of the current scroll position.
      const left = cr.left - sr.left + strip.scrollLeft;
      const top = cr.top - sr.top + strip.scrollTop;
      out.push({
        source,
        repo: repoOf(col),
        cx: left + cr.width / 2,
        left,
        right: left + cr.width,
        top,
        bottom: top + cr.height,
      });
    }
    return out;
  }

  function ensureStrip(strip: HTMLElement): StripState {
    let st = strips.get(strip);
    if (st) return st;
    let setPosition = false;
    if (getComputedStyle(strip).position === "static") {
      strip.style.position = "relative";
      setPosition = true;
    }
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", reduceMotion ? "vines-svg vines-reduced" : "vines-svg");
    strip.appendChild(svg);
    st = { svg, nodes: new Map(), setPosition };
    strips.set(strip, st);
    return st;
  }

  function removeStrip(strip: HTMLElement, st: StripState) {
    st.svg.remove();
    if (st.setPosition) strip.style.position = "";
    strips.delete(strip);
  }

  /** Measure every strip, accrue activity for active repos, rebuild and
   *  repaint each strip's vines. `accrueDt` is 0 for pure layout syncs. */
  function syncAndGrow(accrueDt: number) {
    const liveStrips = new Set<HTMLElement>();
    const allPanels: Panel[] = [];
    const perStrip: { strip: HTMLElement; panels: Panel[] }[] = [];

    for (const strip of document.querySelectorAll<HTMLElement>(STRIP_SELECTOR)) {
      const panels = panelsForStrip(strip);
      liveStrips.add(strip);
      perStrip.push({ strip, panels });
      allPanels.push(...panels);
    }

    // Pre-seed (demo): make repos look already-worked the first time seen.
    const intensities = repoIntensities(allPanels);
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
    if (accrueDt > 0) store = accrue(store, intensities, accrueDt * SPEED);

    let totalVines = 0;
    for (const { strip, panels } of perStrip) {
      const vines = buildVines(panels, store, FULL_ACTIVE_MS);
      totalVines += vines.length;
      // Don't inject into strips that never have vines, to stay tidy.
      if (vines.length === 0 && !strips.has(strip)) continue;
      renderStrip(ensureStrip(strip), vines);
    }

    // Drop overlays for strips that vanished from the DOM.
    for (const [strip, st] of strips) {
      if (!liveStrips.has(strip)) removeStrip(strip, st);
    }

    if (DEBUG) {
      console.info(
        `[vines] strips=${perStrip.length} panels=${allPanels.length} vines=${totalVines}`,
      );
    }
  }

  function renderStrip(st: StripState, vines: RenderVine[]) {
    const alive = new Set(vines.map((v) => v.key));
    for (const [key, n] of st.nodes) {
      if (!alive.has(key)) {
        n.posG.remove();
        st.nodes.delete(key);
      }
    }
    for (const v of vines) {
      let n = st.nodes.get(v.key);
      if (!n) n = createVineNodes(st, v);
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

  function createVineNodes(st: StripState, v: RenderVine): VineNodes {
    const posG = document.createElementNS(SVGNS, "g");
    posG.setAttribute("class", "vine");
    const stem = document.createElementNS(SVGNS, "path");
    stem.setAttribute("class", "vine-stem");
    const leafLayer = document.createElementNS(SVGNS, "g");
    leafLayer.setAttribute("class", "vine-leaves");
    posG.appendChild(stem);
    posG.appendChild(leafLayer);
    st.svg.appendChild(posG);
    const n: VineNodes = { posG, stem, leafLayer, renderedLeaves: 0, lastD: "" };
    st.nodes.set(v.key, n);
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

  // ── layout-change sync (resize / columns added/removed) ──────────────
  let syncQueued = false;
  function queueSync() {
    if (syncQueued || destroyed) return;
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      if (!destroyed) syncAndGrow(0);
    });
  }

  // ── growth tick ──────────────────────────────────────────────────────
  const tick = setInterval(() => {
    if (destroyed) return;
    const now = Date.now();
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

  // ── observers (NO scroll listener — sticking is native) ──────────────
  const ro = new ResizeObserver(queueSync);
  ro.observe(document.body);
  const mo = new MutationObserver(queueSync);
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", queueSync, { passive: true });
  const onHide = () => save(store);
  window.addEventListener("pagehide", onHide);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") save(store);
    else lastTick = Date.now();
  };
  document.addEventListener("visibilitychange", onVisibility);

  syncAndGrow(0);

  return {
    destroy() {
      destroyed = true;
      clearInterval(tick);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", queueSync as EventListener);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      save(store);
      for (const [strip, st] of strips) removeStrip(strip, st);
    },
  };
}
