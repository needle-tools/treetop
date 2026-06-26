/**
 * Imperative vines overlay — DOM, observing the session columns, the
 * lifetime tick, and persistence. The pure model lives in vine-core.ts.
 *
 * MODEL: each session has a "length" = how long we've observed it alive
 * (while the tab is visible), persisted per source. A vine between two
 * windows is sized by the AVERAGE growth of those two sessions, so it
 * adapts slowly as the sessions age and never jumps when windows are
 * reordered (it's a pure function of stable session ages).
 *
 * STICKING: each vine SVG is injected INTO its `.sessions-strip` and
 * positioned in the strip's CONTENT coordinates, so it scrolls natively
 * with the panels (no float). We only re-measure on layout changes; growth
 * ticks reuse cached geometry and never measure layout.
 *
 * Perf: pointer-events:none; seconds-apart tick (no rAF loop); composited
 * CSS leaf sway; no cursor interaction; the only app-DOM touch is setting
 * `position: relative` on a static strip (restored on teardown).
 */

import {
  buildVines,
  accrueAges,
  stemPath,
  leaves,
  type Panel,
  type SourceAges,
  type RenderVine,
} from "./vine-core";

const STORE_KEY = "vines:v3"; // per-session lifetimes
const TICK_MS = 2000;
const SAVE_EVERY_MS = 15_000;
const DT_CLAMP_MS = 4 * TICK_MS;
const DEFAULT_FULL_MS = 4 * 60 * 60 * 1000; // ~4h of session lifetime → full

const STRIP_SELECTOR = ".sessions-strip";
const COL_SELECTOR = ".session-col[data-session-source]";
const SVGNS = "http://www.w3.org/2000/svg";
const LEAF_D = "M0 0 C -4.5 -4 -4.5 -11 0 -15 C 4.5 -11 4.5 -4 0 0 Z";
const STEM_GRAD_ID = "vine-stem-grad";

const QUERY = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search ?? "");
  } catch {
    return new URLSearchParams();
  }
})();
const SPEED = (() => {
  const n = Number(QUERY.get("vinesspeed") ?? QUERY.get("vinespeed"));
  return Number.isFinite(n) && n > 0 ? n : 1;
})();
const FULL_MS = DEFAULT_FULL_MS;
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
  setPosition: boolean;
}

interface StripSnapshot {
  liveStrips: Set<HTMLElement>;
  presentSources: string[];
  perStrip: { strip: HTMLElement; panels: Panel[] }[];
}

type MutationLike = Pick<MutationRecord, "target" | "addedNodes" | "removedNodes">;

function nodeMatches(node: unknown, selector: string): boolean {
  const maybeElement = node as Element | null | undefined;
  return typeof maybeElement?.matches === "function" && maybeElement.matches(selector);
}

function nodeContainsStrip(node: unknown): boolean {
  if (nodeMatches(node, STRIP_SELECTOR)) return true;
  const maybeElement = node as Element | null | undefined;
  return (
    typeof maybeElement?.querySelector === "function" &&
    maybeElement.querySelector(STRIP_SELECTOR) !== null
  );
}

function nodeListContainsStrip(nodes: ArrayLike<unknown>): boolean {
  for (let i = 0; i < nodes.length; i++) {
    if (nodeContainsStrip(nodes[i])) return true;
  }
  return false;
}

export function mutationsAffectVinesLayout(records: MutationLike[]): boolean {
  for (const record of records) {
    if (nodeMatches(record.target, STRIP_SELECTOR)) return true;
    if (nodeListContainsStrip(record.addedNodes)) return true;
    if (nodeListContainsStrip(record.removedNodes)) return true;
  }
  return false;
}

/** Grow to (nearly) the full panel height — a little headroom so the top
 *  leaves aren't clipped by the strip's overflow. */
function vineMaxHeight(v: RenderVine): number {
  const colH = Math.max(0, v.baseY - v.topY);
  return Math.max(100, colH - 18);
}

function load(): SourceAges {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw) as SourceAges;
    if (!obj || typeof obj !== "object") return {};
    const clean: SourceAges = {};
    for (const [src, ms] of Object.entries(obj)) {
      if (typeof ms === "number" && ms >= 0) clean[src] = ms;
    }
    return clean;
  } catch {
    return {};
  }
}

function save(store: SourceAges) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* best-effort */
  }
}

/** Inject the shared stem gradient once (dark at the root → green at the
 *  top). objectBoundingBox so it maps to each stem's own bounds. */
function makeDefs(): SVGSVGElement {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "vines-defs");
  svg.setAttribute("aria-hidden", "true");
  const defs = document.createElementNS(SVGNS, "defs");
  const grad = document.createElementNS(SVGNS, "linearGradient");
  grad.setAttribute("id", STEM_GRAD_ID);
  grad.setAttribute("gradientUnits", "objectBoundingBox");
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "1"); // base
  grad.setAttribute("x2", "0");
  grad.setAttribute("y2", "0"); // tip
  for (const [offset, cls] of [
    ["0", "vine-grad-base"],
    ["0.45", "vine-grad-mid"],
    ["1", "vine-grad-top"],
  ] as const) {
    const stop = document.createElementNS(SVGNS, "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("class", cls);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);
  return svg;
}

export function createVinesOverlay(): { destroy: () => void } {
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  let store: SourceAges = load();
  const strips = new Map<HTMLElement, StripState>();
  const panelCache = new Map<HTMLElement, Panel[]>();
  const seeded = new Set<string>();
  let lastTick = Date.now();
  let lastSave = Date.now();
  let destroyed = false;

  const defs = makeDefs();
  document.body.appendChild(defs);

  // ── measure one strip's columns in STRIP-LOCAL content coordinates ───
  function panelsForStrip(strip: HTMLElement): Panel[] {
    const sr = strip.getBoundingClientRect();
    const out: Panel[] = [];
    for (const col of strip.querySelectorAll<HTMLElement>(COL_SELECTOR)) {
      const source = col.dataset.sessionSource;
      if (!source) continue;
      const cr = col.getBoundingClientRect();
      if (cr.width === 0 && cr.height === 0) continue;
      const left = cr.left - sr.left + strip.scrollLeft;
      const top = cr.top - sr.top + strip.scrollTop;
      out.push({
        source,
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

  function snapshotFromLayout(): StripSnapshot {
    const liveStrips = new Set<HTMLElement>();
    const presentSources: string[] = [];
    const perStrip: { strip: HTMLElement; panels: Panel[] }[] = [];

    for (const strip of document.querySelectorAll<HTMLElement>(STRIP_SELECTOR)) {
      const panels = panelsForStrip(strip);
      liveStrips.add(strip);
      panelCache.set(strip, panels);
      perStrip.push({ strip, panels });
      for (const p of panels) presentSources.push(p.source);
    }
    for (const strip of [...panelCache.keys()]) {
      if (!liveStrips.has(strip)) panelCache.delete(strip);
    }
    return { liveStrips, presentSources, perStrip };
  }

  function snapshotFromCache(): StripSnapshot {
    const liveStrips = new Set<HTMLElement>();
    const presentSources: string[] = [];
    const perStrip: { strip: HTMLElement; panels: Panel[] }[] = [];

    for (const [strip, panels] of panelCache) {
      if (!strip.isConnected) {
        panelCache.delete(strip);
        continue;
      }
      liveStrips.add(strip);
      perStrip.push({ strip, panels });
      for (const p of panels) presentSources.push(p.source);
    }
    return { liveStrips, presentSources, perStrip };
  }

  function syncAndGrow(accrueDt: number, measureLayout: boolean) {
    const { liveStrips, presentSources, perStrip } = measureLayout
      ? snapshotFromLayout()
      : snapshotFromCache();

    // Demo pre-seed: make a session look already-aged the first time seen.
    if (PRESEED > 0) {
      for (const s of presentSources) {
        if (!seeded.has(s)) {
          seeded.add(s);
          const want = PRESEED * FULL_MS;
          if ((store[s] ?? 0) < want) store = { ...store, [s]: want };
        }
      }
    }
    if (accrueDt > 0) {
      store = accrueAges(store, presentSources, accrueDt * SPEED, FULL_MS);
    }

    let totalVines = 0;
    for (const { strip, panels } of perStrip) {
      const vines = buildVines(panels, store, FULL_MS);
      totalVines += vines.length;
      if (vines.length === 0 && !strips.has(strip)) continue;
      renderStrip(ensureStrip(strip), vines);
    }
    for (const [strip, st] of strips) {
      if (!liveStrips.has(strip)) removeStrip(strip, st);
    }

    if (DEBUG) {
      console.info(
        `[vines] strips=${perStrip.length} sources=${presentSources.length} vines=${totalVines} measured=${measureLayout}`,
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
      // depth shading: 0 = dark (root) → 1 = bright (top)
      path.style.setProperty("--leaf-light", leaf.light.toFixed(2));
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
      if (!destroyed) syncAndGrow(0, true);
    });
  }

  const tick = setInterval(() => {
    if (destroyed) return;
    const now = Date.now();
    const dt =
      document.visibilityState === "visible"
        ? Math.min(now - lastTick, DT_CLAMP_MS)
        : 0;
    lastTick = now;
    syncAndGrow(dt, false);
    if (now - lastSave > SAVE_EVERY_MS) {
      save(store);
      lastSave = now;
    }
  }, TICK_MS);

  const ro = new ResizeObserver(queueSync);
  ro.observe(document.body);
  const mo = new MutationObserver((records) => {
    if (mutationsAffectVinesLayout(records)) queueSync();
  });
  mo.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", queueSync, { passive: true });
  // Persist on every exit path so startup restores the exact last size
  // (vines snap to their saved size immediately — no grow-in animation).
  const onHide = () => save(store);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("beforeunload", onHide);
  const onVisibility = () => {
    if (document.visibilityState === "hidden") save(store);
    else lastTick = Date.now();
  };
  document.addEventListener("visibilitychange", onVisibility);

  syncAndGrow(0, true);

  return {
    destroy() {
      destroyed = true;
      clearInterval(tick);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", queueSync as EventListener);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      save(store);
      for (const [strip, st] of strips) removeStrip(strip, st);
      defs.remove();
    },
  };
}
