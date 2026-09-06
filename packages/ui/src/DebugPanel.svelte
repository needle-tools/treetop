<script lang="ts">
  /**
   * Animation / layer debug overlay. Toggle with F8 (ignored while typing in
   * an input / textarea / terminal). Lets you kill CSS-animation groups live
   * to find which one owns the renderer's Layerize cost — no rebuild needed.
   * See anim-debug.ts and plans/performance.md.
   *
   * Workflow: open it, turn on "ALL CSS animations" first — if Chrome's FPS
   * meter / Task Manager CPU drops, the cost IS animation-driven. Then switch
   * ALL off and flip groups one at a time to attribute it. Re-record a trace
   * with a group disabled to confirm Layerize fell.
   */
  import { onMount } from "svelte";
  import {
    ANIM_GROUPS,
    buildOverrideCss,
    classForGroup,
    markerLabel,
    rankMutationHotspots,
    type MutationHotspot,
  } from "./anim-debug";

  let open = false;
  let active = new Set<string>();
  let renderActivityEnabled = false;
  let renderFps = 0;
  let renderP95FrameMs = 0;
  let renderMutationCount = 0;
  let pendingMutationCount = 0;
  let renderHotspots: MutationHotspot[] = [];
  let renderMutationObserver: MutationObserver | null = null;
  let renderFrame = 0;
  let renderStatsTimer: ReturnType<typeof setInterval> | null = null;
  let renderLastFrameAt = 0;
  let renderFrameIntervals: number[] = [];
  let renderRegionCounts = new Map<string, number>();
  let pendingFlashRegions = new Set<HTMLElement>();
  let flashFrame = 0;
  /** group id -> performance.now() when it was disabled, to span a measure. */
  const disabledSince = new Map<string, number>();

  const STYLE_ID = "dbg-anim-overrides";
  const RENDER_REGION_SELECTOR = [
    ".session-col",
    ".row",
    ".session-dock",
    ".sticky-host",
    ".terminal-wrap",
  ].join(",");

  /**
   * Annotate a recorded trace so you can SEE which groups were off and when.
   * - `performance.mark` → a point in the Performance panel's Timings track.
   * - `console.timeStamp` → a vertical line across every track at that instant.
   * - `performance.measure` (on re-enable) → a labeled BAR spanning the window
   *   a group was disabled, to line up against the Layerize track.
   * All guarded — these APIs may be absent in some embeddings.
   */
  function emitMarkers(changedId: string, nowDisabled: boolean) {
    const label = markerLabel(active);
    try {
      performance.mark?.(label);
      (console as { timeStamp?: (l: string) => void }).timeStamp?.(label);
      if (nowDisabled) {
        disabledSince.set(changedId, performance.now());
      } else {
        const start = disabledSince.get(changedId);
        if (start != null) {
          performance.measure?.(`dbg ⛔ ${changedId}`, { start });
          disabledSince.delete(changedId);
        }
      }
    } catch {
      /* tracing is best-effort */
    }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = buildOverrideCss(ANIM_GROUPS);
    document.head.appendChild(el);
  }

  function toggle(id: string) {
    const cls = classForGroup(id);
    const nowDisabled = !active.has(id);
    if (nowDisabled) {
      active.add(id);
      document.documentElement.classList.add(cls);
    } else {
      active.delete(id);
      document.documentElement.classList.remove(cls);
    }
    active = active; // svelte reactivity
    emitMarkers(id, nowDisabled);
  }

  function resetAll() {
    const ids = [...active];
    for (const id of ids) document.documentElement.classList.remove(classForGroup(id));
    active = new Set();
    for (const id of ids) emitMarkers(id, false); // close out each measure
  }

  function shortIdentity(value: string | null | undefined): string {
    if (!value) return "";
    const parts = value.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || value;
  }

  function renderRegionFor(record: MutationRecord): HTMLElement | null {
    const target =
      record.target instanceof HTMLElement
        ? record.target
        : record.target.parentElement;
    if (!target || target.closest(".dbg-panel")) return null;
    return (
      (target.closest(RENDER_REGION_SELECTOR) as HTMLElement | null) ?? target
    );
  }

  function renderRegionLabel(region: HTMLElement): string {
    if (region.classList.contains("session-col")) {
      return `session: ${shortIdentity(region.dataset.sessionSource) || "unknown"}`;
    }
    if (region.classList.contains("row")) {
      return `worktree: ${shortIdentity(region.dataset.wtRow) || "unknown"}`;
    }
    if (region.classList.contains("session-dock")) return "session dock";
    if (region.classList.contains("sticky-host")) return "sticky note";
    if (region.classList.contains("terminal-wrap")) return "terminal";
    return region.tagName.toLowerCase();
  }

  function queueRenderFlash(region: HTMLElement) {
    if (
      region.matches(".session-col.col-offscreen, .row.row-offscreen") ||
      region.closest(".session-col.col-offscreen, .row.row-offscreen")
    ) {
      return;
    }
    pendingFlashRegions.add(region);
    if (flashFrame) return;
    flashFrame = requestAnimationFrame(() => {
      flashFrame = 0;
      const regions = [...pendingFlashRegions].slice(0, 24);
      pendingFlashRegions.clear();
      for (const el of regions) {
        if (!el.isConnected || typeof el.animate !== "function") continue;
        el.animate(
          [
            {
              outline: "2px solid rgba(255, 205, 64, .95)",
              outlineOffset: "-2px",
            },
            {
              outline: "2px solid rgba(255, 205, 64, 0)",
              outlineOffset: "-2px",
            },
          ],
          { duration: 480, easing: "ease-out" },
        );
      }
    });
  }

  function renderFrameTick(at: number) {
    if (renderLastFrameAt > 0) renderFrameIntervals.push(at - renderLastFrameAt);
    renderLastFrameAt = at;
    renderFrame = requestAnimationFrame(renderFrameTick);
  }

  function publishRenderStats() {
    const frames = renderFrameIntervals;
    renderFrameIntervals = [];
    const elapsed = frames.reduce((sum, value) => sum + value, 0);
    const sorted = [...frames].sort((a, b) => a - b);
    renderFps = elapsed > 0 ? Math.round((frames.length * 1_000) / elapsed) : 0;
    renderP95FrameMs = sorted.length
      ? Math.round(
          sorted[
            Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
          ] * 10,
        ) / 10
      : 0;
    renderHotspots = rankMutationHotspots(renderRegionCounts);
    renderRegionCounts = new Map();
    renderMutationCount = pendingMutationCount;
  }

  function stopRenderActivity() {
    renderMutationObserver?.disconnect();
    renderMutationObserver = null;
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    if (flashFrame) cancelAnimationFrame(flashFrame);
    flashFrame = 0;
    if (renderStatsTimer) clearInterval(renderStatsTimer);
    renderStatsTimer = null;
    pendingFlashRegions.clear();
    renderFrameIntervals = [];
    renderRegionCounts = new Map();
    renderLastFrameAt = 0;
    pendingMutationCount = 0;
    renderActivityEnabled = false;
  }

  function startRenderActivity() {
    if (renderActivityEnabled || !document.body) return;
    renderActivityEnabled = true;
    renderMutationCount = 0;
    pendingMutationCount = 0;
    renderHotspots = [];
    renderMutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        const region = renderRegionFor(record);
        if (!region) continue;
        pendingMutationCount += 1;
        const label = renderRegionLabel(region);
        renderRegionCounts.set(
          label,
          (renderRegionCounts.get(label) ?? 0) + 1,
        );
        queueRenderFlash(region);
      }
    });
    renderMutationObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "aria-expanded",
        "aria-pressed",
      ],
    });
    renderLastFrameAt = performance.now();
    renderFrame = requestAnimationFrame(renderFrameTick);
    renderStatsTimer = setInterval(publishRenderStats, 1_000);
  }

  function toggleRenderActivity() {
    if (renderActivityEnabled) stopRenderActivity();
    else startRenderActivity();
  }

  function isTypingTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return (
      el?.tagName === "INPUT" ||
      el?.tagName === "TEXTAREA" ||
      !!el?.isContentEditable ||
      !!el?.closest?.(".xterm")
    );
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "F8" && !isTypingTarget(e.target)) {
      e.preventDefault();
      if (open) stopRenderActivity();
      open = !open;
      return;
    }
    if (e.key === "Escape" && open) {
      stopRenderActivity();
      open = false;
    }
  }

  onMount(() => {
    ensureStyle();
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      stopRenderActivity();
      window.removeEventListener("keydown", onKey, { capture: true } as any);
    };
  });
</script>

{#if open}
  <div class="dbg-panel" role="dialog" aria-label="Renderer debug">
    <div class="dbg-head">
      <strong>Renderer debug</strong>
      <button
        class="dbg-x"
        title="Close (Esc / F8)"
        on:click={() => {
          stopRenderActivity();
          open = false;
        }}>×</button
      >
    </div>
    <section class="dbg-section">
      <label class="dbg-render-toggle">
        <input
          type="checkbox"
          checked={renderActivityEnabled}
          on:change={toggleRenderActivity}
        />
        <strong>Flash DOM updates</strong>
      </label>
      <p class="dbg-hint">
        Yellow outlines are concrete visible DOM writes, not inferred component
        renders. Counts include offscreen writes; flashes do not. The observer
        and frame meter only run while enabled.
      </p>
      {#if renderActivityEnabled}
        <div class="dbg-render-stats">
          <span class:slow={renderP95FrameMs > 33}
            >{renderFps} fps · p95 {renderP95FrameMs} ms</span
          >
          <span>{renderMutationCount} writes total</span>
        </div>
        {#if renderHotspots.length > 0}
          <ol class="dbg-hotspots">
            {#each renderHotspots as hotspot (hotspot.label)}
              <li>
                <code>{hotspot.label}</code><span>{hotspot.count}/s</span>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="dbg-idle">No DOM writes in the last window.</p>
        {/if}
      {/if}
    </section>
    <section class="dbg-section">
      <strong>Animation / layer A/B</strong>
      <p class="dbg-hint">
        Kills CSS animations live so you can A/B the Layerize cost. Watch
        Chrome's FPS meter / Task Manager, or re-trace. Start with “ALL”. Each
        change emits a trace marker (see the Timings track).
      </p>
      <p
        class="dbg-marker"
        title="Emitted as performance.mark / console.timeStamp"
      >
        ▸ {markerLabel(active)}
      </p>
      <ul class="dbg-list">
        {#each ANIM_GROUPS as g (g.id)}
          <li class:master={g.id === "all"}>
            <label>
              <input
                type="checkbox"
                checked={active.has(g.id)}
                on:change={() => toggle(g.id)}
              />
              <span>disable</span>
              <code>{g.label}</code>
            </label>
          </li>
        {/each}
      </ul>
      <div class="dbg-foot">
        <span>{active.size} disabled</span>
        <button
          class="dbg-reset"
          on:click={resetAll}
          disabled={active.size === 0}
        >
          Re-enable all
        </button>
      </div>
    </section>
  </div>
{/if}

<style>
  /* One-off debug overlay — intentionally plain. No animations / will-change
     here so the panel never adds to the very cost it measures. */
  .dbg-panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 2147483000;
    width: 320px;
    max-height: 80vh;
    overflow: auto;
    background: var(--surface-1, #1b1b1f);
    color: var(--text, #e6e6ea);
    border: 1px solid var(--border, #34343a);
    border-radius: 10px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 10px 12px;
  }
  .dbg-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .dbg-x {
    background: none;
    border: none;
    color: inherit;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .dbg-hint {
    margin: 0 0 8px;
    opacity: 0.7;
  }
  .dbg-section + .dbg-section {
    border-top: 1px solid var(--border, #34343a);
    margin-top: 10px;
    padding-top: 10px;
  }
  .dbg-render-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    cursor: pointer;
  }
  .dbg-render-stats {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin: 6px 0;
    color: #9ed7a3;
  }
  .dbg-render-stats .slow {
    color: #ff8d85;
  }
  .dbg-hotspots {
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
  }
  .dbg-hotspots li {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .dbg-hotspots code {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--accent, #8ab4ff);
  }
  .dbg-idle {
    margin: 6px 0 0;
    opacity: 0.55;
  }
  .dbg-marker {
    margin: 0 0 8px;
    padding: 4px 6px;
    background: var(--surface-2, #26262b);
    border-radius: 6px;
    color: var(--accent, #8ab4ff);
    word-break: break-word;
  }
  .dbg-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .dbg-list li.master {
    border-bottom: 1px solid var(--border, #34343a);
    padding-bottom: 6px;
    margin-bottom: 2px;
  }
  .dbg-list label {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .dbg-list span {
    opacity: 0.6;
  }
  .dbg-list code {
    color: var(--accent, #8ab4ff);
  }
  .dbg-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--border, #34343a);
    opacity: 0.85;
  }
  .dbg-reset {
    background: var(--surface-2, #26262b);
    color: inherit;
    border: 1px solid var(--border, #34343a);
    border-radius: 6px;
    padding: 3px 8px;
    cursor: pointer;
  }
  .dbg-reset:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
