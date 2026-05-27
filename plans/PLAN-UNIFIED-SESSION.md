# supergit — plan: unified session column

## Problem

Two separate components render "a live TUI session":

- **NewSessionCol** — fresh sessions (Claude, Codex, shell). Shows a
  SessionHeader + TerminalView. No chat transcript visible even though
  Claude is writing messages from the first second.
- **SessionView (terminal mode)** — resumed sessions. Shows the chat
  transcript + TerminalView embedded at the bottom.

This causes:
1. **Feature duplication** — any terminal feature (SSH detection,
   awaiting-input wiring, working state, title editing) must be wired
   in both components. SSH Browse Files currently only works in
   NewSessionCol.
2. **UX gap** — fresh Claude sessions show no chat history while the
   TUI is alive. The user can't see what Claude is writing until they
   close the TUI and reopen in read mode. Resumed sessions show the
   full transcript. Same thing, different experience.
3. **Confusing naming** — "NewSessionCol" handles reattached shells
   (`__attached__:shell:`) which aren't new at all.

## Goal

One component for all live terminal sessions. Fresh and resumed are
the same — the only difference is the transcript starts empty vs
pre-populated.

## Proposed architecture

```
UnifiedSessionCol
├── SessionHeader (existing, shared)
├── ChatTranscript (optional, shown when JSONL exists)
│   └── streams messages in real-time from the JSONL
└── TerminalView (existing, shared)
```

For shells (no JSONL): just header + terminal (same as today's
NewSessionCol).

For Claude/Codex:
- **Before JSONL detected**: header + terminal (like today)
- **After JSONL detected**: header + streaming transcript + terminal
- **After TUI exits**: header + full transcript (read mode, Resume button)

The transcript component streams from the daemon's session endpoint,
polling or using SSE to pick up new messages as Claude writes them.

## Migration path

1. **Extract terminal features into a shared store** — SSH detection,
   sync state, cwd tracking. TerminalView writes to the store,
   App.svelte reads it. No parent component wiring needed.

2. **Build the streaming transcript** — a lightweight component that
   tails the JSONL and renders new messages. Doesn't need the full
   SessionView machinery initially — just the message list.

3. **Merge NewSessionCol into SessionView** — SessionView gains the
   ability to render in "fresh" mode (no transcript yet, just terminal).
   Source-string detection in App.svelte routes everything through
   SessionView. NewSessionCol is deleted.

4. **Clean up source strings** — `__new__:` and `__attached__:` become
   implementation details of SessionView, not separate render branches
   in App.svelte.

## Risks

- **SessionView is already 2000+ lines.** Absorbing NewSessionCol's
  lifecycle makes it bigger. May need to extract sub-components first
  (TranscriptView, TerminalEmbed).
- **Shell transcripts are different from agent transcripts.** Shells
  use ShellView (command history), agents use the message list. The
  unified component needs to handle both, or shells stay separate.
- **Performance** — streaming the transcript while the TUI is alive
  means more DOM updates. Need to verify scrolling stays smooth with
  both transcript and terminal active.

## What this unlocks

- SSH Browse Files works everywhere (terminal store, not component wiring)
- Fresh Claude sessions show live chat as it happens
- One place to add terminal features (not two)
- Cleaner source-string handling in App.svelte
- Rename: NewSessionCol → deleted, SessionView → SessionCol or just Session

## Priority

Medium — the current architecture works but creates friction every time
we add a terminal feature. The SSH file browser was the first real pain
point. The streaming transcript is a UX win on its own.
