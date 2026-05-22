# PLAN-AGENT-USAGE.md — weekly/daily usage per coding agent in the menubar

**Status: proposed** (not started). Captured 2026-05-22 from a menubar
review session.

## Why

The fixed `<nav class="menubar">` in the top-right now hosts TUIs /
Notes / Undo / Events. The user wants a fifth chip that surfaces, at a
glance, **how much they've used each coding agent**:

> "an option that shows me my weekly usage per coding agent — maybe an
> agent logo and when I hover it I get a tooltip with weekly and daily
> stats."

Today the daemon already knows which agent owns each session
(`packages/daemon/src/agents.ts`, the session-share/import paths, the
TUIs popover) but it doesn't aggregate "how much you used Claude this
week vs. today." This plan wires that up.

## Sketch

### Menubar chip

- New `.actions-anchor` between TUIs and Undo (so the destructive
  Undo/Events chips stay on the right edge where the user expects
  them).
- Renders as a compact row of agent **logos** only — Claude, Codex,
  Ollama, Copilot — sized to match the menubar's existing 0.78rem
  buttons (icons ≈ 14px). No text label, no count badge by default;
  the icons themselves are the affordance.
- Hover the chip → tooltip with **all agents**' weekly + daily summary
  in one card (sortable by usage). Hover an individual logo inside the
  chip → narrower tooltip for just that agent. Use the existing
  `<Tooltip>` (`packages/ui/src/Tooltip.svelte`) for both — it already
  supports nested hover and the menubar's z-index stack.
- Greyed-out logo = agent detected but no usage in the active window.
  Hidden logo = agent never detected on this host (so the chip
  collapses to whatever's actually relevant).

### Tooltip content

Per agent:

```
Claude                       (logo, brand colour)
  Today   4 sessions · 1h 12m · 32k in / 4.5k out
  Week   21 sessions · 8h 04m · 240k in / 38k out
  Top repo: supergit (45% of week)
```

- **Sessions** = distinct session IDs that had ≥1 turn in the window.
- **Time** = sum of session "active windows" (first turn → last turn
  per session). Open question below on whether to use PTY uptime
  instead.
- **Tokens** = `input_tokens + cache_read_input_tokens` and
  `output_tokens` from Claude's JSONL `message.usage`. Omit the token
  line for agents whose transcripts don't carry token counts (Ollama,
  shells).
- **Top repo** = the repo accounting for the largest share of the
  agent's week, derived from the session's cwd → repo lookup the
  TUIs popover already does (`tuiContext` in `App.svelte`).

## Data path

### Daemon

New route:

```
GET /api/agent-usage
  → { asOf, windows: { today: {…}, week: {…} }, agents: { claude: {…}, codex: {…}, ollama: {…}, copilot: {…} } }
```

- `today` = rolling 24h (or local-midnight — see open question).
- `week` = rolling 7d.
- Per agent: `{ sessions, durationMs, messages, tokens?: { in, out, cacheRead }, topRepo?: { name, fraction } }`.

Sources to scan, per agent:

- **Claude**: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
  Token usage is on every `assistant` turn's `message.usage`. The
  existing session-share code already enumerates these roots; reuse
  its enumerator instead of writing a new walker.
- **Codex**: `~/.codex/sessions/**/*.jsonl` (path varies by OS — same
  enumerator as session-share).
- **Ollama**: daemon owns Ollama session state directly; pull from
  whatever store `packages/daemon/src/server.ts` already maintains
  for the Ollama transcript view.
- **Copilot**: TBD — detection only today, no transcript log we own.
  Skip in v1; surface as "—" in the tooltip.

Caching strategy:

- In-memory aggregator behind the route. First call does a full scan
  (bounded by mtime — files older than 7d are skipped); subsequent
  calls within a 60s TTL return the cached result.
- Invalidation: subscribe to the daemon's existing `fs_change`
  pipeline (the one `activityByCwd` rides on) so the next call after
  a new JSONL line gets fresh numbers without polling.

### UI

- New `agentUsage` store (TS, in `App.svelte` or a small helper if
  the component is getting too dense — TBD, but defer the extract).
- Fetch on mount + every 60s while the menubar is mounted. Refetch
  on chip open for immediate freshness.
- The chip renders from `agentUsage.agents[agent]`; the tooltip body
  is a new small component (`AgentUsageTooltipBody.svelte`,
  paralleling `ChangedFilesTooltipBody.svelte`) so the rendering
  isn't tangled into App.svelte.

## Phasing

1. **v0 — wiring.** Add the chip + tooltip with a stubbed daemon
   endpoint that returns canned numbers. Lets us iterate on the
   tooltip's visual density before committing to the scanner.
2. **v1 — Claude scanner.** Real numbers from Claude's JSONL.
   Tokens, sessions, time, top repo.
3. **v2 — Codex + Ollama.** Same shape; Codex maps cleanly to the
   Claude path. Ollama uses daemon's existing in-memory data.
4. **v3 — polish.** Tiny inline sparkline next to each agent for
   "trend over last 7 days." Click chip → permalink to a deeper
   per-agent page (out of scope here).

## Open questions

- **"Active time" definition.** Sum of (last turn − first turn) per
  session is honest but undercounts long "thinking" PTYs. PTY uptime
  overcounts when the user just left the terminal open. Lean toward
  the JSONL-based number and call it "engaged time" in the tooltip.
- **Window edges.** Rolling 24h/7d or local-midnight + Monday week
  starts? Rolling is simpler and avoids timezone surprises in the
  CI; calendar is what users intuitively read. Default: rolling, with
  the asOf timestamp shown in the tooltip footer.
- **Cost estimate.** Tempting to multiply tokens by model price for a
  $/day figure, but per-session model varies (Sonnet 4.6 vs Opus 4.7)
  and pricing changes. Defer — show tokens, let the user do the math
  if they care.
- **Privacy / share session.** When a session is shared via
  session-share, do remote turns count toward the host's stats?
  Probably yes (the host machine *did* spend the cycles), but flag
  in the tooltip with a small "incl. shared" hint.

## Anti-scope

- Not a billing dashboard. No per-model cost breakdown, no exports,
  no historical archive beyond 7 days.
- Not a leaderboard. Single-user host stays the v0/v1 surface; if
  multi-user lands (PLAN.md v2 invitable workspaces), agent-usage
  per member is a separate plan.
- Not a session browser. Hover gives summary stats; the deeper view
  is v3+ and out of this plan's scope.
