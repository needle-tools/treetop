# supergit — plan (dashboard pillar)

Rough concept notes, not a spec. Captures the brainstorm so far. Conventions: "we"
means "us deciding what to build"; honest tradeoffs are called out inline; nothing
here is locked in.

**This plan covers the dashboard + workflow pillar only.** The 3D / binary
handling pillar lives in its own plan: [PLAN-3D.md](./PLAN-3D.md). They share
the daemon and the UI shell but ship independently — either can land and be
useful without the other.

## What this is, in one line
The git client for people working on twenty things at once — many repos, many
branches, many agents — who need a real overview and proper git insight in
one place.

## Decisions so far
- **v0 scope: A** — local-only daemon + web dashboard, dashboard pillar only.
  The thing the author would use daily, immediately. Ships in weeks, not
  months. No 3D anything in v0 here — that's the other plan and starts
  whenever.
- **The supergit workspace IS a git repo.** Single-member from v0; invitable
  / multi-user from v2. We get sync, history, and team collaboration for
  free with no backend infrastructure. See
  [Shared supergit workspace](#shared-supergit-workspace).
- **TDD discipline from day one.** Because AI agents will write most of the
  code, every block has an executable spec before it ships. See
  [DEVELOPMENT.md](./DEVELOPMENT.md).
- **Editor-agnostic.** Detect installed editors (Fork's pattern) and shell
  out. No fork of any editor, no heavy extension.
- **Two pillars, one daemon, one UI shell.** Dashboard and binary work share
  infrastructure but ship independently.

## Contents
- [Vision](#vision) — what supergit is for, who it's for.
- [Architecture](#architecture) — local daemon, thin clients (web first), stack pick.
- [Agent dashboard](#agent-dashboard) — the killer screen, and how it detects which agent is in which worktree.
- [Git scope](#git-scope) — the 80% loop we cover; the 20% we punt to Fork via "Open in Fork".
- [Reminders & event log](#reminders--event-log) — durable event stream + nudges so nothing falls through the cracks (the "forgets to push" colleague fix).
- [Shared supergit workspace](#shared-supergit-workspace) — the workspace is itself a git repo with a derived SQLite cache; single-user v0, invitable / multi-user v2.
- [Views, annotations & multi-user state](#views-annotations--multi-user-state) — node-graph workflow view, user-authored notes. v2+.
- [Needle Cloud plays](#needle-cloud-plays) — presence relay and team mode. (CAS backend and preview render plays live in PLAN-3D.md.)
- [Roadmap](#roadmap) — v0/v1/v2/v3 for this pillar.
- [Open questions](#open-questions) — things to settle before code.

---

## Vision

supergit is not a Fork replacement; it's an agent control panel that happens
to do git. Fork is repo-centric (one window per repo, branches as the unit) —
that model breaks the moment you run multiple AI agents across multiple repos
and multiple worktrees in parallel, which is the daily reality now.

The pieces exist scattered across tools today — VSCode windows for editing,
Claude sessions for prompting, Fork for git inspection, terminals for
worktree ops. Nothing ties them together for an AI-heavy workflow where
several agents work on parallel feature branches and you occasionally want
one to integrate another's work.

The concrete daily pains we're solving:
- "Which VSCode window had the Claude conversation about audio?" → the
  dashboard becomes the index of every active and recent session across all
  open workspaces.
- "I lost the session, I don't know where I left off." → every worktree row
  shows its last session with a one-click resume.
- "Fork has no worktrees." → worktrees are the primary unit of the UI.
- "I want claude #1 working on `feat/audio` and claude #2 on `fix/xr`, then
  later have one merge the other's branch in." → parallel worktrees + a
  cross-agent handoff action.

Audiences, in order:
- Solo and small-team devs running multiple agents across multiple repos.
  Early adopter pool; where the author lives.
- Anyone running AI agents in parallel (Cursor, Aider, Goose, etc.).
- Teams later, once the dashboard is loved.

What we are explicitly not competing with:
- Fork, GitKraken, Sourcetree on deep git ops (rebase UI, conflict resolver).
  Different category. "Open in Fork" is an escape hatch on every worktree
  card.
- GitHub / GitLab on code hosting. Different category — we talk to those as
  remotes.

The 3D / binary side is the other pillar, equally real but independent — see
[PLAN-3D.md](./PLAN-3D.md).

---

## Architecture

A **local daemon** owns all state and exposes a small HTTP+SSE API; **clients**
(web UI first, TUI and CLI later) are thin views over it. This is the structural
choice that makes "live across many repos and agents" feasible at all.

```
┌─────────────────────┐    ┌──────────────────────────────┐
│  supergit daemon    │◄───┤  Web UI  (localhost:7777)    │  ← primary
│  - process scan     │    └──────────────────────────────┘
│  - git ops          │    ┌──────────────────────────────┐
│  - worktree mgmt    │◄───┤  TUI  (ratatui / bubbletea)  │  ← later
│  - diff jobs        │    └──────────────────────────────┘
│  - SSE / WS fanout  │    ┌──────────────────────────────┐
│                     │◄───┤  CLI  (`supergit ls`, etc.)  │  ← scriptable
└─────────────────────┘    └──────────────────────────────┘
        ▲ optional sync
        ▼
   Needle Cloud (presence relay, team mode) — v2+
```

Stack lean:
- **Daemon**: Rust + `axum`. Single static binary, cross-compiles cleanly.
  Go + `chi` is the backup if hiring/iteration speed wins out over runtime cost.
- **Web UI**: Svelte + Vite SPA. No SSR — pure localhost client.
- **Transport**: SSE for daemon → client push (dashboard is one-way). REST for
  command actions. WebSocket reserved for interactive collab if/when needed.
- **State**: a supergit *workspace* — itself a git repo — containing
  registered repos, append-only event log, declared relationships, and
  (later) members. Daemon maintains a derived SQLite index for fast queries.
  JSON-lines log is the source of truth; SQLite is a rebuildable cache. See
  [Shared supergit workspace](#shared-supergit-workspace).
- **Distribution**: `brew install supergit` and equivalents on Linux/Windows.
  First run installs daemon as `launchd` / `systemd` user service and opens
  the browser. No Electron, no Tauri, no dock icon.

Process model: one daemon per user (not per repo). Repos are registered
explicitly via `supergit add <path>` with an optional `--auto-scan ~/git` for
greenfield setups.

**Why not a VSCode fork or a heavy extension.** Briefly considered, both
fail for the same reason. A VSCode fork (Cursor-style) is dozens of
engineer-years of upstream maintenance, locks the project to one editor, and
fights against the dashboard paradigm — VSCode is editor-centric, supergit
is cross-window-observer-centric. A pure VSCode extension hits the same wall
we're trying to escape: extensions live inside a single VSCode process, can't
see across the 3–5 workspaces a user has open simultaneously, and re-create
exactly the window-juggling problem the dashboard exists to fix. The
standalone-daemon shape is the only one that can sit *above* every editor
and observe N workspaces at once.

The **editor launch** side copies Fork's pattern: detect installed editors
(VSCode, Cursor, Rider, Neovim, IntelliJ, etc.) and offer "open in <editor>"
buttons on every worktree card via plain CLI shell-outs — `code <path>`,
`rider <path>`, `nvim <path>`. No extension needed for this; Fork already
proves it works cleanly and editor-agnostically.

A **thin VSCode extension** is only needed for the *reverse* flow — telling
the daemon which workspaces are *currently open* so the dashboard can show
"this worktree has a VSCode window alive." That's v1+, not v0. Scope strictly
reporter-only: window state + cwd + workspace name, nothing more. No agent UI,
no diff UI, no git UI inside the extension. Same applies to JetBrains /
Cursor / Neovim plugins later. supergit stays editor-agnostic.

---

## Agent dashboard

The home screen answers one question — *what is every agent doing across every
repo right now?* — and everything else is a drill-down from there.

```
┌─ supergit ─────────────────────────────────────────────────────┐
│ REPO         WORKTREE              BRANCH        AGENT    Δ     │
│ supergit     ~/git/supergit        main          —        ·     │
│ needle-eng   ~/wt/needle/audio     feat/audio    claude   2m    │
│ needle-eng   ~/wt/needle/xr-fix    fix/xr-input  claude   14m   │
│ marketing    ~/wt/mkt/landing-v3   feat/landing  cursor   1m    │
└────────────────────────────────────────────────────────────────┘
```

Detecting which agent is where, cheap to expensive:
1. **Process scan** — `ps` for known agent binaries (`claude`, `cursor-agent`,
   `aider`, `goose`), resolve each PID's cwd via `lsof`, match against known
   worktree paths. Refresh every few seconds.
2. **Session-file tail** — `~/.claude/projects/<encoded-path>/*.jsonl` already
   encodes cwd and recent tool calls. Mtimes give "active N min ago" for free;
   tailing gives a live "agent recent activity" panel.
3. **Opt-in heartbeat** — a Claude Code `Stop`/`PostToolUse` hook writes
   `.supergit/heartbeat` with timestamp + last tool. Most accurate, requires
   user setup. Bundle a one-liner installer. v1+.

Drill-down per worktree: status, text diff (binary diff is the other plan's
job, plugged in via `DiffProvider`), last ~10 commits, agent tail (last ~20
tool calls), action buttons (commit, push, open in Fork, kill agent, open in
editor).

**Session continuity** (the "where did I leave off?" fix): every worktree row
shows its most recent agent session — last active, tool-call count, files
touched, a one-line summary of the last action. Click to resume in that
worktree (`claude --continue` or per-agent equivalent). Across worktrees this
becomes a single index of every conversation you've had, sortable by recency
and searchable by content. No more juggling VSCode windows trying to remember
which one held the conversation you need.

**Cross-agent handoff** (v1): when agent A on `feat/audio` should pick up
agent B's work on `feat/xr`, supergit packages the context — B's branch diff,
recent commit messages, the last few session messages — and either drops it
into A's worktree as a primer prompt, or just stages the merge for A to
integrate manually. The git operation underneath is plain `merge` /
`cherry-pick` / `rebase`; the value is handing the right context to the
receiving agent so it doesn't have to re-derive what B was doing.
Human-in-the-loop by default, with an opt-in one-click "have A integrate B's
work" action.

Not in scope here: chatting with the agent, editing prompts, multi-step
orchestration. supergit observes and presents — it doesn't replace Claude
Code's UI.

---

## Git scope

We cover the 80% loop you hit dozens of times per day reviewing AI output, and
we punt the deep 20% to Fork via an "Open in Fork" button on every worktree
card. Trying to match Fork on rebase/merge/blame is years of polish we will
lose.

In scope (v0/v1):
- status (staged vs unstaged file lists)
- diff — *with a really good viewer*, because reviewing AI output is the main
  thing users do all day. Text-only in v0; format-aware viewers (glb, image,
  Blender, Unity) are added via `DiffProvider` plugins from the other plan
  ([PLAN-3D.md](./PLAN-3D.md)).
- commit / commit --amend
- push / pull / fetch
- branch create/switch/delete (local + remote)
- **worktree create/list/remove/prune** — first-class, the whole point.
- log (last ~50 commits, paginated; not a full graph)
- stash push/pop/list
- remote add/remove/set-url

Out of scope (probably forever): interactive rebase UI, merge conflict resolver
UI, submodules, blame, reflog browser, cherry-pick chooser, full branch graph
visualization.

For all of these: an "Open in Fork" button on every worktree card, plus an
"Open in terminal" / "Open in <detected editor>" set of escape hatches.
Don't compete, delegate.

Worktree convention: `~/git/<repo>` for main checkout, `~/wt/<repo>/<branch>`
for everything else. Flat-under-`~/wt` rather than `<repo>/.worktrees/` because
it's easier for the dashboard to scan, easier for the user to find, and plays
well with cross-repo. User can override the root in `~/.supergit/config.toml`.

The AI-review loop we optimize for: Claude finishes → supergit notices →
user opens diff view → one-click commit + push with co-author trailer
preserved → worktree auto-prunes after merge.

---

## Reminders & event log

A persistent **event log** captures everything the daemon observes — commits,
branch switches, pushes, agent activity, worktree create/remove — into a
durable append-only stream. On top of that, a small **reminder engine** runs
rules over the log + current repo state to surface "things you might forget"
in the dashboard. The motivating example is the colleague who regularly
forgets to push, but the same machinery covers idle worktrees, stale stashes,
unreviewed agent output, and branches that have been merged upstream but not
cleaned up locally.

**Event log** (infrastructure, ships in v0 as a side-effect of the daemon):
- Append-only JSON-lines at `<workspace>/events.jsonl` — the workspace is
  itself a git repo, see [Shared supergit workspace](#shared-supergit-workspace).
- Every event tagged with timestamp, repo, worktree, actor (user / agent /
  supergit itself).
- Daemon maintains a derived SQLite index (`state.sqlite`) for fast queries.
  The JSON log is the source of truth; SQLite is a rebuildable cache.
- Powers: the activity timeline, the reminder engine, cross-agent handoff
  context, and future audit/export.
- Cheap to add — the daemon already watches all this; persisting it is one
  more side effect. Independent of any reminder UI.

**Reminder rules** (v1):
- *Unpushed commits.* "3 commits ahead of origin/<branch> for >Xh."
- *Stale staged changes.* "Staged changes untouched for >Xh."
- *Idle worktree with work.* "Uncommitted changes and no activity for >Xd."
- *Old stash.* "Stash older than X days."
- *Agent output unreviewed.* "Claude finished N min ago, diff never opened."
- *Mergeable branch left behind.* "Branch merged upstream — delete the
  worktree?"

**Surface**:
- Dashboard row: a colored pill on the affected worktree + a top-level count.
- Browser tab title: `(N) supergit` when reminders are pending.
- OS notification (opt-in per rule): fires once when a rule first crosses
  its threshold; doesn't re-fire until snoozed or resolved.
- Status-bar widget in the VSCode reporter extension (v1+): pending count.

**Configuration**:
- `~/.supergit/reminders.toml` lists rules with per-rule thresholds.
- Per-repo overrides live in the repo's supergit config.
- Snooze a specific reminder for N hours/days; mute a rule entirely.

**Cross-machine / cross-agent (v2+, requires presence relay)**:
- "Your laptop has unpushed work on `feat/audio`" surfaces on your phone.
- Team mode (very opt-in): teammates can see "X has unpushed changes on
  shared branch Y for >24h." Pair/small-team workflow; not a default.

What we don't build:
- Slack / email integration in v1 — too noisy, too many edge cases.
- Predictive "you might forget to commit because…" — no ML, just rules.
- A rule scripting SDK in v1 — rules are hardcoded with thresholds. Defer
  exposing an SDK to v3 unless there's demand.

3D-pillar reminders (CAS usage, asset render failures, etc.) get their own
rules later — see PLAN-3D.md when it grows them.

---

## Shared supergit workspace

The biggest architectural choice in the plan: a **supergit workspace** is
itself a git repo. It aggregates many GitHub repos, can be shared with
others by invitation, and acts as the single source of truth for everything
supergit knows about your work. The workspace is the multi-user unit;
individual GitHub repos remain owned and hosted on GitHub (or wherever they
live).

Single-member at v0, invitable / multi-user at v2 — same architecture
throughout. The workspace concept costs little to add in v0 and saves a
painful refactor later.

What lives in a workspace repo:
- `config.toml` — workspace name, members (git identities), defaults.
- `repos.json` — registered repos with their remotes
  (e.g., `git@github.com:foo/bar.git`), worktree roots, per-repo settings.
- `relationships.json` — declared connections between repos
  (*"`needle-app` depends on `needle-engine`"*, *"`marketing` deploys
  alongside `landing`"*). Shown as edges in the node-graph view.
- `events.jsonl` — append-only event log (system events + user-authored
  annotations).
- `presence/<user>.json` — one short file per user, updated periodically by
  their daemon ("marcel was active on `feat/audio` 2m ago"). One file per
  user keeps merges trivial.
- `state.sqlite` — *derived* cache rebuilt from the event log for fast
  queries. `.gitignored` by default; the log is the source of truth.

How sync works:
- Daemon `git pull`s the workspace periodically (or watches via FS if
  local), then rebuilds its SQLite cache from new events.
- Daemon `git push`es its own events and presence updates as they happen
  (batchable).
- Conflict resolution: events are append-only and timestamped, so merges
  are usually trivial. A small structured merge driver handles the rare
  collisions.
- Hosting: any git remote — GitHub private repo, self-host, Needle Cloud,
  S3-backed git. Workspace is portable.

Inviting collaborators (v2):
1. Add their git identity to `members` in `config.toml`.
2. Push to the shared remote.
3. They clone the workspace, point their daemon at it, and instantly see
   the shared dashboard with everyone's presence, annotations, and the
   declared cross-repo relationships.

Why JSON-lines + derived SQLite (not a binary SQLite committed directly):
- Git merges JSON lines cleanly; merging binary SQLite is a nightmare.
- JSON is human-readable for debugging and recovery.
- SQLite is an *index*, regenerable. Anyone can blow it away and rebuild.
- Optional: snapshot the SQLite to an LFS-tracked file periodically for
  fast first-clone. Default off; turn on for huge workspaces.

The CAS chunks (binary blobs from PLAN-3D.md) do **not** live in the
workspace. CAS lives at `~/.supergit/objects/` with optional cloud
backends. The workspace is metadata only — small, text, mergeable.

How this changes earlier plan items:
- The "git-tracked state" idea in the next section is subsumed by the
  workspace itself.
- The "Agent presence relay" Needle Cloud play becomes optional: workspace
  sync via git already moves presence around. The cloud relay just adds
  real-time push (vs periodic pull) when low latency matters.
- Repo registration becomes "add this GitHub repo to the workspace"
  instead of "add this path to my local supergit."

Out of scope for v0:
- Invitation / membership UI. Manual config edits at v1; UI at v2.
- Federated workspaces (workspace-of-workspaces). Single-level only.
- Real-time push via cloud relay. Workspace-only sync is push/pull-based;
  cloud relay is the optional v2+ upgrade.

---

## Views, annotations & multi-user state

Three ideas worth capturing while they're fresh. All v2+ — none are prerequisites
for the daily-driver MVP. Calling them out together because they share a
substrate (the event log) and a philosophy (build collaboration into the tool
without requiring a backend).

**Node-graph workflow view** (alternative to the list dashboard).
The list answers "what's running right now?" A node-graph answers a different
question — "how do my parallel branches and agent handoffs relate?" Nodes for
worktrees / branches / agents; edges for "branched from", "merged into",
"agent works on", "agent A handed off to B". Same daemon data, different
shape. Probably a *toggle* between list and graph rather than a replacement.
Natural fit for someone who already lives in node-graph tools (Needle,
Blender shader editors, comp software).

**Annotations** (user-authored notes on git objects, worktrees, or sessions).
- "Note on `feat/audio`: claude #2 is waiting on the XR fix before merging."
- "Sticky on commit abc123: needs WebXR re-test before push."
- "TODO on this worktree: ask Felix about the material setup."

Implementation-wise these are just user-authored events on the event log,
discriminated by `actor: user`. Same storage, same query path, same
notification surface — they show up as pills in the dashboard like reminders.

The single-user, file-backed companion to this — markdown notes with
rich anchors (file:line, folder, commit, session) and a floating-overlay
UI — is sketched separately under
[Notes with anchors + floating overlay](#notes-with-anchors--floating-overlay)
in the UX ideation section. The shared-multi-user surface above collapses
to events on the log; the single-user surface below collapses to files in
the workspace. They co-exist.

**Multi-user sync (subsumed by the workspace).**
The original "git-tracked state" idea — peer-to-peer dashboard state
without a backend — collapsed into the workspace concept above. The
workspace *is* a git repo, so sync is just `git pull` / `git push` of the
workspace. See [Shared supergit workspace](#shared-supergit-workspace) for
the full design.

Open call on timeline for the rest — none of these are committed beyond
"interesting if v1 lands well." Captured here so the design space is on
record.

---

## Needle Cloud plays

Two cloud plays apply to this pillar; the CAS backend and cloud-side preview
render plays for binary assets live in [PLAN-3D.md](./PLAN-3D.md).

1. **Agent presence relay**. Agents run in multiple places (laptop, desktop,
   cloud VM). Each daemon publishes presence metadata to Needle Cloud → the
   dashboard sees every agent everywhere, from any device including phone.
   Privacy: only metadata syncs, never code or diffs unless opted in.
2. **Team-mode dashboard** (later, B2B). The presence relay extended to a
   team: "the whole studio's agent fleet, live." Paid tier on Needle Cloud.

Guardrails (apply to both pillars' cloud plays):
- **Pluggable, never required.** Corp/privacy users walk if cloud is mandatory.
- **Don't fork git's protocol.** Live as a layer on top — remotes stay
  GitHub / GitLab / whatever.
- **Don't compete with GitHub on code hosting.** Compete where they're
  weak (multi-agent overview) or absent (3D-side, in the other plan).

---

## Roadmap

Concrete tiering for the dashboard pillar. The binary pillar has its own
roadmap in PLAN-3D.md and the two ship in parallel without blocking each
other.

**v0 — local agent dashboard (the daily-driver MVP)**
- Workspace init (`supergit init workspace`) — workspace is a git repo
  containing registered repos, event log, relationships. Single-member.
- Daemon + web UI, SSE updates, single binary.
- Derived SQLite cache rebuilt from the workspace event log.
- Repo registration ("add this GitHub repo to the workspace"), worktree
  list, agent detection (process + session files).
- Session list per worktree with one-click resume (`claude --continue`).
- Status, text diff, commit, push, pull, branch, worktree create/remove.
- Append-only event log inside the workspace.
- "Open in Fork" / "Open in editor (detected)" / "Open in terminal" escape
  hatches via plain CLI shell-outs.
- Full TDD harness from day one — every block has tests before it ships.
  See [DEVELOPMENT.md](./DEVELOPMENT.md).

**v1 — making the dashboard feel inevitable**
- Spawn-worktree-and-launch-agent action.
- Cross-agent handoff (package one agent's work as context for another).
- Reminder engine: unpushed commits, idle worktrees, stale stashes,
  unreviewed agent output. Dashboard pills + opt-in OS notifications.
- Heartbeat hook + installer.
- Thin VSCode reporter extension (which workspaces are open right now).
- **Auto-fetch all registered repos on a timer.** **Shipped.** Runs
  every 5min (overridable via `SUPERGIT_FETCH_INTERVAL_MS`; set to `0`
  to disable). Non-overlapping cycle, swallows individual repo
  failures, broadcasts `change` so the UI re-pulls ahead/behind. See
  `runFetchCycle` in `packages/daemon/src/server.ts`.
- **Notes with anchors (single-user, file-backed).** Markdown notes in
  `<workspace>/notes/*.md` with frontmatter anchors (file:line, folder,
  commit, session). Surfaced first as a row-foldout subtab; the
  floating-overlay UI is a follow-up sub-phase. Full design under
  [Notes with anchors + floating overlay](#notes-with-anchors--floating-overlay).
- **v1.1 — Live agent activity** (Claude + Codex). **Shipped.** Each
  session's JSONL is tailed with a file watcher, the translation layer
  (`sessions.ts`) normalises Claude's and Codex's wildly different
  shapes into one `NormalizedMessage` stream, and the UI renders it as
  a chat panel below the worktree with markdown + per-agent brand
  colour + auto-scroll + live refresh via 2-second polling. Read-only;
  safe regardless of how the session was launched. Copilot deferred —
  its storage isn't tail-friendly.

- **v1.2 — Managed-spawn for Claude + Codex (read + WRITE).**
  **Shipped.** The daemon spawns `claude` / `codex` (and plain
  `$SHELL`) PTYs via a long-lived Node helper
  (`packages/daemon/src/terminals/helper.mjs` using `node-pty`,
  because Bun's PTY support is still experimental); the dashboard
  renders the live stream in **xterm.js** terminal columns inside each
  worktree row, and keystrokes flow back to the PTY's stdin. So the
  dashboard *is* the running session. External sessions (started
  outside supergit) remain observe-only via the v1.1 tail. macOS +
  Linux confirmed; Windows untested.

  Layout decision settled in favour of **inline columns**: each
  worktree row hosts its own horizontal strip of terminal / agent
  columns, swappable and reorderable. The "open everywhere in one
  dock at the bottom" idea was discarded — inline keeps the
  "this row IS its session" affordance the dashboard hinges on.

  Adjacent pieces also shipped: workspace-side persistence of
  Terminal columns + reattach after a UI reload, live cwd surfaced
  via `lsof`, and command-history capture (every Enter-terminated
  line appended to the shell's JSONL with cwd at the moment of
  Enter). See commits in the `ccf5200..01b6fac` range.

**v2 — second skins, multi-user, presence**
- TUI client (second skin on the same daemon API).
- Multi-user workspace: invite collaborators via member list; presence
  files per user; shared annotations.
- Cross-repo relationships (declared edges in `relationships.json`,
  visible in the dashboard and the node-graph view).
- Annotations (user-authored notes on worktrees, commits, sessions).
- Agent presence relay (cloud sync, real-time on top of git-based
  workspace sync).

**v3 — team mode + extensibility**
- Team-mode dashboard on Needle Cloud (multi-user fleet view).
- Node-graph workflow view (toggle alternative to the list dashboard).
- JetBrains / Cursor / Neovim reporter plugins.
- **Extension / plugin API.** Community-contributed extensions for
  `DiffProvider`, reminder rules, dashboard panels, slash-commands. In
  the limit: agents writing their own supergit extensions to fit their
  workflow. Designed *after* the natural extension points (DiffProvider,
  reminder rules, presence relay) have stabilized through real use.

**Never ship** (saying it out loud to keep us honest):
- Our own interactive rebase UI. Use Fork or the terminal.
- A Fork-style branch graph visualization.
- A merge-conflict resolver UI for text. Use the editor's.

---

## Open questions

Dashboard-pillar questions only. CAS / chunking / binary-specific questions
live in PLAN-3D.md.

1. **Daemon stack pick.** v0 ships in **Bun + TypeScript** (chosen for
   iteration speed and stack coherence with the Svelte UI — workload is
   I/O bound, so the native-speed argument doesn't bite yet). For v1,
   reconsider with real measurements: Go gives native speed + true
   concurrency; Rust gives ultimate perf + smallest binary. The likely
   answer is **"keep Bun for the daemon glue, drop to Rust/Go for the CAS
   chunking hot path via FFI"** rather than a full rewrite — but only
   commit once measurements demand it. Premature rewrites are YAGNI.
2. **Auto-discover repos vs explicit `add`.** Explicit is safer, auto-scan is
   friendlier. Probably ship explicit + offer `--auto-scan ~/git` on first run.
3. **Single binary with subcommands vs separate daemon/CLI binaries.** Single
   binary is simpler — `supergit daemon` / `supergit ls` / `supergit add`.
4. **API auth.** Token in `~/.supergit/token` sent as header, cheap protection
   against other localhost processes.
5. **Worktree root default.** `~/wt/<repo>/<branch>` is the lean. Configurable.
6. **Daemon-launches-agents or observe-only?** v0 observe-only. v1 may add
   launch — but launch implies process supervision (restart-on-crash? logs?)
   and the scope expands fast.
7. **Cross-agent handoff: human-in-loop or one-click?** Likely "prepare by
   default, opt-in one-click trigger."
8. **VSCode extension scope: how thin is thin?** Reporter-only feels right.
   Anything more risks re-introducing per-window blindness.
9. **Reminder defaults.** What thresholds out of the box? Tentative: 4h for
   unpushed commits, 2h for stale staged changes, 24h for idle worktrees,
   7d for old stashes. All overridable per repo. Tighter defaults feel
   nagging; looser defaults defeat the point.
10. **OS notifications: one-shot or recurring?** First-cross-threshold
    one-shot is less annoying; recurring ("still haven't pushed!") is more
    effective for the actual forgetter. Default one-shot, recurring as
    opt-in per rule.
11. **Annotations as event-log entries or separate storage?** Treating
    annotations as user-authored events (`actor: user`) on the same log
    keeps queries and notifications unified; separate storage makes
    structured editing easier. Lean toward one log with a discriminator.
12. **Git-tracked state: which ref strategy?** Subsumed by the workspace
    concept — state lives in the workspace repo, not as a special ref on
    user repos. See [Shared supergit workspace](#shared-supergit-workspace).
13. **Workspace location default.** `~/supergit/workspaces/<name>/` so the
    user can `cd` to it and treat it like any other repo, or
    `~/.supergit/workspace/` as a hidden default. Lean toward the former.
14. **SQLite cache: gitignored or committed snapshots?** Gitignored by
    default — rebuild on first run from the event log. Opt-in LFS-tracked
    snapshots for huge workspaces with slow first-clone.
15. **Event-log merge driver schema.** Events are timestamped and
    append-only; trivial merges should auto-resolve. The rare conflict
    (two events at the same timestamp + key) needs a structured merge
    driver. Specify the JSON schema + driver in v1.
16. **Extension API surface.** What can plugins extend — `DiffProvider`,
    reminder rules, dashboard panels, slash-commands, daemon routes?
    Probably a small core extension API in v3+ once the natural
    extension points have been validated by real (in-tree) implementations.
    Premature plugin API = bad interface frozen too early.
17b. **Side-by-side sessions.** Currently each worktree row's session
    panel stacks vertically. For comparing two agents working on related
    branches or watching multiple sessions in flight, a docked
    "sessions" pane at the right (or bottom) that holds N panels
    horizontally would be the right shape. Keep the row-anchored panel
    as default — opt in to "pop out to dock". Adjacent to v1.2
    managed-spawn since dock makes most sense once each panel can be
    typed into.

17. **Unique-to-branch commits in the worktree history.** Right now
    History shows all commits reachable from HEAD; it's not obvious
    which ones are *only* on this branch vs already merged into main /
    the upstream. Sketched candidates:
    - Diff against the upstream (`<upstream>..HEAD`) — mark those commits
      with a green left rail; everything before the merge-base is dim.
    - Diff against `main` when no upstream — same rail, fallback target.
    - A toggle "Only this branch" that filters History to the rev-list
      output of `<base>..HEAD`.
    - Show the merge-base as a horizontal divider line in the list.
    Leaning toward: green rail on unique commits + a small "ahead of
    <base>" badge in the History header. Backend already has the data
    (we run `rev-list <base>..HEAD` for the ↑n indicator).

---

## TODO — errors recorded by `/api/errors` (prod snapshot, 2026-05-13)

Originally captured from a 200-entry `/api/errors` snapshot. The first
three buckets shipped under commits `84a1ac8` (`shellCwds` TDZ hoist),
`f4df4dc` (HMR-stale ReferenceError sweep — only `loadCommitsInitial`
was a current bug; the others were transients), and `14bcd8c` (the
xterm `'dimensions'` race, fixed alongside the TerminalView
ResizeObserver gate). Status of the rest:

- **409 Conflict responses recorded as errors.** **Shipped** in
  `330dab8`. `isExpectedClientError(status, method)` in
  `packages/ui/src/errors.ts` returns true for `status === 409 &&
  method !== "GET"`, and the fetch wrapper short-circuits the record
  in that case. GETs returning 409 (rare, probably a real bug) keep
  recording. Other 4xx (400/401/403/404) on any method keep recording.
  Covered by `errors.test.ts` (skip 409 non-GET, keep 409 on GET,
  keep 400 non-GET).
- **Transient `Failed to fetch` / 502 bursts.** Half (a) shipped in
  `330dab8`: identical-shape entries (kind + method + route + status)
  arriving inside a 60s window collapse to one row whose `count`
  bumps and `timestamp` updates. A daemon-restart burst that used to
  spray 30 rows is now one row tagged `× 30` via a new `.err-count`
  chip. Uncaught/rejection errors with no `route` never coalesce.
  Half (b) STILL OPEN: downgrade pure network-unreachable fetch
  failures (TypeError thrown from `fetch`) from "error" to a quieter
  "offline" badge using the SSE `streamConnected` flag — the
  coalescing already kills the spam; the badge would replace the
  remaining loud-red-pill UX for short outages.

## TODO (small UX gaps, batch later)

These are noted-but-not-blocking issues. None are big enough to deserve
their own plan; group them into one polish PR when convenient.

- **Untracked files render inline with unstaged diffs.** Today untracked
  files appear as a `# untracked files (...)` comment header above the
  workdir diff (see `getDiff` in `packages/daemon/src/git.ts`). They
  should render as proper synthetic "new file" diffs (lines all `+`),
  inline with modified files, so the Unstaged tab reads as one unified
  list. Implementation: `git diff --no-index --no-color /dev/null <f>`
  per untracked file, concatenated with the existing workdir diff.
  Handle binary files via `--binary` or a "Binary file" placeholder.
- **Diffs/status don't live-update.** Editing a file in another editor
  doesn't refresh the row's status or the Unstaged diff. Today we only
  refetch on the 5-min auto-fetch tick (or manual refresh). Fix:
  daemon-side `fs.watch` per worktree (debounced) broadcasting via SSE,
  UI revalidates the affected row only. Watch out for node_modules /
  build-output noise — use a gitignore-aware filter or a small
  allowlist of git's own touched paths.
- **Split `packages/ui/src/App.svelte` into components.** Full plan
  in [App.svelte refactor (componentization)](#appsvelte-refactor-componentization)
  below.
- **Zen mode should unfold a folded row.** Clicking the ▣ "Enter zen"
  button on a row that's currently folded (the compact one-liner)
  takes over the viewport but the body is still hidden — the user
  sees a near-empty zen pane until they manually unfold. Zen should
  treat the row as expanded *for the duration of zen* without
  mutating the persisted `rowFolded[rowKey]` state, so exiting zen
  returns the row to its prior folded state. Easiest path: in
  `.row.row-zen` CSS / the row template, ignore `rowFolded` while
  `zenRowKey === row.key`.
- **Smooth out `/api/session` cold-start burst.** Today the cache-miss
  path in `packages/daemon/src/sessions.ts` does a fixed 8 MB tail-read
  via `tailParseSessionFile`. For sessions with small messages that
  parses way more than `MAX_CACHED_MESSAGES`, only to trim immediately.
  The transient alloc burst is what triggers Bun/JSC to grab huge OS
  arena pages it then refuses to give back — so RSS sticks at the peak
  even though `heapUsed` is tiny. Fix: walk the file backward in
  256 KB chunks, counting newlines, stop once we have
  `MAX_CACHED_MESSAGES + slack` lines. Strictly bounded; should
  noticeably lower the RSS high-water mark on a daemon serving multiple
  big TUI sessions.

---

## App.svelte refactor (componentization)

`packages/ui/src/App.svelte` is **4782 lines** as of this writing:
1854 of script, ~1120 of template, 1808 of style. It holds 73
top-level state declarations and 87 functions. The pain isn't aesthetic
— it's that every UI feature lands here, two agents can't easily work
in the same file without colliding, and the same chip/popover/row
shapes are re-implemented every time we add a new menu.

### Concrete findings (what's actually duplicated)

Counted in the current file, not hypothetical:

- **7 popover variants** (`actions-popover`, `events-popover`,
  `tuis-popover`, `wt-picker-popover`, `branch-popover`,
  `new-agent-popover`, `agents-popover`). All share the same shell:
  surface-2 background, radius-md, box-shadow, sticky `popover-head`,
  scrollable body, `use:clampToViewport`. Each variant overrides 3-5
  properties (position anchor, min/max width, head copy).
- **`.agent-row`** family — 19 references across at least 6 contexts:
  TUI overview popover, branch picker, new-agent picker, agent picker,
  worktree picker, dispose menu. Same anatomy every time: agent icon
  + name + manual-title + meta (msgs/time/sid) + close-X. Variants
  for `brand-{claude,codex,copilot}`, plus context-specific modifiers
  (`branch-row`, `new-agent-row`, `wt-pick-row`, `rm-wt-current`).
- **Chip-shaped pills** — `.ab`, `.ab-ahead`, `.ab-behind`,
  `.repo-chip`, `.tab-count`, `.agent-pill`. All small monospace
  pills, ~0.05-0.2rem padding, `var(--radius-sm)`, sized
  0.7-0.85rem. The `--chip-*-bg/text` tokens are good but the base
  shape is re-stated each time.
- **Dots** — `.status-dot`, `.agent-dot`. Already factored to 8px
  circle (after the recent alignment fix), but live in separate
  rules. One `Dot` primitive collapses them.
- **Icon buttons** — `.tiny`, `.actions-btn`, `.dispose-btn`,
  `.restart-btn`, `.fullscreen-btn`, `.row-zen-btn`, `.close`,
  `.remove`. All transparent-bg, muted-color, surface-3 hover. One
  `.icon-btn` base plus 1-2 modifiers covers the lot.
- **Row-scoped `Record<wtPath, X>` maps** — `commitsExpanded`,
  `diffTab`, `workdirDiff`, `stagedDiff`, `diffLoading`,
  `commitsByPath`, `commitsLoading`, `commitsExhausted`,
  `openCommitSha`, `commitDiff`, `fullFile`, `rowFolded`,
  `pickerSessionsByWt`, `awaitingByWt`, `activityByCwd`. Each is "one
  entry per row" — a tell that the row should own its own state,
  not the dashboard.

### Phase 0 — CSS dedup, zero behaviour change

Pure style refactor. No template changes, no component splits.
Targets the duplication that's bleeding into every new feature.

1. Introduce CSS bases + modifiers:
   - `.chip` — base padding / radius-sm / monospace / font-size.
     Variants come from the existing `--chip-*-bg/text` tokens
     wired through `.chip-green`, `.chip-orange`, `.chip-blue`,
     `.chip-indigo` modifiers.
   - `.dot` — 8px circle base, colored via `--dot-color` set per
     instance (`.dot.clean`, `.dot.dirty`, `.dot.claude` etc).
   - `.icon-btn` — transparent / muted / surface-3-hover base.
     Specific buttons keep their semantic class for selection but
     drop the duplicated CSS body.
   - `.popover` — shell shape (surface-2 / radius-md / shadow /
     clampToViewport-ready positioning). Each `actions-popover`,
     `agents-popover` etc. becomes `.popover.actions` /
     `.popover.agents` with just the per-variant overrides.
2. Rename the existing classes to point at the base + modifier
   pattern; the template renames are mechanical (`class="ab ab-ahead"`
   → `class="chip chip-green"`). Keep the legacy class as an alias
   for one commit if there's any chance of in-flight branches still
   using it.
3. Audit `.agent-row` rules — split into base + brand + variant
   stylesheets so adding the next picker doesn't double the CSS.

Expected line reduction in the `<style>` block: **~30%** (1800 → ~1250).
Expected line reduction in `<template>`: small (just shorter class
strings).

**Risk:** low. CSS-only, visual regressions are easy to spot.
Verify by `bun dev` and walking the dashboard.

### Phase 1 — Pure presentational components

Tiny, slot-driven, no business state. Each is 50-150 LOC.

1. `Chip.svelte` — `<Chip variant="green|orange|blue|indigo" title?>` +
   default slot. Replaces every site of `.chip`-modifier markup.
2. `Dot.svelte` — `<Dot kind="clean|dirty|claude|codex|copilot"
   size?>`. Replaces `.status-dot` / `.agent-dot` usages.
3. `Popover.svelte` — `<Popover head="…" on:close>` + default
   slot for the body. Wraps `use:clampToViewport`, handles ESC,
   exposes the scrollable body. All 7 popover sites consume it.
4. `IconButton.svelte` — `<IconButton title icon class?>`. Replaces
   the family of small action buttons.
5. `AgentRow.svelte` — `<AgentRow agent name manualTitle? meta? on:click
   on:close>` — the row anatomy used in every picker. Brand color
   from `agent` prop.

App.svelte loses ~400-500 lines of template + the CSS that backed
those classes (already gone in Phase 0).

**Risk:** low-medium. Components are pure functions of props; the
business logic stays in App.svelte for now.

### Phase 2 — Row-scoped composites

Each row currently lives as one big template chunk in `{#each rows}`,
sharing dashboard-global state. Extract pieces that have a clear
"props in, events out" contract.

1. `RowHead.svelte` — chevron + name editor + repo chip + branch
   chip + actions cluster. Slots for the popovers anchored to it.
2. `RowStatus.svelte` — the dot + dirty-count + ↑/↓ chips line.
   Pure read of `wt.fileStatus` and `wt.branchStatus`.
3. `SourceControlPane.svelte` — the foldout: tabs (Unstaged /
   Staged), inline DiffViewer, History list. Owns its own
   `diffTab`, `workdirDiff`, `stagedDiff` state (no more
   `Record<wtPath, X>` maps). Receives `wt` + `onCommitOpen`
   callbacks.
4. `SessionsStrip.svelte` — the horizontal `.sessions-strip`
   container that hosts `SessionView` / `TerminalView` /
   `ShellView` / `new-session-col` cards. Owns drag-to-reorder.

**Risk:** medium. State migration is the tricky part — anything
that currently lives in a `Record<wtPath, X>` map moves into the
component instance.

### Phase 3 — Big composites

1. `WorktreeRow.svelte` — wraps the Phase 2 components and owns
   row-level state (rowFolded, zen toggle, drag highlight). App.svelte
   becomes `{#each rows as row}<WorktreeRow {row} on:zen on:remove />`.
2. `DashboardHeader.svelte` — the top bar (Recent actions, Errors,
   TUIs popovers, add-folder button).
3. `DirtyCheckoutModal.svelte` — the existing modal, extracted with
   its own scoped styles.

After Phase 3, `App.svelte` should be **~800-1000 lines**: imports,
global state (rows, sessions, polling, SSE subscription), routing,
top-level layout. Heavy templates + scoped styles live in their
respective components.

**Risk:** medium-high. Row-level state has many touch points (SSE
refresh, zen mode, drag-and-drop, FS-change handling). Each one has
to be re-plumbed through props or moved into the row.

### Phasing & guard rails

- Each phase is independently committable. **No phase blocks the next.**
  If we ship Phase 0 and pause, the codebase is already strictly better.
- **Tests stay green between phases** (parser + workspace tests
  cover the daemon side; UI changes verified by `bun dev` walkthrough).
- **No new behaviour during a refactor commit.** A commit either
  refactors *or* changes behaviour, never both. Catches accidental
  bug-introductions instantly.
- **Tackle Phase 0 first.** It's the highest leverage with the
  lowest risk — once the CSS is normalised, the component
  extractions in Phase 1-3 have a clean palette to consume.

---

## Distribution

### Today: `bun run start`

`bun run build` produces `packages/ui/dist/`. `bun run start` runs the
daemon in production mode, serving the built UI from the same port
(default **27787** — deliberately different from dev's 7777/7779 so you
can have both running side-by-side). No `--hot`, no Vite, no svelte
HMR — memory and CPU drop substantially compared to `bun run dev`.

Still requires `bun install` plus a Node runtime on the machine (the
supernode helper for PTYs is a Node script). Not a "single binary"
but it's a real production posture for daily use while we iterate.

### Future: real desktop app (Tauri)

The end state is a double-clickable macOS / Windows / Linux app with
an icon, no terminal involvement to launch. The plan is **Tauri**
(not Electron) because:

- Tauri ships a tiny webview-based shell (~15 MB vs Electron's ~150 MB).
- The same Svelte UI runs unchanged inside it.
- The daemon can be embedded as a Rust sidecar (`tauri::api::process::Command`),
  starting and stopping with the app's lifecycle, exposing the same
  HTTP/WS routes to the in-app webview.
- Cross-platform packaging is built in (`tauri build`).

Open complexities to think through before this lands:
- **node-pty native module + Node helper.** The Tauri sidecar
  approach needs Node bundled inside the app, plus node-pty's prebuilt
  binary for each platform. Doable; not trivial. Alternative: rewrite
  the PTY backend in Rust (using `portable-pty` or `tokio-pty-process`)
  and drop the Node helper entirely. Bigger change, cleaner result.
- **Workspace + state paths.** Inside an app bundle, `~/supergit/...`
  still works, but we should consider `~/Library/Application Support/supergit/`
  on macOS for proper convention.
- **Auto-update.** Tauri has a built-in updater. Worth wiring once we
  ship 1.0.
- **Icon + branding.** Needs design pass; we have a Needle logo but
  not a supergit one.

This isn't a near-term priority — the `bun run start` path is enough
for now. Park as "phase N, once the feature surface settles."

---

## UX ideation

### Git diff as a pinnable pane in the sessions strip

Worktree-row idea: treat the **git changes view** (Unstaged / Staged
tabs + the DiffViewer) as a column in the same horizontal strip as
chat / terminal sessions, pinned to the **left** of the strip's scroll
viewport. As the user scrolls right through chat columns, the diff
pane stays glued to their viewport's left edge.

Implementation primitive: `position: sticky; left: 0` on a flex child
of the horizontally-scrolling sessions-strip. Modern browsers support
this natively.

**Why this might be the right shape:**
- Unifies the dashboard's mental model — chats, terminals, diffs are
  all *panes* below the worktree row. One header treatment, one close
  affordance, one drag-to-reorder pattern.
- Reviewing the diff *while chatting with an agent about it* becomes
  the canonical layout: diff anchored left, agent on the right. Today
  this requires alt-tabbing or shuffling tabs.
- The diff pane's tabs (Unstaged / Staged) live in the pane header,
  matching SessionView's pattern.

**Trade-offs:**
- Diff content typically wants more horizontal room than chat columns
  (60–90ch). Either the diff pane is wider (min ~100ch, max ~50vw) or
  it stays at chat-column width and the DiffViewer handles its own
  horizontal scroll.
- History (commits) — leave inline below for now; revisit later if it
  feels like it should also be a pane.
- The expand chevron / "show changes" toggle would gain a slightly
  different meaning ("show/hide the diff pane" rather than "show/hide
  the whole expanded block"). Acceptable.

**Cost estimate:** ~200–400 LOC. Pull diff/tabs out of the row's
expanded block into a `DiffPane.svelte` mirroring SessionView's
shape, slot it into the strip as a sticky-left first child when the
row is expanded.

Park as future work; the current expanded layout works for now.

### Notes with anchors + floating overlay

Recurring need while reviewing AI output across many repos: a
scratchpad that *outlives the session* but stays *anchored* to the
thing it's about. Quote from the author: "a way to keep notes and
maybe link them to files / markdown files+lines / folders, attached
to the UI, floats on another layer."

**Data shape.** Notes as workspace files at
`<workspace>/notes/*.md`; frontmatter carries the anchors:

```yaml
---
id: 2026-05-13-audio-merge
anchors:
  - repo:needle-engine/src/audio/AudioSource.ts:42
  - repo:needle-engine/src/audio/          # folder
  - commit:abc123
  - worktree:~/wt/needle/audio
  - session:claude/abc-def
tags: [followup, xr]
---
Body. Standard markdown — supergit renders it.
```

Files, not events, because notes want edit / delete / multi-line
bodies and markdown is the right primitive. This is the single-user
companion to the shared
[Annotations](#views-annotations--multi-user-state) idea — those
collapse to events on the log (one author per entry, broadcast to the
team), these collapse to files in the workspace (full markdown,
mutable, versions with everything else). Same workspace as source of
truth; the two co-exist.

**UI: floating overlay, anchored.** Notes don't fit cleanly into the
row layout, so:

- A draggable / pinnable card overlay (`position: fixed`, drag-to-move,
  snap-to-edge, "always on top" of the dashboard). When the matching
  row / file / line scrolls into view, a faint ribbon connects card
  to anchor.
- Gutter pin icons in the diff viewer for lines that have notes
  anchored to them.
- A "notes" subtab in the row foldout listing every note anchored
  inside the worktree.
- Global notes index (keyboard shortcut, e.g. ⌘⇧N) — side panel,
  filterable by anchor type / tag, fuzzy search over body.

**Anchor resolution is the hard half.** A `file.ts:42` anchor should
follow renames and survive line shifts. Cheapest start: store
verbatim, mark "stale" when they no longer resolve, let the user
re-anchor by clicking the warning chip. Smarter pass: `git log
--follow` for rename tracking, then a fuzzy match on the snippet
that was at `:42` when the anchor was created.

**Phasing.**
- v1.x — file-backed storage, anchor types (file, file:line, folder,
  commit), a row foldout subtab, plain markdown rendering. No
  floating overlay yet — start with the row-anchored surface that
  matches the rest of the dashboard.
- v1.y — the floating-overlay card + gutter pins. UX-heavy; prototype
  before locking interaction model.
- v2 — stale-anchor handling + smart migration via `git log --follow`.
- v2+ — folds the multi-user case back into the
  [Annotations](#views-annotations--multi-user-state) story.

**Cost estimate.** v1.x storage layer + foldout subtab is small
(~300 LOC daemon + UI). The floating overlay is the open-ended part —
half a week of UX prototyping, easy to scope-creep. Don't ship the
overlay until the foldout surface has been used enough to know what
notes are really for.
