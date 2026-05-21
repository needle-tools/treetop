# PLAN-SUMMARIZE.md — "Summarize with Ollama" for sessions

Living plan. Not a spec — captures the design + the open trade-offs so
the implementation can stay TDD per [DEVELOPMENT.md](./DEVELOPMENT.md)
and not drift. Companion to [ollama.md](./ollama.md) (current Ollama
integration) and [PLAN.md](./PLAN.md) (overall dashboard direction).

## What we're adding, in one line

A "Summarize" menu item on every session column that ships a sampled
start+middle+end of the conversation to a local Ollama model and
streams the summary back into a small dialog. If no suitable model is
installed, we ask the user before pulling one.

## Why this is worth building

Long Claude/Codex sessions get unreadable past a few hundred turns.
The dashboard already knows where the session lives on disk and has
the parsed message stream (`/api/session`), and we already speak
Ollama (`packages/daemon/src/ollama.ts`). The missing piece is a
single button that turns "5 hours of agent work" into a paragraph the
user can read in 20 seconds — and we can do it 100 % locally, no API
key, no egress. That's the kind of feature that earns the dashboard
its keep.

## Scope

In:
- Burger-menu item "Summarize with Ollama" on Claude, Codex, and
  Ollama (read-only) session columns.
- Sampling: user + assistant turns only, start/middle/end slices with
  an omission marker between them and per-message truncation so the
  prompt fits a small model's context.
- Streaming summary in a small modal dialog over the session column.
- First-run flow when no suitable model is installed: a confirm
  dialog offers to `ollama pull <default-small-model>`; user can
  decline and pick a different installed model from a dropdown
  instead.

Out (v1, defer):
- Surfacing summaries as sticky-link chips on the worktree row.
  (Possible follow-up — see "Storage" below for the file shape that
  would make this easy.)
- Summarizing across sessions / across worktrees.
- Non-Ollama backends (no Claude / OpenAI / etc.). The pitch is
  local-first; users with API keys can already copy-paste into their
  preferred chat.
- Tool-call / thinking-block summarization. We deliberately drop
  these in v1 — too noisy, and a small model wastes its context
  rendering `Edit(file_path=…)` tool inputs.

## User flow

1. User clicks the burger menu on any session column → picks
   **Summarize with Ollama** (new item, between "Copy session ID +
   path" and "Save as link").
2. Modal opens, anchored over the session column. Top row: model
   picker (defaults to the smallest installed model that fits the
   default budget; user can change). Below: empty area waiting for
   the stream.
3. Daemon checks `<workspace>/summaries/` for a cached summary
   keyed to this session. If one exists *and* the session file's
   mtime matches what was recorded when the summary was generated,
   it loads instantly and the modal shows a **Refresh** button
   instead of streaming. If the source has new turns since (mtime
   advanced) we show the stale summary with a "Session has 47 new
   messages since this summary — Refresh?" banner.
4. Otherwise the daemon samples the session, builds the prompt,
   opens a streaming request to Ollama. Tokens arrive into the modal
   as the model generates them. On `done` we write the result to
   `<workspace>/summaries/<key>.md` with frontmatter. Footer shows
   "Summarized 412 messages → 127 tokens in 4.2 s".
5. Copy button copies the rendered summary; close button dismisses.

If no model is installed (or none small enough to be useful):
1. Modal opens in "install" mode instead. Body: "No local model
   detected. Install `llama3.2:3b` (≈ 2.0 GB)?" with **Install** and
   **Cancel** buttons. (Default model name is configurable — see
   "Default model" below.)
2. Install kicks off `ollama pull <model>` in a background task; we
   stream the progress lines from the CLI into the same modal so the
   user sees something happen.
3. On success, we flip the modal to summarize mode and run the
   sampler. On failure, surface the error verbatim and leave the
   dialog open with a Retry.

## Default model

`llama3.2:3b` — small (~2 GB), fast, multilingual, available from
Ollama's default registry, has a 128 K context window. The 3B size
fits comfortably on every machine that already runs the dashboard.

Picker order at modal open:
1. Most-recently-used summarization model (persisted in the workspace
   as `summarize.lastModel`).
2. Default (`llama3.2:3b`) if installed.
3. Smallest installed model whose name suggests text generation
   (skip embeddings — match by `details.family` not containing
   `bert`/`nomic`, or by `name` not ending in `embed`).
4. Anything installed.

Override: env `SUPERGIT_SUMMARIZE_DEFAULT=<model>` for users who'd
rather we propose `qwen2.5:3b` or `phi3:mini`. Honoured only when the
named model is in the installed list.

## Sampling — the heart of this feature

The prompt sent to the model has three pieces in order:
1. **System instruction** — what we want back.
2. **Sampled transcript** — start + middle + end with explicit
   `[… N messages omitted …]` markers between them.
3. **Final ask** — "Now summarize." (so the model can't drift mid-list
   into thinking it's the user talking).

Budget. We aim for a prompt that fits in **8 K tokens** regardless of
the model's actual context window. Two reasons: (a) small models do
genuinely worse past their first few thousand tokens; (b) keeps the
default fast on a CPU-only machine. Override via
`?budget=<tokens>` on the summarize endpoint for power users.

Tokens are estimated at **chars ÷ 4** — same heuristic Codex's context
chip uses. Crude but consistent, and the only thing that needs to
hold is "we don't blow up the model" — being 20 % off is fine.

Slicing algorithm:
```
filtered = messages.filter(m => m.role in {user, assistant})
                   .map(m => flatten m.blocks to plain text)
                   .filter(text non-empty)
N = filtered.length
if N <= TARGET_MESSAGES (≈ 30):
    use all of them, only per-message truncation
else:
    headCount = TARGET_MESSAGES * 0.4   // 12
    tailCount = TARGET_MESSAGES * 0.4   // 12
    midCount  = TARGET_MESSAGES * 0.2   // 6
    head = filtered[:headCount]
    tail = filtered[-tailCount:]
    mid  = filtered[middleIdx - midCount/2 : middleIdx + midCount/2]
    omitted1 = N - headCount - midCount - tailCount  (messages between)
    omitted2 = computed for the second gap
emit head
emit "[… {omitted1} messages omitted …]"
emit mid
emit "[… {omitted2} messages omitted …]"
emit tail
```

Then iterate: if the joined transcript exceeds the budget, drop
TARGET_MESSAGES by ~20 % and retry; also clip each message body to
`MAX_MSG_CHARS` (start at 2 KB, shrink if still over budget).

This keeps the prompt deterministic: same input → same prompt, easy
to unit-test the sampler in isolation.

## Storage

Summaries live at `<workspace>/summaries/<key>.md` — one file per
session. Plain markdown with YAML frontmatter so a user can `cat` or
grep one without any tooling. The directory is created lazily on
first write (matches `<workspace>/ollama/` and `<workspace>/shells/`
precedent).

**Key derivation.** The source path (`/api/session`'s `?source=`
argument) is the natural identity but is an absolute filesystem path
— unsafe to drop into a filename verbatim. We hash it:

```
key = sha256(normalize(sourcePath)).slice(0, 16)
```

16 hex chars is more than enough for a single user's session
collection (collisions vanishingly unlikely; even at 100K sessions
the birthday probability is ≈ 10⁻¹⁰). The path is normalized first
(`resolve` + lowercase on Windows) so capitalization drift between
agent writers and our readers doesn't desync the key.

Why hash and not the session id: Ollama transcripts don't have one
in the Claude/Codex sense, and Claude session IDs are uuids but
nothing stops two different workspaces from referencing the same
session if a user copies a JSONL around. The source path is the only
stable handle for "this file on this machine."

**File shape.**

```markdown
---
source: /Users/marcel/.claude/projects/.../session-abc.jsonl
agent: claude
sessionId: 8f12-… (when known)
model: llama3.2:3b
sourceMtimeMs: 1747841234567
generatedAt: 2026-05-21T13:42:11Z
includedMessages: 28
totalMessages: 412
truncatedMessages: 3
estimatedTokens: 1840
elapsedMs: 4231
---

<the summary markdown, as the model produced it>
```

Frontmatter is authoritative for staleness checks (`sourceMtimeMs`)
and the footer diagnostics on reload. The body is just the model's
output — no post-processing, so a user can copy-paste and trust what
they see is what we'll re-show.

**Staleness.** On dialog open the daemon reads the frontmatter and
compares `sourceMtimeMs` to the current `stat(source).mtimeMs`:
- Equal → "Cached" badge + Refresh button.
- Source newer → "Stale (N new messages)" badge + Refresh button.
  `N` comes from re-parsing the session and diffing message count
  against the recorded `totalMessages`.
- Source older somehow (clock skew, restored backup) → treat as
  stale.

**Concurrency.** Writes go through `appendFile`-like atomic replace:
write to `<key>.md.tmp` then `rename`. Prevents a half-written file
on a kill mid-stream. The streamed UI keeps a live buffer; only the
final concatenated text reaches the disk.

**Lifecycle.** Summaries are never auto-deleted. A user-visible
"Delete summary" button is in scope (small trash icon next to
Refresh) — the modal calls `DELETE /api/sessions/summarize` and the
file is removed. Removing the session itself (deleting the worktree,
unregistering the repo) does *not* cascade-delete summaries; they
stay in the workspace as low-cost history. Cleanup of orphans is a
"once we have enough that it matters" follow-up, not v1.

**Why not the event log.** `events.jsonl` is for actions ("user
added repo X", "agent committed Y") — embedding 1–5 KB markdown
blobs per summary makes every consumer of the event log pay for
weight they don't need. The `summaries/` directory keeps that
separation clean.

**Sticky-link follow-up.** Because summaries are plain files in the
workspace, the v2 path to "pin a summary as a worktree chip" is
trivial: extend the sticky-link schema with a `summary: <key>` kind
that resolves to `<workspace>/summaries/<key>.md`. No data migration
needed.

### What we do NOT include

- `thinking` blocks (internal reasoning — noisy, large)
- `tool_use` / `tool_result` blocks (file diffs, command outputs —
  the small model wastes its context parsing them)
- `system_reminder`, `ide_context`, `command` blocks (UI plumbing)
- `isMeta` user messages (already dropped by the parser)

If the resulting transcript is empty (a session that only ever did
tool calls — unusual but possible), the modal says
"Nothing to summarize: this session has no user / assistant text" and
stops. No API call.

## Daemon surface

New module: `packages/daemon/src/ollama-summarize.ts`.

```ts
export interface SampleOptions {
  /** Total user+assistant turns to keep. Default 30. */
  targetMessages?: number;
  /** Per-message character cap before truncation. Default 2048. */
  maxMsgChars?: number;
  /** Hard cap on the joined transcript in chars. Default 32 KB
   *  (≈ 8 K tokens). Triggers shrink-and-retry. */
  budgetChars?: number;
}
export interface Sampled {
  prompt: string;
  /** Diagnostics for the UI footer. */
  totalMessages: number;
  includedMessages: number;
  truncatedMessages: number;
  estimatedTokens: number;
}
export function sampleSessionForSummary(
  messages: NormalizedMessage[],
  opts?: SampleOptions,
): Sampled;
```

Pure function, no I/O — unit-tested directly. Pairs with one helper
that builds the full prompt (system + sampled + ask).

New module: `packages/daemon/src/summaries.ts` — owns the
`<workspace>/summaries/` directory: key derivation, read with parsed
frontmatter, atomic write (`.tmp` + rename), delete, list. Mirrors
the `OllamaSessionsLog` / `ShellsLog` shape so the daemon's storage
surface stays consistent.

New endpoint: `GET /api/sessions/summarize?source=<path>`.

Returns `{ summary: string, frontmatter: {…}, stale: boolean,
newMessageCount?: number }` when a cached summary exists,
`{ summary: null }` otherwise. Source path goes through the same
allowlist `/api/session` uses (Claude / Codex / Ollama roots only).

New endpoint: `POST /api/sessions/summarize`.

Request body:
```json
{
  "source": "<absolute session source path>",
  "model": "llama3.2:3b"
}
```

Response: `text/event-stream` with these event kinds:
- `event: meta` once at the start, carrying the `Sampled`
  diagnostics + the resolved model.
- `event: chunk` repeatedly, each carrying the latest delta from
  Ollama's `/api/generate` stream.
- `event: done` once, with the elapsed milliseconds. The daemon
  writes the final markdown + frontmatter to
  `<workspace>/summaries/<key>.md` before emitting `done`.
- `event: error` on failure (Ollama unreachable, model not found,
  disk full, …), closing the stream. On error nothing is written;
  any prior cached summary stays intact.

New endpoint: `DELETE /api/sessions/summarize?source=<path>`.

Removes the cached summary file for that source. Returns 204 on
success, 404 if there was nothing to delete.

Why SSE not chunked JSON: we already have SSE infra in the daemon for
file changes; same `broadcast`-shaped helper works, no extra deps,
and the UI's `EventSource` handling pattern is well-trodden.

Implementation: post to `http://127.0.0.1:11434/api/generate` with
`stream: true` and pipe its NDJSON response → our SSE chunks. Set
Ollama's `options.num_ctx` to `max(budgetChars / 4 * 1.5, 8192)` so
the model's KV cache is sized for the actual prompt, not its default
2 K cap.

New endpoint: `POST /api/ollama/pull`.

Request body:
```json
{ "model": "llama3.2:3b" }
```

Response: SSE stream of progress lines from `ollama pull <model>`
(stderr → `event: progress`, exit → `event: done` or `event: error`).
The `ollama pull` CLI writes nice human-readable progress; we just
forward the lines. Future: switch to the HTTP `/api/pull` endpoint
which streams structured JSON, but that needs us to handle the
shell-out-or-API fallback we already do in `ollama.ts`. Defer.

## UI surface

New component: `packages/ui/src/SummarizeDialog.svelte`.

Lifecycle: opened from SessionView's burger menu, anchored as a modal
over the session column. States:
1. **Probing** (50 – 200 ms) — parallel fetch of
   `/api/ollama/models` *and* `GET /api/sessions/summarize?source=…`.
   The cached-summary check decides whether we even need to stream.
2. **Cached** — when the GET returned a summary. Show it
   immediately, with a "Cached" or "Stale (N new messages)" badge
   pulled from the response. Buttons: Copy, Refresh, Delete, Close.
   Refresh transitions to Summarize state, reusing the same model.
3. **Install** — only when models-probe returns empty (or only
   embedding models) *and* no cached summary exists. Confirm/Cancel;
   on confirm, opens an SSE to `/api/ollama/pull` and shows progress
   lines. On done, transitions to Summarize.
4. **Summarize** — model picker at top (defaults per the picker
   order above), big body for the streamed summary, footer with the
   diagnostics. SSE to `/api/sessions/summarize`. Cancel button
   aborts the EventSource (and a server-side AbortController kills
   the upstream Ollama request). On `done` the dialog transitions
   to Cached (it's now on disk).
5. **Done / Cached** — copy + refresh + delete + close buttons.

The dialog reads markdown the same way SessionView does (the existing
`marked` setup), so the summary renders with paragraph breaks and
inline code, not as one wall of text.

Modal positioning: same overlay pattern as `ConfirmDialog.svelte` (we
already have a generic confirm). Lock body scroll while open.

Menu item plumbing: add an entry to `SessionView.svelte`'s `base`
array (between "Copy session ID + path" and "Save as link"), gated
on `messages.length > 0` and disabled with a tooltip when the session
is empty. Don't introduce a new prop — every column should have this
by default. The Ollama read-only column inherits it via the same
SessionView wrapper that already takes `extraMenuItems`.

## Tests (TDD — write these first per CLAUDE.md rule #1)

In `packages/daemon/test/ollama-summarize.test.ts`:
- `sampleSessionForSummary` with N < target → returns all messages,
  no omission markers.
- N >> target → returns head + middle + tail with two
  `[… N omitted …]` markers, in the right positions, counts add up.
- Per-message truncation: a single 10 KB user message gets clipped
  to `maxMsgChars` and ends with the standard `…<truncated>` suffix.
- Budget enforcement: a thousand normal-sized messages → joined
  transcript is ≤ `budgetChars`. The function shrinks `target` and/or
  `maxMsgChars` until it fits, surfaces `includedMessages` and
  `truncatedMessages` in the diagnostics.
- Drops `thinking`, `tool_use`, `tool_result`, `system_reminder`,
  `ide_context`, `command` blocks. A session of only tool calls →
  empty prompt + `includedMessages: 0` (the route will turn this
  into the "nothing to summarize" UI state).
- Token estimate matches the chars/4 heuristic the context chip
  uses (consistency test, not a precision claim).

In `packages/daemon/test/summaries.test.ts`:
- `keyFor(source)` is stable across calls and case-insensitive on
  Windows (uppercase drive letter vs lowercase ⇒ same key).
- Write → read round-trip: frontmatter values come back exactly,
  body bytes are unchanged.
- Atomic write: a forced failure mid-write leaves no `<key>.md`
  (only the `.tmp` discarded), so a stale half-summary can't be
  read back.
- `staleness(source, frontmatter)` reports `equal` / `newer` / and
  computes `newMessageCount` against the persisted `totalMessages`.

In `packages/daemon/test/server-summarize.test.ts`:
- `POST /api/sessions/summarize` with a valid `source` from a temp
  Claude JSONL → fakes the Ollama HTTP endpoint, asserts the SSE
  stream emits `meta` then ≥ 1 `chunk` then `done`, and that
  `<workspace>/summaries/<key>.md` exists with the streamed body +
  the expected frontmatter.
- `GET /api/sessions/summarize?source=…` after a successful POST
  returns the body + frontmatter + `stale: false`.
- Append a line to the source JSONL → GET now returns
  `stale: true` and a `newMessageCount > 0`.
- `DELETE` removes the file; subsequent GET returns
  `{ summary: null }`.
- Unknown source path → 403 on POST/GET/DELETE (same allowlist
  `/api/session` uses).
- Ollama unreachable → SSE emits a single `error` event then closes;
  HTTP status itself is still 200; no summary file written, and any
  prior cached file is untouched.
- `POST /api/ollama/pull` happy path → SSE forwards progress lines;
  abort closes the upstream child.

UI side, in `packages/ui/test/summarize-dialog.test.ts`:
- Probe → install mode flip when models list is empty.
- Probe → summarize mode when models list is non-empty.
- "Nothing to summarize" rendered when daemon returns
  `includedMessages: 0`.

## Open trade-offs (decide during implementation, not now)

- **Where to put the cancel button on the install screen.** Halting
  an `ollama pull` mid-download leaves a half-fetched blob on disk
  that Ollama will resume next time — fine, but the UX should say
  so. ("Cancel — already downloaded chunks are kept.")
- **Should `keyFor` include the model?** Right now one source has at
  most one cached summary — re-summarizing with a different model
  overwrites. Alternative is `<key>.<model>.md` so the user can keep
  per-model summaries side-by-side. v1: single file per source
  (simpler UI, simpler staleness check); revisit if multi-model
  comparison turns out to matter.
- **`/api/chat` vs. `/api/generate`.** `chat` takes a messages array
  and lets us put the system instruction in its proper slot; we'd
  send our sampled transcript as one `user` message. `generate`
  takes a single prompt string. `chat` reads cleaner but `generate`
  is what Ollama's docs lead with and survives older Ollama
  versions. Start with `chat`; fall back if compatibility issues
  show up.
- **Should the picker show cloud models?** `ollama list` includes
  cloud-hosted models with `size = 0`. They work the same way over
  the same HTTP API but require login. Probably yes (don't filter),
  but flag them in the picker so the user knows they leave the
  machine.
- **Hard-coding `llama3.2:3b` as the default to install.** It's a
  fine starting point but worth a one-time review at implementation
  time — `qwen2.5:3b-instruct` and `phi4-mini:3.8b` are both
  plausible alternatives. The env-var override keeps this from
  being load-bearing.

## Anti-patterns to actively avoid

(Per CLAUDE.md hard rule #10 and the anti-patterns list.)

- **Don't mock Ollama in the sampler tests.** The sampler is pure —
  no Ollama, no fetch. The HTTP/SSE tests need a fake Ollama, but
  the fake serves a *recorded* `/api/generate` NDJSON response, not
  a hand-stubbed object.
- **Don't add a "summary length" slider.** A small model has one good
  setting; expose it later if anyone asks.
- **Don't pre-warm the model on dashboard start.** `ollama run` keeps
  models hot for 5 min after last use anyway. Eagerly loading a 2 GB
  model on every dashboard boot would be hostile.
- **Don't tee the summary into the activity log silently.** If we
  decide to persist summaries later, that's a separate, opt-in
  feature. Surprise writes to the workspace are out.

## Rollout

Single PR. The feature is self-contained — new daemon module + two
new endpoints + one new UI component + one new menu item. The only
shared file we touch is `SessionView.svelte`'s `menuItems` block, and
the change there is a single new entry in the existing array. No
schema changes, no migrations. If anything in the design above turns
out wrong we delete one component and one menu entry; nothing else
is affected.
