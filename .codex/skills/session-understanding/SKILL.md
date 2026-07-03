---
name: session-understanding
description: Inspect and summarize local Codex, Claude, and other agent session JSONL transcripts. Use when Codex needs to understand historical agent behavior, scan recent sessions for tool/command patterns, compare live-vs-transcript shapes, audit command nicifier coverage, find examples of tool calls/results, or investigate parser/UI transcript bugs without loading huge session files into memory.
---

# Session Understanding

Use this skill when the task needs evidence from many local agent transcripts, especially under `~/.codex/sessions` or `~/.claude/projects`.

## Quick Start

Run the bundled stream scanner from the repo root:

```bash
node .codex/skills/session-understanding/scripts/scan-agent-sessions.mjs --days 30 --limit 30
```

For machine-readable output:

```bash
node .codex/skills/session-understanding/scripts/scan-agent-sessions.mjs --days 30 --json
```

For a specific corpus:

```bash
node .codex/skills/session-understanding/scripts/scan-agent-sessions.mjs --root ~/.codex/sessions/2026/07 --limit 50
```

## Workflow

1. Start with the scanner before opening large JSONL files directly.
2. Use `--days`, `--root`, and `--limit` to narrow the corpus.
3. Use `--json` when another script or test should consume the summary.
4. Open individual sessions only after the scanner identifies useful examples.
5. Preserve the live/transcript split: scanning JSONL explains transcript data, not live app-server state.

## What The Scanner Reports

- Files and JSONL rows scanned.
- Tool call counts by tool name.
- Command counts, normalized command heads, and examples.
- Git and test command samples for UI nicifier work.
- Result row counts when recognizable from Codex or Claude transcript shapes.

The scanner is intentionally read-only and stream-based. It should not parse entire session files into memory.
