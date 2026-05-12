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

## Anti-patterns we reject

- Mocking the thing under test, or mocking the database.
- Tests that pass without asserting.
- Silent error handling (`unwrap_or_default()` style in hot paths).
- `it.skip` / `xfail` without a tracking issue.
- Refactor + new behavior in one PR.
- Adding error handling, fallbacks, or validation for scenarios that can't
  happen. Trust internal invariants; validate at system boundaries only.

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
> Dev daemon restarts under `bun dev:portless` are fine without asking
> (hot reload is the point); only prod is sensitive.

- `bun run start` builds the SPA, then runs the daemon serving
  `packages/ui/dist`. Default port: **27787** (override with
  `SUPERGIT_PORT=…`). Open `http://localhost:27787`.
- For the clean `https://supergit.localhost/` URL, wrap with
  `bunx portless supergit …`. The portless proxy daemon must be running
  first; it binds `:443` and so needs sudo:
  ```
  sudo portless proxy start --https
  ```
  Then `bunx portless supergit bun run packages/daemon/src/server.ts`
  (or just `bun start` if you keep the port in env). `supergit-dev.localhost`
  works the same way via `bun run dev:portless`.
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

### Port collision footgun (don't reintroduce)

`bunx portless supergit …` exports `PORT=<supergit's port>`,
`PORTLESS_URL=…`, and `NODE_EXTRA_CA_CERTS=…` into the daemon's env.
Those would propagate to every PTY supergit spawns and break neighbouring
dev servers (Vite reads `process.env.PORT` + `strictPort: true` → refuses
to start). `packages/daemon/src/terminals/helper.mjs` strips those three
vars before handing the env to a PTY; keep that scrub in place if you
refactor terminal spawning.

### Debug endpoint

`/api/debug/mem` returns `process.memoryUsage()`. `?gc=1` runs a sync
full GC first and reports before+after — useful when triaging "is RSS
high because of live data or V8 reservation?".

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
