# ollama.md — Ollama support in supergit

Living notes on how supergit hosts Ollama as a third agent alongside
Claude Code and Codex. Captures what's wired, where the rough edges
are, and what we'd want to change if/when Ollama gets bigger usage.

## What we have

Ollama is API-driven (no PTY). The "+" picker creates a chat
session via `/api/ollama/sessions`, and the user talks to it
through SessionView's in-bubble composer; the composer streams
chunks from `/api/ollama/chat` and writes structured user/
assistant turns to the JSONL.

- **Detection** — `/api/agents/installed` probes the `ollama`
  binary via `resolveAgentBinary` (same well-known-prefix + PATH
  scan used for Claude/Codex). Models come from
  `/api/ollama/models`, which hits
  `http://127.0.0.1:11434/api/tags` first and falls back to
  parsing `ollama list` when the server isn't running.
- **Create chat** — `"+"` picker → Ollama row → submenu of
  installed models (lazy-loaded, with retry on error). Click a
  model → `POST /api/ollama/sessions { model, wt, cwd }` →
  daemon writes the header file and returns a `termId`. The UI
  opens a `__transcript__:ollama:<termId>` column directly
  (OllamaTranscriptView is just a SessionView wrapper that sets
  the model pill label). Model tag flows through
  `OpenSession.ollamaModel` so the pill reads `qwen3-coder:30b`
  even before the daemon's next `/api/repos` rescan picks the
  file up into `wt.agents`.
- **Chat** — SessionView renders a composer strip for `agent
  === "ollama"`. Enter sends → `POST /api/ollama/chat` (SSE);
  the daemon reads the JSONL, reconstructs `messages[]`, proxies
  to Ollama's `/api/chat` stream, and writes one `kind: "turn"`
  entry per user/assistant turn on completion. The Stop button
  aborts the upstream fetch; the daemon persists the partial
  assistant turn with `partial: true` rather than losing it.
  SessionView's disk-sync `load()` skips its 2 s `/api/session`
  re-read while a stream is in flight so chunks don't get
  clobbered.
- **Persistence** — `<workspace>/ollama/<termId>.jsonl` holds:
  - One `kind: "header"` on session creation (`model`, `wt`,
    `spawnCwd`, `createdAt`).
  - One `kind: "turn"` per user/assistant turn
    (`role`, `content`, `model`, optional `partial: true`).
  - Per-`termId` write mutex so concurrent appends never
    interleave bytes mid-line.
- **Read view** — `OllamaTranscriptView` is a thin SessionView
  wrapper (no Resume button, no extra menu items). It fetches
  the canonical messages via `/api/session?source=<path>` and
  renders them with the standard bubbles. The chat composer at
  the bottom is the only continuation surface — there's no
  read/edit mode distinction.
- **Past sessions in the picker** — `scanOllama(workspacePath)`
  reads headers and emits `AgentSession` entries; clicking one
  hits `normalizeSessionForOpen`, which translates the on-disk
  JSONL path into a `__transcript__:ollama:<termId>` source so
  the same SessionView mount path runs.
- **Cancel semantics** — one in-flight stream per `termId`. A
  second `POST /api/ollama/chat` for the same termId aborts the
  prior; `DELETE /api/ollama/chat/:termId` aborts from a
  different tab; client disconnect (browser close, Stop) aborts
  via the ReadableStream's `cancel` callback.

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

### Status: done

All six steps have shipped. The legacy PTY path is fully removed:

1. ✓ `parseOllamaJsonl` reads `turn` entries; PTY-output fallback
   gone (old files render as header-only).
2. ✓ `POST /api/ollama/sessions` + `POST /api/ollama/chat` (SSE)
   are live; `DELETE /api/ollama/chat/:termId` cancels mid-stream.
3. ✓ SessionView renders a chat composer for `agent === "ollama"`
   with streaming chunks, Stop, and a waiting-spinner. `load()`
   skips its disk-sync while a stream is in flight so chunks
   don't get clobbered by a mid-stream poll.
4. ✓ The "+" picker calls `openNewOllamaChat` → `POST /api/ollama/
   sessions` → `__transcript__:ollama:<termId>` column directly.
   No PTY-toggle escape hatch — there's no reason to spawn
   `ollama run` from supergit anymore.
5. ✓ `OllamaTranscriptView` shrunk to a thin pill-labelling shim;
   Resume button + Resume-with-context menu item gone.
6. ✓ Legacy code deleted:
   - `server.ts` PTY-capture flush loop, spinner-strip,
     `OLLAMA_FLUSH_MS`/`OLLAMA_FLUSH_MAX`, `initialInput`
     primer-write delay, and the `/api/ollama/sessions/:termId/
     transcript` GET endpoint.
   - `ollama-sessions.ts` `OllamaOutputEntry` /
     `OllamaModelChangeEntry` types, `appendOutput`,
     `readTranscript`, and the PTY-fallback path in
     `readMessagesForChat`.
   - `sessions.ts` `stripAnsi`, `splitOllamaTurns`, the
     `segments` machinery in `parseOllamaJsonl`.
   - UI: `resumePastOllama`, `ollamaInitialInput`, the
     `s.agent === "ollama"` dispose branch, the `ollamaModel` /
     `initialInput` props on NewSessionCol + TerminalView, and
     the ollama branch in `cmdForOpenSession`.

### What stays

- `<workspace>/ollama/<termId>.jsonl` as the on-disk format and
  picker source.
- Per-turn `model` attribution via `NormalizedMessage.author`.
- Header pill, dock dot, worktree-row session count.
- `OpenSession.ollamaModel` (persisted so the pill label survives
  reloads before `wt.agents` rescans).

## Open / nice-to-have

- Context-window overflow: as the conversation grows, eventually we
  exceed the model's context. Current behaviour is "let Ollama
  truncate" (it'll drop oldest turns from its KV cache silently).
  Cleaner would be to auto-summarize older turns via the existing
  `ollama-summarize.ts` once we cross some threshold.
- `/api/ollama/models` doesn't cache. Each picker open re-hits the
  HTTP API. Fast enough today but if a user has dozens of cloud
  models the response can be 100 KB+.
- Header file's `model` is pinned at creation. If a user renames a
  model on Ollama's side, the label can go stale. Low impact — we
  use it as a label, not a key — but per-turn `model` overrides
  fix this automatically for new turns.
- Pre-cleanup PTY-captured Ollama JSONLs (with `output` entries)
  render as header-only. If you want to surface them as "this is
  archived; can't be continued" rather than empty, that's a render
  branch in OllamaTranscriptView — currently they look the same as
  a brand-new session.
