# Windows compatibility TODO

Tracking cross-platform issues found while porting supergit to Windows.

## Fixed (source code)

- [x] **`package.json` start script** — bash-only syntax (`${VAR:-default}`, `exec -a`).
      Replaced with cross-platform `start.ts` launcher.
- [x] **UI static serving** (`server.ts:2718`) — `startsWith(UI_DIR + "/")` fails on
      Windows where `resolve()` produces backslash paths. Fixed with `path.sep`.
- [x] **`which` command** (`open.ts:45`) — `which` doesn't exist on Windows.
      Now uses `where` on win32.
- [x] **Repo name from path** (`workspace.ts:addRepo`) — `split("/")` on a Windows
      path like `C:\git\supergit` returns the whole string. Now uses `basename()`.
- [x] **Agent binary resolution** (`procs.ts:resolveAgentBinary`) — PATH dirs joined
      with `/` instead of `path.join()`. Also: didn't probe `.exe`/`.cmd` suffixes,
      so `claude.exe` and `codex.cmd` were invisible.
- [x] **Submodule worktree detection** (`git.ts:99,115`) — `.includes("/.git/")`
      misses `\.git\` on Windows. Now uses regex `/[/\\]\.git[/\\]/`.
- [x] **Session ID from path** (`agents.ts:825`) — `split("/")` on session file path.
      Now splits on `/[/\\]/`.
- [x] **Zsh detection** (`server.ts:1332`) — `split("/")` on command path to get
      binary basename. Now splits on `/[/\\]/`.
- [x] **Git worktree path normalization** (`git.ts:parseWorktreeList`, `listWorktrees`)
      — git on Windows returns forward-slash paths (C:/...), Node uses backslashes.
      Now `resolvePath()` normalizes them. Also guards against git walking upward
      to a parent repo for non-git directories.
- [x] **Case-insensitive path matching** (`agents.ts:agentsForWorktree`) — Claude
      writes `cwd: "c:\\git\\..."` (lowercase drive), git returns `C:\git\...`.
      Now uses `normCase()` for comparisons on Windows.
- [x] **Default shell** (`server.ts:/api/shell-default`) — fallback was `/bin/zsh`.
      Now checks `$COMSPEC` on Windows, falls back to `powershell.exe`.
- [x] **dev.ts** — uses `bash -c 'exec -a ...'` and bare `"bun"`. On Windows,
      uses `process.execPath` and skips the bash wrapper.
- [x] **Session read endpoint** (`server.ts:/api/session`) — used
      `process.env.HOME` (undefined on Windows) + hardcoded forward-slash paths
      to build the agent-root allowlist. Now uses `homedir()` + `join()` + `sep`,
      with case-insensitive `startsWith` on Windows.

## Fixed (tests — 32 failures → 0)

- [x] `agents.test.ts` — wrap expected cwds in `resolve()`, resolve helper cwds.
- [x] `git.test.ts` — wrap expected worktree paths in `resolve()`.
- [x] `git.integration.test.ts` — use `join()` for submodule paths, `mkdir()`
      instead of `mkdir -p`, regex for `.git/modules` check.
- [x] `sessions.test.ts` — `fileURLToPath()` instead of `.pathname` for fixtures.
- [x] `attachments.test.ts` — `startsWith(dir + sep)` instead of `+ "/"`.
- [x] `open.test.ts` — `basename()` instead of `split("/").pop()`.
- [x] `procs.test.ts` — `sampleCwds` returns empty on Windows; test accounts for it.
- [x] `terminals.test.ts` — `describe.skipIf(isWin)` for NodePtyBackend (bash-only),
      platform-aware `resolveAgentBinary` test.
- [x] `term-clamp.test.ts` — skip PTY round-trip on Windows.

## Not yet addressed (source code)

- [x] **`openIn("fork")`** — now probes `fork` on PATH, then
      `%LOCALAPPDATA%\Fork\Fork.exe`. macOS still uses `open -a Fork`.
- [x] **`openIn("terminal")`** — tries `wt.exe` (Windows Terminal) first,
      falls back to `powershell` in a new window via `cmd /c start`.
      Supports the optional `command` parameter (e.g. resume-in-terminal).
- [x] **`sampleProcs()`** — now uses `Get-Process` via PowerShell to report
      WorkingSet64 (memory). CPU% stays 0 (no cheap instant-% source on
      Windows); UI hides the badge.
- [ ] **`sampleCwds()`** — returns empty map on Windows (graceful degradation).
      Windows doesn't expose per-process CWD without native API calls.
- [ ] **`shellQuote()` / `renameArgv()`** — Unix-only (bash `exec -a`).
      Callers guard with `process.platform !== "win32"`, but PTY processes on
      Windows get no argv[0] rename (cosmetic only).
- [ ] **NodePtyBackend / helper.mjs** — spawns bash-based shells with
      zsh-specific ZDOTDIR injection. Needs a Windows shell init path
      (PowerShell profile, cmd autorun).

## Fixed (general bugs)

- [x] **Claude directory-based sessions not discovered** — newer Claude
      stores sessions as `<project>/<uuid>/subagents/*.jsonl` instead of
      flat `<project>/<uuid>.jsonl` files. `scanClaude` now also probes
      UUID-named directories and picks the most recently modified subagent
      file as the session representative.

## Fixed (UI / UX bugs)

- [x] **"Add custom link" popover behind notes** — `.agents-popover` had
      `z-index: 50`, sticky notes layer at 900. Bumped both popover variants
      to `z-index: 1100` so they render above sticky notes.

## Fixed (UI / UX bugs on Windows — continued)

- [x] **"Add folder" picker** — modern IFileOpenDialog COM interop replaces
      the ancient FolderBrowserDialog. Remembers last directory natively.
- [x] **Ollama "pick model" dropdown** — popover closed on click because
      CSS attribute selectors broke on Windows backslash paths. Fixed by
      CSS.escape() on all six popover click-outside handlers.

## Not yet addressed (UI / UX bugs)

- [ ] **`supergit://commit/` links** — resolve to GitHub URLs that 404 on
      private repos. May need auth or a different resolution strategy.
