# PLAN-SEARCH — global search / command palette

Status: **planning** (no code yet). Owner: TBD.

A VS Code–style global palette for supergit. Opened by a keyboard
shortcut, searches across the workspace, and acts on the result
(focus a worktree row today; run a command / open a session later).

## Why this is cheap to build

The @-mention picker is already a pluggable palette in everything but
name. We reuse it instead of building search from scratch:

- **`Provider` contract** — `mention-types.ts:88`. `search(query, scope,
  limit) → PickItem[]`. Pluggable by design.
- **Existing providers** — `sessionsProvider`, `commitsProvider`
  (`mention-providers.ts`).
- **Fuzzy rankers, already unit-tested** — `fuzzyScore`
  (`mention-providers.ts:82`) and `scoreSession` (`sessionSearch.ts`).
  See `packages/ui/test` for their characterization tests; new providers
  follow the same pattern.
- **`TargetType` already includes `"file"` and `"command"`**
  (`mention-types.ts:19`) — the link/target plumbing anticipated this.
- **`MentionPicker.svelte`** renders a grouped, keyboard-navigable list
  of `PickItem`s.

So the work is mostly: a new provider + a global (un-anchored) palette
shell + keybinding wiring. The search machinery already exists.

## Decisions (locked 2026-06-01)

| Concern | Decision |
|---|---|
| **Palette trigger** | `Ctrl+F` (Win/Linux) / `Cmd+F` (macOS) |
| **Fullscreen shortcut** | `Ctrl+Cmd+F` (macOS) / `F11` (Win/Linux) — moved **off** `Ctrl+F` |
| **v1 search scope** | **Repos / worktrees / folders only.** Sessions, commands, commits are later phases. |

Rationale for the palette key: in a terminal-heavy app, single-key
`Ctrl` shortcuts collide with readline (`Ctrl+P` = prev-history,
`Ctrl+K` = kill-line). `Ctrl/Cmd+F` reads as "find/search", and we
intercept it in the terminal's capture-phase keydown handler so a
focused PTY never sees it (same mechanism the copy/paste/interrupt
shortcuts already use in `TerminalView.svelte`).

### Migration note — undo this turn's change

A `Ctrl+F → toggle fullscreen` branch was added to
`TerminalView.svelte`'s capture-phase keydown handler (the block right
after `const isMac = …`). Per the decisions above this must change:

1. **Rebind fullscreen** to `Ctrl+Cmd+F` (mac) / `F11` (win/linux). The
   fullscreen action itself is unchanged — it already lives in the
   header burger menu (`SessionHeader.svelte` `toggleFullscreen`, target
   = the `.session` ancestor). Just move which keys trigger it.
   - `F11` caveat: in a plain browser tab, `F11` is intercepted by the
     browser for *window* fullscreen and may never reach the page. It
     works reliably in the native (electrobun) app. If browser-tab
     fullscreen matters, fall back to the burger menu there, or pick a
     different Win/Linux key. Flag this during implementation.
2. **Repurpose the `Ctrl/Cmd+F` capture branch** to open the palette
   instead of toggling fullscreen.

## v1 scope — "Go to repo / worktree / folder"

A quick-open that lets the user jump to any worktree row across all
repos (local + remote daemons) by fuzzy-typing its name/branch/path.

### New: `reposProvider`

Add to `mention-providers.ts`, following `sessionsProvider`'s shape.

- **Data source**: the same `Repo[]` the app already holds (from
  `/api/repos`). Shapes (from `App.svelte:191`+):
  - `Repo { id, path, name, color?, daemonId?, worktrees: Worktree[], remotes? }`
  - `Worktree { path, branch, head, detached, nonGit?, … }`
- **Items**: one `PickItem` per worktree (and a row per repo when it has
  no worktrees yet). Haystack = `name + branch + path` (+ repo name for
  worktrees). Rank with the existing `fuzzyScore`.
- **`PickItem` mapping**:
  - `label` = worktree branch (or repo name)
  - `subtitle` = repo name (so duplicate branch names across repos
    disambiguate)
  - `meta` = short path tail
  - `value` = worktree `path` (the focus key)
  - `targetType` = `"folder"` … but note `TargetType` currently lists
    `session | commit | url | file | command` — **`"folder"` needs
    adding**, or reuse `"file"`. Prefer adding `"worktree"`/`"folder"`
    for clarity. Also widen `ProviderId` (`"sessions" | "commits"`) to
    include `"repos"`.

### The action — focus a worktree row

`App.svelte:2449` already has `jumpToWorktreeRow(path)`:

```ts
const sel = `[data-wt-row="${CSS.escape(path)}"]`;
el.scrollIntoView({ behavior: "smooth", block: "center" });
el.classList.add("wt-row-pulse"); // pulse highlight for 1.2s
```

The palette's "activate" on a repos result calls this with the picked
`value` (path). For remote-daemon repos, confirm the row renders with a
`data-wt-row` attribute for the same path; if not, that's a small add.

### The palette shell

The current `MentionPicker` is anchored to a note/caret. v1 needs a
**global, un-anchored** variant:

- A top-level component (e.g. `CommandPalette.svelte`) mounted once in
  `App.svelte`, centered-modal, opened via a store/flag.
- Reuse `MentionPicker`'s list rendering + keyboard nav if it can be
  decoupled from its anchor; otherwise a thin sibling that imports the
  same row markup. Decide during spike — don't fork the ranker.
- `SearchScope` for the global palette: leave `currentRepoPath` /
  `currentWorktreePath` **undefined** = workspace-wide (the scope type
  already documents this as the widening case, `mention-types.ts:27`).

### Keybinding wiring

Two layers, because a focused terminal eats keystrokes:

1. **Document-level** (`App.svelte` `handleKey`, ~line 6201) — open the
   palette when nothing terminal-ish is focused. Mirror the existing
   undo/redo guard (skip when an `INPUT`/`TEXTAREA`/contentEditable is
   focused; but the palette key should still fire over the dashboard).
2. **Terminal capture-phase** (`TerminalView.svelte`, the existing
   keydown capture listener) — intercept `Ctrl/Cmd+F`,
   `preventDefault` + `stopPropagation`, dispatch "open palette", and
   `return` before xterm/the PTY sees it.

Use a small shared event/store so both layers call the same opener.

## TDD plan

Providers and ranking are pure TS → test before UI (CLAUDE.md hard
rule 1). Mirror `sessionSearch.test` / the mention-provider tests:

- `reposProvider.search`:
  - empty query → all worktrees, ordered sensibly (by repo then branch,
    or recency if available).
  - fuzzy query matches branch, repo name, and path tails.
  - duplicate branch names across repos both surface, disambiguated by
    subtitle.
  - non-git folders (`nonGit`) included/excluded per decision.
- `TargetType`/`ProviderId` widening compiles and existing mention tests
  stay green (hard rule 2 — no regressions).
- Keybinding logic: extract a pure predicate (e.g.
  `isPaletteOpenKey(ev, isMac)`) so the modifier matrix is unit-tested
  without a DOM, the way the fullscreen-key predicate should be too.

UI wiring (palette open/close, row activation → `jumpToWorktreeRow`)
verified manually via `/run` or `/verify` since it's DOM glue.

## Future phases (out of v1 scope)

- **Sessions** — `sessionsProvider` already exists; add it to the global
  palette's provider list. Lowest-effort next step.
- **Commands** — a command registry `{ id, title, keywords, run() }` +
  `commandsProvider`. Today actions are scattered
  (`claude-session-menu.ts`, `SessionHeader` menu items, `App.svelte`
  handlers). This is the "command palette" half and the most new infra.
  `TargetType` already has `"command"`.
- **Commits** — `commitsProvider` exists but is worktree-anchored
  (`mention-providers.ts:265`, requires `currentWorktreePath`). A global
  variant needs a workspace-wide commit source or a "search within the
  focused worktree" sub-mode.
- **Scope toggle UI** — let the user narrow the palette to the current
  repo/worktree vs. workspace-wide (the `SearchScope` plumbing is ready).

## Open questions

- Browser-tab `F11` fullscreen reliability (see migration note) — accept
  menu-only fallback in browser, or choose another Win/Linux key?
- Does the global palette also want a mouse affordance (a search box /
  ⌘F hint in the header), or keyboard-only for v1?
- Ordering for the no-query repos list — alphabetical, by `addedAt`, or
  by most-recently-active worktree?
