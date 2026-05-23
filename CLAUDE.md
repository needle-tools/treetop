# CLAUDE.md — rules for AI agents working on supergit

This file is the contract every AI agent (Claude or otherwise) must follow when
contributing to supergit. It distills our planning docs into actionable rules.
If something here is unclear, see [plans/PLAN.md](./plans/PLAN.md),
[plans/PLAN-3D.md](./plans/PLAN-3D.md), and [plans/DEVELOPMENT.md](./plans/DEVELOPMENT.md).

`AGENTS.md` is a symlink to this file — same rules apply.

## What supergit is
A multi-repo, multi-agent, worktree-first git dashboard. The workspace is itself
a git repo (single-member at v0, invitable from v2). Two pillars:
1. Dashboard + workflow ([PLAN.md](./plans/PLAN.md)) — the daily-driver MVP.
2. 3D / binary asset handling ([PLAN-3D.md](./plans/PLAN-3D.md)) — separate plan,
   ships in parallel.

## Hard rules

1. **TDD or it didn't happen.** Test-first for non-trivial code. Workflow:
   write failing test → make it pass → refactor. The test is the contract.
   See [plans/DEVELOPMENT.md](./plans/DEVELOPMENT.md).
2. **Don't break existing tests.** If a change makes existing tests fail,
   that's a regression. Either the test is wrong (update it deliberately and
   explain why), or your change is wrong (fix it). Never delete or skip tests
   to make CI pass.
3. **Edit files; don't create new ones unprompted.** Prefer editing existing
   files. No new docs (`*.md`) unless explicitly asked.
4. **Honor the v0 scope.** v0 is: workspace + add-repo + list-worktrees +
   agent detection + text diff. Anything outside this surface needs a clear
   justification or it waits for v1+.
5. **Workspace is the source of truth.** State goes in the supergit workspace
   (`<workspace>/events.jsonl`, `<workspace>/repos.json`, etc.). Never write
   state to ad-hoc places like `~/.supergit/`.
6. **Don't compete with Fork on deep git ops.** Rebase UI, conflict resolver,
   submodule UI, blame, reflog — explicitly out of scope. "Open in Fork" is
   the escape hatch.
7. **Format-aware diff, not byte diff.** For known formats (glTF, blend,
   unity scene, png), use a `DiffProvider`. Never show "binary file
   changed" with no info. (This applies once the 3D pillar starts; v0 is
   text-only.)
8. **Editor-agnostic.** Shell out to detected editors. No editor fork, no
   heavy extension.
9. **Pluggable backends, never required cloud.** Cloud (Needle Cloud, S3,
   etc.) is one backend among several. Local-disk always works.
10. **Don't add features beyond the task.** A bug fix doesn't justify a
    refactor. A new feature doesn't justify a new abstraction. Three similar
    lines beats a premature helper.
11. **No localStorage for shared UI state.** UI state that should be
    consistent across browser and native app (open sessions, note
    positions, visible worktrees, folded rows, etc.) goes in daemon
    prefs (`/api/prefs` → `<workspace>/prefs.json`) via
    `getDaemonKV()`. Direct `localStorage` is only for per-device
    ephemeral preferences (last-used model, share-dialog peer, drafts).
12. **NEVER touch the prod daemon.** Do not kill, restart, or
    interfere with the production process (port `:27787`) under any
    circumstances. No `kill`, no `lsof … | xargs kill`, no
    `bun run start` on the prod port — nothing. The user will
    restart prod themselves when they're ready. This applies even
    if the user just asked you to build, deploy, or "try it" — building
    the SPA is fine, restarting the process is not. Violations destroy
    live TUI sessions the user is hosting.

## Anti-patterns we reject

- Mocking the thing under test, or mocking the database.
- Tests that pass without asserting.
- Silent error handling (`unwrap_or_default()` style in hot paths).
- `it.skip` / `xfail` without a tracking issue.
- Refactor + new behavior in one PR.
- Adding error handling, fallbacks, or validation for scenarios that can't
  happen. Trust internal invariants; validate at system boundaries only.
- New `localStorage.setItem` / `localStorage.getItem` calls for layout or
  session state. Use `getDaemonKV()` from `daemon-kv.ts` instead.

## Stack (v0)

- Daemon: **Bun + TypeScript**. Native HTTP, native SQLite, native test runner,
  watch mode for hot reload.
- UI: **Svelte + Vite**. SPA, talks to daemon via Vite proxy at
  `http://localhost:7777`.
- State: JSON files in the workspace repo (`events.jsonl`, `repos.json`).
  Derived SQLite cache deferred to v1 — current data volumes don't need it.
- Tests: Bun's built-in `bun test`.

Why Bun and not the plan's eventual Rust: time-to-first-running-app is what
matters at v0. Rust is a future rewrite *if* perf demands it. Don't preemptively
rewrite.

## File layout

```
supergit/
├── packages/
│   ├── daemon/        # Bun + TS HTTP server
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── workspace.ts
│   │   │   └── git.ts
│   │   └── test/
│   └── ui/            # Svelte + Vite SPA
├── plans/             # PLAN.md, PLAN-3D.md, DEVELOPMENT.md
├── CLAUDE.md
├── AGENTS.md          # symlink → CLAUDE.md
├── dev.ts             # spawns daemon + UI with hot reload
└── package.json       # root, workspaces + scripts
```

## Working on the code

- `bun install` once at root → installs workspaces.
- `bun dev` → starts daemon (port 7777) and UI (port 7779) with hot reload.
- `bun test` → runs all tests across packages (daemon + UI).
- `bun run test:watch` → same, but re-runs on file changes.
- `bun run test:coverage` → emits a line/function coverage table.
- Open `http://localhost:7779` to use the dashboard.

## Running prod

**Always ask before restarting prod.** Even if the user just authorized a
code change, picking a fix is *not* the same as authorising a process
kill. Prod runs detached and survives this shell; killing it interrupts
whatever the user is doing in the running dashboard. The rule:
> Whenever you would `kill -9` the prod listener (typically the one on
> `:27787`) or otherwise restart it, **first send a one-line message
> asking for permission** — even after the user just said "deploy this"
> or "try X." Wait for an explicit go-ahead before issuing the kill.
> Dev daemon restarts under `bun dev` are fine without asking (hot
> reload is the point); only prod is sensitive.

- `bun run start` builds the SPA, then runs the daemon serving
  `packages/ui/dist`. Default port: **27787** (override with
  `SUPERGIT_PORT=…`). Open `http://localhost:27787`.
- For a long-lived prod (survives this shell / a tool sandbox), launch
  detached with `nohup … >/tmp/supergit-prod.log 2>&1 </dev/null &; disown`.
  Background tasks spawned by AI tooling get SIGTERM'd after a few minutes;
  detaching reparents the process to `launchd` so the harness can't kill it.

### Don't auto-restart the daemon (would kill TUIs)

Don't wrap `bun run start` in a supervisor that respawns the daemon on
an RSS threshold. The daemon spawns `packages/daemon/src/terminals/helper.mjs`
as a child via `Bun.spawn`, and the helper has a `SIGTERM` handler that
walks `terms.values()` and kills every PTY before exiting. So killing
the daemon → kills the helper → kills every Claude/Codex TUI session
the user is hosting. We tried this once; don't reintroduce it without
first re-architecting the helper to survive daemon restarts (e.g.
detached + Unix socket IPC so the daemon can attach to an existing
helper instead of owning it as a child).

### PTY env scrub (don't remove)

`packages/daemon/src/terminals/helper.mjs` strips `PORT`, `PORTLESS_URL`,
and `NODE_EXTRA_CA_CERTS` from the env it hands to spawned PTYs. The
PORT scrub matters in general: any reverse-proxy wrapper (current or
future) that exports `PORT=<supergit's port>` would otherwise propagate
into every Vite/dev-server PTY supergit spawns, and Vite reads
`process.env.PORT` with `strictPort: true` → refuses to start because
"port already in use." Keep the scrub.

### Debug endpoint

`/api/debug/mem` returns `process.memoryUsage()`. `?gc=1` runs a sync
full GC first and reports before+after — useful when triaging "is RSS
high because of live data or V8 reservation?".

## UI styles

Shared component CSS lives in `packages/ui/src/styles/` (e.g.
`header.css`, `popover.css`), **not** scoped inside `.svelte` files.
Two reasons:

1. Variants and the shell often need to apply to the same DOM node
   (Popover.svelte's root). Svelte's per-component scope hashing would
   otherwise force every variant rule to be split between the
   component file (for the shell) and `:global()` in every caller.
2. `extraClass`-based variant rules (`.events-popover`,
   `.tuis-popover`, `.menubar .actions-btn`, …) can target shared
   roots directly without `:global()` boilerplate.

Per-component look-and-feel (one-off layouts that don't compose with
anything else) still belongs in `<style>` inside the relevant
`.svelte` file. The file-header comments in `styles/*.css` explain the
rationale at length when you need it.

## Test coverage

We don't enforce a hard percentage gate (chasing 100% rewards bad tests),
but every block in the list below ships with tests *before* it ships:

- **Every parser**: `parseWorktreeList`, `parseFileStatus`, `parseBranchStatus`,
  `parseLastCommit`, `parseCommitList`. See `packages/daemon/test/git.test.ts`.
- **Every storage class**: `Workspace`, `EventLog`, `ExpandedStore`. See
  `packages/daemon/test/workspace.test.ts`, `events.test.ts`, and
  `packages/ui/test/storage.test.ts`.
- **Every reversible operation has a round-trip test** (add / remove /
  rename → undo → redo restores the original state, ids and metadata
  preserved). See `packages/daemon/test/integration.test.ts`.
- **Persistence helpers** (filesystem or localStorage) are tested with an
  injected store / temp dir, never against real global state.
- **New daemon routes** either have a direct unit test on their pure parts
  *or* are exercised by an integration test that uses the same payload
  contracts the route uses.
- **New format providers** (glb, blend, png, ...) ship with a roundtrip
  test: parse → serialize → equal.

Anti-patterns we reject:
- Tests that pass without asserting.
- Mocking the database / filesystem / git when a temp dir works.
- `it.skip` without a tracking issue.
- "Refactor + new behavior in one PR" — refactor first (tests green),
  then add new tests + new behavior.

**Automation:** every push and PR to `main` runs `bun test` via
`.github/workflows/test.yml`. Coverage is reported in the same job.
Locally, treat `bun test` as the inner loop — it's fast (<200ms) so the
default workflow is "write a failing test → make it pass → commit."

## When in doubt
Read the test names first — they're the spec. If the test names don't cover
what you need to know, that's a docs gap; fix it.
