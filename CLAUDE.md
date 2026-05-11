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
- `bun dev` → starts daemon (port 7777) and UI (port 5173) with hot reload.
- `bun test` → runs all tests across packages.
- Open `http://localhost:5173` to use the dashboard.

## When in doubt
Read the test names first — they're the spec. If the test names don't cover
what you need to know, that's a docs gap; fix it.
