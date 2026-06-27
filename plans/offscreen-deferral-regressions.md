# Offscreen-deferral regressions — tracker

Living tracker for the cluster of regressions introduced by the late-June
2026 renderer perf pass, in particular:

- **`4d61ab6` "Defer offscreen layout and terminal work"** — stopped mounting
  `TerminalView` for offscreen session columns and added a "muted hold socket"
  to keep attached PTYs alive. Done only in `NewSessionCol`, with `drain:false`.
- The agent-scan deferral commits (**`f96f1f5` Bound cold repo git fanout**,
  **`dd83850` Reduce startup session and git pressure**, **`15324c4` Keep agent
  scans off repo refresh hot path**, **`71e8896` Resolve installed agents in
  parallel**) — made the per-worktree agent scan (`wt.agents`) load lazily.

Symptom owner: Marcel. Investigated 2026-06-27.

---

## Status at a glance

| # | Regression | Status | Commit |
|---|------------|--------|--------|
| 1 | Active TUIs stop / vanish from dock ~1 min after switching away (zen / scroll) | ✅ fixed | `3de74db` |
| 2 | Backgrounded agent is muted/paused (stalls) instead of running | ✅ fixed | `3de74db` |
| 3 | Dock dot shows no working **spinner** for background agents | ✅ fixed | `3932349` |
| 4 | At startup, live TUIs don't show as active in the dock until scrolled to | ✅ fixed (verify) | `3b47599` + Part A `ccad40f` + Part B stagger-spawn (uncommitted) |
| 5 | TUI scrollback truncated / can't scroll up when returning from a zen session | 🔲 open (note only) | — |
| 9 | Switch repo (zen or not) → return → agent was NOT working; re-sending revives it | 🔲 open (triage) | — |
| 6 | Dirty state doesn't update in the git/folder column | ✅ fixed (verify) | max-wait batcher (uncommitted) |
| 7 | Paste truncates large clipboard content (into a TUI) | ✅ fixed (verify) | throttled chunking (uncommitted) |
| 8 | Vines don't reposition when a column is added/removed | ✅ fixed (verify) | settle-loop (uncommitted) |

---

## 1. Offscreen agent PTYs get grace-reaped — FIXED (`3de74db`)

**Symptom:** switch away from a TUI (zen in another repo, or scroll it
off-screen); ~1–2 min later the agent "stops" and disappears from the dock.

**Cause:** `4d61ab6` unmounts `TerminalView` off-screen. The "muted hold socket"
that keeps the PTY past the daemon's 60s grace timer (`server.ts GRACE_MS`) was
added only to `NewSessionCol`; `SessionView` (resumed/opened agents) had none →
last WS subscriber detaches → daemon reaps the PTY.

**Fix:** extracted the hold-socket lifecycle to `terminal-hold.ts`
(`createTerminalHold`, unit-tested) and wired it into `SessionView`.

## 2. Held agents muted/paused — FIXED (`3de74db`)

**Cause:** the hold socket sent `drain:false` unconditionally → daemon mutes →
helper `term.pause()` → agent stalls. Contradicts `TerminalView`'s own
`drain = !document.hidden` ("offscreen agent TUIs keep streaming").

**Fix:** hold socket now drains while the tab is visible (`shouldDrain =
!document.hidden`); only a backgrounded tab mutes. Applied to both
`NewSessionCol` and `SessionView`.

## 3. Background dock spinner missing — FIXED (`3932349`)

**Cause:** the daemon computes `working` per-PTY and broadcasts it on the state
channel precisely so the dock can reflect offscreen activity
(`node-pty-backend.ts`), but the hold socket only forwarded `awaitingInput`.

**Fix:** hold socket now forwards `working` too (fired only when the frame
carries it, so awaiting-only edges don't clear the spinner) → wired to the
existing `workingChange`/`onWorkingChange` path.

---

## 4. Live TUIs not active in the dock at startup — ROOT-CAUSED + FIXED (verify after rebuild)

**Confirmed root cause (2026-06-27, real data):** in `App.svelte` `load()`,
`liveTerminalIds` + `reconcileLiveAgentTerminals` sat **behind
`await reposStream`** — the cold, bounded repos NDJSON fanout the perf pass
introduced. So the dock had no live-terminal evidence until *every* repo
finished enriching; dots only appeared as the user scrolled (mounting a column
populated activity via the transient-working path instead).

Proof the reconcile *logic* is fine: fed the real persisted session
(`resumeSessionId cf33af3d…`, `attachTermId:null`) + the real live PTY
(`ownerId cf33af3d…`, `cwd C:\git\needle-cloud`, agent claude) to
`reconcileLiveAgentTerminals` in isolation → it set `attachTermId`,
`isLiveTui:true`, `hasDockActivity:true`. The match keys line up exactly
(`resumeSessionId === ownerId`, `cwd === wtPath`). So the gate was timing only.

**Fix (uncommitted):** hoist the `/api/terminals` parse + `liveTerminalIds` +
reconcile to run *before* `await reposStream` (reconcile's resumeSessionId path
needs no repo data), then re-reconcile after the stream for sessions matchable
only via the per-worktree agent scan. Net: live TUIs light their dock dot
immediately on load. Pairs with `3b47599` (foreign-filter exemption).

Confirmed scenario with Marcel: happens on a **plain UI reload (daemon alive,
`/api/terminals` populated)**, i.e. a real regression — not just the
post-reinstall no-PTYs case.

### Deeper finding (2026-06-27, after rebuild): startup with no PTYs

After a daemon restart (reinstall), there are **no live agent PTYs** — the
helper dies with the daemon. `prefs.json` has **169 open sessions: 135 read,
34 terminal-mode** (all with `resumeSessionId`), across ~20 worktrees. At
startup those 34 are (a) **hidden** from the dock — the "foreign" filter trips
because the per-worktree agent scan is deferred (`knownSources` empty) — and
(b) have **no PTY** until their column mounts (click/scroll re-spawns
`claude --resume`, confirmed via screenshots + `createdAt` timestamps). So
`d0de330` only covers the daemon-alive reload; the post-restart case needs
more. Marcel chose **show-all + background stagger-spawn**.

`.row-body` for folded/offscreen rows stays mounted via `display:none`
(App ~3668), so SessionView components are mounted for all 169 sessions — only
the xterm (`TerminalView`) is deferred. So once a session gets an
`attachTermId`, its existing hold socket keeps the PTY alive; no new hold
plumbing needed.

- **Part A — visibility (DONE, uncommitted):** `dockSessionHiddenAsForeign`
  gains an `isRestorableTui` exemption (mode `terminal` + `resumeSessionId`);
  App passes it. The 34 now show in the dock at startup (idle, before any PTY),
  independent of the deferred scan. TDD test added.
- **Part B — background stagger-spawn (DONE, uncommitted):** after first load,
  enqueue the terminal-mode sessions lacking a live PTY and `POST /api/terminals`
  (`claude --resume <id>`, cwd, `ownerId = resumeSessionId`) ~2.5/sec, setting
  `attachTermId` on each spawn so the dot flips active and the mounted
  SessionView's hold socket keeps it alive. Guards against the column-mount
  path double-spawning via a `bgSpawnInFlight` set keyed by source PLUS a
  1.5s start grace so onscreen columns mount and self-exclude (their `onSpawn`
  sets `attachTermId` + marks the id live) before the loop begins.
  - Pure selection logic = `selectSessionsForBackgroundSpawn`
    (`session-source-routing.ts`), TDD-tested in
    `session-source-routing.test.ts` (9 cases: picks restorable terminal
    sessions, forwards model/effort, codex too, skips live/in-flight/
    column-spawned/read-mode/shells, cross-worktree order). The side-effecting
    half (`ensureBackgroundTuiSpawn` / `spawnNextBackgroundTui` /
    `spawnBackgroundTui`, `App.svelte`) drains until empty for
    `BG_SPAWN_IDLE_STOP_TICKS` then stops; restarted only by a fresh mount
    (gated by `bgSpawnStarted`). Knobs: `BG_SPAWN_INTERVAL_MS=400`,
    `BG_SPAWN_START_GRACE_MS=1500`.
  - Wiring verified by `bun test` (selection) + the built app (spawn POST /
    dock dot). Not yet rebuilt/committed.

### Earlier partial step

`3b47599` exempted live TUIs from the "foreign" dock filter
(`dockSessionHiddenAsForeign`) — necessary but not sufficient on its own.

**What the dock needs** (`openSessionHasDockActivity`, App ~6509): a session is
"active" if **(a)** `attachTermId ∈ liveTerminalIds`, OR **(b)**
`transientWorking`/`transientAwaiting[source]` is set, OR (c) codex-app-live.

**Ground truth (2026-06-27, `<workspace>/prefs.json` → `supergit:openSessions`,
170 sessions / 30 worktrees):** almost every persisted agent session has
**`attachTermId: null`** even with a `resumeSessionId` and `mode:"terminal"`.
So (a) is false at startup until **`reconcileLiveAgentTerminals`** re-matches
`resumeSessionId` → a live PTY's `ownerId` (with `live.cwd === wtPath`).
And (b) is empty until a column **mounts** and its socket forwards state.

So a dot can only appear at startup if reconcile succeeds. It isn't → the dots
appear only when the row is scrolled in (column mounts → socket → transient
working populates path (b), and/or a fresh `claude --resume` is spawned).

**`3b47599`** exempted live TUIs from the "foreign" dock filter
(`dockSessionHiddenAsForeign`) — correct and necessary, but it only helps once
`isLiveTui` is true, which still depends on reconcile. So it didn't move the
needle on its own.

**Open questions / next step — needs live `/api/terminals` (couldn't reach it
from the sandbox; daemon doesn't persist agent PTYs to disk —
`active-terminals.json` is shells only):**
1. Do the live agent PTYs actually carry `ownerId === resumeSessionId`? (spawn
   passes `ownerId={effectiveSessionId}` — verify it survives.)
2. Is `live.cwd === wtPath` an exact match on Windows (back/forward slash,
   casing, trailing `~`)? A path-normalization mismatch would silently break
   reconcile for every session.
3. After a **reinstall**, the daemon restarts → helper dies → all agent PTYs
   die. So post-reinstall there may be *no* live agent PTYs, and "appears on
   scroll" is the column **re-spawning** `claude --resume` on mount. If so the
   real ask ("active at startup") collides with the deferral by design and
   needs a product decision (eagerly attach/show vs. lazy spawn).

**Candidate fixes (pick after confirming 1–3):**
- Make reconcile match by `cwd`+`agent` when `resumeSessionId`→`ownerId` misses,
  and/or normalize Windows paths before the `cwd === wtPath` compare.
- Run a dedicated eager "attach live terminals to restored sessions" pass right
  after `restoreOpenSessions()` (chunked across frames, per Marcel) so dots
  light without mounting columns.
- Or drive dock liveness for unmounted columns from a global signal
  (`/api/terminals` ownerId/cwd) instead of per-column transient state.

Relevant code: `App.svelte` `dockEntries` (~6428), `restoreOpenSessions`
(~3446) + bootstrap `onMount` (~7204, `restoreOpenSessions()` before
`load("mount")`), `reconcileLiveAgentTerminals` (`session-source-routing.ts`),
`openSessionHasDockActivity`/`openSessionHasLiveTerminal`.

---

## 5. TUI scrollback truncated when returning from a zen session — OPEN

**Symptom (2026-06-27):** returning to a TUI from another zen session shows
content cut off; can't scroll up. Self-resolves "maybe only after I or you sent
something" (a keystroke / fresh PTY output).

**Hypothesis:** the held column remounts xterm on reveal and replays the daemon
backlog, but the xterm viewport/fit (usable scrollback height) isn't reconciled
until the next output/resize forces a refit. Suspect `TerminalView`'s reveal
path (`scheduleRevealReconcile` / `paintBufferedTerminalOutput` / fit-on-open)
and backlog sizing in `terminal-backlog.ts`. Likely a side effect of the
`4d61ab6` unmount-on-offscreen change. Also captured as a memory note.

## 6. Dirty state not updating in the git/folder column — FIXED (verify)

**Symptom (2026-06-27, screenshot):** the dirty/changed-files indicator in the
repo/worktree (folder) column doesn't update.

**Root cause:** `d15910e` "Debounce filesystem refresh bursts" made the UI
fs_change batcher (`createFsChangeBatcher`, `App.svelte` ~4223) a **pure
trailing-edge debounce** (`delayMs: 250`). It's a single global timer fed by
every worktree's `fs_change`; each push resets it, so it only fires after the
stream goes quiet for 250 ms. With many active TUIs / dev servers (e.g. the
`npm run testrunner` shells in `active-terminals.json`) writing files < 250 ms
apart, the burst never goes quiet → the timer never fires → `load("fs-change-
batch")` never runs → dirty state freezes. The old leading-edge batcher flushed
periodically during a burst, masking this.

**Fix (uncommitted):** add a **max-wait** guard to `createFsChangeBatcher`
(`maxDelayMs`), armed once per burst (not reset per push), so it flushes at
least every `FS_CHANGE_MAX_BATCH_MS = 2000` ms even during nonstop fs activity —
keeping the burst-coalescing win while guaranteeing dirty refreshes. Pure +
TDD-tested in `sse-change-kinds.test.ts` (the new test fails on the old
trailing-only batcher).

---

## 9. Agent stops working after a repo switch — OPEN (triage)

**Symptom (2026-06-27, Marcel):** working in repo A's TUI, switch to repo B
(in zen *or* not), come back to A → claude was **not** doing anything (idle, no
dock spinner). Re-sending a prompt revives it and the dot then shows activity
(screenshot: `Sketching… 34s · still thinking with high effort`). So the dock
dot was *truthful* — there genuinely was no work in flight. The agent had
stopped (or its PTY was reaped) while A's column was offscreen.

**This is the #1/#2 family, not a dock-display bug.** `3de74db`'s hold socket
is supposed to (a) keep the offscreen PTY past the 60s daemon grace and (b)
keep it *draining* (not muted) while the tab is visible. The repeatable
failure means a gap in that coverage for the **zen/repo-switch** transition.

**Suspects to check (needs the live app — can't reach prod :27788 from the
sandbox):**
1. Does `terminalHold.sync(...)` actually arm when zen masks repo A's row?
   The gate is `mounted && shouldHoldOffscreenAttachedTerminal({attachTermId,
   terminalMounted})`. If the masked row's `columnNearViewport` doesn't flip
   to false (IntersectionObserver vs the zen display:none mask, or the
   ancestor MutationObserver missing the class that hides it), the hold never
   arms → last subscriber is the unmounting TerminalView → PTY grace-reaped.
2. Race on unmount: TerminalView's io WS closes as the column unmounts; if the
   hold WS connect lags, is there a > grace window with zero subscribers?
3. `shouldDrain` is `!document.hidden`. Switching repos keeps the tab visible,
   so the hold should drain — but confirm the daemon isn't muting on the
   *handover* (the `drain:false` default the #2 fix removed).

Quickest live check: switch away from a working TUI, watch `daemon.log` for a
PTY reap / grace-timer fire on that termId, and `/api/terminals` for whether
the ownerId PTY survives the switch.

## 7. Paste truncates large clipboard content (into a TUI) — FIXED (verify)

**Symptom (2026-06-27):** copying a large blob (e.g. the full `/api/terminals`
JSON) from elsewhere and pasting **into a claude/codex TUI column** lands
truncated.

**Root cause:** supergit's transport chain is lossless end-to-end —
`xterm.paste(text)` → one `onData` → one `ws.send` → daemon `handle.write(buf)`
(no cap) → helper `term.write()`. The loss is at the **TUI input boundary**:
the whole blob is written to the pty in one shot, and when the agent drains its
input slower than the bytes arrive the kernel pty input buffer overflows and
silently drops the overflow. The note-attachment paste path already dodged this
by throttling (`pasteChunks`, one chunk at a time); the plain-text path didn't.

**Fix (uncommitted):** large text pastes now stream as one bracketed paste
whose body is chunked + throttled so the receiver keeps up. Pure helpers in
`terminal-image-paste.ts` — `shouldThrottlePaste` (code-point count vs
`PASTE_THROTTLE_THRESHOLD_CODEPOINTS = 8192`) and `chunkPasteBody`
(`PASTE_CHUNK_CODEPOINTS = 2048`, splits on code-point boundaries so a
surrogate pair is never cut → lossless `join("")`), TDD-tested in
`terminal-image-paste.test.ts`. `TerminalView.onPaste` routes only large
pastes through `sendThrottledTextPaste` (small pastes keep the untouched
single-shot `xterm.paste`); bracketing is applied only when the app has
bracketed-paste mode on, and the stream stops if the socket drops mid-paste.

> Tuning note: the chunk size / `PASTE_CHUNK_DELAY_MS = 8` are first-pass
> values. If a live repro still truncates, lower the chunk size or raise the
> delay — the structure (chunk + await between writes) is the fix.

> Note: prod daemon for Marcel's installed app is on **:27788** (not the
> CLAUDE.md default `:27787`). Read-only API diagnostics from a sandboxed
> shell can't reach it; inspect `<workspace>/prefs.json`,
> `<workspace>/active-terminals.json` (shells only), and
> `<workspace>/daemon.log` directly instead.

## 8. Vines don't reposition on column add/remove — FIXED (verify)

**Symptom (2026-06-27):** the decorative vines between session columns don't
move when a TUI/terminal/entry is added or removed.

**Root cause:** adding/removing a `.session-col` slides the siblings via
`animate:flip` (220ms) + a width transition (`App.svelte` ~1798). The vines
overlay re-measures *once*, on the childList MutationObserver callback (a single
`requestAnimationFrame`), which samples the **pre-animation** layout. Nothing
re-measures as the columns slide, so the vines stay stranded until an unrelated
event (resize/scroll) happens to re-measure. (`.session-col` IS a direct child
of `.sessions-strip`, so the mutation *does* fire — it's purely the one-shot
timing.) Not strictly from the perf pass, but in the same family.

**Fix (uncommitted):** `vines-overlay.ts` — for childList add/remove mutations
(new pure predicate `mutationsAddOrRemoveVinesColumns`, TDD-tested), run a
**settle loop** that re-measures each frame for `LAYOUT_SETTLE_MS = 260` ms so
the vines track the moving columns and land on the final layout. Attribute/
class changes keep the cheap one-shot `queueSync`. Settle RAF is cancelled on
destroy.

## Testing note

The component wiring for #1–#4 (SessionView opening the hold, dock reading it)
is **not unit-reachable** in this stack (no DOM/xterm/WS in `bun test` —
`terminal-view-mount.test.ts` says so). The pure helpers ARE tested
(`terminal-hold.test.ts`, `dockSessionHiddenAsForeign` in `storage.test.ts`)
and those tests genuinely fail on the old behavior. Wiring is verified by
running the built app.
