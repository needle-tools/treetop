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

### What "real" memory would look like

If Resume-with-context becomes important enough to invest in:

- **Abandon `ollama run` for resumed sessions** and talk to
  `POST /api/chat` directly with a `messages: [{ role, content }]`
  array reconstructed from the captured transcript. This is the only
  way to get true conversation continuity, because the API
  *actually* takes a messages array and the model sees it as prior
  turns, not user input.
- **Parse the captured transcript into turns.** `>>> ` lines start a
  user turn; everything between is the model's response. Tricky
  edge cases: multi-line user input (Ollama lets you continue with
  `\\` or paste), tool / system messages, and the model's own use
  of `>>> ` inside a response. Worth doing once we hit the wall on
  the PTY-paste approach.
- **Build a chat UI** for these resumed sessions instead of an
  xterm. Render markdown, show clear role boundaries, keep an editable
  history. Big effort — equivalent to writing a tiny Claude/Codex
  chat-side app, except for local models.

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
