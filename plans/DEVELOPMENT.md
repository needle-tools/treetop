# supergit — development methodology

Why this file exists: **most of the code in this project will be written by AI
agents.** A human author has mental context that lets them notice "I'm
breaking that other thing" mid-edit. An AI agent doesn't — it edits the file
in front of it and trusts the surrounding code is fine. So every block needs
explicit, automated verification that it continues to behave as intended,
before *and* after AI touches it.

This document captures the discipline we hold to. Applies to both pillars
([PLAN.md](./PLAN.md) and [PLAN-3D.md](./PLAN-3D.md)).

## Core principle: TDD, always

Test-first, always, for non-trivial code. Workflow per feature:
1. Write a failing test that specifies the intended behavior in plain
   language (test name) and concrete examples (test body).
2. Make the test pass with the smallest correct implementation.
3. Refactor with the test as guardrail.

The test is the **contract** the AI must satisfy. Without it, "passing" means
nothing because there's no spec. With it, regression is caught the moment the
AI introduces it, not weeks later in production.

## Test layers

- **Unit**: pure functions, parsers, format providers, rule evaluators.
  Fast (<10ms each), no I/O. Many of them.
- **Integration**: daemon endpoints, CAS roundtrips, event-log reads/writes,
  workspace sync. Real disk, real sqlite, real git. Each test gets a temp dir.
- **End-to-end**: critical workflows scripted against a running daemon.
  Browser-driven for dashboard flows.
- **Property-based**: invariants across many inputs — event-log append
  idempotency, CAS hash determinism, chunk roundtrip equality, workspace
  merge convergence under random concurrent edits. `proptest` or equivalent.
- **Performance benchmarks**: hot paths get written budgets and `cargo bench`
  runs on every PR. CAS hashing, diff rendering, sqlite queries, event-log
  scan.

## What every block needs before it's "done"

- A clear written specification of intended behavior (the test names *are*
  the spec).
- Unit tests covering happy path, edge cases, and at least one failure mode.
- For I/O blocks: an integration test exercising the real dependency.
- For perf-critical blocks: a benchmark with a written ceiling.
- For format providers (glb, blend, png, ...): a roundtrip test
  (parse → serialize → equal).
- For sync / merge blocks: property tests that converge under random
  concurrent edits.

## CI gates (every PR)

- All tests pass on Linux + macOS + Windows.
- No clippy / lint warnings.
- Benchmarks within ±10% of baseline (regressions auto-block).
- Coverage report posted (target: 80% line, 70% branch — guideline, not a
  hard gate; chasing 100% rewards bad tests).
- E2E suite passes.

## Anti-patterns we reject

- **Mocking the thing under test.** Mock external systems (network, OS
  notifications); never mock your own code's internals. If a unit needs
  mocks of its own callees, it's too coupled.
- **Mocking the database.** Hit a real sqlite (temp file). Mocks lie.
- **Tests that pass without asserting.** `assert!(true)` and friends.
- **Silent error handling.** `unwrap_or_default()` in the hot path. If an
  error is unreachable, `expect("reason")` with the reason.
- **Skipping tests.** `#[ignore]` is debt; closes in a follow-up PR with a
  tracking issue.
- **Refactor + new behavior in one PR.** Refactor first (tests stay green),
  then add the new behavior with new tests. Two PRs.

## Working with AI agents

- The agent reads the failing test, writes the implementation, runs tests,
  iterates until green. No "I think this should work" — only "the test
  says it works."
- Multi-block changes are sequenced: change block A with its tests passing
  before touching block B. The dashboard's agent-tail view surfaces this
  so reviewers can see test-first discipline being followed (or violated).
- Cross-block regressions are detected by the full test suite running on
  every commit, not just on PR submit. A pre-commit hook runs unit + fast
  integration; the slow suite runs in CI.
- Property tests do the heavy lifting against AI-induced regressions —
  they catch breakage even when the AI introduced an "improvement" that's
  technically correct for the examples but violates an invariant.

## Side-instance development

Use a temporary workspace copy when dogfooding performance, layout, or CSS
against realistic persisted data while leaving the production Treetop workspace
metadata alone:

```sh
npm run dev:temp
```

The script starts the daemon on `:17777` and Vite on `:17779`, copying from
`$HOME/supergit/workspaces/default`. The UI shows a red `TEMP WORKSPACE` badge
when this mode is active. Use `http://localhost:17779`.

The copied workspace keeps normal persisted UI state, but excludes live/runtime
state such as `active-terminals.json`, `shells/`, daemon/error logs, peer
identity, invites, keys, and remote cache. Repo paths inside `repos.json` still
point at the real repos, so commands launched in terminals can still affect
real files and git state.

For persistent scenario workspaces, use a named side instance:

```sh
npm run dev -- --workspace perf-scroll
```

This uses `$HOME/supergit/workspaces/perf-scroll`, creating it if it does not
exist and reusing it when it does. The workspace is editable by default, has
its own prefs/backups/logs, and starts with side-instance behavior (peer
discovery, auto-fetch, and `.claude.json` repair disabled). Use
`http://localhost:17779`.

To seed a missing named workspace from the main workspace:

```sh
npm run dev -- --workspace perf-scroll --copy-from-main
```

To inspect without allowing workspace/repo mutations:

```sh
npm run dev -- --workspace perf-scroll --readonly
```

Run a second side workspace by choosing another port pair:

```sh
npm run dev -- --workspace perf-images --port 17877 --ui-port 17879
```

## CI regressions (2026-10-23)

- Legacy Codex context occupancy/capacity snapshots must not replace billing
  checkpoints. The corpus audit regression also checks the next real usage delta.
- A native upward scroll invalidates pending reader-anchor corrections even when
  wheel intent already paused follow. WebKit can render between those events.
- The lifecycle harness tracks SSE lifetime on the response, not the completed
  request. Repeated-steer tests gate HTTP failures explicitly rather than relying
  on two response deadlines staying apart on a busy runner.

## Session messaging and Zen regressions (2026-10-23)

Session messaging regressions: when a new terminal column resolves its provider
session ID, bind that ID to the existing PTY owner instead of keeping the
`__new__` tag. MCP focus waits for this metadata update before acknowledging.
Opening/resuming a column through MCP preserves Zen and moves its row to the
target project. The real-PTY regression stages input without submitting it and
rejects reassignment to another established session.

## Saved command MCP lifecycle (2026-10-24)

Needle Cloud's `node tools/dev.mjs dev` was active in an internal command PTY
while `list_commands.running` was empty. The old daemon registry only recorded
`runMode: shell`; internal commands lived in the UI's `commandTermSources` map.
The HTTP launch route also checked duplicates before asynchronous project lookup,
so concurrent launches could both pass that check.

HTTP and MCP now share `ProjectCommands`: verified project/command IDs, a lock
covering launch/stop/restart and UI publication, one registry for internal PTYs
and background children, saved cwd/run mode, and confirmed exit before restart.
The existing internal command wrapper, terminal persistence, URL scanning and
embedded-column reveal path are retained. MCP exposes `start_command`,
`stop_command` and `restart_command`; descriptions and server instructions require
explicit user authorization. Listing/saving/editing never executes commands.

External OS-terminal launches still have no monitored PID in `openIn`. They are
reported separately as `external_untracked`; repeat launches are suppressed and
stop/restart fails explicitly rather than claiming exit or changing run mode.
Regression tests use temporary projects, real test-only PTYs/background process
trees, concurrent starts, failed launches, stop timeouts, and gated exit promises.
No user project command is run while validating this feature.

## The point

The goal isn't "the AI wrote tests" — AI can write bad tests too. The goal
is **executable specifications a human signed off on, that catch breakage
when the AI later edits unrelated code.** Treat specs and tests as the
durable artifact; treat the code under them as relatively cheap.
