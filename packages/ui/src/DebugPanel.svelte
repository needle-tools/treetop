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
  } from "./anim-debug";

  let open = false;
  let active = new Set<string>();
  /** group id -> performance.now() when it was disabled, to span a measure. */
  const disabledSince = new Map<string, number>();

  const STYLE_ID = "dbg-anim-overrides";

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
          // @ts-expect-error — the {start} options form is valid at runtime
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
      open = !open;
      return;
    }
    if (e.key === "Escape" && open) {
      open = false;
    }
  }

  onMount(() => {
    ensureStyle();
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  });
</script>

{#if open}
  <div class="dbg-panel" role="dialog" aria-label="Animation debug">
    <div class="dbg-head">
      <strong>Animation / layer debug</strong>
      <button class="dbg-x" title="Close (Esc / F8)" on:click={() => (open = false)}>×</button>
    </div>
    <p class="dbg-hint">
      Kills CSS animations live so you can A/B the Layerize cost. Watch Chrome's
      FPS meter / Task Manager, or re-trace. Start with “ALL”. Each change emits
      a trace marker (see the Timings track).
    </p>
    <p class="dbg-marker" title="Emitted as performance.mark / console.timeStamp">
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
      <button class="dbg-reset" on:click={resetAll} disabled={active.size === 0}>
        Re-enable all
      </button>
    </div>
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
