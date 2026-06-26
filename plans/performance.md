# performance.md — frontend perf findings + open work

Living notes on the supergit dashboard renderer-process performance.
Started after Chrome Helper sat at 70-100% CPU with the tab in focus
and a few sessions/worktrees on screen. Updated as we apply fixes and
re-record traces.

## Perf-goal run contract

Any broad performance goal run must leave behind evidence, not just a
series of plausible commits. Use `plans/perf-goal.json` as the append-only
run log. Each candidate commit needs:

- the exact scenario measured (`cold-start`, `dock-same-item-repeat`,
  `dock-random-navigation`, `open-column`, `terminal-start`, `image-paste`,
  `notes-heavy-scroll`, `events-analyze`, `idle-visible`, `typing-visible`);
- before/after numbers from the same workspace copy, browser, viewport,
  and build mode;
- the commit hash, files touched, and a short hypothesis;
- a pass/fail verdict based on the metric delta and the UX guardrails
  below;
- links or paths to trace/console/network artifacts when available.

Measure these families on every broad run:

- **Interaction latency:** click-to-settle p50/p95/max, long tasks,
  dropped/late animation frames, and whether repeated navigation to the
  same item is idempotent.
- **Main-thread cost:** Chrome trace totals for Scripting, Rendering,
  StyleRecalc, Layout, Paint, PaintImage, Layerize, UpdateLayer, and max
  task duration.
- **Compositor/animation cost:** active animation count by group,
  layer count / Layerize per second, and DebugPanel marker segments
  (`all`, `dock-arrows`, `sleep-z`, `working-pill`, etc.).
- **Network/API pressure:** request rate, in-flight max, route p50/p95/max,
  cancelled/pending requests, and response bytes for `/api/repos`,
  `/api/sessions/batch`, `/api/events`, `/api/terminals`, `/api/shells`,
  `/api/messages`, `/api/notes`, `/api/image`, and `/api/debug/analyze`
  when present.
- **Daemon/process health:** daemon RSS/heap, event-loop delay, child
  process count, terminal helper queues, PTY first-output time, and
  terminal WebSocket backpressure/backlog.
- **Correctness/visual guardrails:** no blank panes, no lost terminal or
  visual sessions, no broken image paste/preview, no note/sticker
  mis-anchoring, no scroll-position drift, no missing file-link handling,
  and no visible animation/affordance removal unless the UX change is
  explicitly requested.

Do not count a commit as a perf win if it only removes, pauses, hides, or
dims a visible feature/animation. If a run proposes gating visible work,
the JSON entry must prove the gate is invisible at the point of use (for
example, offscreen-only with a browser smoke check showing the animation is
already running before it enters view).

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
- [ ] **Optimize the `.idle` pulse without removing it.** The pulse is a
      visible liveness affordance. Perf work may make it cheaper or gate it
      only while truly offscreen, but removing/dimming it is a UX regression
      unless explicitly requested.
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

- [x] **Favicon spinner — REMOVED entirely (2026-06-09).** Rather than
      cache encoded frames, the whole canvas/`toDataURL`/DOMParser favicon
      subsystem was deleted from `awaitingBadge.ts` (~520 lines). A trace
      showed it as a steady `toDataURL` (220ms) + `parseFromString` (85ms)
      renderer cost for a signal the `(N)` title prefix + native dock badge
      (`navigator.setAppBadge`) already provide. The favicon is now the
      static `/favicon.svg`; `awaitingBadge.ts` keeps only the cheap
      title/meta/dock surfaces. See "Layerize storm during typing" below.
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

### Backend responsiveness after long-running Treetop sessions (2026-06-10)

Runtime probes on the native app after ~2h showed the daemon itself was still
answering tiny routes quickly (`/api/debug/mem` ~1-2ms, `/api/shell-default`
~1ms), with modest RSS (~200MB) and single-digit CPU. The suspicious evidence
was instead TCP backpressure: several `supergit:27787 -> WebKit` localhost
connections had multi-MB send queues, with matching WebKit receive queues.
That means PTY/SSE data had reached the browser process but WebKit was not
draining it promptly, which can make later UI work appear to arrive minutes
late.

Fixes landed in source:

- Add a short completed-result cache around `sharedDetectAgents()` (`10s`,
  configurable with `SUPERGIT_AGENTS_CACHE_MS`) so frequent `/api/repos`
  rebuilds do not re-walk hundreds of agent JSONLs every few seconds.
- Add terminal WebSocket backpressure handling: when Bun reports a terminal
  socket is backpressured, subsequent PTY output is held in a per-socket
  backlog and flushed on WebSocket `drain`; later fixes made this queue
  lossless and shifted pressure relief upstream to terminal visibility
  pausing.

Follow-up terminal backpressure fix (2026-06-10):

- Hidden terminal columns no longer drop off-screen output. The browser-side
  `TerminalWriteBuffer` preserves byte order and asks the caller to flush when
  its cap is reached; the daemon-side visibility pause is what prevents
  far-off-screen terminals from continuously forcing hidden parse/render work.
- Repro showed the renderer fix was not the whole root cause: with 10 hidden
  terminals streaming, the browser sent a 1MB paste immediately but the target
  PTY did not echo it within 20s. Hidden TerminalViews now send visibility
  control frames to the daemon; when a PTY has no visible subscribers, the
  Node/Go helper pauses PTY output delivery instead of draining/dropping it.
  The same repro now delivers the 1MB paste to the target PTY in ~25ms while
  hidden terminals avoid helper/stdout flood. No terminal bytes are discarded;
  a very chatty far-hidden process may block on its PTY until revealed.
- "Visible" is intentionally generous: the TerminalView observer uses an
  expanded root margin so nearby off-screen columns keep output flowing before
  they are literally on-screen. Only far-off-screen noisy columns are muted.

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

## Processes panel: CPU read too high, and watching it cost CPU

Found 2026-06-01 from a screenshot: two idle Claude TUIs in the Processes
popover reading **36% / 27% CPU** (group total 63%) while showing
"idle 9s", with a `powershell` row visible in the same list.

### Two separate problems

1. **The CPU number was per-core, not per-machine.** Both samplers report
   "% of a single core": `ps -o pcpu` (macOS/Linux) and Windows'
   `Win32_PerfFormattedData_PerfProc_Process.PercentProcessorTime` *sum*
   across logical processors (ceiling `100 × coreCount`). Windows does
   **not** normalise it — the old comment in `procs.ts` claiming it did was
   wrong. So `36%` meant "~⅓ of one core," which Task Manager (which divides
   by core count) shows as ~2–3% on a 16-thread box. The panel structurally
   read several × higher than the number the user compares against.
   - `"idle Ns"` is `now − lastOutputAt` (`ProcessList.svelte`) — time since
     the TUI last *printed*, **not** "doing nothing." An Ink/React TUI
     re-rendering a spinner burns real CPU while "idle" by that metric.
2. **The monitor inflated its own reading.** Each `/api/processes` poll ran
   *two* PowerShell passes — `sampleProcs` (perf counters) **and**
   `discoverRepoProcesses` (full-machine `Win32_Process` enumeration **plus**
   a `git worktree list` per repo) — at a **2s** open-panel cadence. The
   `powershell` row in the screenshot is that discovery query matching its
   own command line (its `$rp` literal contains the repo paths).

### Fixes applied (2026-06-01)

| Layer | Change | Where |
|---|---|---|
| daemon | `normalizeCpuPercent(perCore, cpuCount)` divides every CPU reading by `os.cpus().length` so the column is machine-relative (matches Task Manager / Activity Monitor). Applied to both `sampleProcs` branches + the Unix `discoverRepoProcesses` parse. Cross-platform. | `procs.ts` |
| daemon | `throttleAsync` wraps the heavy external scan in an **8s** TTL cache (shared in-flight, retry-on-failure); TUI rows stay fresh every poll. Stops re-enumerating every process twice a poll. | `procs.ts`, `server.ts` (`externalProcessRows`, `EXTERNAL_SCAN_TTL_MS`) |
| UI | Open-panel poll cadence `FAST_MS` **2s → 5s**. The shown CPU% is a 30s trailing average (`CPU_AVG_WINDOW_MS`), so 5s granularity is plenty and the spawn rate drops ~60%. | `ProcessList.svelte` |

All three pure parts are unit-tested (`procs.test.ts`:
`normalizeCpuPercent`, `throttleAsync`, `sampleProcs` sanity). Daemon-side
changes need a native rebuild to reach prod.

### Open TODOs — Processes panel

- [ ] **Recalibrate the hot/warm CPU thresholds.** `TUI_HOT_CPU_PERCENT=50`
      / `WARM=30` (`ProcessList.svelte`) were tuned against the old per-core
      scale; now that the value is machine-relative they trip far less
      often. Decide whether 50%/30% *of the whole machine* is the right
      "hot" bar or lower it.
- [ ] **Collapse the two PowerShell passes into one spawn.** Even throttled,
      an external scan still spawns `powershell.exe` twice (perf counters +
      `Win32_Process`). A single PS invocation returning both would halve the
      remaining startup cost.

## Layerize storm during typing (2026-06-09)

Trace `Trace-20260609T104714.json` (10.5s, prod build), recorded because the
dashboard felt slow **while typing** (in a session terminal). Main-thread
breakdown:

| Phase | %wall | Detail |
|---|---|---|
| **Layerize** | **54%** (197×, ~29ms each) | full compositor layer-tree rebuild — **once per frame** |
| serviceScriptedAnimations / RAF | 19% | always-on CSS animations + overlay reposition |
| `querySelector` (native, self) | 1806ms | overlay/badge position queries |
| `getBoundingClientRect` | 200ms | forced reflow in the same reads |

Paint was only 3% — the round-1/2 paint fixes held. The new bottleneck is
**Layerize**, exactly as predicted.

### Root cause

Measured **376 composited layers** (max UpdateLayer-per-commit). Two things
compound into a ~56ms/frame (~18fps) typing experience:

1. **376 layers → each Layerize costs ~29ms.** The compositor walks every
   layer on every rebuild. The layers come from the pile of always-on
   `infinite` CSS animations (status-badge spin/edge-flow/blink, dock
   halos/pulses, agent working glow + idle "zZZ" trail, hot/warm buttons),
   each auto-promoting its element. The status-badge pseudos alone were
   ~240 of them (see `.row-offscreen` comment in `worktree-row.css`).
2. **Every keystroke dirties the tree.** 97/100 input events were followed
   by a Layerize within 60ms; the keystroke's Svelte reactive fan-out (the
   effect runner ran 1673×) mutates the DOM and forces a rebuild over all
   376 layers. `body.ui-idle` doesn't help — typing counts as *active*.

### Fixes applied (2026-06-09)

| Change | Where | Effect |
|---|---|---|
| **`body.is-typing` de-promotes the ambient global animations** during keystroke bursts (`animation: none`, so the layers leave the tree). Toggled by a debounced (`TYPING_IDLE_MS=600`) keydown tracker on editable targets, incl. xterm's hidden textarea. | `ui-idle.ts` (`installTypingTracker`/`isEditableTarget`), `styles/base.css`, `App.svelte` | shrinks the Layerize walk *while typing*, then resumes on pause |
| **Favicon spinner removed** (see Low-impact TODO above) | `awaitingBadge.ts` | kills `toDataURL`+`parseFromString` (~3%) |

Note the existing IntersectionObserver gating (`col-visibility.ts` →
`.col-offscreen`, `App.svelte` `rowVisibilityObserver` → `.row-offscreen`)
already de-promotes **off-screen** rows/columns. The 376 layers in this
trace were therefore mostly **on-screen** — which is the gap `body.is-typing`
fills. The two are complementary: offscreen → IO gating; on-screen-while-
typing → `body.is-typing`.

### Lever 1 — the trigger is xterm's DOM renderer (and `contain` scopes it)

A second trace **with `invalidationTracking` enabled** (`Trace-20260609T112325`)
named the per-keystroke culprit unambiguously: **952 `LayoutInvalidationTracking`
events, dominated by `Added/Removed from layout :: #text` (472) and `:: SPAN`
(407)**, with `xterm-bold` / `xterm-cursor-blink` classes. That's xterm.js's
**DOM renderer** (only `addon-fit` + `addon-web-links` are loaded — no
WebGL/canvas addon) **adding and removing the row `<span>`+`#text` nodes on
every keystroke**. Nodes in/out → paint-artifact structure changes → compositing
re-runs → Layerize. (To capture this yourself: `chrome://tracing` → Edit
categories → enable `disabled-by-default-devtools.timeline.invalidationTracking`,
or just click a Layout event in the Performance panel and read its
"Invalidations".)

**`contain: layout paint` on `.xterm-host`** (TerminalView.svelte) was tried as
a cheap CSS-only experiment. Re-trace (`Trace-20260609T160402`) vs the baseline:

| Metric | Baseline | + `contain` |
|---|---|---|
| Typing frame rate | ~18 fps (53ms/frame) | **~37 fps (27ms/frame)** |
| Layerize %wall | 54% | **22%** |
| Layerize **per rebuild** | 28.9ms | **5.8ms** (5×) |
| Layers/commit | 376 | 354 (≈ same) |

The win is **not** fewer layers — it's containment **scoping the compositing
work**. xterm emits hundreds of per-cell `<span>`s; without containment each
per-keystroke layerization weighs them all against the rest of the page.
`contain: paint` collapses the terminal into one isolated paint/stacking
subtree, so those spans stop participating in the global layer-assignment walk.
Correction to the earlier note: Layerize is `O(layer count)` **and**
`O(paint-chunk complexity)`; `contain` cut the latter. The trigger still fires
every keystroke (25/25) — it's just ~5× cheaper now.

### Lever 2 — GPU renderer for visible terminals (shipped 2026-06-09)

A non-DOM renderer removes the trigger *entirely* — typing becomes a contained
canvas re-raster, no structural churn, no per-keystroke Layerize — taking the
remaining 22% toward ~0. The earlier note here picked `@xterm/addon-canvas`
over WebGL because of the ~16-WebGL-contexts-per-page browser cap; that addon
turned out to be **dead for xterm 6** (deprecated upstream in the 5.x line,
peer-dep pinned to `@xterm/xterm ^5.0.0`, never released for 6). The xterm.js
README lists exactly one maintained GPU renderer: `@xterm/addon-webgl` (the
0.19.0 release pairs with xterm 6.0.0; it's what VS Code's terminal uses).

So: **WebGL, with the context cap managed by a slot pool** instead of avoided.

- `terminal-webgl.ts` — `createWebglPool(max, createAddon)`:
  `MAX_WEBGL_TERMINALS = 12` slots (headroom under the ~16 cap). A slot is a
  *count*, not a shared object — each visible terminal creates its own addon/
  canvas/context; disposing frees the budget for the next terminal.
- `TerminalView.svelte` — the existing visibility IntersectionObserver (the
  one that buffers PTY writes off-screen) owns the slot: on-screen → acquire,
  scrolled out / unmounted → release. So a wall of mounted TUIs is fine; only
  on-screen ones hold contexts, and re-acquiring on reveal piggybacks on the
  reveal path's existing flush + refit.
- **Every failure degrades to the DOM renderer** (which keeps the `contain`
  mitigation): no WebGL2 → addon load throws, caught; >12 visible → extras
  stay DOM; browser evicts a context under GPU pressure (other tabs etc.) →
  `onContextLoss` → addon disposed, slot freed, content re-renders from
  xterm's buffer. Pool + wiring pinned by `test/terminal-webgl.test.ts`.

Still to do: re-record a typing trace against a build with the addon to
confirm the per-keystroke Layerize trigger is gone (expect ~22% → ~0).

### Open TODOs — Layerize

- [x] **Re-record after the fix (done 2026-06-09).** `contain: layout paint`
      on `.xterm-host`: Layerize 54%→22%, per-rebuild 28.9ms→5.8ms, typing
      ~18→~37fps. See table above.
- [x] **Swap xterm to a GPU renderer (done 2026-06-09, WebGL not canvas —
      see Lever 2 above).** Removes the per-keystroke Layerize trigger for
      visible terminals (remaining ~22% → expected ~0; re-trace pending).
      The Svelte-scoped `pill-sweep` / `sleep-z-conveyor` (per visible
      session column) also still promote — extend `body.is-typing` with
      `:global()` hooks if they dominate on-screen after this lands.
- [ ] **Shrink the baseline layer count even when not typing.** 376 is high
      at rest. Audit which always-on `infinite` animations genuinely need to
      composite vs. could be paint-cheap or capped by row count.
- [x] **The 1806ms `querySelector` (fixed 2026-06-09).** The hot path wasn't
      the `.session-col` one-shots — it was **StickyNotesLayer**: its
      MutationObserver watches all of `<main>` (`subtree: true`), so xterm's
      per-keystroke/per-chunk DOM churn scheduled a reposition tick every
      frame while any visible TUI streamed, and each tick ran a
      document-wide `querySelector` *per note*, twice (`screenPosFor` +
      `afterUpdate → applyRowMargins`), with interleaved rect reads/writes.
      Three-part fix (`sticky-notes-dom.ts`, pinned by
      `test/sticky-notes-dom.test.ts`):
      1. observer batches entirely inside `.xterm-host` are dropped before
         scheduling (it's `contain: layout` — terminal churn can't move a
         row); with the WebGL renderer those batches mostly vanish anyway,
         this covers DOM-fallback terminals;
      2. one scoped `querySelectorAll` per pass builds a row map
         (`buildAnchorRowMap`/`anchorRowFor`) instead of a document query
         per note; chips likewise resolve via one scoped query;
      3. row rects are read once per row and all reads happen before the
         margin writes, so a pass forces at most one reflow.

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

## Renderer CPU: per-column session-poll storm (2026-06-05)

**Symptom.** `Supergit Web Content` (the WebKit renderer) pinned at
**55% CPU / 1.5 GB RSS** while the dashboard was open. A 5.85 s Web
Inspector timeline showed the main thread ~50% busy: 1.60 s in script
(758 ms microtasks, 725 ms requestAnimationFrame), 1.30 s in
layout (748 ms recalculate-styles, 109 forced reflows). Network: **165
requests in 5.85 s (~28/s)** — `/api/session` ×78 and `/api/active-sends`
×78, i.e. **~13 Hz each**.

**Root cause — it scales with open columns, not with activity.** Each
`SessionView` runs its **own** `setInterval(2 s)` (`SessionView.svelte`
`onMount`) firing `load()` (`/api/session`) + `refreshInflight()`
(`/api/active-sends`). 13.3 req/s ÷ 0.5 req/s-per-column ⇒ **~27 columns
mounted**, each its own timer + fetch + promise chain + reactive flush.
The idle-gate + ETag/304 already added only help when *idle/unchanged*;
with a wall of columns actively polled the per-column fan-out is the cost.

Two amplifiers:
- `/api/session`'s `load()` is well-guarded (304 + body-equality early
  return) — cheap when unchanged.
- `/api/active-sends`' `refreshInflight()` is **not**: it does
  `inflight = await res.json()` every tick — a *new array even when
  empty* (the normal case) ⇒ a forced reactive re-render per column.
- The scroll-stick `requestAnimationFrame(() => el.scrollTop =
  el.scrollHeight)` reads layout after mutation ⇒ forced reflow ×columns.

### Lever 1 — coalesce N per-column polls into one shared poll *(DOING)*

Collapse the per-column timers/fetches to **one timer + one batched
request per daemon per tick** → O(1) in column count.

- **Daemon:** `POST /api/sessions/batch` `{ sources:[{source,etag?}] }`
  → `{ results:[{source, status:200|304|403, etag?, body?}] }`. Logic
  lives in a testable `getSessionsBatchResults()` in `sessions.ts`
  (reuses the quick stat-ETag short-circuit + `getSessionResponseJson`);
  the route is thin glue (the server monolith is source-text tested only).
- **Client:** a shared `session-poll.ts` store — a single idle-gated,
  resume-aware 2 s timer. Per tick, per `daemonId`: one batch POST for
  all registered sources (dispatch a source's body only when it changes),
  and **one** `GET /api/active-sends` (no `sessionId`, If-None-Match on
  the revision ETag) whose list is sliced to each column — dispatched
  only when that column's slice changes. `SessionView` registers/
  unregisters instead of owning a timer; `load()`/`refreshInflight()`
  stay for event-driven immediate refresh (post-send, resume).

Coalescing active-sends behind the global revision-ETag also removes the
unconditional `inflight` reassignment (folds in much of Lever 3 for free).

### Deferred levers (do only if Lever 1 isn't enough)

2. **Poll only visible columns** — register/unregister the poll via an
   IntersectionObserver so off-screen columns go quiet. Biggest extra win
   if the user keeps many columns scrolled out of view.
3. **Change-detect `/api/active-sends` per column** — if Lever 1's global
   ETag isn't sufficient, skip the `inflight` reassign when the sliced
   list is deep-equal to the previous one.
4. **Fix the forced reflow** — in the scroll-stick path read `scrollHeight`
   *before* the DOM write, or only when `shouldStick` actually changed, to
   drop the 109 forced layouts.

### Renderer CPU round 2: color-mix-in-keyframes style-recalc storm (DONE)

After Lever 1 the network/script storm was gone (165→17 req, 1601→51 ms
script, 758→7.5 ms microtasks) — but a second capture still showed the
renderer at **~28 % CPU** (the recording's own samples; the earlier 55 %
was the pre-Lever-1 snapshot) with **style recalc as the entire cost: 939
ms / 771 events, perfectly continuous at ~2/frame, ~1.9 ms each**, paint
≈ 0, script ≈ 0.

Cause: always-on `infinite` animations that **interpolate a `box-shadow`
value containing `color-mix(… var(--…) …)`**. WebKit re-resolves the
`color-mix(var())` every frame and bills it to **style recalculation**
(hence huge recalc, ~0 paint). Each awaiting session/column/dot running
one = 1 recalc/frame; it scales with how many agents sit "awaiting input."
(NOT a minification/bundling issue — recalc cost is runtime invalidation,
independent of how the CSS is compiled.)

Where `awaiting-input` comes from: the PTY emits `{type:"state",
awaitingInput:true}` when an agent is parked at its prompt →
`SessionView.svelte:1515` (terminal column), `NewSessionCol.svelte:249`
(new column), and per-session **dock dots** (`dot-awaiting` →
`dot-awaiting-urgent`). So the cost tracks "how many agents are done and
waiting on you."

Fix — make the pulses **composited**: animate `opacity` (and `transform`)
instead of an interpolated `color-mix` box-shadow. The glow colour is
resolved **once** into a static value; opacity/transform run on the
compositor with no per-frame recalc.
- `.session.awaiting-input` / `.new-session-col.awaiting-input`: glow moved
  to an `::after` (inset, since both are `overflow:hidden`) whose opacity
  pulses.
- dock `dot-awaiting`/`-urgent`: keep the composited `transform: scale`,
  move the halo to an `::after` static ring with opacity pulse.
- `warm-glow` (single conditional button): `color-mix` hoisted into static
  `--warm-glow-*` custom props so the keyframe stops re-resolving it.
- `status-badge-ahead-blink` left as-is — animates `background` between two
  *solid* colours (no `color-mix`), its `::before`/`::after` are taken by
  edge-streaks, and it's a conditional opt-in badge; low value, would need a
  restructure. Recorded here if it ever shows up in a capture.

## Renderer CPU round 3: the layer-tree bloat — an invisible dock spinner (2026-06-06)

**Symptom.** Dashboard pinned the renderer (fans audible). A trace showed the
main thread ~99% busy with **Layerize at 54%** (the compositor rebuilding its
layer tree ~once per frame, ~17 ms each). Paint was only ~5% and there was no
layout shift — Chrome's paint-flashing lit up *only* the dirty-changes wiggle,
which was a red herring.

### New tooling built for this (keep it)

- **`DebugPanel.svelte` + `anim-debug.ts`** — an **F8** overlay that kills CSS
  animation groups live (sets `animation: none` via `html.dbg-<id>` classes, so
  the layer *de-promotes* — `paused` wouldn't). Lets you A/B which animation
  owns the Layerize cost without a rebuild. Each toggle emits trace markers:
  `performance.mark` (Timings track), `performance.measure` (a labelled BAR over
  the disabled window), and `console.timeStamp` (a line across all tracks).
- **Marker-correlation script** — parse the trace, segment by `dbg: disabled
  [...]` marks, and table Layerize% per state. The bun one-offs used live under
  the session tmp dir; the recipe at the bottom of this file still applies.

### Root cause — layer COUNT, not any single animation

The `.dock-dot-spinner` carried `animation: dock-spin … infinite` on the **bare
selector**, running unconditionally even though the spinner sits at `opacity:0`
on idle dots (the comment rationalised it as "already moving when it becomes
visible"). An always-running transform animation **auto-promotes its element to
a compositor layer** (web.dev animations guide; no `will-change` needed). Every
dock dot contains a spinner, so **every idle session dot was its own layer** —
dozens of them — and each `Layerize` had to walk that whole bloated tree.

**The markers initially misled us.** In the bloated-tree trace, disabling the
`working-pill` glow dropped Layerize 54%→30%, so it *looked* like the culprit.
It wasn't: the working pill was merely *triggering* full-tree relayerizes, and
the tree was huge because of the idle spinners. Lesson: a single-group marker
delta is only trustworthy once the tree size is controlled — always check the
**all-off baseline** and watch whether `UpdateLayer` count vs `Layerize` cost
*decouple* (they did: UpdateLayer stayed ~800/s while Layerize cost cratered →
the tree shrank).

### Fix (done)

Gate the spin on the working state — `animation: dock-spin` moved from
`.dock-dot-spinner` onto `.dock-dot.dot-working .dock-dot-spinner`
(`SessionDock.svelte`). Idle dots de-promote. Guarded by
`packages/ui/test/dock-spinner.test.ts`.

**Result (same workload, before → after rebuild):**

| | before | after |
|---|--:|--:|
| main-thread busy | ~99% | **42%** |
| Layerize | 54% | **5%** |
| top cost | Layerize (compositing) | **JavaScript** (v8/microtasks ~36%) |

The compositing bottleneck is gone; the new ceiling is JS (reactivity /
session-poll — see the round-1/2 notes above).

### The DirtyGlyph detour (resolved: kept SMIL)

Chasing the paint-flashing red herring, we first replaced DirtyGlyph's SMIL
`d`-morph with a composited `translateX` scroll of a static wave. It worked but
changed the motion (travel vs rock) and wasn't where the cost was. Once the
spinner fix shrank the tree, the morph's marginal cost is just a little Paint
that scales with the number of *visible dirty sessions* — affordable for normal
counts — so we **reverted to the SMIL rock** (the preferred look, cross-engine).
The composited alternative: a static multi-period wave path (4× `GIT_DIRTY`
periods from x=-2) translated by exactly one 8u period for a seamless loop —
revive it only if you routinely have dozens of dirty repos on screen and Paint
climbs.

### Open / deferred

- [ ] **`working-pill` composited glow** — now ~3 points (was an artefact of the
      bloated tree). Deferred; revisit only if a trace captured during heavy
      *multi-agent working* shows it spiking. The doc records a failed
      rotating-conic attempt — use an opacity-pulse glow, not a rotating one.
- [ ] **Long tail of always-on dock animations** (arrows bounce, unread/awaiting
      pulses, sleep `zZZ`) — each auto-promotes while running; individually
      small now, collectively the 5%→2% residual. Cap by visibility/row count if
      the JS-side work is ever cleared and this becomes the ceiling.
