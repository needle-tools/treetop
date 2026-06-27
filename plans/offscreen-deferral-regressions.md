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
| 4 | At startup, live TUIs don't show as active in the dock until scrolled to | ✅ fixed (verify) | `3b47599` + dock-gating fix (uncommitted) |
| 5 | TUI scrollback truncated / can't scroll up when returning from a zen session | 🔲 open (note only) | — |
| 6 | Dirty state doesn't update in the git/folder column | ✅ fixed (verify) | max-wait batcher (uncommitted) |
| 7 | Paste truncates large clipboard content | 🔲 open (triage) | — |

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

## 7. Paste truncates large clipboard content — OPEN (triage)

**Symptom (2026-06-27):** copying a large blob (e.g. the full `/api/terminals`
JSON) and pasting only yields a truncated tail. Unclear yet whether it's
supergit's composer/clipboard handling or an upstream paste path. Triage:
check the paste handler (composer + sticky notes), any size cap on pasted text,
and `image-shrink`/attachment interception that might swallow large text.
Lower priority; not obviously tied to the offscreen-deferral cluster.

> Note: prod daemon for Marcel's installed app is on **:27788** (not the
> CLAUDE.md default `:27787`). Read-only API diagnostics from a sandboxed
> shell can't reach it; inspect `<workspace>/prefs.json`,
> `<workspace>/active-terminals.json` (shells only), and
> `<workspace>/daemon.log` directly instead.

## Testing note

The component wiring for #1–#4 (SessionView opening the hold, dock reading it)
is **not unit-reachable** in this stack (no DOM/xterm/WS in `bun test` —
`terminal-view-mount.test.ts` says so). The pure helpers ARE tested
(`terminal-hold.test.ts`, `dockSessionHiddenAsForeign` in `storage.test.ts`)
and those tests genuinely fail on the old behavior. Wiring is verified by
running the built app.
