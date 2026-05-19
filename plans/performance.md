# performance.md — frontend perf findings + open work

Living notes on the supergit dashboard renderer-process performance.
Started after Chrome Helper sat at 70-100% CPU with the tab in focus
and a few sessions/worktrees on screen. Updated as we apply fixes and
re-record traces.

## TL;DR

Three perf traces taken over ~24 hours, ~4-9 seconds each on the prod
build (`bun run start` on `:27787`). Numbers below are main-thread
time on `CrRendererMain` as a fraction of wall-clock recording time.

| Phase | Paint | PaintImage | Layerize | UpdateLayer | Notes |
|---|---|---|---|---|---|
| Baseline (2026-05-16) | **45%** | 3156 events | 6% | 13634 events | masks + animated conics dominate Paint |
| After badge/hot fix (2026-05-16) | 33% | 0 | 27% | 6001 | Paint down 33%, traded for Layerize ↑ |
| After idle-pill + drop will-change (2026-05-17) | **11%** | low | **39%** | — | Paint largely solved; Layerize is the new bottleneck |
| After tab-visibility pause (2026-05-19) | TBD | TBD | TBD | TBD | targets background-tab cost specifically |

Net wins so far: Paint **45% → 11%**, PaintImage events **3156 → 0**.
Net regression: Layerize **6% → 39%** — fixing one moved cost to the
compositor's layer-tree management.

## Mechanics — what each Chrome phase actually costs

Useful background for anyone touching the always-on chrome:

- **Paint** runs whenever a layer's pixel content changes. Properties
  that animate paint cost: `background`, `background-color`,
  `border-color`, `box-shadow`, any gradient stop/angle (including
  `@property`-registered custom props inside a `conic-gradient`).
- **PaintImage** is a sub-phase of Paint. CSS background-image (incl.
  conic / linear gradients) and `<img>` rasterization fire here.
- **Layerize** rebuilds the compositor's layer tree. Triggered by:
  `will-change` toggling, `transform`/`opacity` animations
  starting/stopping, z-index re-ordering, position changes, and the
  raw count of composited layers (more layers → longer walk per
  rebuild).
- **UpdateLayer** is the per-frame "this layer's display list
  changed" event. High counts at steady state mean something is
  invalidating frequently.

What's **free**: `transform` and `opacity` animations on elements
that already have their own compositor layer. These bypass Paint
entirely and only cost a tiny per-frame matrix update.

What's **expensive**:
- CSS masks (`-webkit-mask`, `mask`, `mask-composite`) — defeat layer
  promotion of children, force per-frame paint of the masked element.
- Animating `border-color`, `box-shadow`, `background-color`, or any
  gradient stop / angle (including @property tricks) — paint-time.
- Forcing `will-change` on many tiny elements — inflates the layer
  tree, multiplies Layerize cost per frame.

## Fixes applied

In commit order. Each links to the rationale in the diff.

1. **`8ff748f`** — drop CSS masks on status-badge ahead/behind sweeps,
   and on the `.actions-btn.hot` rotating border. Replaced masked
   pseudos with edge-strip pseudos (badges) and with a transform-
   rotated static conic + ::after hole (hot button). Paint dropped
   45% → 33%, PaintImage zeroed out.
2. **`7d7e9a7`** — replace `.agent-pill.idle`'s `border-color`
   animation with an opacity-pulsing pseudo overlay; remove the
   `will-change: transform` hints that inflated the layer tree.
   Paint dropped 33% → 11%. Layerize went *up* because we now have
   more composited layers (each idle pill + badge has its own).
3. **(pending commit)** — pause all CSS animations when the tab is
   hidden, via a `body.tab-hidden` class toggled from
   `visibilitychange`. Chrome already throttles JS in hidden tabs but
   keeps CSS animations running; pausing them drops background-tab
   cost to ~0.
4. **(pending commit)** — favicon spinner uses a reused `<canvas>`
   element rather than `document.createElement('canvas')` per tick.
   Smaller win (PNG-encode dominates), but kills GC churn.

## Reverts / things we tried that didn't work

- **Transform-rotated static conic on `.agent-pill.working::before`.**
  Worked for the squarer `.actions-btn.hot` (which is ~150×43), but
  on the much wider/shorter pill the rotating arc swept
  non-uniformly — fast across the long edges and slow at the short
  ones, with visible kinks at corners. Reverted to the original
  `@property`-animated `from` angle. Trade-off accepted: this pseudo
  repaints every frame *only while an agent turn is in flight* (i.e.
  transient), so the cost is bounded. See SessionHeader.svelte for
  the comment block explaining why we keep it.

## Open TODOs — ranked by impact

### High-impact

- [ ] **Cap idle-pill animations by visibility / row count.** The
      `.agent-pill.idle::before` opacity pulse is composited, so each
      one is cheap on its own, but with N rows × M sessions per row
      the layer count balloons and shows up as Layerize cost. Options:
      (a) IntersectionObserver to drop the `.idle` class when the row
      is fully offscreen; (b) hard-cap: only the first ~20 rows get
      the pulse, the rest get a static dim border. (a) is more
      principled; (b) is a 4-line change.
- [ ] **Reconsider the `.idle` pulse altogether.** Static dim border
      is already a clear visual cue. The pulse adds liveness but at
      a continuous compositor cost. Worth a UX call: is the pulse
      pulling weight or is it ambient decoration?
- [ ] **Audit the layer count.** Open DevTools → Rendering →
      Layer borders on a populated dashboard and count the green
      borders. If it's in the hundreds, that's the Layerize budget
      spent. Suspects to verify aren't over-promoted: status-badge
      edge strips (2 per badge), idle-pill overlay (1 per idle pill),
      hot/warm button pseudos, the dock dots.

### Medium-impact

- [ ] **`.actions-btn.warm` `box-shadow` pulse.** Animates an inset
      `box-shadow` — paint-time, always-on while any TUI is warm.
      Same trick as the hot button: an opacity-pulsing pseudo overlay
      with a static box-shadow would composite. Hasn't shown up as a
      dominant cost in traces yet because the user hasn't had warm
      TUIs at record time, but worth fixing prophylactically.
- [ ] **`.status-badge-ahead.pulsate` `background` blink.** Discrete-
      keyframe (snap-on/snap-off) so it only paints at transitions
      (~6/s per pulsing badge), but still paint. Could be done with
      opacity on a pseudo overlay if it ever shows up hot.
- [ ] **xterm.js renderer choice.** Each visible TerminalView's
      `<canvas>` is its own paint surface. If many terminals are
      visible and streaming, this contributes. Check whether we're
      on the WebGL renderer addon (cheaper for active terminals) vs
      the default DOM renderer.
- [ ] **Honor `prefers-reduced-motion` globally.** We have per-
      component `@media` blocks already; verify the user's OS setting
      is being honored end-to-end on the dashboard.

### Low-impact (won't move the needle alone, do alongside)

- [ ] **Favicon spinner — cache encoded frames.** The reused-canvas
      change kills the alloc churn but `toDataURL('image/png')` is
      still the per-tick cost (5-15ms on a 32×32 canvas). The
      animation has a finite set of useful frames (≤60 for a
      one-revolution spinner); pre-encode them at startup and cycle
      through cached data URLs. Steady-state JS cost → 0.
- [ ] **SessionView polling.** Every open SessionView fetches
      `/api/session` + `/api/inflight` every 2s and rebuilds the full
      transcript reactive tree. With many open sessions this adds up
      to noticeable JS time on each tick. Could move to a single
      shared SSE stream that diffs into per-session stores.
- [ ] **`StickyNotesLayer` RAF loops.** Already self-gated (stop when
      no transitions are active), but watch for accidental always-on
      loops.

## How to record + analyse a trace

1. Reproduce a realistic load (real worktrees, ~1+ active session).
2. Chrome DevTools → Performance → Record → ~5s → Stop.
3. Export the .json (top-right) into `~/Downloads`.
4. Quick analysis with `jq` filtered to the main thread:

   ```sh
   jq -r '
     (if type == "object" and has("traceEvents") then .traceEvents else . end) as $e
     | ([$e[] | select(.name == "thread_name" and .args.name == "CrRendererMain")
          | "\(.pid)/\(.tid)"]) as $mains
     | [$e[] | select(.ph == "X" and .dur != null)
          | . as $ev | select(($mains | index("\($ev.pid)/\($ev.tid)")) != null)] as $main
     | [$main[] | {name, dur}] | group_by(.name)
     | map({name: .[0].name, count: length, total_ms: (map(.dur) | add / 1000)})
     | sort_by(-.total_ms) | .[:20] | .[]
     | "\(.total_ms | floor)ms\t\(.count)\t\(.name)"
   ' ~/Downloads/Trace-YYYYMMDDTHHMMSS.json
   ```

   The `Paint` / `PaintImage` / `Layerize` / `UpdateLayer` numbers are
   the headline.

5. To find *what* is painting (most useful when Paint is dominant):

   ```sh
   jq -r '
     (if type == "object" and has("traceEvents") then .traceEvents else . end) as $e
     | [$e[] | select(.ph == "X" and .name == "Paint" and .args != null)]
     | map(.args.data.nodeName // "?") | group_by(.)
     | map({k: .[0], n: length}) | sort_by(-.n) | .[:15] | .[] | "\(.n)\t\(.k)"
   ' ~/Downloads/Trace-...json
   ```

   The top row is your culprit.

6. **Important:** Trace against the **same build** the user is seeing.
   `bun run start` builds once at startup; if you changed CSS since
   then, restart prod (asking first, per CLAUDE.md) or test the
   change against `bun dev` instead.
