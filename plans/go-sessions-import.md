# Plan: Go-based Codex session scanner

## Problem

Codex 0.130+ session JSONL files can reach 500 MB+. The daemon needs to
extract metadata (cwd, model, token usage) and count messages from these
files on every scan cycle. The current Bun streaming implementation
(`Bun.file().stream()`) works but still causes ~187 MB heap pressure per
large file because every chunk passes through V8's TextDecoder and
string split pipeline. An mtime-keyed LRU cache prevents repeated reads,
but the first scan of a large session is expensive.

## Proposal

Move the per-file Codex session scan into the Go helper binary that
supergit already ships (`supergit-helper`). Go can byte-scan a 500 MB
file in <500 ms with zero GC pressure — no string allocations, no
TextDecoder, no V8 heap involvement.

### Subcommand

```
supergit-helper codex-scan <path>
```

Outputs a single JSON object on stdout:

```json
{
  "cwd": "/Users/herbst/git/quicklook-compare",
  "id": "019e3132-e493-7622-acd7-bc0912c7f070",
  "messageCount": 1230,
  "contextChars": 492436,
  "model": "gpt-5.5",
  "lastInputTokens": 223385,
  "modelContextWindow": 258400
}
```

### How it works

1. **Head (first 64 KB):** parse `session_meta` for `cwd` + `id`, and
   `turn_context` for `model`. Codex 0.130+ embeds a 20 KB+ system
   prompt in `base_instructions`, so 64 KB is the safe minimum.

2. **Tail (last 64 KB):** parse the latest `event_msg` with
   `payload.type === "token_count"` for `lastInputTokens` and
   `modelContextWindow`. Also pick up any later `turn_context.model`.

3. **Full-file streaming pass:** scan every line for the byte patterns
   `"response_item"` and `"role"`. When a match is found and the line
   also contains `"user"` or `"assistant"`, increment `messageCount`.
   If no `lastInputTokens` was found (pre-0.130 sessions), also JSON-
   parse matching lines to sum `contextChars`.

The Go implementation uses `bufio.Scanner` with a 1 MB buffer — one
allocation for the entire scan. No per-line string copies needed for the
counting pass; `bytes.Contains` operates on the raw `[]byte`.

### Daemon integration

- `ensureCodexScanCached()` in `agents.ts` spawns `supergit-helper
  codex-scan <path>` via `Bun.spawn`, parses stdout JSON, and populates
  the same `CodexScanCacheEntry`.
- The mtime-keyed LRU cache stays in TypeScript — it gates whether the
  Go process is spawned at all. Unchanged files never trigger a spawn.
- If the Go binary is missing or exits non-zero, fall back to the
  current Bun streaming implementation (already working, just slower).

### What stays in TypeScript

- Cache layer (mtime check, LRU eviction)
- `scanCodex()` orchestration (file discovery, session assembly)
- `readCodexSessionMeta()` / `scanCodexMessageCount()` /
  `scanCodexTokenUsage()` / `scanCodexContextTokens()` public API
  (they delegate to `ensureCodexScanCached`, which delegates to Go)
- All Claude / Copilot / Ollama scanners (unaffected)

### Expected improvement

| Metric              | Bun streaming (current) | Go helper (proposed) |
|---------------------|------------------------|---------------------|
| Time (502 MB file)  | ~2 s                   | <500 ms             |
| Heap pressure       | ~187 MB                | ~0 (separate process)|
| RSS spike           | ~650 MB                | ~1 MB (Go process)  |

### Risks

- Go binary must be available and on PATH (or resolved via the same
  mechanism as `resolveAgentBinary`). Fallback to Bun streaming if not.
- Subprocess spawn overhead (~5 ms) is negligible compared to the scan
  time savings.
- The Go scanner must handle the same edge cases as the TS version:
  truncated last lines, missing `session_meta`, pre-0.130 flat format,
  XML-like tags in content, files without trailing newlines.
