/**
 * Animation/layer debug overlay — pure data + CSS builder.
 *
 * Why this exists: the renderer's dominant cost is Layerize (the compositor
 * rebuilding a layer tree of ~75 always-composited layers, once per frame —
 * see plans/performance.md). To find WHICH always-on animation owns that cost
 * without a rebuild-and-retrace loop each time, DebugPanel.svelte injects the
 * stylesheet below once and toggles `html.dbg-<id>` classes to kill a group's
 * animations live. Watch Chrome's FPS meter / Task Manager / a fresh trace as
 * you toggle — when Layerize drops, that group was the culprit.
 *
 * Disabling sets `animation: none` (not `animation-play-state: paused`) on
 * purpose: `paused` keeps the element composited, so the layer survives and
 * Layerize wouldn't move. `none` lets the layer de-promote, which is the whole
 * point of the experiment.
 */

export interface AnimGroup {
  /** kebab id; the toggle class is `dbg-<id>`. */
  id: string;
  /** human label shown in the panel. */
  label: string;
  /** selectors whose animation we kill when the group is active. */
  selectors: string[];
}

/**
 * Prime suspects, in the order they show up in the dock. `all` is the master
 * switch (does the page idle at all when nothing animates?); the rest isolate
 * a single always-on animation so we can attribute the Layerize cost.
 *
 * Selectors mirror the rules in SessionDock.svelte / styles/header.css /
 * styles/worktree-row.css / DirtyGlyph.svelte. This is a debug tool, so a bit
 * of coupling to internal class names is acceptable — if a selector drifts,
 * its toggle simply stops biting (the `all` switch still works).
 */
export const ANIM_GROUPS: AnimGroup[] = [
  {
    id: "all",
    label: "ALL CSS animations + transitions",
    selectors: ["*", "*::before", "*::after"],
  },
  {
    id: "dock-arrows",
    label: "Dock ahead/behind arrows (bounce)",
    selectors: [".dock-arrow-up", ".dock-arrow-down"],
  },
  {
    id: "dock-spinner",
    label: "Dock working spinner",
    selectors: [".dock-dot-spinner"],
  },
  {
    id: "dock-pulses",
    label: "Dock unread / awaiting pulses",
    selectors: [
      ".dock-dot.dot-pulsing .dock-dot-inner",
      ".dock-dot.dot-awaiting .dock-dot-inner",
      ".dock-dot.dot-awaiting-urgent .dock-dot-inner",
      ".dock-dot.dot-awaiting .dock-dot-inner::after",
      ".dock-dot.dot-awaiting-urgent .dock-dot-inner::after",
    ],
  },
  {
    id: "sleep-z",
    label: "Agent sleep ‘zZZ’ trail (idle pills)",
    selectors: [".sleep-z .z", ".sleep-z.visible .z"],
  },
  // NB: the dirty-changes wave is a SMIL <animate> (DirtyGlyph.svelte), not a
  // CSS animation, so `animation: none` can't toggle it — no group for it here.
  {
    id: "working-pill",
    label: "Agent 'working' pill glow",
    selectors: [
      ".agent-pill.working",
      ".agent-pill.working::before",
      ".agent-pill.working::after",
    ],
  },
  {
    id: "status-badges",
    label: "Status badge spin / blink / edge-flow",
    selectors: ['[class*="status-badge"]'],
  },
];

/** The body/html class that activates a group's override. */
export function classForGroup(id: string): string {
  return `dbg-${id}`;
}

/**
 * Human-readable label for the CURRENT disabled set, emitted as a
 * `performance.mark` / `console.timeStamp` on every toggle so a recorded trace
 * shows which groups were off at each instant (line it up with the Layerize
 * track). Ids are sorted so the same state always yields the same label.
 */
export function markerLabel(active: Iterable<string>): string {
  const ids = [...active].sort();
  return ids.length ? `dbg: disabled [${ids.join(", ")}]` : "dbg: all enabled";
}

/**
 * Build the static override stylesheet for every group. Injected once; the
 * panel toggles `html.dbg-<id>` classes to switch a rule on/off. The `all`
 * group also kills transitions so the page can truly idle.
 */
export function buildOverrideCss(groups: AnimGroup[]): string {
  return groups
    .map((g) => {
      const cls = classForGroup(g.id);
      const sel = g.selectors.map((s) => `html.${cls} ${s}`).join(",\n");
      const decls =
        g.id === "all"
          ? "animation: none !important;\n  transition: none !important;"
          : "animation: none !important;";
      return `${sel} {\n  ${decls}\n}`;
    })
    .join("\n\n");
}
