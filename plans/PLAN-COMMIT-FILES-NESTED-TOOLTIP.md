# PLAN-COMMIT-FILES-NESTED-TOOLTIP.md — nested files-changed tooltip on commit rows

**Status: proposed** (not started). Captured 2026-05-22 from a dashboard
hover-UX session.

## Why

The ↑N / ↓N commit-list tooltip (see `.wt-tt-commits` in
`packages/ui/src/styles/worktree-row.css`, rendered from
`packages/ui/src/App.svelte`) shows sha / author / date / subject for
each unpushed or unfetched commit. Subject + author already give a
decent read on "what's this commit about" once the tooltip is wide
enough (see the recent `min-width` change on `.wt-tt-commits`), but
"what files did it touch" is still a click away — you have to expand
the worktree row, open Source Control, find the commit.

A nested hover popup on a commit row inside the tooltip would surface
the changed file list directly, the same way the changed-files tooltip
on the `dirty` pill surfaces unstaged/untracked files.

## Sketch

- **Trigger.** Hover any commit row (`.wt-tt-sha` … `.wt-tt-subject`
  group) inside the existing `.wt-tt-commits` grid. After a short
  delay (`showDelayMs` ≈ 200ms), open a nested popup.
- **Nesting / hover survival.** The outer Tooltip already exposes
  `TOOLTIP_HOVER_CTX` (see `packages/ui/src/Tooltip.svelte`) so a
  nested popup can call `cancelHide()` while the cursor is over it
  and `scheduleHide()` on leave. Reuse that contract — don't invent a
  new hover-pin mechanism.
- **Positioning.** The outer tooltip can be very wide
  (`min(64rem, 90vw)`), so the nested popup must `escapeClip` (portal
  to `<body>`, `position: fixed`) and anchor to the *commit row's*
  rect, not the trigger that opened the outer tooltip. Reuse the
  `portal` action from Tooltip.svelte and pass the row element.
- **Content.** List of changed paths with the same `+adds / -dels`
  numbers the changed-files tooltip uses (see
  `ChangedFilesTooltipBody.svelte`). Cap at ~20 paths with a
  "+N more" footer; the user can expand the row for the full list.

## Data path

Today `loadWtSummary()` returns `unpushedCommits` / `unfetchedCommits`
as `{ sha, subject, author?, date? }` only — no file info. Two
options, in order of preference:

1. **On-hover fetch.** New daemon route, e.g.
   `GET /api/commit-files?repo=<id>&sha=<sha>` returning
   `[{ path, adds, dels, status }]`. Fetched lazily on first hover of
   a commit row, cached per-sha (commits are immutable so cache can
   live for the session). Mirrors how `loadWtSummary` is fired from
   the outer Tooltip's `onShow`.
   - Pro: doesn't bloat the existing summary payload for the common
     case where the user never opens the nested tooltip.
   - Pro: cache keyed by sha, not worktree path — survives row
     expand/collapse and works across worktrees that share commits.

2. **Inline in `WtSummary`.** Extend `WtCommit` with
   `files: { path, adds, dels }[]` populated by the existing
   `loadWtSummary`.
   - Con: pays the cost up-front on every ↑N hover, even when the
     user doesn't drill into a specific commit. With
     `COMMIT_TOOLTIP_LIMIT = 10` that's up to 10× `git show --stat`.
   - Pro: zero round-trip on hover (snappier feel).

Default to (1) unless profiling says the round-trip is annoying.

## Open questions

- **Renames.** `git show --name-status` reports `R<score>` with
  `old → new`. Worth showing both? The changed-files tooltip today
  doesn't deal with renames (working tree status doesn't expose them
  the same way), so this would be net-new UI.
- **Submodules.** A commit that bumps a submodule SHA shows up as a
  modified `subproject` — what do we render? Probably "submodule
  <name>: <old>..<new>" with no adds/dels.
- **Binary / large.** `git show --numstat` returns `-` `-` for binary.
  Render as "(binary)" badge, no number.
- **Click target.** Should clicking a file row open it in the editor
  at that revision (à la `git show <sha>:<path>`), open the diff in
  Fork, or do nothing? "Open in Fork at this commit" is probably the
  cheapest useful action; defer the in-app diff viewer.

## Out of scope (deliberately)

- In-app diff rendering for the file (that belongs in the expanded
  Source Control pane).
- File-tree grouping (flat list is fine for the typical 1–20 paths in
  a commit; group only if profiling shows real commits with 100+
  paths in the wild).
- Hover-to-preview file contents (would need an editor surface — way
  out of scope for a tooltip).

## When to pick this up

After the current tooltip-width pass settles and we see whether users
actually reach for "what files?" while hovering the commit list. If
the answer is "rarely, they just expand the row," skip this entirely
— it's not worth the added complexity (round-trips, nested-hover
edge cases, portal positioning math) for a feature that mostly
duplicates what the expanded Source Control pane already shows.
