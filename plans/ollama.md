# ollama.md — Ollama support in supergit

Living notes on how supergit hosts Ollama as a third agent alongside
Claude Code and Codex. Captures what's wired, where the rough edges
are, and what we'd want to change if/when Ollama gets bigger usage.

## What we have

- **Detection** — `/api/agents/installed` probes the `ollama` binary
  via `resolveAgentBinary` (same well-known-prefix + PATH scan used
  for Claude/Codex). Models come from `/api/ollama/models`, which
  hits `http://127.0.0.1:11434/api/tags` first and falls back to
  parsing `ollama list` when the server isn't running.
- **Spawn** — `"+"` picker → Ollama row → submenu of installed
  models (lazy-loaded, with retry on error). Click a model →
  `ollama run <model>` PTY in the worktree's cwd. Model tag flows
  through `OpenSession.ollamaModel` → `SessionHeader.agentLabel` so
  the pill reads `qwen3-coder:30b`, not `ollama` — every Ollama
  column would otherwise carry the same label.
- **Persistence** — Ollama writes no transcript itself, so the
  daemon does it for us:
  - `<workspace>/ollama/<termId>.jsonl` gets a header on spawn
    (`model`, `wt`, `spawnCwd`, `createdAt`).
  - PTY output is buffered and flushed every ~3 s as
    `kind: "output"` entries (capped at 64 KB per flush).
  - Loading-spinner braille glyphs (U+2800–U+28FF + the trailing
    space `ollama run` prints between frames) are stripped at
    capture time — a thinking phase used to bloat the JSONL with
    thousands of `⠋ ⠹ …` frames nobody reads.
  - `kind: "exit"` is appended when the PTY ends. The decoder is
    flushed before the exit so the last chunk of model output
    isn't lost.
- **Read-only view on stop** — `OllamaTranscriptView` mounts on
  `__transcript__:ollama:<termId>` sources. It fetches the joined
  transcript from `/api/ollama/sessions/:termId/transcript`, strips
  ANSI (CSI/OSC/single-char ESC, lone CRs) for readability, and
  polls every 3.5 s while `alive`. Scrollable: same `height: 100%`
  + `flex: 1; min-height: 0` pattern SessionView uses, so long
  transcripts stay inside the column box instead of pushing it
  taller than its siblings.
- **Past sessions in the picker** — `scanOllama(workspacePath)`
  reads the headers and emits `AgentSession` entries; `detectAgents`
  takes a workspace path so it can include them. Clicking an Ollama
  row in the picker hits `normalizeSessionForOpen`, which translates
  the on-disk JSONL path into a `__transcript__:ollama:<termId>`
  source so the read view mounts (rather than the SessionView branch,
  which would try to parse the JSONL as Claude/Codex).
- **Stop spinner** — NewSessionCol now owns the 1 s cancellable
  grace window + `disposing` flag, mirroring the SessionView
  resume-in-terminal flow (commit 290cef3). Claude, Codex, and
  Ollama brand-new columns all behave the same on End Session.

## Resume vs. resume-with-context

Plain Resume spawns `ollama run <model>` clean — no memory of the
prior chat. That's a hard limit of the CLI: `ollama run` has no
notion of sessions on disk.

`OllamaTranscriptView` exposes a second button — **Resume with
context** — that:
1. Builds a primer string: `"Below is our previous conversation,
   please continue from where it left off; do not repeat it back."`
   followed by the ANSI-stripped transcript, clipped to the last
   16 KB.
2. Spawns a fresh `ollama run <model>` with the primer in the new
   `initialInput` field of POST `/api/terminals`.
3. Daemon waits 1.5 s for the TUI to draw its `>>> ` prompt (writing
   earlier loses the bytes — ollama's readline isn't yet listening),
   then `handle.write`s the primer. Best-effort: if the PTY died
   between scheduling and firing, we swallow.

This is the pragmatic-now mechanism. The trade-offs are real and
worth keeping in mind:

- **Ollama has no real session state.** The model sees the transcript
  as user text and continues from there. It's resume-shaped but not
  resume-quality — the model might re-greet, summarise what it
  thinks happened, or ignore parts of the primer.
- **Long transcripts get clipped.** 16 KB tail-clip keeps the WS
  write cheap and avoids overrunning small-context models, but the
  earliest turns are lost.
- **The PTY echoes the primer.** The user briefly sees the prior
  conversation re-paste itself, then the model's response. Not a
  bug — a consequence of feeding it through stdin — but worth
  knowing if it surprises someone reviewing this code.
- **No structured turns.** We dump the raw (stripped) transcript as
  one big paste rather than parsing it into `user:` / `assistant:`
  turns. The Ollama TUI's prompts (`>>> `) make this *possible*, but
  the parsing isn't reliable enough yet to bake in.

## Plan: API-driven chat mode

We've hit the ceiling of the PTY-paste approach. Sessions can't be
truly continued, models re-greet on resume, the 16 KB tail-clip drops
early turns, and the `>>> ` turn-parser is fragile. The fix the doc
above hints at — drive `/api/chat` directly with a structured
`messages[]` array — is what we're going to build. The TUI's own
state isn't pre-loadable (no `--from-history`, no `/load chat.json`),
so we replace the TUI with our own chat UI rather than try to feed
state into it.

The good news is most of the parts already exist:

- `SessionView.svelte` already renders `NormalizedMessage[]` with
  markdown, bubbles, the pinned-prompt strip, the header chip — it's
  the read-only view today. We add an input strip at the bottom and
  it becomes interactive.
- `parseOllamaJsonl` (`sessions.ts:419`) already reconstructs turns
  from captured PTY output. We extend it to also accept structured
  `turn` entries, and write those going forward.
- `<workspace>/ollama/<termId>.jsonl` stays the source of truth —
  same path, same picker enumeration. Old files keep parsing through
  the existing PTY path; new files use `turn` entries.

### On-disk format

Add one new entry kind to the Ollama JSONL — everything else stays:

```jsonc
{ "kind": "turn",
  "ts": "2026-05-21T10:15:00Z",
  "role": "user" | "assistant",
  "content": "...",
  "model": "qwen3-coder:30b" }
```

`turn` entries are the canonical record for API-driven sessions. The
existing `output` / `model` / `exit` entries are kept for back-compat
so old PTY-captured sessions still render in the picker and read view.

`parseOllamaJsonl` is extended:
- If the file contains any `turn` entries, build `messages[]` from
  them in order and **ignore** `output` chunks (they'd be redundant /
  conflicting).
- If the file has only `output` entries, fall back to the current
  PTY-stripping turn-splitter.

The daemon reads the same shape when reconstructing `messages[]` to
send upstream — one parser, one source of truth.

### Daemon

New endpoint: `POST /api/ollama/chat` (SSE).

Request body:
```jsonc
{ "termId": "abc12345",
  "content": "user message" }
```

Behavior:
1. Read `<workspace>/ollama/<termId>.jsonl`, reconstruct `messages[]`
   via the unified parser, append `{role:"user", content}`.
2. Open a streaming `fetch` to `http://127.0.0.1:11434/api/chat` with
   `{ model, messages, stream: true }`. Model comes from the JSONL
   header (`model` field).
3. Forward each NDJSON chunk to the SSE response as it arrives.
4. On stream completion, write two `turn` entries to the JSONL — the
   user turn (with the request ts) and the assistant turn (with the
   completion ts + accumulated content + model that produced it).
5. On client disconnect, abort the upstream fetch and still persist
   whatever assistant content was received (partial turn marked with
   `partial: true` — better than losing it).

Spawning a new chat: `POST /api/ollama/sessions` creates a fresh
JSONL with just the header (no PTY at all). Returns `{termId}`. The
"+" picker → Ollama → model now hits this instead of
`/api/terminals`.

The old `/api/terminals` Ollama path stays for one release as the
"open as TUI" escape hatch, hidden behind a debug toggle. Then it
goes.

### UI

`SessionView.svelte` gets an optional input strip rendered when
`agent === "ollama" && initialMode === "read"`. The strip:
- A textarea (Shift+Enter newline, Enter sends).
- A Send button and a Stop button (Stop shows mid-stream).
- Streams responses into a new assistant bubble that grows as
  chunks arrive. Same markdown renderer SessionView already uses;
  re-parse on each chunk, debounced to ~60 ms so streaming doesn't
  thrash the layout.

`OllamaTranscriptView.svelte` becomes a thin shim around the new
`SessionView` mode and loses the "Resume" / "Resume with context"
dispatch — those concepts go away. Past sessions in the picker open
the same column they always had; clicking the input strip and
hitting Enter just continues the chat.

`NewSessionCol.svelte` switch: the Ollama submenu's "click a model"
handler stops POSTing to `/api/terminals` and instead POSTs to
`/api/ollama/sessions`, then opens the resulting `termId` in a
`SessionView` column directly (no transcript-source path indirection
needed; the daemon can serve the same `/api/session?source=…` URL
once we plumb the JSONL path through).

### Migration

- Old PTY-captured JSONLs (only `output` entries): keep working in
  read mode. If the user clicks "Continue chat" on one, we *do* let
  them — we just take the PTY-parsed `messages[]` as the seed and
  start writing `turn` entries from the new turn onward. The history
  rendering will look mixed (old turns from PTY parsing, new turns
  from structured entries) but that's fine.
- No db migration. New code, old data, one parser.

### Risks / edge cases

- **Streaming cancel**: the Stop button needs to abort the upstream
  `fetch`. Use an `AbortController` per active chat in the daemon,
  keyed by `termId`. Client disconnect or explicit DELETE
  `/api/ollama/chat/:termId` triggers the abort.
- **Context window overflow**: as the conversation grows, eventually
  we exceed the model's context. v1 strategy: drop oldest turns
  until we fit (with a system-message hint like "earlier turns
  omitted"). v2: auto-summarize older turns via
  `ollama-summarize.ts`, which already exists for the session-summary
  feature. Land v1 first.
- **Concurrent writes**: the JSONL append is single-writer (one
  active chat per `termId`), but a long generation that the user
  cancels could race with the abort-write. Serialize writes per
  `termId` through a small in-memory mutex.
- **Markdown rendering of partial chunks**: marked.parse on a
  half-emitted code fence renders weirdly. SessionView already
  handles this for streaming Claude/Codex output via debounced
  re-render; reuse the same code path.
- **Picker dedup**: the existing "live PTY + on-disk header = two
  entries" bug (see Open / nice-to-have below) gets *fixed by this
  change* — there's no separate PTY anymore, just the JSONL.

### Order of work

1. Daemon: extend `parseOllamaJsonl` to read `turn` entries. Test
   round-trip parsing of both old PTY format and new turn format.
2. Daemon: `POST /api/ollama/sessions` (create empty session) +
   `POST /api/ollama/chat` (stream). Test against a real local
   model with a multi-turn conversation.
3. UI: add the input strip to `SessionView`. Wire Send/Stop.
4. UI: switch the "+" picker's Ollama path to the new
   `/api/ollama/sessions` endpoint. Keep the old `ollama run` PTY
   path behind a `?legacyOllama=1` toggle for one release.
5. Remove `OllamaTranscriptView`'s Resume / Resume-with-context
   buttons (the input strip replaces both). Keep the file as a
   pure shim that sets `agent="ollama"` + the model pill.
6. After one release of soak: delete the legacy PTY path + the
   spinner-strip, `output`-flush, and primer code in `server.ts`.

### What stays / what goes

Stays:
- `<workspace>/ollama/<termId>.jsonl` as the on-disk format and
  picker source.
- Per-turn `model` attribution (already in NormalizedMessage.author).
- Header pill, dock dot, worktree-row session count.

Goes (eventually):
- PTY-capture flush loop and spinner-strip (server.ts:1478-1531).
- The 1.5 s primer-write delay (server.ts:1539-1547).
- The PTY-transcript turn-splitter (`splitOllamaTurns`) — replaced by
  reading structured `turn` entries.
- Read-only-vs-interactive distinction for Ollama columns — there's
  just one mode.

## Open / nice-to-have

- Picker dedup: a live Ollama session shows up twice if the user
  opens the worktree picker — once as the live PTY, once as the
  on-disk header that `scanOllama` finds. Not a correctness bug, the
  source strings differ, but cleaner would be to fold the two into
  one entry that knows it's live.
- Spinner-strip regex is conservative — it only catches braille +
  trailing space. If Ollama swaps to a different spinner (dots,
  ASCII art) we'd start storing them again. Probably fine since
  they're already periodic-flushed, not hot-path.
- `/api/ollama/models` doesn't cache. Each picker open re-hits the
  HTTP API. Fast enough today but if a user has dozens of cloud
  models the response can be 100 KB+.
- Header file isn't touched after spawn except for `output`/`exit`
  appends. If a user renames a model on Ollama's side, the captured
  `model` field can go stale. Low impact — we use it as a label,
  not a key.
