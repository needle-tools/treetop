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
- **Editor-agnostic.** Detect installed editors (Fork's pattern) and shell
  out. No fork of any editor, no heavy extension.
- **Two pillars, one daemon, one UI shell.** Dashboard and binary work share
  infrastructure but ship independently.

## Contents
- [Vision](#vision) — what supergit is for, who it's for.
- [Architecture](#architecture) — local daemon, thin clients (web first), stack pick.
- [Agent dashboard](#agent-dashboard) — the killer screen, and how it detects which agent is in which worktree.
- [Git scope](#git-scope) — the 80% loop we cover; the 20% we punt to Fork via "Open in Fork".
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
- Daemon + web UI, SSE updates, single binary.
- Repo registration, worktree list, agent detection (process + session files).
- Session list per worktree with one-click resume (`claude --continue`).
- Status, text diff, commit, push, pull, branch, worktree create/remove.
- "Open in Fork" / "Open in editor (detected)" / "Open in terminal" escape
  hatches via plain CLI shell-outs.

**v1 — making the dashboard feel inevitable**
- Spawn-worktree-and-launch-agent action.
- Cross-agent handoff (package one agent's work as context for another).
- Heartbeat hook + installer.
- Thin VSCode reporter extension (which workspaces are open right now).

**v2 — second skins and presence**
- TUI client (second skin on the same daemon API).
- Agent presence relay (cloud sync of presence metadata).

**v3 — team mode**
- Team-mode dashboard on Needle Cloud (multi-user fleet view).
- JetBrains / Cursor / Neovim reporter plugins.

**Never ship** (saying it out loud to keep us honest):
- Our own interactive rebase UI. Use Fork or the terminal.
- A Fork-style branch graph visualization.
- A merge-conflict resolver UI for text. Use the editor's.

---

## Open questions

Dashboard-pillar questions only. CAS / chunking / binary-specific questions
live in PLAN-3D.md.

1. **Rust + axum vs Go + chi.** Probably Rust for binary perf and
   single-binary distribution; if iteration speed matters more, Go is fine.
   Pick before day one.
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
