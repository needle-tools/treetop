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

## The 2026-06-26 broad perf pass — what worked, what regressed, the rules

A 65-commit pass (`dd83850`…`2692e9d`) made Treetop "truly much better" but also
caused a wave of regressions we then spent days fixing (see
[offscreen-deferral-regressions.md](./offscreen-deferral-regressions.md)). This
section distills the durable lessons so we get the wins next time without the
regressions.

### What actually moved the needle

**UI (renderer):**
- **Visibility-gating** — defer render / poll / image-decode / summary fetch for
  offscreen columns and rows. `4d61ab6` (the big one: 48 columns → 1 mounted
  xterm at startup, zero startup long tasks), `5663d62`, `5de3a40`, `6acbfa8`,
  `e8bfe8d`, `7e15fe0`.
- **Lazy-mount collapsed UI** — `<details>` bodies / work foldouts render only
  when open. `eefeb75`, `d612aff`.
- **Layout containment** — `contain: layout paint style` + `content-visibility`
  on *contained leaf* subtrees (markdown code frames). `eba02e7`, `ab658ba`.
- **Avoid forced reflow** — write-only scroll (`scrollTop = 1e9`, let the
  browser clamp) instead of read-then-write inside rAF/observers. `314b42c`,
  `d06e3ec`.
- **Cache across remount + short-circuit on identity** — poller body/etag LRU,
  daemon returns pre-parsed session so the client skips `JSON.parse`, reference
  equality before expensive `JSON.stringify` signatures. `b283da2`, `d7125e9`,
  `ce47651`, `82da3f2`.

**Daemon:**
- **One shared concurrency limiter for cold fanout** — unbounded `Promise.all`
  over git/FS work is a thundering herd that spikes RSS to GBs and stalls the
  single event loop, starving PTY spawns. `createLimiter(8)`. `f96f1f5`,
  `3b527c0`.
- **Make speculative work conditional** — don't run git/IO eagerly "for the
  happy path" when it usually errors; gate on cheap predicates already in hand
  (e.g. only fetch ahead-log when `ahead>0`). `dd83850`.
- **Never block a route on a slow background scan** — serve last-good
  immediately, refresh async: fire-and-forget (`5fda982`) or
  stale-while-revalidate (`15324c4`, new `async-cache.ts`).
- **TTL is a safety net, not the invalidator** — when an fs-watcher already
  invalidates, push the time-TTL long (30s → 10min) so heartbeat polls don't
  re-trigger the whole fanout. `4537cae`, `ec622b4`.
- **Debounce trailing, not leading; respect the client's connection budget.**
  `d15910e`, `0ba526f`.

### The regression pattern (read this before the next perf pass)

**Every "stop doing work for offscreen/hidden things" optimization broke
something that *relied on* that work.** The cost you remove is often
load-bearing:

- **Unmounting offscreen things destroys geometry that other code measures.**
  Excluding offscreen rows/notes from the layout (`ffaaea0`, `538cae9`) broke
  sticky-note anchor positioning → notes drift on scroll. Fixed by keeping them
  in the anchor layout (`70045c2`, `dc79e63`).
- **`content-visibility:auto` on a subtree whose box is read elsewhere gives it
  synthetic geometry** → wrong scroll targets / anchors. Safe on contained
  leaves, *not* on session columns whose scroll math is read. (`afa1ca4`
  reverted by `dc79e63`.)
- **Deferring the renderer kills the resource lifecycle it owned.** Unmounting
  `TerminalView` dropped the last WS subscriber → daemon grace-reaped the PTY →
  agents died offscreen. Mitigation: a muted **"hold" socket** that keeps the
  subscription alive while the expensive renderer is unmounted (`4d61ab6`, then
  the hold-socket fixes in `3de74db`).
- **Mode/state that arrived before the replay window is lost on reattach.** A
  remounted xterm only gets the recent scrollback, so a TUI's early
  `\x1b[?2004h` (bracketed paste) was gone → multi-line paste submits at the
  first newline (#10). Fix: track + re-assert DEC private modes on reattach.
- **Cache/SWR/long-TTL trade freshness for latency** → stale dirty/ahead badges,
  late-appearing sessions, stale-on-first-open. The 30s→10min worktree TTL plus
  a saturated git limiter is exactly the "dirty badge stale ~30s with many
  repos" bug (#11); fixed with per-worktree coalescing + a priority lane.
- **"Idle/decorative" animations are real liveness cues, not waste.** Killing
  them (agent-pill pulse, dock-arrow bounce) read as the app being frozen
  (`e8a2cda` restored them).

### Rules for the next pass
1. **Gate the cost, keep the box and the subscription.** Render a placeholder
   div that preserves geometry; keep a cheap "hold" connection for anything
   with a server-side lifecycle (PTY, etag, modes).
2. **If you unmount it, ask what *measured* it** — anchors, scroll math, vines,
   dock backdrop. Keep those inputs alive.
3. **`contain`/`content-visibility` only on subtrees whose box nothing reads.**
4. **Cache freshness needs a correctness test on the invalidation path** — the
   only cache commits that didn't regress are the ones that tested staleness.
5. **A long TTL assumes the watcher never misses; pair it with a priority/poll
   path for the thing the user is looking at.**
6. **Treat visible animation as product** (`perf-goal.json` codifies this:
   dimming a visible animation is a regression, not a win).
7. **Make gating decisions pure + tested** (`shouldMountStickyNote`,
   `nextCachedSessionSummaryRequest`, `planWorktreeRecompute`,
   `selectSessionsForBackgroundSpawn`).

**Session transcript scrolling (2026-09-01):** `SessionView` had two competing
vertical scroll authorities: the transcript and the live `Worked for…` body,
plus their tail/pause state spread across the component. Live app-server
updates could therefore preserve one scroll position while moving the other.
The durable shape is one `.messages` scroller owned by
`session-scroll-controller.ts`; a live work body may have bounded overflow so
its summary and the preceding user turn remain visible, but its tail/pause state
belongs to that same controller rather than a second component-level authority.
Paused updates anchor the deepest visible stable transcript row across the
Svelte update. In both regular and zen layouts, an unpaused live work round
anchors its summary near the viewport top while reserving a small tail of the
preceding user turn plus their real inter-row gap above it. The reserved tail
is capped rather than scaling to 35% of the viewport, which had left the work
surface visibly too low. Viewed images remain in their timeline entries; do
not duplicate them into a gallery after the work summary, because that changes
the tail geometry as images decode. Completed responses return to ordinary
bottom-tail following.

An explicit tail-follow request is sticky until its scheduled correction runs.
Sending an app-server message first forces follow, then the optimistic user row
changes the reactive tail key; that second update must coalesce with, not erase,
the pending force. Otherwise the newly grown DOM already looks far from the end
and the send leaves the reader behind even though they were following the tail.

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

**Build smoke regression (2026-09-01):** the native smoke daemon starts from
a temporary copy of the default workspace. That copy accidentally included
`.debugging/` (1.8 GB locally), so the daemon remained in its pre-log copy on a
nearly full disk and the smoke probe timed out after 10 seconds. Temporary
workspaces now exclude `.debugging/`, like logs and other runtime-only state.
Codex RPC recordings inside that directory are also segmented at 256 MiB and
evict the oldest recording files before their aggregate size exceeds 2 GiB;
the in-memory replay buffer remains independently bounded by frame count.

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

### Stuck-request recovery (2026-09-01)

Production diagnostics showed that the shared-poll design still had one
single-flight failure mode: a request without a response kept `runningTick`
settled to neither success nor failure, so every later 2 s tick only joined
that promise. Two restored `POST /api/codex-app/turns` requests had likewise
remained active for more than six hours, consuming browser connections while
session panes appeared never to load. The affected Baker JSONL itself parsed
normally (463 messages, about 1 MB response, 16–17 ms via both direct and
batch endpoints), which separated request starvation from parser cost.

All shared session-poll requests now bound both fetch and body decoding to 15
seconds; a timeout retains cached state and releases the single-flight guard
so the next tick retries. Codex app-server RPCs now reject unanswered requests
after 30 seconds, and the UI turn submission has a 35-second outer deadline so
restored queue draining becomes visibly blocked/retryable instead of holding a
connection indefinitely. Regression tests cover recovery on the next poll and
a late app-server response not poisoning the next RPC.

The first timeout this exposed was a distinct payload-amplification bug. A
9.56 GB Codex transcript with repeated ~64 MB compaction records could still be
viewed through the bounded history path, but continuing it called
`thread/resume` without `excludeTurns`. App-server then tried to return the
entire thread before Supergit could call `turn/start`, remained busy after the
client deadline, and made the deadline look like the cause. Turn resumes now
request thread state without returning historical turns; paged transcript and
app-server history reads remain responsible for rendering history.

Session size is now surfaced without adding another cold-start transcript
scan. Agent discovery carries the file size from its existing `stat`; the exact
JSONL line count is requested only for an opened session, streamed through a
bounded 1 MiB buffer at global concurrency 1, coalesced per snapshot, and
incrementally scans appended bytes on later requests. This keeps unusually
large sessions visible in the header and dock without making every historical
session pay the line-count cost during `/api/repos` enrichment.

The same visibility-gated scan now computes exact Codex session pricing. The
former discovery shortcut sampled only 64 KiB from each end and treated the
latest cumulative token counter as the whole session; large turns could put
both `turn_context` model evidence outside those samples, while compaction
resets made the last cumulative counter undercount prior work. The exact scan
tracks the active model, prices positive `token_count` deltas, and falls back
to `last_token_usage` when a cumulative counter resets. Its state is cached by
file snapshot and only appended bytes are processed later. The line scanner
retains at most 512 KiB for a potentially relevant record, so giant compaction
or tool-output rows are counted without being accumulated or parsed. Live
session stats refresh once per completed turn, never once per output append.

On 2026-09-09, the still-running 2026-09-07 13:48 build provided a long-lived
control case for the later offscreen app-server gate. After about 46 hours its
WebKit content process held a 10.2 GiB physical footprint (17.5 GiB peak), used
roughly 115% CPU, and reported browser event-loop stalls up to 74.8 seconds.
The daemon remained responsive: `/api/debug/analyze` completed in 25 ms,
ordinary session cache hits were sub-millisecond, and route timings attributed
the apparent multi-second fetches almost entirely to time outside the server.
The page retained 65 session columns, 61 offscreen, including 19 live
app-server sources, and had received about 932,000 app-server events. A native
sample spent essentially the whole five-second window rebuilding WebKit author
style resolution and walking CSS animations while under memory pressure; VM
accounting attributed 6.7 GiB resident memory to WebKit's allocator rather than
the daemon or graphics surfaces. This build predates `bf6033ff`, so it still
performed visual app-server mutation work for hidden live columns. The capture
therefore confirms the mechanism that commit fixes: retain the cheap lifecycle
subscription, but route offscreen events through state-only handling until the
column is near the viewport. Do not use this old process to judge that fix; a
fresh build is required for validation.

The first state-only implementation had a lifecycle correctness regression:
it discarded the visual projection of every offscreen event and only
invalidated a four-turn `thread/read` key. Re-entering a column therefore
painted its stale message array before that asynchronous repair, and the
history merge could retain rows that the refreshed latest page no longer
contained. Offscreen panels now remember a cursor into the already-bounded,
shared event-stream history and replay that exact thread interval as one batch
before their transcript body becomes renderable. If the cursor has fallen out
of the bounded history, the body stays deferred until an authoritative latest
page is reconciled; older history and SSE events newer than the read survive,
but stale rows inside the refreshed range do not. Source changes clear both the
cursor and event-deduplication state so one panel lifecycle cannot contaminate
another thread.

A later lane-return regression had two independent causes. First, the session
body combined its own retained `IntersectionObserver` result with
`.row-offscreen` / `.col-offscreen` classes produced by two other observers.
Those classes exist only to disable decorative animations; callback ordering
could leave one stale and strand real content on its geometry-preserving
placeholder. The session observer is now the sole body-mount authority.
Second, a live app-server pane removed its entire last complete projection
while deferred offscreen events were replayed or an authoritative
`thread/read` was pending. A slow or failed reconciliation therefore appeared
as a wholly blank pane despite already having messages. Catch-up now updates
the retained projection in place; it never hides known content. Tests pin both
the stale-animation-class case and the live-catch-up case.

Replay Lab had a separate unbounded path: its read route prepared a projected
16 MiB transcript tail, then also called the legacy full-file parser to build
the `SessionView` override. Opening a 1.39 GB transcript drove the debug daemon
past 4 GB RSS and blocked unrelated startup discovery for 319 seconds; Vite's
`/api/session/stats` socket hang-up was collateral. Replay transcript rendering
now uses the same bounded tail parser as the production session surface. The
exact stats scan for that file remains bounded and completed in 0.47 seconds;
the replay read completed in 0.14 seconds after the fix.

The attempted startup optimization that routed a live Codex App pane to its
JSONL as soon as `transcriptSource` appeared was invalid. Message ownership is
mode-exclusive: a live `__codex_app__:*` visual pane uses app-server history
and events even when its transcript path is known; Stop/review rewrites the
pane to the transcript source, which is then owned only by the JSONL poller.
The transcript path remains usable as file metadata while live, but must never
select or mutate rendered messages. Delayed app-server history, SSE callbacks,
and frame-batched deltas all revalidate this ownership before applying. Future
startup work must reduce or schedule app-server cost without creating a hybrid
live/transcript renderer.

Live app-server updates also need a reader-position guard independent of tail
follow. The transcript already uses keyed Svelte rows and reuses unchanged item
references, but the active work subtree legitimately changes as tool and text
deltas arrive. A paused reader is now anchored to the deepest visible stable
row before that DOM update and restored to the same viewport offset afterward.
Anchor selection deliberately ignores a giant enclosing work row when a nested
step is visible; choosing the container made earlier scroll memory ineffective.

This investigation also found the data volume at 100% capacity (about 3 GiB
free) and repeated `ENOSPC` writes in daemon diagnostics. That is an independent
startup/reliability risk and requires freeing disk space; session code must not
silently reinterpret it as malformed transcript data.

### Visible terminal recovery after sleep (2026-10-22)

Visible terminal transport drops now reattach the existing PTY with exponential
backoff (1s to 30s), also retrying immediately on focus, online, or becoming
visible. Recovery resets the renderer before daemon backlog replay. Exit frames
and component teardown cancel retries; automatic recovery never spawns a second
PTY. Retry remains available while reconnecting. Scheduler behavior is covered
in `packages/ui/test/terminal-reconnect.test.ts`.

### Sleep/wake terminal cleanup (2026-10-24)

Windows standby at 03:41 local suspended the renderer and daemon after sockets
disconnected. A maintenance wake at 04:39 delivered overdue per-terminal grace
and orphan cleanup timers together: both paths killed the same 15 live PTYs,
about 0.8 seconds before the renderer reconnected. This was actual termination,
not a stale activity indicator. Windows Kernel-Power events corroborated the
standby/wake times in the workspace daemon log.

Both cleanup paths now use the same reconnect-aware timeout. While cleanup is
pending it checks once per second; a gap over five seconds (or a backwards clock
jump) restarts the full original grace period. Each callback detects the pause
itself, so timer delivery order on wake cannot bypass protection. Reconnection
cancels the timer, and uninterrupted abandonment still expires normally. The
tests simulate the observed 3,441-second pause, both 60-second/five-minute
deadlines, repeated standby, and reconnection 800 ms after wake. No timers run
for this protection while cleanup is not pending.

### Offscreen exited-terminal reconnect storm (2026-09-01)

A later production capture showed WebKit at 106–151% CPU, 3.1 GB RSS, and a
4.7 GB peak while the Bun daemon stayed near 1% CPU. Browser diagnostics
recorded an 80.3-second event-loop stall; ordinary fetches completed together
after the renderer resumed, so their 35–82 second browser timings were
collateral rather than daemon route latency. A native stack sample was almost
entirely a timer-triggered JavaScript microtask doing string parsing and
allocation.

The workspace log exposed the repeating unit: Baker's shell PTY had exited,
but its offscreen terminal-hold socket reopened every 1–2 seconds. Each attach
replayed about 14 KB, received the same `exit` frame, closed, and scheduled
another reconnect. The hold manager only interpreted `state` frames; it
treated the clean close after an `exit` frame as an unexpected transport drop.
Because every successful attach reset reconnect backoff, this loop stayed at
the minimum delay forever.

Terminal holds now treat an `exit` frame as terminal state: clear the intended
PTY id, cancel heartbeat/reconnect timers, surface cleared working/awaiting and
exit state to the owning component, and never reconnect that id. Transport
drops without an exit frame still reconnect, preserving the hold socket's
server-lifecycle contract. A behavior test covers exit-frame release followed
by close and timer delivery.

The terminal loop was not the whole renderer load. A second native sample,
captured after those reconnects stopped, was rooted in
`EventSource::parseEventStream` followed by Svelte microtasks, string creation,
and GC. Browser diagnostics showed 434 `fs-change-batch` `/api/repos` loads
with a roughly one-second p95. Although the daemon already recomputed and
patched just the changed worktree in its cached response, its SSE event sent
only the path, so the UI re-streamed all 37 repos and replaced broad dashboard
state for every successful watcher batch. During a sustained stream this
produced separate 80.3- and 76.8-second renderer event-loop stalls.

Successful `fs_change` events now carry the computed `WorktreeDetails`. The UI
immutably replaces only that worktree and its owning repo, preserving every
unrelated object identity; the existing batcher still advances per-worktree
invalidation keys and stale-summary subscriptions. Missing details (the
daemon's intentional recompute-failure boundary) or an unknown path retain the
full reload fallback. Patches are also scoped by daemon id so identical local
and remote paths cannot contaminate each other, and remote SSE uses the same
row-level update. Behavior tests cover identity preservation, fallback, and
daemon scoping.

The first rebuilt production run exposed a second-order problem hidden by the
original reload storm. A single top-level `repos` assignment is itself very
expensive with 73 persisted session columns: native samples again stayed
entirely inside the EventSource-triggered Svelte microtask, and one watcher
event blocked WebKit for 136 seconds. Periodic visible fetches write git
bookkeeping such as `FETCH_HEAD` even when the displayed worktree details are
unchanged, so sending those no-op rows still caused the large assignment every
30 seconds. The daemon now compares the prior and recomputed details and does
not broadcast semantic no-ops. The UI independently compares incoming detail
fields and returns an explicit `{ matched, changed }` result: an unknown row
keeps the correctness fallback, while a known duplicate does nothing and can
never be mistaken for a cache miss.

That rebuilt run also showed 45 exact `/api/session/stats` reads during the
first ten seconds. Unlike transcript polling and cached-summary reads, the
stats effect was not visibility-gated. Exact line-count reads now wait until
their existing `SessionView` is near the viewport; the component, geometry,
and visibility subscription remain mounted, and previously loaded values are
kept while offscreen.

The 2026-09-01 startup audit found one remaining avoidable request fanout. Seven
`GET /api/sessions/summarize` calls were cached-summary reads (generation is a
`POST`), but even cache reads are unexpected startup work. Background session
summaries are now an opt-in Sessions setting, default off; the same reactive
gate prevents cache reads and tears down the five-minute terminal generation
timer immediately when disabled. It also aborts an automatic generation stream
already in flight, which propagates cancellation to the daemon's Ollama fetch;
manual summary actions remain available. Startup `/api/image` traffic is the
expected browser loading of sticky-note attachment thumbnails; those images
retain native `loading="lazy"` and `decoding="async"` behavior.

A later live freeze was a separate app-server delta batching leak. WebContent
held about 119% CPU and 2.7 GB RSS while the daemon stayed near 5%; a five-second
native sample spent 3,588/3,728 main-thread samples under `EventSource` followed
by a Svelte microtask checkpoint. The app-server recording showed the trigger
directly: one thread delivered roughly 70 `item/agentMessage/delta` records in
one second. Text patches were already queued to one animation-frame update, but
every record first assigned the reactive `codexLiveLastActivityIso`, forcing a
component update after each SSE event and defeating the batch. Delta activity
now commits with the frame-batched message patch. Known nonvisual notifications
(`turn/diff/updated`, account rate limits, reasoning part boundaries, and file
patch-updated notices) no longer enter SessionView reactivity or the hub replay
buffer. Browser stall diagnostics now include per-method synchronous
`codex-event.sync.*` spans plus post-Svelte `codex-event.settle.*` spans, so a
remaining event/render bottleneck is attributable from `errors.jsonl` without
another native-symbol guess.

The follow-up freeze on 2026-09-02 exposed the command-output variant that the
first batching fix had not closed. WebContent reached 104% CPU and a 9.5 GB
physical footprint while the daemon remained idle. Over twenty minutes the
recording contained 4,623 `item/commandExecution/outputDelta` notifications;
three commands alone streamed about 1.0 MB, 416 KB, and 376 KB. The new settle
spans attributed a visible 29.5-second update to command output, while a native
sample again spent 3,760/3,762 main-thread samples in the EventSource listener's
Svelte microtask checkpoint, dominated by regex and string-rope work. The leak
had two parts: every output delta redundantly upserted the already-rendered tool
call before entering the patch batch, and the visual model retained unbounded
growing command output for recursive summary/nicifier passes. Existing tool-use
rows are now reused without a reactive write, adjacent deltas coalesce before
the frame flush, and live visual command output preserves a bounded head and
tail (128 KiB) while the full output remains in Codex's session data. The same
bound applies when the completed item snapshot replaces its streaming row.

The 2026-09-09 recurrence was another renderer-retention variant. WebContent
held about 49% CPU and 4.5 GB RSS while the daemon stayed near 5% CPU and
340 MB. Browser diagnostics counted 65 session columns (more than 60
offscreen), a 13k-element tree, sub-millisecond synchronous Codex event
handlers, but 1.5-second p95 Svelte settles and multi-second item-completion
settles. A long-lived active app-server thread dominated the recording.

Offscreen live columns correctly retained their app-server subscription, but
they still normalized and reassigned transcript messages for every event.
Offscreen events now update only lifecycle state (working, requests, errors,
queue draining), invalidate cached history, and leave transcript state alone;
returning to the viewport reloads the app-server turn page. This keeps the box
and subscription while gating the expensive normalization work. The existing
2,000-message setting remains solely a progressive history-loading ceiling; it
must not be reused to truncate live session state.

A fresh 2026-09-09 build confirmed that gate but exposed a separate steady-
state dock cost. With no new app-server events during a 12-second SSE capture,
WebContent still held roughly 35–40% CPU (briefly 92%) and 1.7 GB RSS. A native
five-second sample spent the active portion in `updateRendering`, layout, and
compositing-requirement traversal. The animation inventory explained the
trigger: about 30 status-badge pseudo-elements kept animating inside collapsed
dock labels, while 15 repo arrows ran `infinite` ten-second timelines despite
moving only during their first 0.8 seconds. Repo status retains its at-a-glance
motion: collapsed-label badge animations are de-promoted only while those
labels are invisible, and return for every badge when the dock expands. Arrows
keep the same two-bounces-per-ten-seconds cadence using a real 0.8-second finite
animation followed by 9.2 seconds with no active animation timeline. WebKit can
de-promote those layers during the still interval without changing the visible
signal. The historical ~932k/917k event counters in
older persisted diagnostics belong to the prior 46-hour control process; the
fresh process had only 38 visual-event settle batches when this capture was
taken, so those old totals must not be attributed to the current build.

### Renderer attribution diagnostics (2026-09-04)

The previous browser diagnostics had a blind spot between smooth rendering and
a single catastrophic event-loop stall: sustained 20–50 ms frames could make
the app feel continuously slow without ever crossing the two-second stall
threshold. The UI now samples `requestAnimationFrame` in bounded ten-second
windows and reports only after two consecutive pressured windows. A report
includes FPS, p50/p95/max frame time, slow-frame counts, visible/offscreen
session and worktree topology, animation counts, recent UI timing spans, and a
single confirmation-window mutation summary. The mutation observer is armed
only after the first bad window, disconnected after confirmation or when the
document is hidden, and reports aggregate counts rather than mutation payloads.
This keeps the measurement cost out of the normal rendering path.

Chromium 123+ Long Animation Frame entries add blocking, render-start,
style/layout-start, and script-count attribution. A direct probe of macOS's
system WKWebView on 2026-09-04 showed neither `long-animation-frame` nor
`longtask` in `PerformanceObserver.supportedEntryTypes`, so Treetop's primary
signal is the portable rAF sampler. Pressure reports record the actual supported
entry types and user agent so this assumption stays inspectable as WebKit
changes. Session batch polling separately times JSON decode and reactive
callback dispatch, so a slow cycle can be assigned to network/daemon work,
payload decoding, or downstream Svelte updates.

Every JSON API response now carries both standard `Server-Timing` and
`X-Supergit-Server-Ms`. Fetch diagnostics preserve daemon duration and the
remaining browser-observed duration (`outsideServerMs`) for slow requests and
for requests adjacent to a long task. Interpret a large `serverMs` as route or
serialization work; a small `serverMs` with a large outside remainder as
transport/browser scheduling or renderer starvation. This replaces the former
guess that a large wall-clock `fetch()` duration necessarily meant a slow API.

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

## Renderer update audit and visual DOM-write probe (2026-09-06)

A fresh native build showed two separate costs. Cold `/api/repos` enrichment
took 1.79s (1.73s in `asset-explorer`), while the settled WebContent process
still used roughly 30–48% CPU. The renderer-pressure confirmation window saw
only 11 DOM mutation records, and session-poll decode/dispatch stayed in the
low single-digit milliseconds. A native WebKit sample instead remained in
layout/compositor-tree traversal. This rules out a sustained whole-transcript
Svelte/DOM rebuild as the cause of that particular steady-state load; it does
not rule out intermittent mutation bursts.

The F8 renderer panel now has an opt-in **Flash DOM updates** probe for those
bursts. It observes concrete child/text/selected-attribute writes, flashes the
nearest visible session/worktree/dock/note/terminal region, shows one-second
ranked hotspots, and reports FPS plus p95 frame time. It still counts offscreen
writes but does not animate offscreen boxes, caps flashes per frame, ignores its
own panel, and tears every observer/timer/rAF down when disabled or closed.
This is intentionally described as DOM-write visualization rather than paint
flashing: page JavaScript cannot read WebKit's actual paint invalidation
rectangles. Browser DevTools paint/layer overlays or native traces remain the
authority for compositor-only work.

A later busy sample (three concurrently working app-server sessions) made the
split clearer: synchronous Codex event handling stayed below 1ms p95, while the
post-Svelte settle span rose to 647ms p95 and WebContent held roughly 30–50%
CPU over a 13k-element tree. Native `sample` stacks were dominated by
`updateRendering`, `layoutIfNeeded`, compositing requirements, and transform
animation extent. Disabling every CSS animation reduced WebContent CPU by about
18%, but none of the existing named F8 groups reproduced that reduction. The
renderer-pressure snapshot therefore now includes a grouped animation inventory
(animation name, concrete target, pseudo-element, state, count); the next busy
build can identify the previously anonymous 67-animation set directly instead
of guessing from source selectors. Animations are contributory here, not the
whole cost, so do not treat the all-off delta as a complete fix.

## Deep transcript stepping and history prefetch (2026-09-09)

Replay Lab exposed a shared transcript scaling bug: advancing the supplied
session from step 3000 to 3001 took about 554ms, versus 25ms at step 5. A CPU
profile showed that parsing was not the bottleneck. `VisualTranscript` was
re-running command tokenization for immutable historical tool blocks while
recomputing work overviews and media metadata. Weak caches in the reusable
nicifier helpers now retain previews, inline-script metadata, remote hosts, and
media derivations for the lifetime of their immutable block objects. The same
browser check is now about 56ms at step 3000 versus 24ms at step 5. A second
check on a 165MB transcript measured 59ms at step 10000 versus 19ms at step 5;
the remaining difference includes roughly 25ms of browser layout.

Older-history paging now starts within 2.5 viewports of the top (with a 600px
minimum lead) and shows a geometry-preserving loading skeleton while a backing
request is outstanding. The single shared session scroll controller publishes
the existing tail-follow state and marker, keeps a paused reader anchored while
new steps arrive, and resumes tail following only when the reader returns to
the end.

Fast replay exposed a turn-boundary race in that controller: replacing the
open live-work row with its completed summary can clamp `scrollTop` and emit a
browser scroll event before the next turn settles. That geometry event was
mistaken for reader intent, so one update followed and every later update ran
offscreen. Tail updates now keep a short settling epoch; scroll events produced
inside it cannot pause following, while explicit upward wheel input still does.
The shared controller test models the clamp between scheduling and render, and
the 100-steps/s browser repro remains at zero tail distance across turns.

A 24.95MB Fastvid/Astra transcript exposed a second source of synthetic scroll
events: decoded inline images changed the transcript's `scrollHeight` after the
tail key had settled. Chrome's scroll anchoring moved `scrollTop` and emitted a
scroll event 21–22px from the new tail; the controller treated it as reader
intent and stayed detached. Reader detachment now requires an input signal
(upward wheel or an active pointer gesture). Passive layout scrolls preserve
the armed follow intent, including an extra settling write when geometry changes
between the final tail write and pending-state cleanup.

A later app-server streaming regression came from queued tail corrections, not
lost follow state. Every delta scheduled the normal post-render plus settling
write, but a newer delta did not invalidate the older callbacks. A burst could
therefore keep applying stale correction passes across later frames while the
live work body changed underneath them. Tail scheduling now treats the newest
tail key as the sole owner of both correction phases; superseded callbacks are
no-ops. This keeps the existing two-phase late-layout protection while reducing
a three-delta burst from six scroll writes to two.

Replay Lab's transcript and turn analysis now synchronize through the shared
`SessionView` scroll controller using absolute normalized-message turn indexes.
The viewport's semantic center drives the analysis map; scrolling the map asks
`SessionView` to widen its existing history window before centering that turn.
The callback is opt-in, so ordinary sessions do not acquire analysis-map layout
reads. The tail marker is also the real reattachment control: its hit target
remains available while detached, reveals on hover or keyboard focus, and jumps
the shared transcript scroller back to its live tail. Analysis rows navigate
through that same controller; exact analysis-map edges map to exact transcript
edges, while interior rows retain semantic turn-centered navigation.

The follow handle had a separate end-position regression (2026-10-07): its
forced correction still applied the live-work top alignment, which could leave
a compact transcript 168px above its real bottom. Both handles now request an
exact end jump. That bottom-follow choice stays armed across later output until
the reader pauses or the session resets; automatic live-work alignment remains
the default for other follow requests. A Chromium regression clicks the real
handle with an overflowing live-work body and checks both scroll endpoints to
within 1px, then verifies that later output is still followed. Controller tests
also cover a response growing beyond the near-end threshold and upward reader
input detaching again.

Live app-server history failures were a separate blank-pane path from the
visibility/render lifecycle bugs. `SessionView` permanently remembered a
failed history key, so a transient timeout or socket failure could leave an
empty synthetic session with no further read attempt. History failures now
retain any already-rendered messages, retry with capped exponential backoff
while preserving app-server ownership, and show an explicit Retry state when
the pane has no history to display. Failed older-page reads keep that history
visible and add a compact Retry warning instead of failing silently. An
active-writer conflict uses a slower retry cadence; it does not fall back to
the transcript renderer.

A 2026-09-18 FastVid trace exposed a distinct live-projection loss at turn
completion. The app-server had recorded the complete final `agentMessage` and
returned it from thread history, while the visible lane ended at an earlier
commentary item. Ordinary completed `agentMessage` snapshots were ignored, so
the lane depended on receiving every preceding text delta. Completed snapshots
now pass through the same canonical item normalizer as app-server history, and
the lane invalidates and reloads authoritative app-server history after every
completed turn and after an SSE reconnect. An invalidation generation prevents
an older in-flight history response from marking that reconciliation complete.
This remains entirely inside the app-server source path; transcript data is not
used to repair a live lane.

The same FastVid-style offscreen gate exposed a second loss mode in a 2026-09-18
FHIR deployment turn: the shared replay ring retained 1,000 events, while one
turn produced thousands. State-only delivery had kept lifecycle flags but
discarded completed item snapshots and all 39 per-request usage checkpoints;
returning to the lane could therefore show only the final request's `$0.07`
instead of the round's `$4.52`. Offscreen panes now retain canonical
`item/started`, `item/completed`, warning/error, and token-usage state while
still deferring high-frequency deltas. Completed item IDs suppress only replayed
deltas for that same item, so parallel tools cannot advance one another's
cursor. Resume-only last-request usage is not priced unless this surface saw
the owning turn start. Paged app-server history also assigns the turn's real
completion timestamp to its final normalized row, restoring the same elapsed
round layout after reload; accounting-only checkpoints no longer inflate the
visible step count. These repairs remain app-server-owned and do not consult
the JSONL transcript.

The 1,000-event ring was itself the wrong memory boundary. It mixed every
thread on a daemon, so traffic in one lane could evict another lane's pending
interval, and event count bore little relation to retained size. Transient SSE
replay is now isolated per thread and covers the active turn up to a 128 MiB
serialized-data safety budget. A completed turn is pruned only after its
canonical completion has been delivered to every subscriber; durable/paged
app-server history remains the source for later remounts. The emergency byte
eviction uses an advancing queue cursor so a large stream cannot turn the
memory guard into repeated O(n) array shifts.

A 2026-09-29 FastVid trace showed that the per-thread ring still retained the
wrong lifetime and representation. The daemon answered the relevant thread
read in 47 ms, while the browser spent 67 seconds outside the server, recorded
event-loop stalls up to 234 seconds, and the WebKit content process reached a
16.3 GiB physical footprint. A native sample was almost entirely inside the
shared EventSource callback and its microtask checkpoint. The stream had
retained one parsed object per token delta for every active turn on the daemon
once any surface had opened the shared stream; mounting another surface
synchronously replayed that whole active-turn backlog
even though durable app-server history is the remount source. The shared hub
now retains no historical event objects and never replays pre-subscription
traffic. It coalesces adjacent deltas for the same item into frame-sized ordered
deliveries, flushing them before every immediate snapshot. An already-mounted
offscreen pane owns its exact missed interval locally, where adjacent deltas
are stored in bounded 64 KiB chunks and replayed before its body becomes live;
overflow still falls back to authoritative thread history. This keeps the
cheap subscription and exact visible projection while removing both the raw
callback storm and the unbounded parsed-object multiplier.

That renderer-side repair was necessary but did not remove the EventSource
boundary itself: the daemon still emitted one SSE frame per app-server event,
including its synchronous 300-event subscription replay. Retained recordings
contain turns with 27,314 and 22,932 delta frames, so WebKit still had to run
one callback and one `JSON.parse` for every fragment before the renderer could
coalesce them. The daemon now transports adjacent canonical events in ordered
batches of at most 256, flushed within 16 ms; it does not interpret, merge, or
drop the events. The browser accepts both the batched envelope and the legacy
single-event envelope, then applies the existing visual-delta compactor. A
30,000-event boundary test verifies exact reconstructed text, exact event
ordering across transport batches, and fewer than ten visual deliveries.

Queued user rows exposed one more offscreen reconciliation ordering bug. Their
optimistic send-time anchor could precede a prior turn's final reply when that
reply arrived later through authoritative app-server history, producing
queued user -> prior reply -> new-turn reply after remount. The explicit anchor
is only a pre-acceptance fallback. Once `turn/start` returns, its authoritative
turn ID is attached to the local row, and normalized live rows retain the turn
ID from their app-server event. The overlay is placed immediately before the
first canonical item in its own turn, without comparing timestamps, sorting
history, or consulting transcript data. It still disappears when the matching
canonical app-server `userMessage` arrives through thread history.

A 2026-10-01 FastVid turn exposed the same race before app-server had returned
the new turn ID: a normal optimistic send still honored its incidental tail-row
anchor, so completion reconciliation could place the prior final reply after
the new request and make that reply disappear into the new live work group.
Only steering is position-bearing inside an existing turn. A normal send now
stays after the complete current projection until its canonical user item or
turn ID arrives.

The same trace exposed a paused-reader race in scroll correction. Every live
update captured a semantic row anchor, but a later wheel/scrollbar gesture while
already paused did not invalidate the scheduled correction because the pause
boolean had not changed. Those stale corrections fought an ongoing gesture,
producing flicker and repeated jumps toward the old position. Explicit wheel
and pointer-drag scrolling now advances the anchor epoch even while already
paused. A bare `scroll` event deliberately does not: streamed layout, browser
clamping, and native scroll anchoring can emit it without reader input, and the
semantic-row correction must still run in that case.

The regression suite now also mounts the production `SessionView` in real
Chromium against a test app-server boundary (HTTP thread history, SSE
completion event, and turn POST). It checks both contracts together: a paused
reader remains on the same part of the transcript across completion layout,
and a late prior-turn reply remains before an optimistic next request while
tail-follow stays active. This browser test runs as part of the normal
repository `bun test` discovery, rather than living as a manual Replay Lab
check.

A 2026-10-07 question-popup review found that `AsyncQuestionCard` inherited
16px body and option text and introduced oversized padding, rounded tiles,
and a circled uppercase heading beside the compact composer panels. It now
uses their existing typography, small radius, spacing, and action-button
treatment; the question pane shares the goal/plan pane width. The amber accent
remains, while the decorative question circles are removed from the card,
request heading, and composer badge. The browser lifecycle test compares
rendered question typography, panel geometry, and control radii with the
existing goal panel so this mismatch cannot silently return.

A 2026-09-23 FHIR session exposed the complementary failure after acceptance:
the live normalizer handled `agentMessage` item snapshots but discarded the
app-server's canonical `userMessage` snapshots. When the optimistic row was
removed, reconciliation preserved the response-first live projection and
appended the newly visible history user row after it. Live user items now pass
through the same canonical item normalizer as history, and reconciliation uses
history only for canonical app-server item order while retaining live-only
usage and warning rows at their neighboring item boundary. This is still one
app-server projection; transcript data is neither merged nor consulted.

A 2026-10-02 recurrence found two remaining replacement paths. A canonical
user snapshot can arrive after another item from its newly accepted turn; a
plain append then removes the correctly placed optimistic row and briefly
renders response -> request. Matching new-turn user snapshots are now inserted
before the first already-observed item carrying that authoritative turn ID.
Separately, optimistic reconciliation used to match equal user text anywhere
in the session, so a new short reply such as "yes" could be mistaken for an
older turn and disappear. Content matches are now bounded to rows after the
send-time anchor and reject conflicting turn IDs. The browser lifecycle test
covers the response-first/canonical-user-second delivery order; a focused
projection test covers repeated user text across turns.

A 2026-10-11 steering and queue lifecycle audit found that optimistic rows
were still reconciled by content without one-to-one ownership. Repeated equal
steers could therefore acknowledge each other, while a late canonical steer
could move behind already-rendered output and conceal that output. Optimistic
rows now match canonical app-server user items one-to-one after their stable
message anchor, and canonical acknowledgements replace the row at its visible
position. Turn lifecycle events also outrank late HTTP start responses, so a
completed turn cannot be reopened and block the next queued request. Source
epochs prevent delayed responses from mutating a reused SessionView after an
A -> B -> A switch. Queue ownership is synchronously restored on every source
change; queued work from A can no longer be submitted to B. Browser coverage
asserts exact visible request/response order through fast completion, delayed
acknowledgements and failures, queue promotion, source switches, and offscreen
remounts. Transcript messages remain outside this app-server projection.

A later adversarial audit found three remaining parity failures. A disjoint
latest app-server page could place previously observed older live rows after
the new page; unmatched rows older than the page now stay before it. A steer
seen live before its history page could be classified as ordinary input and
keep that identity forever; canonical app-server history now corrects its
intent and turn identity without replacing richer live content. Finally, the
stable visual-item cache compared only a subset of block fields, so media,
stream completion, subagent results, file edits, and compaction details could
change underneath an obsolete rendered row. Cache reuse now compares every
immutable block field shallowly, conservatively refreshing replaced nested
metadata without serializing large tool or media payloads.

A 2026-10-14 browser reproduction exposed steering being hidden by action-group
collapse: the user bubble belonged to the prior tool group, which closed when
the next tool event opened another group. Shared work-detail grouping now gives
user messages their own non-collapsible group alongside agent responses. The
real SessionView lifecycle test verifies the exchange remains visible through
optimistic send, canonical acknowledgement, agent output, and subsequent tools.

The 2026-10-14 audit of `01a12190-a469-7f31-9321-ea1b160082f0`
found inter-agent deliveries falling back to human messages when bounded-tail
parsing lacked session metadata. Shared normalization now emits subagent activity
independently of that header, using the sender rather than the recipient task
name; live input envelopes use the same conversion. All 350 recorded deliveries
were verified to produce no human-message boundaries, including the daemon tail.
Usage checkpoints now charge cumulative progression instead of repeatedly charging
the last request. New `token_usage_record` rows are authoritative when present;
legacy snapshots still update context size but do not bill the same work again.
The final root round records 1,665,520 fresh-input-plus-output tokens. Its three
active children separately record 3,467,542 in that time range (5,133,062 combined).
Goal-budget notices include child work and have their own goal start/end boundary;
they are not the root round's token counter. Live and transcript remain separate
sources, sharing conversion/accounting functions rather than merging their data.
Round summaries now label their token count as "this agent"; token and cost
tooltips explicitly exclude subagent usage. Expanded rounds distinguish fresh,
cached, output, and reasoning tokens (reasoning is included in output), and rounds
with subagents explain the separate accounting and goal-budget scope. This does
not invent a combined total from whole child sessions: reused children may span
several parent rounds. The SessionView browser test covers live usage, unrelated
child traffic, and completion while preserving the scoped round count.

An Astra follow-up review found that app-server agent deliveries still polluted
the human-message identity set even after their visible role changed; the next
human input could therefore become phantom steering. History/live now register
only normalized human rows. Usage decoding is shared too: explicit zero counters
retain a reset baseline, and a handled thread checkpoint cannot fall through to
a legacy alias and charge the last request again. Plain-text delivery envelopes
retain the same parent relationship as structured records, and response-usage
rows are recognized when identifying a bounded recording. The supplied session's
4,314 response records sum to 16,806,683 fresh-input-plus-output tokens, exactly
matching shared normalization; its final round remains 1,665,520. Round breakdowns
also expose cache writes as part of fresh input and reasoning as part of output,
without adding either subset twice. Parent relationship labels stay neutral when
the recorded metadata does not establish message direction.

A second Astra pass reproduced a history-to-live accounting handoff bug: parsed
history checkpoints lived in a temporary context, so the next live notification
could bill already observed work. History now seeds an uninitialized live usage
baseline without rewinding a baseline already advanced by live events or newer
pages. The full-file stats scanner also still used an independent legacy-only
pricing parser. It now shares `codexUsageForTranscriptRecord` with transcript
normalization, preserving cached append state, authoritative response records,
zero-counter resets, and `thread_settings_applied` model switches. A fixed-size
snapshot of the growing source matched all 4,331 response records exactly:
648,588,086 reported tokens, 16,890,550 fresh-input-plus-output tokens. Two actual
forked-child files also matched; no inherited-usage change was justified by those
records. Parent `NEW_TASK` payloads now populate input metadata, not output;
encrypted-task notices remain explicitly notices, and known input is never
fabricated as a result via the display-text fallback. Browser coverage opens the
actual parent-delivery card and verifies an Input-only section.

The third Astra pass constrained inter-agent envelope recognition to a leading
header and read sender/task metadata only before `Payload:`. Human requests
quoting a notification therefore keep their human role. Subagent roster metadata
now prefers later resolved model/effort settings, and paired activity completion
and results beat pending spawn defaults; historical rounds remain unchanged.

The same pass reproduced usage double-counting across item snapshots, standalone
thread checkpoints, and canonical history reconciliation. Usage-only app-server
rows now retain recorded cumulative bucket ranges. Stable item IDs align
page-local reset epochs; only evidenced canonical coverage is subtracted, leaving
partial/uncovered and later-reset work intact. Unanchored ranges cannot erase
observed work on numeric coincidence. This does not drop visible messages or mix
transcript data into the live source. A real SessionView lifecycle case previously
changed 150 tokens to 200 at completion; it now remains at 150. A truncated reset
page also retains the separate model buckets (100 before reset, 200 after).
Coverage is indexed by turn/epoch and merged before overlap lookup, avoiding a
full canonical-message scan for every live usage row. A Bun helper-only smoke
with 2,000 canonical and 2,001 live rows took 2.72 ms with exact retained totals;
this is not an end-to-end renderer timing. The fixed-size 132,664,288-byte source
snapshot retained all 351 deliveries as agent activity and matched authoritative
fresh-input-plus-output usage exactly at 17,018,449.

The fourth Astra pass found that a newer canonical usage item could update the
display without advancing its live baseline/owned item amount. A subsequent
checkpoint rebilled covered work (history 100 -> refreshed 200 -> live 250 showed
350). History adoption now uses the same stable-item epoch anchors as merge,
advancing only aligned current-epoch cumulative vectors that do not rewind any
bucket. Older pages, intervening live work, and pre-reset matches remain protected.
A SessionView lifecycle test found a second caller bug: completion removed the
observed-start identity, discarding valid final usage arriving afterward. Observed
starts now live until the source changes; active-turn state remains separate.
The browser case now renders 100 -> 200 -> 250, including the late final update.

The whole-message envelope classifier also accepts multipart input through one
shared path, preserving whitespace-only/character-sized text parts and attached
images. Multipart and image-bearing agent deliveries no longer create human
round/steering boundaries; separately-parted human quotations stay human. Finally,
unknown child metadata/wait results no longer overwrite known completed/failed
roster state. Explicit running still reactivates the child. Browser coverage
checks a late timeout cannot resurrect a completed badge, and an explicit restart
does bring it back. No transcript/app-server data was mixed by these corrections.

The related lifecycle audit reproduced a stale pane on return from offscreen:
buffered deltas reached session.messages, but synchronous catch-up inside the
visibility reactive statement ran after the derived-message pipeline. Svelte's
legacy dependency graph did not propagate that indirect write in the same flush.
Catch-up now runs in a guarded microtask after the visibility flush. A real
SessionView test overlaps a delayed app-server history refresh with an offscreen
new turn and streaming delta, then verifies the returned pane shows that delta.
The history response and transcript data remain separate sources.

The same audit measured repeated work-summary computation for unchanged clocks.
Shared immutable work items, display entries, detail groups, and content summaries
now retain their projections across ticks; timing and token rates recompute, and
new entries or pricing/model snapshots invalidate content. A Bun comparison using
the same 500 command entries and 20 clock updates measured 11.65 ms/update before
and 0.08 ms/update after. This measures summary CPU only, not total browser frame
time. Running native diagnostics before the change showed event ingestion mostly
0–3 ms but rendering settle p95 around 100–400 ms, with maxima over one second.

A 2026-10-11 subagent audit found that the composer roster was incorrectly
derived from the virtual render window. Spawn prompts, model metadata, and even
the child itself therefore disappeared once the originating row moved outside
the mounted tail. The roster now incrementally projects collaboration rows from
the complete loaded session while the expensive transcript DOM remains
virtualized; unchanged ordinary streaming rows preserve the prior projection
by immutable message identity. Parent-task metadata passed while opening a
child is source-tagged navigation context, not a fabricated history row, so
app-server and transcript data remain isolated. A live child can open from its
authoritative app-server ID before a transcript file exists, while transcript
navigation still requires a resolved file.

The live session header had a separate source-ownership bug: synthetic
app-server session shells assigned `Date.now()` as their start, so a reset or
reactive recreation made an old thread say "started just now" and could move
that value while events streamed. Live sessions now take their immutable start
from app-server `thread.createdAt`; turn timestamps and transcript metadata are
not substitutes. The header's three compact metadata rows are also explicitly
non-wrapping so changing counters cannot create a fourth row or alter lane
geometry.

The cumulative artifact map consumes the same normalized visual-work entries
as the per-turn artifact view. Full-history extraction is opt-in while a map is
open, completed work is cached by immutable item identity, and each session
publishes into a dedicated store so artifact updates do not wake the app root.
Closing the map releases that store and restores the normal bounded transcript
work; the regular session renderer and its geometry remain mounted throughout.

### Cumulative artifact-map scaling (2026-09-11)

Git fetch/pull/push ref arguments now carry a shared nicifier `git-ref` part
instead of a filesystem-path part. Artifact extraction retains them as Git
artifacts in the same map; the sparse tree renders one source → destination
row with the existing Git icon, not slash-separated folders or file links.
The tooltip retains the operation, remote and raw refspec (including force
and exclusion markers). Actual file commands reading paths under `refs/`
remain filesystem artifacts; there is no path-prefix blacklist.

The follow-up target audit streamed 59 Codex/Claude session files (128,573
rows, 22,035 tool invocations) from the October 12–15 Codex folders and recent
Baker/FHIR Claude sessions. It confirmed stream sinks as preview paths (30
`/dev/null` occurrences), unresolved shell expressions presented as filenames,
Git identities/config values treated as files, and PHP `->post` inside heredoc
stdin misread as shell output redirection. Shared target classification now
keeps streams out of file artifacts, retains unresolved expressions as symbolic
entries without local-file links, and separates URLs from filesystem paths.
Git diff separators preserve actual file arguments, including paths under
`refs/`; explicit revisions remain Git artifacts. Shell redirection extraction
uses the existing heredoc ranges to avoid interpreting input code as shell
syntax. Real content sources such as `/proc/self/status`, `/dev/shm` files and
ordinary `dev/` directories remain represented.

The October 16 tail of session `01a11346-0734-7570-abbc-ae9c35e979d0`
reproduced another missing write preview: Python assembled a section replacement
as `s[:start] + <literal> + s[end:]` before `p.write_text(s)`. Shared extraction
now retains that literal as explicitly partial replacement content, not a
fabricated full-file diff. Reassignment/augmentation before the write prevents
using a stale literal. The changed-file tooltip accepts the existing shared
artifacts directly so it does not discard captured previews when rebuilding
file-only rows. A real SessionView browser test opens the changed-file chip,
hovers AGENTS.md, and verifies both the replacement text and zero disk-diff
requests. The actual tail record also retains its 362-character replacement
through canonical Codex normalization.

The follow-up now resolves those section boundaries against earlier captured
reads in the shared work projection. The actual last AGENTS.md replacement
reconstructs a `+7 −21` hunk starting at line 286. Artifact Map, the changed-file
chip, action-group counters and the individual edit hover share the resolved
edit; groups inherit the enclosing round's resolution rather than independently
guessing before-state. No current-disk diff or transcript/live mixing is used.
Missing/duplicate anchors, truncation markers, a read result received after the
write, a different cwd/workdir, or intervening mutations retain the partial
preview. SSH/container display labels are not sufficient identity proof, so
those remain partial too. Captured whitespace is preserved for reconstruction
so blank lines cannot shift hunk positions; existing display trimming remains
the default. Browser regressions cover both fallback and real plus/minus
previews, including the individual edit-row hover, with zero disk-diff requests.

The first cumulative map implementation accidentally made sparse-tree folder
detection quadratic in the number of artifact events. A synthetic 5,000-event
session touching one file took about 755ms merely to build its tree. Folder
detection now works from unique paths and their ancestors; the same regression
case takes about 12–15ms. Immutable artifact identities replace signatures that
previously reread every diff and preview string, expanded row changes are cached,
and tooltip payloads are materialized only when opened.

The session evolution tracker now reconciles append, tail replacement, rewind,
and changed-middle inputs from their shared item prefix instead of rescanning
all history. Fast input is coalesced to at most ten map refreshes per second.
The Evolution list remains available but is unmounted while collapsed and
windows its first render to the latest 200 matching turns, with explicit paging
for older turns. These gates remove work without unmounting the panel or its
subscription/geometry.

Repeated-read analysis is derived from that same artifact evolution. It only
flags an exact file/range read in a later turn when no intervening write to the
file invalidated the earlier read. Results are cached by the immutable turns
array, so the summary and the Repeated filter share one scan rather than adding
work on every render.

The context inspector is likewise opt-in. It streams JSONL into a compact
timeline that retains request-bearing records but drops unrelated telemetry;
closed panes do no parsing. Replay drives the inspector with the current source
line, coalesced to ten visual updates per second. A live pane polls a byte-range
endpoint and parses only appended bytes, while older context items stay
collapsed/windowed until explicitly expanded.

### Closed live action groups still mounted their rows (2026-10-03)

The Baker `better GLB solve` session made a renderer-only stall reproducible:
its 1.70 GB transcript had 86,351 JSONL rows, while the current app-server turn
alone projected about 4,800 items / 4,600 visual-work entries. The daemon still
served the full thread in tens of milliseconds, but browser diagnostics recorded
4.3-25.3 second event-loop stalls and multi-second `codex-event.settle` spans.
An equivalent local projection spent about 34ms normalizing/building display
entries and roughly 0.2s in a warm full-work overview, so neither explained the
orders-of-magnitude browser freeze by itself.

The live timeline grouped old actions under closed `<details>` elements, but CSS
closure only hid their bodies: every command, result, tooltip, and nested detail
row remained mounted and participated in every streamed Svelte reconciliation.
Closed action groups now retain their `<details>` shell, summary, geometry, and
open-state subscription while unmounting only the hidden detail rows. Opening a
group remounts those rows on demand. A real-browser lifecycle test closes and
reopens the production component to cover both the cost gate and the unchanged
interaction contract.

### Static work-summary pills promoted into hundreds of layers (2026-10-11)

A long-running native instance reached 8.35 GB WebContent RSS and 148% CPU while
the daemon remained below 200 MB RSS and 1% CPU. Renderer diagnostics captured
the discontinuity: a lane remount raised the page from 18 to 709 running
animations, 694 of them `.work-summary-pill-shell`, and from roughly 15k to 26k
DOM elements. FPS fell to 19 while otherwise sub-millisecond Codex event handlers
took multiple seconds to settle through rendering.

Every work-summary pill, including immutable historical and nested action-group
summaries, carried `animate:flip`, an intro scale transition, and permanent
`will-change: transform`. Remounting a long lane therefore promoted and animated
hundreds of static pills at once. Only the current live round's top summary can
actually change arrangement. Motion and transform promotion now apply solely to
that summary; historical and nested summaries keep the same markup, chips, value
pulses, and appearance without individual compositor layers. A Chromium lifecycle
test moves a long live lane offscreen and back, then verifies that the live
summary retains motion while grouped summaries are not transform-promoted.

### App-server history lost turn boundaries (2026-10-06)

The same Baker lane remained slow after hidden action rows were gated. Its
current 40-turn app-server page contained 4,152 normalized messages but only two
explicit `userMessage` items. The history normalizer had discarded each
app-server turn ID, so the shared recent-history window fell back to user-row
boundaries and treated all 4,152 messages as visible. That rebuilt 3,026 display
entries and 500 action-group summaries on every live event; the exact production
projection took about 2.6 seconds before Svelte DOM work, matching 8–16 second
browser event-settle stalls while the daemon itself answered in milliseconds.

Canonical app-server history and live messages now retain their turn ID. The
shared transcript window uses those authoritative boundaries when present,
keeping complete turns and at least the two latest turns without depending on a
user row. The shared visual projection also groups a canonical turn that omits
its user item into the normal work/response shape rather than falling back to
raw message rows. On the captured Baker response this reduces the initial
window from 4,152 to 142 messages, 500 action groups to 6, and the measured
normalization/window/projection/overview pass from about 2.64 seconds to about
82 milliseconds. Transcript sources without turn IDs retain the existing
user-boundary behavior.

### Paused virtual readers drifted during live growth (2026-10-11)

The bounded app-server window could advance its oldest rendered message while
new live rows arrived. The scroll controller then had no surviving semantic
anchor to restore, so a paused reader could move by thousands of pixels even
though tail following was off. The shared window now retains its rendered
start while paused and returns to the normal bounded tail when following
resumes. The controller audit also fixed stale post-restore metrics, native
scrolls racing queued follow work, selection and disposal races, intentional
top-position persistence, and independent scroll memory for nested live-work
bodies. Browser coverage appends enough live rows to cross the virtualization
boundary while the reader remains mid-history.

A subsequent basic live-follow regression came from consecutive app-server
updates arriving in separate Svelte flushes before the first scheduled scroll
correction. The first update correctly captured that the reader was following,
but the newly grown DOM made the second update look far from the tail; it then
superseded the first correction with a false "do not follow" decision. Pending
ordinary follow intent is now sticky across coalesced updates, just like an
explicit send-time follow, while the existing pause generation still lets a
wheel, pointer, selection, or other reader action cancel it. The controller
test reproduces growth between corrections, and the real SessionView browser
test delivers ordinary assistant rows through consecutive live event frames.

### 2026-10-16 — round accounting includes child runs

Round headlines previously displayed only the parent's usage. Shared nicifier
accounting now adds descendants once within each parent-round time window, with
a replay-time cutoff, child creation boundary, and a parent/children breakdown.
Missing child files are explicit rather than silently presenting a partial total.
Live child accounting reads app-server only; transcript accounting reuses the
incremental file-stats usage scanner and canonical normalizer. The supplied
`01a13639…` session's 10:51–11:02 UTC round has 146,446 parent new tokens plus
137,779 child new tokens (284,225 combined; cached input remains separate).

Loading is opt-in on visible session surfaces, serial, and source-generation
owned. Refreshes at completion must survive an already in-flight read. App-server
accounting retains usage checkpoints and descendant IDs, not child tool-output
or image bodies. Checkpoint pricing is cached per immutable child snapshot;
replay windows use binary-search bounds. No startup corpus scan, no opening or
resuming child runs, and no changes to scroll ownership/geometry suspension.
Summary chips occupy a full-width second row instead of a compressed central
column. Coverage exercises cumulative pagination, corrected turn snapshots,
fork metadata, descendant cycles, source disposal, replay cutoffs, and actual
SessionView token totals/layout.

### 2026-10-16 — lane return must preserve scroll-follow intent

Reproduced a viewport-only resize turning follow into a reader pause in the real
SessionView browser harness: the browser clamps `scrollTop` upward when the
viewport grows, while `scrollHeight` stays unchanged. The controller tracked
content height but not viewport height, so it classified that native layout
adjustment as scrolling up and persisted the incorrect pause across lane visits.
Track both heights, including programmatic restores. A viewport shrink may emit
no scroll event; the next tail update must retain follow in that case too.

An additional deterministic reproduction left the lane between a tail update
and its animation-frame correction. The transient bottom gap was persisted as
not-following. Save pending follow intent before retiring callbacks owned by the
old scroll element; keep explicit outer and nested reader pauses authoritative.
No new scroll owner, visibility policy, or observer loop is involved.

The existing offscreen browser test only left and returned with no intervening
events. It now delivers a long response while away and checks actual scroll
geometry as well as the follow indicator. A second browser case exercises
viewport clamping followed by offscreen output; controller tests cover both
resize directions and departure during queued corrections. A completed turn's
activity marker is intentionally inactive, so its CSS class alone is not proof
that follow was lost—assert viewport position/follow intent as appropriate.

An independent audit found a further, distinct failure in the bounded live-work
body. A real SessionView test now navigates with horizontal container scrolling
or vertical window scrolling, receives growing reasoning/tool/checkpoint groups
while away, returns across a turn boundary, and then receives another tool item.
Both Chromium variants failed: native anchoring left the nested body 31px from
its new end (`779 - 558 - 190`), and its unconditional scroll handler remembered
that layout event as a reader pause. The outer controller remained unpaused.
The old tests exercised either unchanged content or a long assistant answer;
contiguous tool calls also coalesce, so they did not exercise this body growth.

The shared controller now records each nested body's content/viewport geometry
after its writes and restores. A geometry-driven body scroll retains follow;
pointer input, upward wheel input, and an already-paused body remain authoritative.
Controller regressions fail before this change for content and viewport changes,
and the two Chromium navigation cases pass afterward. WebKit passed those same
navigation cases even before this additional fix: this is a demonstrated
Chromium failure, not proof that the user's all-lane native-app failure has been
reproduced. Native navigation/gesture behavior and the running bundle version
still require correlation with the user's instance.

The subsequent gesture audit did reproduce a failure in WebKit: a real
horizontal wheel gesture (`deltaX=1600`, `deltaY=-1`) over the outer transcript
navigated to another lane but also marked vertical following paused. After
offscreen output arrived, returning stayed detached. Dominant-horizontal
handoff already existed on nested work/code bodies, but not the outer message
viewport. Reuse that handoff there and exclude horizontal-dominant gestures
from vertical reader intent. This WebKit case failed before the two-line fix
and passes afterward; it also checks that an intentional vertical wheel still
pauses following and preserves the reader while later output arrives. The
user's exact gesture remains unconfirmed, and their running native bundle
(2026-10-16 09:01:35 UTC) predates the previous lane-return fixes.

Coverage audit: the previous controller and lifecycle suites did run, but the
browser harness moved a single lane with a transform and the CI browser was
Windows Chromium. Neither exercised a real horizontal wheel gesture in WebKit.
The existing harness now also supports real horizontal/vertical lane scrolling,
instant/smooth return, offscreen work growth, and a turn transition followed by
more output. `TREETOP_TEST_BROWSER=webkit` runs the same lifecycle suite with
Playwright WebKit, and a macOS CI job now runs it alongside the existing tests.
This tests native-engine behavior, not the exact installed WKWebView binary.
The clipboard test requests only WebKit's supported read permission (writes use
the real button gesture), and the artifact test waits for the hover preview to
close before clicking the next control; assertions and real interactions remain.

Final local verification: 673 related unit tests pass, and all 46 real
SessionView lifecycle tests pass in each of Chromium and WebKit (142 assertions
per engine). These include both new failing-before-fix paths and the reader-pause
controls. No native rebuild or production restart was performed.


### 2026-10-24: bounded process ownership across desktop relaunch

The desktop/source launcher now enables a separate loopback-authenticated process
broker. Daemon replacement detaches its transport rather than terminating live
PTYs, saved internal/shell commands, or the native Codex app-server. The native
tray/menu bar exposes counts, reopen, and confirmed Stop all and quit. Closing
the last desktop window leaves the tray visible; browser/native UI heartbeats
renew the lease, while daemon sockets and tray status polls cannot renew it.

Retention expires after 15 awake minutes without a UI. Sleep/long event-loop
pauses restart the full grace period. Generations fence cleanup decisions and
are checked before each resource; a returning UI acquires its lease before
mounting/restoring sessions. Closed-column cleanup additionally checks aggregate
viewers across daemon controllers. Windows kernel job ownership reaps descendants
on broker crash; Unix uses a pipe-EOF process-group guard. Background saved
commands use hidden broker-owned PTYs while retaining their saved run-mode label.
External application/terminal launches remain explicitly untracked.

Recovery snapshots offer an explicit compact checkbox list when processes were
lost: agent sessions selected, project commands and plain terminals unselected.
No command is restored before that decision. Broker logs rotate at 2 MiB and
record identities, leases, pause detection, cleanup proposals/cancellation,
confirmed exits, and failures without terminal output or environment secrets.
Versioned executable copies permit replacing the app bundle while the broker
runs, and retain at most three generated versions. Protocol/identity mismatch
fails closed rather than starting a second owner.

Regression checks cover real daemon replacement with the same broker/PTY/PID,
forced broker crash cleanup, native Codex turn reattachment, saved command
registration, explicit/idempotent recovery, pending-expiry cancellation, sleep,
and multiple active viewers. A headless browser checks the restore selection,
Skip all, and a 390px window. Native tray/menu-bar interaction still needs manual
verification on each target OS; do not restart the production daemon to test it.

Recovery remains gated until the canonical selection has been reconciled into
shared preferences and explicitly acknowledged. Recovery matches defined owner
or terminal IDs (never two missing IDs), and replaces shell attachment sources
with the restored PTY ID. Temporary workspace copies exclude broker credentials,
locks, recovery manifests, logs, and generated executables.

Additional safety regressions confirm that Stop all waits for in-flight launches,
a watcher ignoring Ctrl+C is reaped as a tree, and native Codex failure cannot
terminate another broker terminal or leave its own turn marked active. One-shot
speech cleanup belongs to the broker and checks its original process generation
before stopping a thread, so a delayed timer cannot start a replacement process.
Validation: CI-style unit run 4,437 passed (69 existing opt-in skips), all 49 Node
browser cases passed, subsequent focused ownership/recovery tests passed, and
Windows Go helper tests passed against a real ConPTY watcher. Existing repository
type-check errors remain outside this change; new broker modules compile without
new reported type errors. No application bundle or production restart was run.


2026-10-24 Windows console follow-up: remove the unrequested application-toolbar
process counter; recovery UI remains outside the toolbar. Bun 1.3.14's
--windows-hide-console still produced a console-subsystem PE, so native builds
also set our daemon and broker artifacts to IMAGE_SUBSYSTEM_WINDOWS_GUI before
packaging. The Go helper uses -H=windowsgui; background child spawns request
windowsHide. A compiled fixture checks the PE and GetConsoleWindow() == 0.
The rebuilt real daemon/broker/helper all have GUI subsystem headers; an isolated
built-broker run logged consoleAttached=false, and forced broker termination
reaped its fixture session. Task Manager kill cleanup remains intentional.
Windows installer rebuilt at artifacts/stable-win-x64-Treetop-Setup.zip; production
app/daemon and existing sessions were not restarted or replaced.

Follow-up after installing: the daemon was the new GUI executable, but the
preserved live broker and helper were still the older console-subsystem binaries.
Do not kill those just to pick up an update; they own active sessions. Broker
connection logging now records reuse (PID/generation) versus a fresh executable.
A separate compiled-GUI fixture reproduced raw Bun.spawn opening a visible
PowerShell console; windowsHide made it pass, including stderr/nonzero exit
handling. Audit background utility launches (Git fetch, application discovery,
focus helpers, SSH, project commands, picker wrappers and native startup cleanup)
to request windowsHide explicitly. Bun's shell already hid its children in an
independent compiled-GUI probe. Merely seeing OpenConsole and a Codex-owned
PowerShell in the process tree was not evidence of a visible window: direct
checks of both normal and unsandboxed diagnostic PowerShell processes returned
GetConsoleWindow()==0 and Visible=false. The editor-discovery regression also
runs real detection from a GUI executable against console-subsystem locator
fixtures and verifies every launched locator remains invisible. No live
broker/helper/session was stopped during diagnosis.
Validation after the utility-launch audit: 4,443 unit tests passed, 69 existing
opt-in skips, zero failures; the strengthened compiled editor-discovery probe
also passed independently. Rebuilt artifacts/stable-win-x64-Treetop-Setup.zip
and verified the daemon, broker and helper PE GUI headers inside the packaged
archive itself. The production app was not installed or restarted.

2026-10-24 Windows native refocus: production launcher logs reported a focused
Chrome_RenderWidgetHostHWND while browser diagnostics timed out with
documentFocused=false. Reproduced this with two isolated Electrobun/WebView2
windows and a plain textarea: the renderer-targeted repair returned true but
actual SendInput characters never arrived. Select the visible, in-process
Chrome_WidgetWin_0 controller host instead; its focus handler activates the
WebView document. Read focus from that host's thread, not Chromium's separately
cached renderer input queue. Preserve the already-restored fast path to avoid
resetting working focus on duplicate activation notifications. Attach all needed
host/target input queues and detach them even if a later attachment fails.
Native diagnostics now include worker/host/WebView thread IDs.

With the production adapter, the isolated native fixture accepted Windows
keyboard input after three consecutive returns without a mouse click (k, kk,
kkk), with documentFocused=true after each return. Separate local app-data and
loopback fixture servers kept production sessions and WebView profiles untouched;
keyboard injection was guarded by the fixture's foreground HWND. Regression
tests cover controller-host selection and queue cleanup, and the existing real
browser test still covers last-input restoration, selection, dialogs and search.

2026-10-24 tray lifetime correction: exitOnLastWindowClosed was mistakenly nested
under build.runtime. Electrobun's CLI serializes config.runtime at the top level;
the installed Resources/build.json therefore contained runtime:{} and the SDK
quit the native tray owner on the final window close. Move runtime to the top
level, validate the config with ElectrobunConfig, and log the packaged runtime
value at native startup. The broker owns the actual sessions/processes; the
native launcher owns the tray/menu-bar icon and now stays alive after closing
its last window. Existing bounded lease/shutdown behavior remains in control.

The regression failed before the move and passed afterward. An isolated real
Windows SDK lifecycle test read the corrected runtime configuration, closed its
last window, verified the OS still recognized its tray icon using
Shell_NotifyIconGetRect, and delivered a native tray callback to reopen a window
in the same process. Explicit quit removed the tray icon and exited. All windows
and profiles belonged to the fixture; production sessions were not touched.
No Treetop/installer build was run for this correction: the user now builds.

### 2026-10-25: restored terminal sidebar state and quarter-turn squares

Shell restoration previously merged columns without publishing the same live IDs
used by the dock. An early terminal snapshot or remote terminal could therefore
leave a surviving server hidden until its view mounted. Restore now publishes
columns and live IDs together, preserving unrelated agent IDs and clearing known
exited shells. Live shells also remove stale persisted Resume cards for the same
terminal. Regression coverage exercises restoration followed by dock eligibility
without mounting a terminal view; 176 focused tests pass.

Live shell squares now turn 90 degrees every 1.5 seconds, with pauses between
turns, even when the server is quiet. Exited terminals remain static; reduced
motion disables the animation. No app build or production restart performed.

### 2026-10-25: Windows borderless window

User clarified that the native caption must be absent, not merely dark.
Windows now selects Electrobun hiddenInset: it removes the caption area while
retaining native resizing. Other platforms retain their existing window style.
A six-pixel transparent top grip uses the SDK drag-region behavior without
adding a visible bar. Windows tray controls expose minimize, maximize/restore,
and close-window (existing bounded session retention), separately from Stop all.
Removed the obsolete caption-color code and title-based window lookup; icon
setup uses the SDK HWND, retries on DOM readiness/focus, and logs failures.

A hidden isolated native SDK fixture measured the real client-area top inset:
default was 31px; hiddenInset was 0px, with resizing retained. Fixture exited
cleanly and did not connect to production. Platform selection and fullscreen
restoration tests pass. No Treetop/installer build or production restart.

### 2026-10-25: checked Windows installer and broker-preserving handoff

Replace the SDK's delete-in-place extractor during build-summary with a standalone
GUI setup executable embedding the checked app archive. Stage and validate before
requesting any exits; serialize installers with a lock. Install-local, expiring
PID-targeted prepare/exit requests require all installed UI/daemon workers to
acknowledge broker availability. UIs exit first and save window state; the daemon
then detaches from the broker. No forced process termination and no broker stop.
Dev builds/workspace brokers never participate. External daemon-owned commands
block handoff. A missing/old responder fails visibly before any exit requests.

After confirming no installed executable is running, rename the old installation
to a rollback directory, move staged files into place, and verify build metadata.
Failure rolls back; successful installs recreate shortcuts and relaunch before
showing confirmation so a modal dialog cannot consume the broker absence lease.
Errors show a persistent dialog and append to stable/installer.log. Old rollback
copies are pruned only when no executable runs there. SDK launcher templates no
longer globally terminate other WebView2 hosts during startup/shutdown.

30 installer/launcher/broker tests pass, including the real surviving terminal PID
across production handoff state transitions, plus 15 focused native/update tests.
First migration from an already-running pre-handoff version is intentionally
blocked with an explicit message: it cannot be remotely taught to detach safely.
The user requested the saved Treetop build command after validation; installation
and production restart remain user actions.
