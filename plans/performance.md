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
### Medium-impact (new)

- [ ] **active-sends polling per session.** Every open Claude session
      polls `/api/active-sends?sessionId=<id>` regardless of whether
      the column is scrolled into view. With 4+ TUIs open that's 4+
      concurrent polls. Should use IntersectionObserver to only poll
      for visible columns — offscreen sessions don't need real-time
      send-state. Same pattern as the idle-pill visibility cap above.
- [ ] **`StickyNotesLayer` RAF loops.** Already self-gated (stop when
      no transitions are active), but watch for accidental always-on
      loops.

## Daemon-side: the cold-start enrich storm

Everything above is the renderer (Chrome/WebKit) process. This section is
the **daemon** + **startup** path — a different process, different
bottleneck, found 2026-05-31 while debugging "a visible repo's TUI won't
connect after a restart."

### Symptom

After a daemon restart, the topmost/visible repo's terminal fails with
"Terminal didn't start within 10s" while off-screen repos start fine.
Daemon RSS briefly spikes to ~3.6 GB (transient — falls back to ~130 MB
once startup settles), and `/api/repos` enrich logs show 1–5.6 s per
call.

### Root cause — a cold-start thundering herd (NOT the renderer)

On restart, three things hit at once:

1. Every column respawns its PTY → simultaneous `POST /api/terminals`.
2. `/api/repos` enrich (`server.ts`) fans out `getWorktreeDetails` — a
   git subprocess + output parse — over **every worktree of every repo**
   via nested `Promise.all`, on a cold cache. Dozens-to-hundreds of
   concurrent git spawns + large output buffers → the RSS spike + a
   stalled single Bun event loop.
3. The visible/topmost repo also kicks off its `visible-fetch` loop
   (`/api/fetch` → git fetch + another `/api/repos` rebuild) the instant
   it's on screen — competing with its own terminal spawn.

A stalled event loop can't answer `POST /api/terminals` within the
client's 10 s guard → the column aborts. The visible repo loses most
often (it adds load #3 to its own spawn moment).

**Do NOT re-blame** the off-screen-terminal-buffer / idle-animation /
off-screen-row-animation work — those are no-ops for a *visible*
terminal (the spawn guard clears on `ws.onopen`, independent of render).

### Fixes applied (2026-05-31, four separate revertable commits)

| Commit | Layer | Change | Knob |
|---|---|---|---|
| `74f5945` | UI | Terminal spawn retries instead of hard-failing at 10 s; stays in "starting" | `MAX_SPAWN_ATTEMPTS=3` (`TerminalView.svelte`) |
| `28cbe01` | UI | Defer a repo's first `visible-fetch` past a startup grace window | `STARTUP_FETCH_GRACE_MS=12_000` (`App.svelte`) |
| `1c80116` | daemon | Cap concurrent cold `getWorktreeDetails` git ops (cache hits bypass) | `WORKTREE_DETAILS_CONCURRENCY=8` (`server.ts`, `concurrency.ts`) |
| `3716f20` | launcher | Daily-rotate `~/.config/supergit/daemon-YYYY-MM-DD.log`, keep newest 5 | `log-rotation.ts`, `src/electrobun/index.ts` |

`#1c80116` is the root-cause fix (flattens the spike); `#28cbe01` stops
the visible repo competing with itself; `#74f5945` makes the client
forgiving of a briefly-busy daemon. `#3716f20` is the unbounded-log
housekeeping that surfaced alongside.

**Note:** `#1c80116` (daemon) and `#3716f20` (launcher) only take effect
after a **native** rebuild (`electrobun build`), not an SPA-only
`vite build`.

### Held daemon RSS — the token-scan dead cache (the real ~2.9 GB)

Separate from the cold-start spike above: after the restart fixes landed,
the daemon still sat at a **flat ~2.9 GB RSS** (V8 heap only ~115 MB → the
rest is native, held). Tracked it to the **token usage scan**, not the
`/api/repos` enrich (that one is correctly cached: detectAgents 10 s +
mtime, daily-totals keyed on `mtimeMs`).

Real evidence from the daemon log:

```
[usage] scanToken MISS 435ms  300401KB 110876lines 27429parsed  …/needle-cloud/…jsonl
[usage] topSessions  considered=368 scanned=84 hits=0  scan-sum=10428ms
```

`/api/agent-usage/claude-top-sessions` → `topClaudeSessionsByTokens` →
`scanClaudeSessionTokenTotals` (`agent-usage.ts`) **fully `readFile`s**
each in-window Claude JSONL to sum tokens — including a **300 MB** session
(→ ~600 MB–1.2 GB as a UTF‑16 string). The per-session cache key was
`${path}|${sinceMs}` with `sinceMs = now - WEEK_MS` from raw `Date.now()`,
so the key changed every call → **`hits=0`**, every session re-read on
every poll, allocator holds the freed buffers → the 2.9 GB. Almost
certainly a regression introduced with the usage chip/chime feature.

**Fix #1 (done) — `1c63c30`:** quantize `now` to the hour
(`floorToHourMs`) before deriving the window, so the cache key is stable
within the hour and unchanged sessions hit cache. 7-day edge still
advances hourly. Unit-tested. Daemon-side → needs a native rebuild.

### Open TODOs — daemon token scan (ranked)

- [ ] **Verify #1's impact.** After a native rebuild, confirm `scanToken`
      flips `MISS → HIT`, `topSessions … hits= > 0`, and RSS drops well
      below 2.9 GB. If it does, #2/#3 may be unnecessary.
- [ ] **#2 Incremental accumulation for active sessions.** Even with #1,
      a *growing* session's mtime changes every message → full re-read of
      the whole (possibly 300 MB) file. Cache running token totals + a
      byte offset per file (the user-scan path in `agents.ts` already does
      this) and add only the new bytes' tokens on change.
- [ ] **#3 Stream instead of `readFile`-into-string (the Go angle).** For
      files over some size threshold, stream line-by-line
      (`Bun.file().stream()`, already used at `agents.ts:894`) or hand off
      to the Go helper so peak memory is bounded regardless of file size.
      Matches `go-sessions-import.md` / the Go-scanner plan.
- [ ] **#4 Throttle scope.** `considered=368, scanned=84` — cap to
      visible/active sessions or top-N by recency rather than every
      in-window session.

### Open TODOs — daemon cold-start (earlier)

- [ ] **Tune `WORKTREE_DETAILS_CONCURRENCY`.** 8 is a guess; raise if cold
      `/api/repos` feels slow, lower if the worktree-fan-out spike returns.
- [ ] **Stagger startup PTY respawns** rather than firing all columns at
      once, as a complementary smoothing of the herd.

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
