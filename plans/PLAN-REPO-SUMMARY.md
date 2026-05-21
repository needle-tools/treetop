# PLAN-REPO-SUMMARY.md — "What happened recently" per repo

Living plan. Sibling to [PLAN-SUMMARIZE.md](./PLAN-SUMMARIZE.md) (session
summaries) and [ollama.md](./ollama.md) (Ollama integration). Shares the
storage convention and the same local-Ollama pipeline, but is its own
feature: different input, different trigger, different surface.

## What we're adding, in one line

A small "What happened recently" strip under each repository row,
showing a one-paragraph summary of the last day's commits and file
changes, generated locally with Ollama and cached aggressively so
it fires once per morning at most.

## Why this is worth building

The dashboard's main pillar is "many repos, many agents, many
worktrees in parallel" — and the first thing a developer needs each
morning is *which repo did I leave something hanging in?* Reading
`git log` across N repos by hand defeats the dashboard premise. A
one-paragraph prose summary per repo, written once when you first
open the dashboard, lets the user skim "yesterday's state" in
seconds.

This is the right *kind* of auto-summarization to lean into:
- Once-per-morning trigger → modest compute (1–3 runs per repo per
  day, not per minute).
- Small structured input (`git log --since=24h --stat`) → fast model
  runs, no 8K-context budget juggling.
- High signal-to-noise → matches what a 3B model is genuinely good
  at (compressing structured text into prose).

Contrast with the rejected "summarize every git state change" idea:
that would fire dozens of times per workday at 3–8 s of CPU each,
for marginal value over the existing badge.

## Scope

In:
- Per-repo, per-day cached summary at
  `<workspace>/summaries/repo-<repoId>.md`.
- Trigger: lazy on first repo-row render in a fresh dashboard
  session, gated by a `(lastSha, generatedAt)` freshness check.
- Source material: `git log --since=24h --stat` aggregated across
  the repo's worktrees + a per-worktree dirty-file count.
- UI: collapsed-by-default strip directly under the repo name row,
  one paragraph + a relative timestamp + a `↻` refresh icon.
- Per-repo opt-out via a flag in `repos.json` (default on).

Out (v1, defer):
- Cross-repo aggregation ("here's what happened across all 12
  repos"). Once per repo is enough; a digest is its own feature.
- Author breakdown ("Alice worked on X, you worked on Y"). Useful
  for team mode (v2+) — not for the solo MVP.
- Tying repo summaries to Linear/GitHub issue refs. Future.
- Auto-refresh on new commits during the day. v1 is morning-only;
  the `↻` button is the manual path for "give me an update."
- Live regeneration based on dirty working-tree state. The summary
  is *commit-anchored*; uncommitted edits show as "N dirty files
  in worktree X" but don't trigger a re-run on every save.

## User flow

1. User opens the dashboard for the day.
2. As each repo row renders, the daemon checks the on-disk cache:
   - No cache, OR `lastSha` differs from current `HEAD`, OR
     `generatedAt` is > 8 hours old → schedule a generation.
   - Otherwise, paint the cached summary immediately under the row.
3. Generation runs in the background (single-flight per repo). When
   it finishes, the dashboard receives an SSE notification and the
   strip fades the new summary in.
4. The strip is collapsed-by-default to a one-line preview (first
   ~80 chars + ellipsis). Click expands it to the full paragraph
   inline, plus the metadata footer.
5. The `↻` icon manually re-runs against the same model — same
   cache invalidation rules, but forced.

If no Ollama model is installed: the strip shows a tiny "Set up
Ollama to see recent activity summaries · install" hint. Single
click into the same install flow the session-summarize dialog uses.

## Trigger logic — the heart of "cheap"

```
shouldGenerate(repoId, currentSha):
    cached = readCache(repoId)
    if cached is null:
        return "missing"
    if cached.frontmatter.lastSha != currentSha and cached.commitCount > 0:
        return "new-commits"
    if hoursSince(cached.frontmatter.generatedAt) > MAX_AGE_HOURS:
        return "stale-age"
    return null      # cache is fresh — paint and stop
```

Defaults:
- `MAX_AGE_HOURS = 8` — long enough that a midday return to the
  dashboard doesn't trigger a re-run; short enough that an evening
  return after morning-only commits sees today's state, not
  yesterday's.
- Lazy generation: we only schedule when the row paints, not on a
  timer. A user who never opens repo X today gets no work done for
  repo X today.
- Single-flight per `repoId`: a re-paint during generation joins
  the existing promise instead of double-firing.
- `--since` window for `git log`: 24 hours. Captures "what happened
  yesterday and this morning" without dragging in week-old work.

What we never re-run on:
- Working-tree file saves (filesystem watcher events). The summary
  is commit-anchored.
- Background fetches that don't change `HEAD` for the local
  branches we track.
- Dashboard auto-refresh from `/api/stream`. Only the explicit
  freshness check fires generation.

## Source material — what we feed the model

The prompt's user-message body is a structured digest, not raw
`git log`:

```
Repository: supergit
Branches active in last 24h: main (12 commits), feat/audio (3 commits)
Dirty worktrees: 1 (3 unstaged files in feat/xr)

Commits, newest first:
  - 2c7f850  Marcel  3h ago  ollama summary
    +180 / -12 across 4 files
  - 2903cb4  Marcel  6h ago  Fix Ctrl+V paste in terminal on Windows
    +47 / -3 across 2 files
  - be6b866  Marcel  9h ago  Graceful prod restart: /api/shutdown + start.ts auto-stop
    +210 / -22 across 6 files
  …

Files most touched:
  packages/daemon/src/server.ts    +540 / -45
  packages/daemon/src/sessions.ts  +120 / -8
  packages/ui/src/SessionView.svelte +95 / -2
```

This shape is built by a pure helper in
`packages/daemon/src/repo-summary.ts`:

```ts
export interface RepoActivity {
  repoName: string;
  branches: { name: string; commitCount: number }[];
  dirtyWorktrees: { path: string; unstaged: number; staged: number }[];
  commits: {
    sha: string;
    author: string;
    relTime: string;
    subject: string;
    insertions: number;
    deletions: number;
    files: number;
  }[];
  topFiles: { path: string; insertions: number; deletions: number }[];
}

export function collectRepoActivity(
  repoPath: string,
  sinceHours: number,
): Promise<RepoActivity>;

export function formatActivityPrompt(activity: RepoActivity): string;
```

`collectRepoActivity` is the I/O surface; `formatActivityPrompt` is
the pure rendering function (easy to unit-test).

## Prompt shape

```
You are a precise technical summariser. The user opens this
repository each morning; below is what was committed and changed
in the last 24 hours. Write a single brief paragraph — under 300
characters — describing what was worked on and where things stand.
Address the developer as "you", not "the user". Plain text only:
no markdown, no bullets, no headings, no backticks. Do not echo
the commit list back.
```

The agent-name context from session summaries (`Claude Code` /
`Codex`) doesn't apply here — the input is git history, not a chat.

## Storage

`<workspace>/summaries/repo-<repoId>.md` — one file per repo. Same
markdown + YAML frontmatter convention as session summaries, with
repo-specific keys:

```markdown
---
repoId: 4f3a92ec
repoName: supergit
repoPath: /Users/marcel/git/supergit
model: llama3.2:3b
lastSha: 2c7f8501a9b2e3f4
generatedAt: 2026-05-21T08:15:42.000Z
sinceHours: 24
commitCount: 7
dirtyWorktreeCount: 1
totalInsertions: 540
totalDeletions: 80
estimatedTokens: 420
elapsedMs: 3120
---

You spent yesterday landing the Ollama summarize feature and a
Windows paste fix, mostly in the daemon and SessionView. One worktree
(feat/xr) still has three unstaged files — likely where you'll pick
up today.
```

`repo-` prefix on the filename so a single directory holds both
session-keyed (`<sha256-hex>.md`) and repo-keyed (`repo-<id>.md`)
summaries without colliding. The session-summary key uses the
source-path hash; repo summaries use the workspace-assigned repo ID
verbatim (it's already URL-safe).

Reuses `SummariesStore` with a small extension:
- `keyForRepo(repoId: string): string` → returns `repo-<id>`.
- The existing `read` / `write` / `delete` / `staleness` methods
  operate on the cached file; repo summaries get their own
  trigger logic (above) because staleness is sha-based, not
  mtime-based.

A separate `RepoSummariesStore` thin wrapper could own the
sha-staleness check + the `RepoSummaryFrontmatter` type. Cheaper
than baking repo-shaped fields into the existing frontmatter type
(which is session-shaped).

## Daemon surface

New module: `packages/daemon/src/repo-summary.ts`.

Pure helpers:
- `collectRepoActivity(repoPath, sinceHours)` — git log + diffstat
  + dirty-worktree counts.
- `formatActivityPrompt(activity)` — the structured digest string.
- `shouldGenerate(cached, currentSha, maxAgeHours)` — returns
  `"missing" | "new-commits" | "stale-age" | null`.

New endpoint: `POST /api/repos/:id/summarize`.

Body: `{ model?: string; force?: boolean }`. `model` defaults to the
last-used summarize model from the workspace settings (fall back to
`llama3.2:3b`). `force: true` bypasses the freshness check.

Response: same SSE shape as `/api/sessions/summarize` (`meta`,
`chunk*`, `done` / `error`). On `done` the daemon writes the result
to `<workspace>/summaries/repo-<repoId>.md`.

New endpoint: `GET /api/repos/:id/summary`.

Returns `{ summary: {...} | null, stale: boolean, reason?: "missing" |
"new-commits" | "stale-age" }`. The UI calls this on row render;
when `stale` is true it kicks off the POST in the background and
paints the cached body in the meantime.

## UI surface

A new component: `packages/ui/src/RepoRecentSummary.svelte`. Owns:
- One-line collapsed preview (default) with relative timestamp +
  `↻` icon.
- Click to expand → full paragraph inline.
- Spinner state during generation (same shape as the session chip).
- "Install Ollama" affordance when models probe returns empty.

Mounted in `App.svelte`'s repo-row template, directly below the
repo name. Always rendered when the repo opts in; renders nothing
when opted out (so the dashboard layout is identical for opt-out
users — no empty slot).

State plumbing:
- A small Svelte store `repoSummaries` keyed by `repoId`, lazily
  populated as rows render. Prevents N parallel fetches when 12
  repos paint at once.
- SSE `change` events with `{ kind: "repo_summary", repoId }`
  invalidate the store entry so the row re-fetches and animates
  the new summary in.

## Tests (TDD first, per CLAUDE.md rule #1)

In `packages/daemon/test/repo-summary.test.ts`:
- `formatActivityPrompt` shape: stable output for a fixed input
  (snapshot-ish — assert on key substrings, not the whole blob).
- Empty activity (no commits in the window, no dirty worktrees) →
  returns a sentinel string the route can detect ("Nothing to
  summarise").
- `shouldGenerate` truth table: missing cache, sha differs,
  sha-matches-but-old, fresh cache.
- Edge cases:
  - Commit count > 50 — the digest must clip the list and surface
    `"… and 30 more commits"` so the prompt stays bounded.
  - Files-touched list capped to top 10 by `|insertions| +
    |deletions|`.

In `packages/daemon/test/repo-summary-route.test.ts`:
- Happy path: temp repo + temp workspace + fake Ollama → POST
  returns SSE → `repo-<id>.md` on disk with the expected frontmatter.
- `GET /api/repos/:id/summary` returns `summary: null` when none
  exists, returns the cached payload + `stale: "new-commits"` when
  a fresh commit lands after the cache was written.
- `force: true` bypasses the freshness gate.
- Opt-out (repo's `summarizeRecent: false`) → POST returns 409.

In `packages/ui/test/repo-recent-summary.test.ts`:
- Collapsed preview shows first ~80 chars + ellipsis when paragraph
  is longer.
- Expand toggles to full paragraph.
- Spinner shown during refresh.

## Open trade-offs

- **`MAX_AGE_HOURS = 8`** is a guess. Worth a one-time review with
  real users: 4 might be too chatty, 12 might miss afternoon
  context. Tunable per-repo if it turns out the right number differs.
- **24-hour `--since` window** is also a guess. Friday → Monday is
  the case it fails: returning Monday you want "since Friday EOD,"
  not "since yesterday." Could grow to "since the last cached
  summary" once we have history. v1: literal 24 hours, simple.
- **Where to surface "no Ollama installed"** — inline in the strip
  is fine for v1, but if it becomes a recurring nag we should
  collapse it into a one-time workspace banner.
- **Per-repo opt-out granularity** — we could also have a
  per-worktree opt-out (skip backup worktrees) but that adds
  config surface for little gain. Default to repo-level.
- **Model choice for repo summaries vs. session summaries** —
  v1: one shared "last summarize model" setting. v2 if needed: a
  separate `summarizeRepoModel` so users can pair a cheap model
  with repo summaries and a beefier one with sessions.

## Anti-patterns to actively avoid

(Per CLAUDE.md hard rule #10.)

- **Don't fire on every `fs_change` event.** The watcher's whole
  point is to be cheap and bursty; piping it into an Ollama call
  is the exact compute trap we rejected earlier.
- **Don't background-pre-warm summaries for repos the user hasn't
  opened.** Lazy on first paint; nothing more.
- **Don't write the digest into the workspace event log.** It's a
  derived view; `events.jsonl` stays the source of truth.
- **Don't mock the git layer in tests.** Use a temp dir with real
  `git init` + a few commits, same way the existing
  `git.integration.test.ts` does it.
- **Don't add a "summary length" slider, a "tone" picker, or
  per-commit summarisation.** A small model has one good setting;
  this is a glance-able morning strip, not a writing assistant.

## Rollout

Single PR, self-contained. Touches:
- New: `packages/daemon/src/repo-summary.ts` + tests.
- New: `packages/ui/src/RepoRecentSummary.svelte` + tests.
- Light: `packages/daemon/src/server.ts` (two endpoints),
  `packages/ui/src/App.svelte` (mount the component in the repo
  row), `packages/daemon/src/summaries.ts` (the `keyForRepo`
  extension or a thin `RepoSummariesStore` wrapper).
- No schema changes to `repos.json` beyond an optional
  `summarizeRecent?: boolean` flag (additive, backward-compatible).

If the feature turns out wrong, deleting the component and the two
endpoints leaves no state behind beyond the cached `repo-*.md`
files, which a user can `rm` themselves.
