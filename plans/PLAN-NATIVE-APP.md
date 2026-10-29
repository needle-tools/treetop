# PLAN-NATIVE-APP.md — packaging supergit as a native app

Captures the discussion about turning the current Bun-daemon + Svelte-SPA
setup into a shippable native app, including the named-localhost
question and the node-pty / Bun compatibility check.

Status: discussion + one empirical data point. No implementation
commitments yet.

## What we have today
- Daemon: Bun + TypeScript, ~30 src files, ~3.7k-line `server.ts`. Heavy
  use of Bun-specific APIs: `Bun.spawn` (dozens of call sites),
  `Bun.serve`, `Bun.file`, `Bun.gc`.
- UI: Svelte + Vite SPA, built to `packages/ui/dist/`.
- PTY hosting: node-pty runs in a Node sidecar (`terminals/helper.mjs`)
  because node-pty's PTY master fd returned ENXIO when read through
  Bun's libuv stream wrappers. Daemon ↔ helper talks NDJSON over stdio.
- External tools the daemon shells out to: `git`, `ollama`, editor
  binaries (`code`, `idea`, `fork`, …), MCP servers, OS file pickers.
  None of these are bundleable — they stay on the user's machine.
- Prod entry: `start.ts` → `bun run packages/daemon/src/server.ts`,
  default port `27787`, point a browser at `http://localhost:27787`.

## The question the user asked
"How easy/hard would it be to make a native compiled app out of this,
with ALL existing functionality bundled into one app?"

## Three realistic packaging paths

### A. `bun build --compile` → single self-contained binary
- Cheapest path. Bun already supports compiling TS to a standalone
  executable.
- Embed `packages/ui/dist` via Bun's asset embedding (or extract to a
  temp dir at boot).
- Ship `helper.mjs` + the per-platform node-pty prebuilt `.node`
  alongside the binary. Bun's `--compile` can't embed native modules.
- On launch: `Bun.serve` on a port and open the user's default browser
  at that URL.
- Not a "native window" — it's a self-contained CLI/server you
  double-click. Closest to today's prod path.
- Estimate: 1–2 days for a working build artifact, longer for installer
  + signing/notarisation.

### B. Electrobun (Bun + native webview)
- Best fit if we want a real desktop app. Electrobun is Bun-based, so
  daemon code runs essentially unchanged.
- Uses WKWebView (mac) / WebView2 (windows), no Chromium. Much smaller
  bundle than Electron.
- We still ship node-pty natively per arch — same constraint as A.
- Buys us: app icon, dock presence, file dialogs, native window chrome,
  signing/notarisation flows, auto-update, no browser tab.
- Bonus: if Electrobun owns the window, the user never sees the URL,
  which collapses the entire "named-localhost" question (see below).
- Estimate: 1–2 weeks for a first end-to-end build.

### C. Tauri / Electron — rejected
- Tauri: Rust shell + WebView. Bun daemon becomes a sidecar binary
  spawned by Tauri. Two runtimes shipped, Rust glue layer, no real win
  over Electrobun.
- Electron: Node runtime, not Bun. Every `Bun.spawn` / `Bun.serve` /
  `Bun.file` call (dozens) would need porting to `child_process` /
  `http` / `fs`. Plus ~100MB+ Chromium bundle. Not worth it.

## Friction points that apply to all paths
- node-pty native binary per platform: mac arm64/x64, linux x64/arm64,
  windows x64. CI matrix.
- External tools (`git`, `ollama`, editors, MCP) stay on user's
  machine. App must degrade gracefully when they're missing (mostly
  already does).
- Workspace state path is already user-chosen, no change needed.
- `start.ts` shutdown dance (`lsof`, `kill -9`) is irrelevant inside a
  packaged app; replace with in-process lifecycle.
- Code signing / notarisation, especially on mac. Real annoyance
  regardless of framework.

## Named-localhost sub-discussion

User asked whether the app could start on a name like `http://supergit`
instead of `http://localhost:27787`.

Three levels of effort:
- **A. `http://supergit.local:27787` via mDNS** — zero admin prompts,
  cross-platform via Bonjour/avahi/Win10+ mDNS. Still carries the port
  suffix.
- **B. `http://supergit:27787` via `/etc/hosts`** — one admin prompt at
  install time, then clean. Standard installer pattern.
- **C. `http://supergit` (no port)** — needs both name resolution *and*
  binding to port 80, which is privileged on mac/linux. Doable via
  launchd/systemd socket activation, but significant cross-platform
  plumbing for a short-URL improvement, and risks colliding with the
  user's other services on :80.

**User's conclusion:** if Electrobun owns the window, the URL is never
visible and the whole question is moot — current `localhost:<port>` is
fine. The named-localhost work only becomes interesting if we ship via
path A (browser-based) and want to make the URL more memorable. So:

- If we ship **path A (single binary, browser)**: optionally do mDNS
  (`supergit.local:<port>`) as a polite default; don't pursue
  hosts-file or port-80 plumbing unless a real user asks.
- If we ship **path B (Electrobun)**: skip the named-localhost work
  entirely.

## node-pty under Bun — empirical check

The comment in `helper.mjs:5` claims node-pty doesn't run cleanly under
Bun (ENXIO when reading the PTY master fd through libuv streams). The
comment was written against Bun 1.2.x; the project now runs on Bun
1.3.13. Worth confirming before committing to the helper-subprocess
shape long-term — if it's fixed, we can delete `helper.mjs` and host
PTYs in-process, which simplifies packaging (no Node runtime needed).

Smoke test added: `packages/daemon/test/node-pty-direct.test.ts`.
Imports node-pty directly in the Bun test process, spawns `bash -c
"echo <marker>"`, asserts the marker arrives via `onData` within 2s.

**Result on Bun 1.3.13 (2026-05-21):** still broken. `onData` never
fires, buffer stays empty, test times out after 2s. The
helper-subprocess workaround remains load-bearing. Re-run this test
when bumping Bun — it's the canary for collapsing the architecture.

## Spike results (2026-05-23)

**`bun build --compile` works out of the box.** Zero source changes
needed for the compile itself. The daemon (63 modules) compiles to a
61MB Mach-O arm64 binary in <1s.

### What was done

Source changes (minimal, backwards-compatible with dev mode):
- `server.ts`: UI_DIR resolution now checks
  `dirname(process.execPath)/ui` before the existing
  `import.meta.dir`-based sibling check. In a compiled binary,
  `import.meta.dir` is `/$bunfs/root` (Bun's virtual FS) so the
  sibling check never hits; the exe-adjacent check finds the `ui/`
  directory we ship next to the binary.
- `node-pty-backend.ts`: `helperPath()` now checks
  `dirname(process.execPath)/helper.mjs` first. Same for
  `fixSpawnHelperBit()` which checks `node-pty-prebuilds/` next to
  the binary before the existing `node_modules/` paths.

Build script: `scripts/build-native.ts` (run via `bun run build:native`):
1. Builds the Svelte SPA.
2. Compiles the daemon to a single binary.
3. Copies `ui/`, `helper.mjs`, and `node-pty` (current platform's
   prebuilds only) into `build/supergit-native/`.
4. Runs a smoke test: launches the binary on a temp port, curls the
   API + UI, asserts both respond.

2026-09-10: the packaging smoke test now uses an empty temporary workspace
with side-instance mode, and scrubs inherited `SUPERGIT_*` and `TREETOP_*`
settings. Copying the personal workspace made startup depend on attachments:
the Windows reproduction copied 9,036 files / 765 MB and responded after
15 seconds, past the 10-second deadline. The same compiled binary responded
in 0.6 seconds with an empty workspace. UI lookup still uses the packaged
assets beside the executable. Workspace-copy dogfooding remains separate.

Output layout:
```
build/supergit-native/       (63MB total for darwin-arm64)
├── supergit                  61MB compiled binary
├── ui/                       ~1MB SPA dist
├── helper.mjs                node-pty sidecar (runs under Node)
├── node-pty-prebuilds/       exe-adjacent prebuilds
│   └── darwin-arm64/
│       ├── pty.node
│       └── spawn-helper
└── node_modules/node-pty/    for Node's module resolution in helper.mjs
    ├── package.json
    ├── lib/
    └── prebuilds/darwin-arm64/
```

### Gotcha found during spike

`SUPERGIT_UI_DIR` is set in the current shell by the prod daemon's env.
When the compiled binary inherits that env, it skips exe-adjacent
detection and serves from the prod path. The build script's smoke test
strips all `SUPERGIT_*` env vars to test the compiled path correctly.
Real users won't hit this since they won't have `SUPERGIT_UI_DIR` set
globally — it only matters for developers who also run prod locally.

### Bun embedded files — considered and rejected

Bun's `Bun.embeddedFiles` API could theoretically embed the SPA into
the binary itself (no adjacent `ui/` directory). However, directory
embedding has reported bugs (Oct 2025–Feb 2026, oven-sh/bun#23852),
and we need to ship adjacent files anyway (helper.mjs + node-pty),
so there's no win from embedding just the UI.

## Recommended sequencing

1. ✅ **DONE** — Bundling spike. `bun build --compile` works, smoke
   test passes, path resolution is backwards-compatible.
2. Keep the helper subprocess. The node-pty-direct smoke test confirms
   Bun 1.3.13 still can't host PTYs in-process.
3. Decide windowing model: browser-tab (path A) vs native window
   (path B / Electrobun). User leans toward B because it removes the
   URL-memorability problem entirely.
4. Path B specifically: prototype Electrobun with the existing daemon
   wired up; the daemon code shouldn't need substantive changes.
5. Signing / notarisation / installer / auto-update — last, per platform.

## Open questions

### Treetop MCP and agent startup (2026-10-07)

`/mcp` now serves stateless MCP HTTP with JSON responses, initialization
instructions, ping, notification acknowledgements, and tool discovery. Tools:
`list_repos`, `add_repo`, `remove_repo`, `reorder_repos`, `set_repo_color`,
`list_commands`, `add_command`, `list_connected_apps`, `list_notes`, and
`open_session`. Commands are saved project actions, not executed by MCP.
Editor/app queries include detected editors, Fork's installation, and project
URL/file/folder links. Notes support an optional anchor prefix filter.

Agent PTYs automatically receive a session-scoped MCP connection: Codex uses
`-c mcp_servers.treetop.url=...`, Claude uses `--mcp-config` plus appended
instructions, and Copilot CLI uses `--additional-mcp-config`. The HTTP URL
carries the launch cwd, allowing `add_command` to resolve its registered
project without an explicit id. Explicit `repo_id` or `cwd` selects a project
from another client. The Codex app-server process also connects; because it
hosts threads with different cwds, its tools use the current thread's cwd
argument rather than a fixed process cwd. Headless Claude resume turns receive
the same connection. No global agent config or project instruction files are
modified. This does not install a skill; MCP initialization instructions supply
the workflow. Other clients can use the same endpoint if they support MCP;
the built-in Ollama chat does not yet have an MCP tool bridge.

Session opening persists a new/resumed agent or shell column in daemon prefs,
reveals its worktree, unfolds the row, and broadcasts the change to the UI.
The dashboard starts the CLI when it mounts the column; when closed, it picks
up the saved column next time. Project mutations broadcast normal change kinds
so caches, watchers, colors, and project order update across clients. Reorder
also updates the saved local project keys while preserving remote project slots.
Concurrent MCP tool calls are serialized per workspace to preserve both writes.

Validation covers HTTP lifecycle, mutations and notifications, project queries,
cwd-based command registration, CLI startup arguments, concurrent session opens,
secondary-worktree visibility, and idempotent UI column merging. Deployment
requires the user's normal rebuild/relaunch; the running daemon is untouched.

### Standalone activation and typing focus (2026-10-23)

Follow-up: the running Windows app reported native focus on `Chrome_WidgetWin_1`
while its visible render-widget child was `Chrome_RenderWidgetHostHWND`.
The old helper accepted any child as success, so it skipped the input target.
Restoration now checks/verifies the selected render widget and retries failed
native activation briefly. Launcher logs include window/foreground/WebView/focus
handles and the result of each attempt.

DOM restoration now repairs same-input focus with a blur/focus edge on native
activation, resolves replaced inputs/columns by session source, and allows three
seconds for document readiness. Browser diagnostics record restored/skipped/
not-ready outcomes without input contents. Explicit session focus also reaches
TerminalView's xterm input, rather than stopping at the visual-chat composer.
Edge regression covers the two previously failing cases, full column replacement,
delayed activation, selection, other controls, dialogs and teardown. Native helper
checks pass; actual Alt+Tab in a rebuilt WebView2 package still needs verification.

The old session focus helper depended on browser blur/focus events and tried
document.hasFocus only once. Packaged WebView2 can notify native activation
before DOM focus is ready or omit the outgoing browser blur. The installed
Electrobun v1.18.4-beta.3 Windows wrapper emits WM_ACTIVATE callbacks but focuses
its outer HWND rather than explicitly restoring the WebView child.

The launcher now forwards native focus/blur to the page. On Windows activation,
it restores the visible WebView child only if this app's window is foreground
and no child already owns native focus. Cross-thread SetFocus temporarily
attaches input queues and always detaches them. No foreground-window activation
is requested, so another application cannot be pulled forward by this path.
The frontend retries document readiness for at most 30 frames and handles a
native activation even when it missed blur. Existing visible/connected input,
dialog and other-active-control guards still apply; restoration does not scroll.

Validation: seven native/helper unit tests pass, including real Windows API
loading; the real Edge DOM regression passes for native-only activation,
delayed document focus, missed blur, caret selection, search/dialog preservation,
removed inputs and disposal. Changed helper modules pass strict TypeScript.
A native rebuild/relaunch is required; no running app or daemon was restarted,
and actual Alt+Tab in the rebuilt package has not yet been exercised.

### Connected voice sessions with no speech response (2026-10-23)

One-shot MCP speech: `speak_message` accepts up to 1,000 characters and a window
ID, checks `mcp.voiceMessage` in daemon prefs and the UI, and waits for playback
acknowledgement. Settings > MCP: Voice message defaults on. Each call uses an
ephemeral Codex subscription WebRTC v3 thread with no tools and a synthetic
silent audio clock; microphone capture is never requested. Explicit user text
through `thread/realtime/appendText` triggers the supplied sentence; v3
`appendSpeech` only added context in live testing. Completion uses assistant
`turn.done` plus drained incoming audio; local resources and the remote thread
are closed, with bounded timeouts. Existing interactive voice mode is separate.
Background summaries now default on, while explicit saved overrides remain.

Voice message eagerness (`mcp.voiceMessageEagerness`) controls the description
returned by each MCP `tools/list`: on request, milestones (default), or frequent
updates. Disabled voice overrides eagerness guidance. Clients that cache their
tool catalog must reconnect/refresh to receive changed descriptions. Preferences
guide concise observable progress, not private reasoning or per-tool narration.

Direct subscription probe played the full requested sentence through Edge,
with `getUserMedia` replaced by a throwing guard, then stopped its owned thread.

A later recorded request accepted `appendText` at 14:07:30Z but produced no
transcript before client cleanup at 14:08:57Z. Speech submission now waits for
both data-channel open and the backend `session.started` event, closing a
startup race; timeout messages identify readiness, speech, or playback stages.
The recording establishes silent output, not the upstream reason for it.

The new running build reached connected WebRTC state, but the affected sessions
produced no transcript events. Windows default capture was unmuted at 72%.
An isolated Edge connection using synthesized speech reproduced the silent
case: nonzero microphone energy and outbound RTP, but no input transcript or
reply audio. A fresh connection with the same client and speech then succeeded.
The exact underlying media/service cause remains unconfirmed.

The controller previously ignored all data-channel messages. It now surfaces
service `error` / `session.closed` events and observes transcript acknowledgements
from both that channel and App Server notifications. A bounded stats monitor
checks whether significant microphone audio is being transmitted without any
speech acknowledgement for 12s. That condition restarts the media session once;
another timeout surfaces an actionable error. Silence alone never reconnects,
and stop/cancel clears the monitor and guards in-flight stats results. Diagnostics
contain counters and energy only, never recorded audio or transcript content.

Validation: 19 voice tests pass, including service-error handling, one-retry
limit and acknowledged/quiet-session behavior. An isolated live 32s synthetic
speech probe received user/assistant transcripts and reply audio with the updated
controller. Only probe-owned voice threads were created/stopped; the user's
microphone, open sessions and daemon were not restarted or reconfigured.

### Voice restart lifecycle (2026-10-22)

Read-only inspection of the running daemon's log and bounded Codex App Server
recording showed successful `/api/voice/start` responses, realtime started/SDP
events, and some successful transcript events across restarts. Several later
starts were followed immediately by client-requested stops. The browser did not
record the failing WebRTC/SDP stage, so the exact live trigger is unconfirmed.

Regression tests reproduced independent controller bugs: failure waited for
remote cleanup before surfacing a retryable error; stop waited before enabling
restart; old connection/subscription callbacks could mutate a replacement;
and a canceled setRemoteDescription could restore a false listening state.
Cleanup is now local-first and remote best-effort, asynchronous callbacks are
generation-guarded, request operations have a 20s deadline, brief disconnected
states get 3s to recover, and live SSE recovery clears its stale warning.
Voice state/connection/audio failures are logged without SDP or transcript text.
Five new lifecycle regressions plus existing voice tests pass (15 tests total).
No production daemon restart or live voice interaction was performed.

### Agent session messages (2026-10-22)

CLI interruption fallback: an observed session ended its JSONL activity with
`task_started` and never persisted `turn_aborted`, despite showing Codex's
explicit interruption banner. The PTY now recognizes that banner across ANSI
and split chunks and clears the matching provider session's live working flag.
Only positive interruption notices affect the fallback; quiet tools remain
working, other sessions are untouched, and the next `task_started` resumes it.
As a final fallback, ten minutes without new Codex transcript activity clears
the working indicator (checked every ten seconds), without killing the session.
Fresh activity in an unfinished turn restores it; an explicit interruption
closes the turn so later metadata cannot reactivate it. Quiet tools can appear
idle after the timeout until they produce another activity record.

Command URL capture now subscribes until terminal exit instead of stopping
after two minutes. Slow installs/Vite startup and later server restarts keep
publishing URLs; the text buffer stays bounded and the observer unsubscribes
on exit. A fake-clock regression emits colored/split HTTPS Vite output after
three minutes, retaining the earlier HTTP service URL and excluding Treetop's port.

2026-10-23: Command-chip edit pencils replace the leading icon on hover/focus,
adding no extra chip width and preserving access to detected-URL open buttons.
The browser regression covers chip widths, pointer hit testing, URL clicks and
scroll bounds with editing enabled.

2026-10-23: Codex CLI approval/question footers (`enter to confirm or esc to
cancel`, and `enter to submit · esc to cancel`) now set terminal awaiting-input
state. Awaiting suppresses working and terminal-I/O spinner motion in the dock,
so pending approval uses the existing waiting pulse even while the CLI turn
remains open. Regression tests cover ANSI/split output and waiting precedence.

2026-10-23: `get_ui_context` reports the focused session separately from the
last active session, active project, viewport projects, window ID and snapshot
age. Browser/native windows publish ephemeral presence; reports expire after
15 seconds and unknown focus is never inferred from the first open session.

`focus_session` reveals an exact discovered transcript/open column and focuses
its input when available; it does not resume a stopped agent. `focus_project`
reveals and unfolds a registered project/worktree. `set_zen_mode` uses an
explicit `enabled` boolean: entering requires `repo_id` (optional `cwd` selects
a worktree), while exiting needs no target. Repeated calls preserve the desired
state. All three accept `window_id` from `get_ui_context`, default to the focused
or last active fresh reporting window, and wait for that window's application
acknowledgement. Missing targets, UI errors and acknowledgement timeouts return
errors rather than claiming success. These are in-app navigation controls;
they do not activate OS windows. `list_notes` already reads full note content,
anchors and tags; `anchor_prefix` filters repo/worktree/session-linked notes.

`send_session_message` now defaults to `action: "stage"`: bracketed paste into
a ready Claude/Codex terminal without Enter, with a request to reveal that
column in the focused (or last active) reporting window. Review and press Enter
manually, or explicitly call `action: "submit"` with the returned `draftId` as
`draft_id`. Receipts expire after five minutes, are single-use, and reject any
intervening terminal input. Stopped sessions can first be resumed through
`open_session` with `resume_session_id`. Native Codex staging is not supported;
`action: "send"` explicitly requests immediate terminal/native submission.
Results distinguish `staged` from `submitted` and set `confirmed: false` rather
than claiming transcript receipt. Verify through `read_session_messages` and
never automatically retry an unconfirmed submission.

MCP now exposes `send_session_message` and `read_session_messages`. Both require
an exact `source` or `session_id` from discovery; optional `repo_id` narrows the
target. Unknown, ambiguous and unregistered targets fail instead of guessing.
Sending is only for an explicit user request, never an autonomous agent chat.

Immediate sends target a live Claude/Codex terminal (bracketed paste followed by Enter),
or one open native Codex column, retaining its model, approval and sandbox
settings. Busy/confirmation-waiting terminals, busy native turns, stopped native
columns and missing live transports fail without spawning a second agent.
The result acknowledges delivery/submission, not completion or a reply.
Copilot, Ollama and Claude visual-only delivery are not implemented.

Reads default to five chronological user/assistant messages within a combined
6,000-character text budget. `verbosity: "verbose"` adds tool/event summaries;
thinking blocks are excluded in either mode. `limit` (1–50), `max_chars`
(100–32,000), and `offset` (skip newest readable messages, 0–1,000) control the
response. Parsing reuses the bounded session cache (up to 2,000 recent normalized
messages); pagination is within that recent window. Truncation and nextOffset
are explicit. Tests use real temporary projects/transcripts and isolated
transport boundaries; no messages are sent to live user sessions during tests.

### Session queries and window restoration (2026-10-07)

MCP `list_sessions` and `search_sessions` reuse cached agent discovery and attach
registered project IDs, names and paths plus saved session titles. Both accept
`repo_id`, `agent`, absolute `cwd` (including descendants), inclusive `after` /
`before` activity timestamps, `include_unregistered`, `limit` (1–100), and
`offset`. Results sort newest first and include total and nextOffset. Search is
case-insensitive literal matching over session IDs, titles, paths and indexed
first/recent user prompts, not full transcript text. Discovery covers Claude,
Codex, Copilot and Ollama; new columns appear once an agent transcript is found.

The native window preserves fullscreen/maximized mode alongside its existing
per-device window bounds, retaining normal bounds while fullscreen/maximized
and ignoring minimized frames. Close flushes pending state synchronously.
Zen worktree selection lives in daemon prefs (`supergit:zenRow`), restores on
startup, and clears when exited or the saved row no longer exists. Window mode
restoration requires rebuilding the native launcher; no production process was
restarted during implementation.

Focused validation: 227 tests pass across session integration, window-launch
and UI storage tests; App.svelte compiles. The local full suite's DPI probe
passes, but two Git subprocess tests exceeded 5 seconds (all eight pull tests
pass separately with a 15-second timeout). CI run 37644628977's original GitHub
log shows the DPI probe returned 0 instead of 1. A real Win32 regression
reproduces this with a preexisting thread override: changing the process default
does not reset that override. The launcher now also sets its thread to
per-monitor-v2, upgrades previously patched templates, and passes both real
Win32 probes. Probe assertions include exit code/stdout/stderr for future
diagnosis. CI verification is pending push.

### MCP reminders (2026-10-07)

MCP `get_settings` reads stored app overrides (`supergit:settings`), Codex
defaults, project order and project configuration including command buttons.
`export_settings` returns the same data as formatted JSON with `schemaVersion: 1`
and `exportedAt` so an agent can save it to a file. Optional `repo_id` filters the
projects array; workspace settings/order remain global. UI defaults that have
never been overridden are not part of the persisted settings snapshot. Runtime
session state is not exported. Both tools are read-only. Existing `list_commands`
queries saved/running commands, and `add_command` saves a project command by id
or session cwd, broadcasting its action button without executing it.
Saved command queries explicitly include `cwd` (null for the project/worktree
directory), `defaultCwd` resolved against `repoPath`, and `runMode`. Running from
another worktree resolves relative command cwd against that worktree instead.

`edit_command` updates a saved command by `repo_id` and `command_id`; omitted
fields retain their value, and null clears name/command working directory. IDs
and other links remain intact. Changes broadcast and append an agent action.
`list_events` exposes the existing recorded action log (payloads and undo/redo
metadata) with exact type/actor, inclusive date-range and pagination filters,
newest first. It is a query, not a live event stream or agent transcript reader.
Validation: all 22 MCP/workspace integration tests pass, including command edits
appearing in the queried action history and read-only settings exports.

`schedule_reminder` accepts a timezone-qualified `at` or `delay_seconds`, title,
message, optional plain-text details, `repo_id` and `session_source` (from session
queries). `list_reminders` filters by project/status; `cancel_reminder` cancels
scheduled items and `dismiss_reminder` acknowledges due ones. State is stored
atomically in workspace `reminders.json`. The daemon checks once per second and
catches overdue items on startup; notifications require a running daemon and
surface when the dashboard reconnects. Read-only instances do not run timers.

Reminders are listed in Inbox, using its compact message-list styles and unread
badge (including an accessible reminder/message count breakdown). There is no
separate Reminders header menu; upcoming/cancelled items remain queryable through
MCP. Due reminders show persistent
bottom-right toasts, removed by clicking, dismissing, or snoozing. Clicking opens a
details dialog and focuses the optional linked project/session; the dialog also
offers a Go to project/session action. Acknowledgement propagates across windows.
SSE changes trigger refresh, with periodic reconciliation for missed events.
MCP initialization instructions advertise reminders to supported agent clients.

2026-10-26: reminder toasts include a bottom-left "Remind me later · 2 hours"
button aligned with the message. POST `/api/reminders/:id/snooze` atomically
reschedules the same due reminder from server time, clears delivery metadata,
and broadcasts the change. Content and navigation links survive restarts.
The action stops click propagation, deduplicates pending clicks, and retains
the toast on request failure. 42 store/alert/toast tests pass; App and Reminders
compile. No production build or restart.

Reminder delivery also appears in Inbox. `/api/messages` includes a reminders
section derived from the durable store; it includes every due reminder and keeps
dismissed ones through 48 hours after `dismissedAt`. Dismissal is idempotent and
does not extend retention. Older dismissed records without a timestamp are kept.
Inbox entries open the same details/project/session action as toasts; dismissed
history does not contribute to the unread badge. Cancelled/upcoming reminders
remain queryable through MCP rather than the delivered Inbox history.

Validation: 57 focused reminder, MCP integration and toast tests pass; both UI
components compile, and the new storage/controller modules pass strict TypeScript
checks. The production daemon was not rebuilt or restarted.

### Codex display switching and stop/resume (2026-10-08)

Visual activity and queued sends are gated by the active visual surface. Switching
to a terminal transcript removes visual activity; displaying a live terminal
visually preserves its attachment and Stop control without enabling app-server
sends in parallel. Stop interrupts a running visual turn, blocks its queue, and
persists an explicit stopped state until Resume (even before a transcript path
exists). Resume availability now reacts to surface/state changes. Terminal stop
checks the response, preserves the attachment on failure, and clears stale
terminal/activity state on success/exit. Failed stop requests show an error.

Browser lifecycle regressions cover switching, visual stop/resume and an attached
terminal's failed/successful stop. On Windows, Bun's Playwright launch/connect
hangs during setup; the same suite is exercised through Node's test runtime.

Validation: 511 focused unit/integration tests and all 9 browser lifecycle tests
pass; the changed Svelte components compile. The repository-wide Svelte check
still reports 49 errors in existing type definitions/usages outside these changes.
The production app has not been rebuilt or restarted.

### Native icon DPI (2026-10-25)

The ICO already contained multiple sizes, but the window loaded one default-size
HICON and assigned it to both ICON_SMALL and ICON_BIG. Electrobun's Tray defaults
also requested a 16x16 source bitmap on Windows. Scaling those handles produced
blur even after replacing the SVG artwork.

Windows now loads the small window icon using GetDpiForWindow and
GetSystemMetricsForDpi, and supplies a separate 256px large icon for Explorer to
downsample. Move, resize, and focus refresh the small icon when DPI changes;
owned handles are released on replacement and window close. The Windows tray
requests a 256px source (the native wrapper uses width/height as LoadImageW pixel
dimensions, not notification-area layout dimensions). ICO generation includes
20/28/40/56/80/96px frames for fractional scaling and synchronizes the browser ICO.

macOS retains a 16-point tray layout but now bundles a 64px source PNG. Its app
iconset already includes all Retina representations through 1024px. No macOS
rendering defect is confirmed; these assets were checked from Windows.

Validation: 10 icon/focus tests pass, including real Win32 GetIconInfo raster-size
checks and a hidden test-owned window verifying distinct handles, reuse, and
cleanup. Packaged macOS Retina source dimensions are checked too. No production
process was touched and no application build was run.

References: [Windows icon sizes](https://learn.microsoft.com/en-us/windows/win32/menurc/about-icons),
[LoadImageW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-loadimagew).

### Earlier packaging questions

- Does Electrobun's process model let us keep the daemon as a
  long-lived thing the webview talks to via HTTP/WS (as today), or do
  we need to move to its typed IPC bridge? HTTP/WS keeps the dev
  workflow (Vite proxy) intact; IPC is "more native" but a bigger
  refactor.
- Auto-update story per platform — Electrobun has hooks, but the
  details matter for whether we can ship updates without users
  re-running an installer.
- How do we handle the "user already has supergit dev running" case
  inside a packaged app? Today's port-claiming dance assumes one
  daemon; a desktop app may want a stricter single-instance lock.


### MCP pending input (2026-10-27)

`read_session_input` resolves an exact registered session and inspects its mounted
native composer plus up to 20 queued messages with a shared text budget. Drafts
and queue entries report user/AI provenance. `send_session_message` now routes
through that same UI owner: stage fills only an empty composer; submit requires
an unchanged draft receipt; explicit send queues when busy or awaiting approval.
None of these actions changes focus or Zen mode or responds to approval prompts.
AI-filled drafts and queue entries carry a visible label; queue provenance is
persisted with the existing queue. Event logging records status/IDs, not draft text.

CLI/TUI input and its provider-owned queue remain **unknown**, but this does not
block explicit injection. Claude and Codex CLI terminals use bracketed paste at
the current cursor (never clear/replace user text). Stage omits Enter; explicit
send/submit presses Enter after checking input revision and confirmation state.
Working state alone is not a blocker: the CLI can accept a follow-up draft or
queue it. Confirmation prompts still block, including a prompt appearing between
paste and Enter. Per-terminal serialization prevents overlapping MCP injections.
`read_session_input` reports the tracked AI-injected text separately from unknown
CLI-owned input, with input-changed/expiry flags. A toast labels staged CLI input
as AI-filled. No focus or Zen-mode change is needed. Receipt submission also
requires the same target and text, and expires after five minutes.

Validation covers controller overwrite/concurrency checks, bounded reads,
registered-target resolution, UI acknowledgements, provenance persistence and
an isolated SessionView browser regression exercising stage/edit/submit/queue.

### 2026-10-29 Installer splash and cancellation

The standalone Windows Setup now embeds treetop-splash.png and opens a native
WPF window through the installed Windows PowerShell/.NET runtime. No browser
or terminal window is required. The small rounded window uses the existing
artwork, a quiet status footer, a progress track, and an accessible cancel X.
Its UI process is separate from extraction/hashing so cancellation stays responsive.
A temporary status/cancel file protocol connects it to the installer; the UI
closes if its owner exits and installer cleanup reaps only this owned UI child.

InstallerControl is platform-independent. Cancel aborts only installer-owned
staging commands and handoff waits. File replacement reaches its verification
checkpoint before cancellation unwinds through the existing rollback path.
After verification commits, cancellation is disabled while shortcuts, cleanup,
and launch finish. Cancellation is not reported as an installation error. If
old UI exit was already requested, recovery waits for that exit before reopening
the previous installation; the terminal broker is never stopped. First installs
have no old app to reopen. Payload verification-only mode never opens UI.

Actual WPF preview rendered successfully; accessibility automation invoked its
cancel X and observed cancellation. Screenshot: .cache/installer-preview.png.
Seventeen handoff/rollback/cancellation/launch tests passed. macOS can reuse the
controller and status protocol, but the WPF frontend is Windows-specific;
no new macOS installer frontend or macOS-tested artifact is claimed.

The five-second command-terminal preflight was also removed after a logged
GET /api/terminals timed out at exactly 5000 ms and blocked a saved command click.
Command clicks now go directly to the broker-backed saved-command start route,
which returns an existing command terminal instead of starting a duplicate.
Ten project-command lifecycle tests passed with a test-only 30s timeout for
slow Windows process creation. Broader UI/terminal stalls remain unresolved.

### 2026-10-29 Repeated post-install native startup crashes

Installer fc1506d8 verified build 09:33:14 and then exhausted three startup
attempts. Its launcher exited once with code 0 and twice with code 9; native
child Bun exited 0xC0000409 on the failed native attempts. The native log reached
BrowserWindow creation/initial focus, but not WebView DOM readiness. The user
saw the splash briefly. No Windows Application Error/WER entry or matching
crash dump was found. No lingering Electrobun-profile WebView2 process was
found during the failure audit.

Isolated SDK tests used copies under .cache, port 37792, a separate empty
workspace/home, and no broker connection. A minimal native window, the full
installed UI in a minimal host, caption/icon customization, and the complete
native launcher all reached DOM readiness and exited cleanly. These passes do
not establish the intermittent crash cause and no speculative startup source
change was made.

The user's later native launch at 09:48:26 reached DOM readiness and restored
keyboard focus at 09:48:29. Production status then reported the same surviving
broker PID 89956, connected, with ten sessions and four commands. The native
tray belongs to the window host; a surviving broker does not display a tray
when the host crashes. The user declined browser recovery. No production
process or broker was started, killed, restarted, or reconfigured by the agent.
Underlying native startup reliability remains unresolved.

2026-10-29 native callback crash fix:
The isolated native failures resolve to libNativeWrapper BridgeHandler::PostMessage
(indirect callback at RVA 0x85766, return 0x8576d) and NavigationStarting's
will-navigate callback (call 0xa3226, return 0xa322d). Both enter Bun FFI
trampolines from the native UI thread before DOM readiness. Geometry changes
still crashed; the failure is not established as a saved-window-size issue.
A headless Windows CreateThread/JSCallback stress test independently reproduces
heap corruption in bundled Bun 1.3.13 in under a second. Bun issue #33840 and
fix #31332 identify unsafe copying of JSC::Strong handles on foreign threads.
The identical test completes all 10,000 callbacks on official Bun 1.4.4.
Pinned build.bunVersion to 1.4.4 through Electrobun's supported runtime override.
Regression coverage checks the minimum fixed runtime and, when
TREETOP_NATIVE_RUNTIME_TEST names a distribution executable, runs real foreign
Windows thread callbacks in an isolated subprocess. Old runtime fails; 1.4.4 passes.
This is strong causal evidence for the observed startup crashes, but native
window launch was deliberately not rerun after the user's no-more-windows request.
No production daemon, broker, or native host was restarted. Installer rebuild
uses SUPERGIT_BUILD_OPEN_OUTPUT=0 to prevent Explorer windows.
Primary references: https://github.com/oven-sh/bun/issues/33840
https://github.com/oven-sh/bun/pull/31332
Rebuild completed successfully. Final Treetop-Setup.exe is 231,993,344 bytes.
Decompressed its final Treetop-Setup.tar.zst into workspace cache: build.json
reports bunVersion 1.4.4 and exitOnLastWindowClosed false. The exact bun.exe
extracted from that payload passes all three config/runtime checks, including
10,000 foreign-thread callbacks. API/UI/embedded Git worker smoke checks pass.
Broader build-launch tests were attempted in the sandbox: 12 passed and four
could not spawn child processes (EPERM); these were not rerun to avoid extra
process/window probes. The targeted native-runtime regression ran elevated.
No installer or production app launch was performed.

2026-10-29 installer cross-platform follow-up:
Committed the initial native runtime/session/Windows installer fixes as 08dc9df.
The next installation stayed alive but timed out waiting for DOM readiness.
A headless native thread test confirmed Bun 1.4.4 delivers cstring callback
arguments as JS strings; this SDK explicitly calls new CString(pointer), which
then throws. patch-launcher now preserves ptr arguments specifically in SDK
JSCallback signatures, leaving outbound FFI string signatures alone. The
regression now exercises CString decoding of dom-ready as well as 10,000 calls.

Added a macOS installer adapter to the shared orchestration: native Cocoa
splash/status/cancel helper compiled with Swift on the build Mac, embedded in
a standalone Treetop-Setup.app, distributed as a separate Setup.dmg. End users
need no Swift compiler. Default install target is ~/Applications/Treetop.app;
IPC and rollback copies live in ~/Applications/.treetop-installer, outside the
bundle. Both native host and daemon now enable installed-app handoff on macOS.
Process inventory is restricted to the exact installed bundle path. Windows
keeps WPF and its existing target/shortcuts. Linux is explicitly unsupported.
Mac packaging/helper cannot be compiled or launched on this Windows machine;
Mac end-to-end validation remains required. Apple reference for native progress:
https://developer.apple.com/documentation/appkit/nsprogressindicator/doublevalue

Session Stop's five-second UI abort was also reported under request congestion.
Removed that client-only deadline: it cannot undo a stop the server has already
accepted. Keep the session attached until a response, accept 404 as already
stopped, and surface server/transport failures. A real delayed HTTP test verifies
confirmation after 5.1 seconds; no production session was stopped in testing.
