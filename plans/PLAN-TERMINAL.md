# PLAN-TERMINAL.md — embedded terminals

**Status: in progress** (branch `feat/embedded-terminal`).

A feature-branch build that lets you interact with `claude` / `codex` /
`$SHELL` directly inside supergit, with a real cross-platform terminal
emulator — full TUI, colours, Ctrl+C, slash commands, permission prompts,
the works.

## The mental model

The session list in the dashboard becomes a list of **conversations**, each
in one of two states:

- **Dormant** — JSONL exists on disk, supergit isn't hosting a live process
  for it. (Most sessions you've ever opened.) Renders as the existing
  markdown-rendered read-only view.
- **Alive** — supergit owns a PTY running `claude --resume <sid>` (or
  similar) in the session's cwd. Renders as an `xterm.js` terminal panel
  attached to that PTY.

"Live" means *supergit is hosting the PTY.* A session you're running in
iTerm right now, outside supergit, is still dormant from our view — we
can't see other people's PTYs. (We could later flag "recently-modified
JSONL" as "active elsewhere" with an orange dot, but that's a nice-to-have.)

### The Resume button

The header of each session column gets a **Resume in terminal** button. Its
behaviour depends on session state:

- **Dormant** → spawn a new PTY via the daemon: `claude --resume <sid>` in
  the session's cwd, registered in the in-memory terminals map. The column
  flips from the read-only renderer to the terminal panel. Session becomes
  **alive**.
- **Alive** → no spawn. The UI just opens a WebSocket to the existing
  PTY's I/O endpoint and replays recent scrollback. Same machinery for
  page reload, second browser tab, or clicking Resume on an already-live
  session.

### Closing a terminal disposes it

There is exactly one close action: `×`. Clicking it sends SIGTERM, waits
500ms, sends SIGKILL if still alive, and removes the entry from the
terminals map. The session flips back to **dormant**. The JSONL on disk
keeps whatever the agent wrote.

We **don't** offer a "detach but keep running" option, deliberately. The
risk of dangling claude/codex processes the user can't see is worse than
the convenience of background-keepalive. If you want to keep a long-running
agent in the background, run it in your own terminal — supergit's job is
not to manage daemons.

The reload behaviour follows from "close = dispose": when a UI's
WebSocket to a terminal closes, the daemon starts a short grace timer
(~3s). If no new WS attaches before the timer fires, the PTY is
disposed. Browser reload reconnects within that window and the session
stays alive; outright closing the panel (or the tab) lets the timer
fire and the PTY dies cleanly. Multiple browser tabs are fine — the
PTY only dies when the *last* subscriber drops and the grace passes.

### Why this design is the right one

- Read mode stays the default — it's the right experience for skimming
  many sessions across many worktrees. Markdown, icons, fast.
- Terminal mode is the *interactive driver* — one click away when you need
  it, invisible otherwise.
- No duplicate views. Each column is in exactly one mode at a time.
- The existing chat-input composer (a fire-and-forget `claude -p`) can
  stay as a "quick reply without firing up a full TUI" affordance, or be
  retired once Resume feels good. Decide after we use it.

This document is a plan, not a spec. Open questions are called out. Adjust
as we build.

---

## Goals

1. Open a new terminal from a worktree row. It spawns a PTY in the worktree's
   path with a configurable command (default: `$SHELL`; quick-launch buttons
   for `claude`, `claude --continue`, `codex`).
2. **Multiple terminals per worktree, side-by-side**, mirroring the existing
   sessions strip (drag-to-reorder, horizontal scroll when over).
3. **Survive page reload.** A terminal's lifetime is bound to the daemon
   process, not to the websocket. Reload the UI → it rebinds to the same
   PTY and sees a scrollback replay of recent output. (Survival across
   *daemon restart* is explicitly out of scope for v0 — see "Daemon
   lifecycle" below for why.)
4. **Two distinct affordances per terminal window:**
   - `×` (close window) — detaches the UI but the PTY keeps running in
     the daemon, so a UI reload picks it up again.
   - `🗑️` (dispose) — sends SIGTERM, waits, sends SIGKILL, removes from
     the store. Explicit "I'm done with this terminal".
5. **No data loss on UI reconnect.** A reconnecting UI sees a scrollback
   replay of recent output (last N KB) so the conversation context is
   visible without scrolling into stdout-from-before-the-reload territory.
6. **Natural-exit paths just work.** Four ways a terminal can end, all
   handled the same way (see "Exit handling" below):
   - User clicks `🗑️` dispose.
   - User presses Ctrl+C inside the terminal (sends `\x03` → SIGINT to the
     foreground process).
   - User types `exit` and hits Enter (the PTY's process tree ends).
   - Process crashes / killed externally (caught by the sweep).
7. **Cross-platform from day one.** macOS, Linux, Windows all work via
   `node-pty` (forkpty on Unix, ConPTY on Windows).

## Non-goals (v0 of this feature)

- Split panes / tmux-style layouts inside one column.
- Terminal sharing between users (this is single-user supergit).
- Recording or replay export.
- Custom themes, font picker, color presets.
- Integrated input completions or AI-assistance overlay.
- Mobile / touch support for terminals.

---

## Daemon lifecycle (the "survival across daemon restart" question)

Earlier drafts of this plan obsessed over making PTYs survive when the
daemon dies, via `setsid`+sockets or a tmux multiplexer. We're explicitly
**not doing that in v0**. Reasoning:

- In production, the daemon starts when supergit launches and runs until
  the user quits or it crashes. Restarts are rare events where losing the
  live terminal is acceptable (the agent's persisted JSONL is fine; the
  user can `claude --resume <sid>` to pick up the conversation).
- In dev, the high-restart-frequency case used to be `bun --hot` reloading
  the daemon on every save. **We're removing `--hot` from the daemon**
  (see `dev.ts`). The daemon process becomes stable across UI iteration;
  Svelte HMR still works for UI changes. Daemon code changes much less
  often than UI code, and when they happen we restart deliberately.
- An in-app **"Reload daemon"** button gives the user explicit control
  over when running terminals get terminated. No more "I just saved a CSS
  file and my overnight agent died."

This means we can use a single backend everywhere — plain `node-pty`.
The `PtyBackend` interface still exists so a future `TmuxBackend` (for
"please, real survival") can drop in without touching anything above:

```ts
interface PtyBackend {
  spawn(opts: { cwd: string; cmd: string[]; size: { rows: number; cols: number } }): Promise<TerminalHandle>;
  list(): Promise<TerminalRecord[]>;
  kill(id: string, signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
}
```

Notably absent compared to earlier drafts: `attach(id)` for resurrecting
across daemon-process boundaries. The in-memory `manager` map is enough
because the manager and the PTYs share a process lifetime.

### Why node-pty

`node-pty` wraps the OS pseudo-terminal primitives — `forkpty(3)` on
Unix, `ConPTY` on Windows (Win10 1809+). Same library VS Code,
Hyper, etc. use. Cross-platform from day one, no shell-out to tmux, no
external dep. The one watch-out is that node-pty has a native compile
step; if it doesn't build cleanly under Bun we fall back to a tiny Rust
or Go PTY broker subprocess. We'll find out in Phase 1.

### "Reload daemon" button

A header-bar affordance in the UI. Clicking it:

1. POSTs `/api/admin/restart`.
2. Daemon broadcasts an `exit` frame on every active terminal WS with
   `{ reason: "daemon-restart" }`.
3. Daemon sends SIGTERM to every managed PTY, waits ~500ms, sends SIGKILL,
   then `process.exit(0)`.
4. `dev.ts` (or the production launcher) respawns the daemon.
5. UI auto-reconnects to the new daemon, sees an empty terminals list,
   shows the prior terminals as "ghost rows" with **Reopen** buttons
   (re-spawn fresh with the same `cmd[]`).

This is a deliberate, user-initiated action — not a thing that happens
silently on save.

---

## Architecture

### Daemon side

```
packages/daemon/src/terminals/
  ├── types.ts              # TerminalRecord, PtyBackend interface
  ├── node-pty-backend.ts   # node-pty implementation (the v0 backend)
  ├── manager.ts            # singleton: lifecycle, replay buffer, process metrics
  ├── ws.ts                 # WebSocket handler
  └── procs.ts              # listProcesses() — pids + cpu/mem for the procs popover
```

#### In-memory state

The manager keeps a `Map<id, ManagedTerminal>` for everything spawned in
the current daemon process. There's no `terminals.json` and no on-disk
PID tracking, because terminals don't outlive the daemon — survival is
explicitly out of scope (see "Daemon lifecycle" above).

`ManagedTerminal` carries:
- `id`, `pid`, `cmd[]`, `agent`, `cwd`, `size`
- `createdAt`
- ring-buffer of recent output (~256KB cap)
- the `node-pty` instance handle
- list of attached WebSockets (broadcast target for live output)

#### Replay buffer

Per terminal: a ring buffer of the last ~256KB of output (configurable),
held in memory. When a WS client connects to an existing terminal, the
buffer is sent first as a single `replay` frame, then live output streams
incrementally. This is what makes "reload the page and pick up where you
were" feel instant — the user sees the agent's recent output without
having to scroll-into-the-void.

#### HTTP routes

```
POST /api/terminals
  body: { worktreeId, cmd[], cols, rows }
  → { id, pid }

GET  /api/terminals?worktreeId=...
  → list of TerminalRecords (alive + recently-exited held for ~5min)

POST /api/terminals/:id/resize
  body: { cols, rows }
  → 204

DELETE /api/terminals/:id
  query: ?force=true to skip SIGTERM and go straight to SIGKILL
  → 204

GET  /api/processes
  → [{ id, pid, cmd[], agent, cwd, createdAt, cpuPercent, memBytes }]
  list of *all* PTYs the daemon currently owns, across all worktrees,
  with live cpu/mem samples. Feeds the procs popover (see UI side).

POST /api/admin/restart
  → 202 (daemon SIGKILLs its terminals, exits; dev.ts or launcher
  respawns it)
```

#### WebSocket

```
ws://localhost:7777/api/terminals/:id/io
```

Binary frames in both directions. From client: keystrokes (raw bytes).
From server: the initial `replay` frame, then output bytes as they arrive.
Resize is HTTP, not WS, so it's idempotent and easy to test.

Heartbeat: ping/pong every 30s; on missed pong the server closes the WS
but **does not kill the PTY**.

### UI side

```
packages/ui/src/terminals/
  ├── TerminalView.svelte      # one xterm.js instance + WS lifecycle
  ├── TerminalStrip.svelte     # horizontal strip mirroring the sessions strip
  ├── ProcessesPopover.svelte  # global popover showing every PTY the daemon owns
  ├── terminalsStore.ts        # open-terminal IDs per worktree, persisted via KVStore
  └── api.ts                   # thin wrapper around the daemon HTTP/WS
```

`TerminalStrip` reuses the same drag-to-reorder pattern and CSS sizing as
`sessions-strip` so the visual rhythm is consistent.

Each `TerminalView` header has:
- title (the command + agent badge if recognised)
- `×` close button (closes WS + removes from the local open list; PTY
  stays alive in the daemon)
- `🗑️` dispose button (confirm dialog → `DELETE /api/terminals/:id` →
  PTY killed and record deleted)

xterm.js gets its own dep entry. We DO NOT bundle a server-side terminal
emulator; the daemon just shovels bytes. Color, prompt, alt-screen are
all xterm.js's job.

### Processes popover (next to "Actions")

A global "Processes" button in the header (next to the existing Actions
button) opens a popover listing **every PTY the daemon currently owns**,
across all worktrees. Useful when:
- You closed a terminal window but left the PTY running and want to find
  it again.
- A runaway process is using CPU and you want to kill it directly.
- You're about to "Reload daemon" and want to see what's going to die.

Each row shows:
- agent icon (claude / codex / shell) + command (`claude --continue`,
  `/bin/zsh`, …)
- worktree the PTY belongs to (clickable — jumps to that worktree)
- uptime (relative, e.g. "12m active")
- live cpu % + memory (sampled every 2s while popover is open)
- `×` button → `DELETE /api/terminals/:id` (with confirm)

Implementation notes:
- Popover polls `GET /api/processes` every 2s while open; closes the
  poll loop on close to keep idle cost zero.
- `/api/processes` collects cpu/mem by reading `/proc/<pid>/stat` on
  Linux, calling `ps -o pid,pcpu,rss,etime -p <pid>` on macOS (cheap
  enough for our handful of PTYs), and via `wmic`/`Get-Process` on
  Windows. Wrapped in a small `procs.ts` helper so platforms are
  swappable. We do not pull in `pidusage` or `systeminformation` as
  dependencies for v0 — shelling out is fine for ≤20 PTYs.
- The popover lives at the dashboard scope, not per-worktree, on
  purpose: it's the "global view of everything supergit is running."

### Exit handling

A terminal can end via four paths:

1. **User clicks `🗑️` dispose.** Daemon sends SIGTERM (5s grace), then
   SIGKILL, marks record `exited`, broadcasts an `exit` frame on the WS.
2. **User presses Ctrl+C (or any other interrupt sequence).** xterm.js
   sends raw bytes (`\x03`) over the WS; the PTY translates them to
   SIGINT for the foreground process. The PTY itself stays alive unless
   what it was running decides to terminate. (For `claude` this cancels
   the current request; for `$SHELL` it interrupts the current command.
   Same behavior as a real terminal.)
3. **User types `exit` (or the agent quits).** The PTY's process tree
   terminates naturally, the kernel closes the master fd, our backend's
   read loop returns EOF, manager records `exited`, broadcasts `exit`
   on the WS.
4. **Process crashed / killed externally.** A periodic `kill -0 pid`
   sweep (every 5s) detects the death even if we missed the EOF, and
   reconciles `terminals.json`.

In all cases the UI receives an `exit` frame with `{ code, signal }` and
flips the view into an "exited" state: the buffer remains visible
(scrollable, copyable), the input is disabled, and the header offers
**Reopen** (spawn fresh with same `cmd[]`) or **Remove** (delete the
record).

### Reconnect protocol (UI reload only — not daemon restart)

UI boot sequence for a worktree row:

1. Read `terminalsStore[wtId]` from localStorage — list of terminal IDs
   we *expect* to be there, plus the `cmd[]` we used to spawn each.
2. `GET /api/terminals?worktreeId=<wtId>` — what's actually alive.
3. **Intersection** is rendered as open. **Expected-but-gone** is shown
   as a "ghost" row with a **Reopen** button that respawns the same
   `cmd[]` (this is what the user sees after a daemon restart).
4. **Alive-but-not-expected** is also rendered (e.g. another browser
   tab opened it, or this UI just had a hard reload).

For each rendered terminal: open WS, receive `replay`, then live.

---

## Phasing

### Phase 0 — feature branch + scaffolding (half day)

- Branch `feat/terminal` off main.
- Empty `packages/daemon/src/terminals/` + types + a `PtyBackend`
  interface stub.
- Drop `--hot` from the daemon in `dev.ts` (done — committed alongside
  this plan so the dev-loop assumption is in place before any terminal
  code lands).
- No UI yet.

### Phase 1 — node-pty backend, daemon only (1–2 days)

- Add `node-pty` as a daemon dep.
- Implement spawn + kill + write + onData against a real PTY.
- Build the in-memory `ManagedTerminal` map + replay ring buffer.
- Periodic `kill -0 pid` sweep to detect external death.
- If node-pty doesn't compile cleanly under Bun, fall back plan: 200-line
  Rust/Go PTY broker we spawn as a subprocess. Daemon stays Bun-only.

### Phase 2 — HTTP + WS endpoints (half day)

- POST/GET/DELETE/resize routes + integration tests that exercise the
  same payload contracts the UI will use (matches the daemon test
  style from CLAUDE.md).
- WS handler with replay-frame-first protocol.
- `POST /api/admin/restart` (SIGKILL all, `process.exit(0)`).
- `GET /api/processes` + `procs.ts` (per-platform cpu/mem sampler).

### Phase 3 — UI integration (1–2 days)

- xterm.js dep, `TerminalView` wired to WS.
- `TerminalStrip` slotted into the worktree row, alongside the sessions
  strip but visually distinct (different chip color, "TTY" badge).
- Close-vs-dispose buttons with confirm.
- Storage for expected-terminals + reconnect-on-reload (UI reload, not
  daemon restart).
- Header **Reload daemon** button → confirm → POST `/api/admin/restart`.
- **Processes popover** next to Actions; 2s polling while open; per-row
  cpu/mem; per-row `×` for kill.

### Phase 4 — polish (open-ended)

- Quick-launch buttons (`claude`, `claude --continue`, `codex`,
  `$SHELL`).
- Indicator when a background terminal has new output the user hasn't
  looked at (a dot on the closed terminal's reopen affordance).
- Slim custom scrollbar styling carried into xterm.js as well.

---

## TDD plan

Following CLAUDE.md, every block ships with tests first:

- `nodePtyBackend.test.ts` —
  - spawns `bash -c "echo hello; sleep 0.1"`, asserts replay buffer
    contains "hello".
  - spawns an interactive `cat`, writes bytes in, reads them back from
    the WS broadcast.
  - kill(SIGTERM) gracefully exits a `bash -c "trap exit TERM; sleep
    300"`.
  - external-death detection: `bash -c "exit 7"`, sweep should mark the
    record as `exited` with `{ code: 7 }`.
- `replayBuffer.test.ts` — ring eviction at the cap, replay returns the
  tail, no truncation mid-escape-sequence (this matters for ansi colors).
- `terminalRoutes.test.ts` — POST then GET shows the record, DELETE then
  GET shows it gone. WS replay frame arrives before any live frame.
- `procs.test.ts` — `listProcesses()` against a real `sleep 60` child
  returns sensible pcpu/rss; gracefully returns zeros if the platform
  helper is missing.
- `terminalsStore.test.ts` (UI side) — KVStore-injected, persists across
  reload, ghost-row behavior for missing terminals.

Tests run as part of `bun test`. We do NOT mock the PTY in the backend
tests — we exec a real `bash -c '...'`, just like the rest of the daemon
suite uses real git.

---

## Reload survives the live agent session (implemented)

A brand-new agent TUI (`__new__:claude:<id>` / `__new__:codex:<id>`)
that's been alive long enough for its JSONL header to land on disk
survives a hard page reload as a `--resume <real-sid>` spawn rather
than a fresh PTY. Mechanism:

- The activity-SSE handler in `App.svelte` stamps the real agent-side
  session id onto the matching `__new__:` `OpenSession` via
  `stampDiscoveredSessionId` (see `storage.ts`). Match key: `(cwd, agent)`.
- `PersistedSession` carries an optional `resumeSessionId` through
  `OpenSessionsStore`, so the stamp survives a reload.
- The transient-column render branch builds the cmd via
  `cmdForOpenSession(s, defaultShell)`: bare `claude` / `codex` when no
  sid has been discovered yet, `claude --resume <sid>
  --allow-dangerously-skip-permissions` / `codex resume <sid>` once it has.

Spec lives in `packages/ui/test/storage.test.ts` (`cmdForOpenSession`,
`stampDiscoveredSessionId`, `OpenSessionsStore + resumeSessionId
round-trip`, and the end-to-end `reload-resume round-trip` suite).

Still-open follow-up:
- **Reattach before resume.** If the daemon's PTY-grace window hasn't
  fired, prefer reattaching to the live PTY (the `attachTermId` path
  used by shells) over a fresh `--resume`. Needs an `ownerId`-keyed
  lookup the agent-column render branch can hit on remount. `GRACE_MS`
  was already widened to 30s (see `server.ts`) so a hard reload almost
  always lands inside the grace window — making this fix even more
  impactful than the resume path it falls back to.

## Open questions

1. **node-pty under Bun:** does the prebuilt binary load cleanly on macOS
   ARM with Bun's Node-API shim? If not, we pin a Bun version, write
   a small PTY broker subprocess, or postpone Windows and use a
   pure-Bun forkpty wrapper on Unix.
2. **macOS launchd / GUI-launch PATH:** if the user launches supergit
   via double-click rather than a shell, the spawned PTY may inherit a
   minimal `PATH`. Probably needs an explicit env merge from the user's
   `~/.zshrc` — punt to a follow-up phase.
3. **Output indicator:** if a closed terminal produces output, do we show
   a count? A dot? A glow? UX call we'll make once it's wired up.
4. **Resize semantics:** if two browser tabs are connected to the same
   terminal at different sizes, who wins? Cheap answer: last-write-wins.
   Better answer: track per-WS size and use the min. Decide after we
   have something to look at.

## Risks & mitigations

- **Native module pain.** If node-pty doesn't build cleanly under Bun,
  fall back to a small PTY broker subprocess (Rust or Go). Daemon stays
  Bun-only either way.
- **Daemon restart kills active work.** Real cost; mitigated by (a) not
  running `--hot`, so daemon restarts only happen on deliberate Reload,
  and (b) Claude/Codex sessions are recoverable via `--resume` from the
  agent's own JSONL on disk.
- **Storage bloat from replay buffers.** Buffers are in-memory only and
  capped per terminal; nothing on disk.
- **Security:** terminals run arbitrary user commands; we accept this
  (it's a local dashboard, not multi-tenant). CORS stays locked to
  `localhost:7779`. The WS endpoint validates terminal IDs against the
  in-memory manager before bridging bytes.
