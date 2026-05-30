# PLAN-HTTP-PANEL.md — Postman-like HTTP request panel

Rough plan, not a spec. Feasibility done; not started. Conventions follow the
other PLAN-*.md files: honest tradeoffs inline, decisions called out, nothing
locked unless marked **locked**.

Scope: a new session/panel type — a lightweight Postman/Insomnia-style HTTP
request console that lives in a worktree's session strip alongside the
terminal, FileBrowser, and GitHistory panels. It sends HTTP requests, shows
responses, and remembers the last request + a history of sent/received pairs.

This is **not** built on the peer messaging API. It is a peer of the
terminal / FileBrowser / GitHistory panels — same level, same mounting.

## Decisions (locked)

- **Scope: per-worktree.** Each worktree gets its own panel and its own saved
  history, exactly like FileBrowser. No global/workspace-level panel for v1.
- **Persistence: daemon prefs** via `getDaemonKV()` → `prefs.json` (CLAUDE.md
  rule #11 — no `localStorage` for shared UI state). FileBrowser already does
  this; we copy the pattern.

## Why this is easy (architecture)

Panel types in supergit are **additive and shallow**. There is no central
panel registry and no session-lifecycle surgery required. A panel is a
*synthetic session* identified by a `source` string prefix. The render layer
dispatches on that prefix. FileBrowser (`__files__:`) and GitHistory
(`__history__:`) were both added this exact way and are the templates here.

The HTTP panel uses a new prefix: **`__http__:`**.

## Surface area — files to touch

Mirrors how FileBrowser was added.

### 1. New component — `packages/ui/src/HttpPanel.svelte` (the bulk: ~400–700 LOC)
- Request builder: method dropdown, URL input, header rows, body editor.
- Response viewer: status + statusText, response headers, body
  (JSON pretty-print is the only fiddly part).
- History list of past request/response pairs.
- Wrap the whole thing in `SessionHeader` with `agent="http"`, `mode="read"` —
  same contract every panel uses (gives us the close button, drag handle,
  header menu for free). See `FileBrowser.svelte`'s `SessionHeader` usage as
  the reference.

### 2. Register the type — `packages/ui/src/storage.ts` (~5 LOC)
- Add `"http"` to the `PersistedAgent` union.
- Add `"http"` to the `VALID_AGENTS` constant.

### 3. Wire into the shell — `packages/ui/src/App.svelte` (~50 LOC)
- Add `openHttpPanel(wtPath)` — create a synthetic source `__http__:<id>`,
  push onto `openSessionsByWt[wtPath]` (model the two existing openers
  `openFileBrowser` / `openGitHistory`).
- Add a button in the "new session" popover next to "Browse files" / "History".
- Add one render branch in the session-strip render block:
  `{#if s.source.startsWith("__http__:")}` → `<HttpPanel … />`.
- Import the component at the top.

### 4. Persistence — daemon prefs via `getDaemonKV()`
- Namespaced key per source: `supergit:http:<source>`.
- Stored shape (proposed):
  ```ts
  interface HttpPanelState {
    lastRequest: {
      method: string;
      url: string;
      headers: Array<{ key: string; value: string }>;
      body: string;
    };
    history: Array<{
      ts: number;
      request: { method: string; url: string;
                 headers: Array<{ key: string; value: string }>; body: string };
      response: { status: number; statusText: string;
                  headers: Record<string, string>; body: string; ms: number };
    }>;
  }
  ```
- FileBrowser persists `nav / expanded / selected / showDotfiles` under
  `supergit:fileBrowser:state` keyed by source — copy that load-on-mount /
  save-on-change pattern.

### 5. Daemon: one small new route — `packages/daemon/src/server.ts` (~30–60 LOC)
- Add `POST /api/http-request` taking `{ url, method, headers, body }`, doing a
  server-side `fetch`, returning `{ status, statusText, headers, body, ms }`.
- **Why server-side:** sidesteps browser **CORS**. Hitting an arbitrary API
  straight from the SPA fails whenever that API lacks permissive CORS headers.
  The daemon already runs server-side fetches and binds `0.0.0.0`, so a proxy
  route is idiomatic here. Slots in next to the other
  `if (url.pathname === …)` handlers (route table starts ~line 1492).
- **Note:** the existing `POST /api/fetch` (server.ts:4896) is NOT a generic
  proxy — it triggers a *git* fetch of all repos. Do not overload it; add a
  dedicated route.
- Also add it to the self-describing route list (the `/api` index array in
  `server.ts`, ~line 1663) for consistency.

## Tests (TDD — write first, per CLAUDE.md)

- **Persisted-state roundtrip:** serialize `HttpPanelState` → store via injected
  KV / temp store → load → deep-equal (per the "persistence helpers tested with
  an injected store" rule).
- **Proxy route:** unit-test the pure request→response mapping, or an
  integration test using the same payload contract the route uses (per the
  "new daemon routes" rule). Hit a local throwaway server, not the network.
- No mocking of the thing under test; use a temp dir / injected store.

## Effort estimate

~1 focused day for a solid v1.
- ~70% is UI polish in `HttpPanel.svelte` (header rows, body editor, response
  formatting / syntax highlighting, history UX).
- ~30% is the (mechanical) wiring + the proxy route + the two tests above.

## Explicitly out of scope for v1

- Workspace-level / shared collections (per-worktree only for now).
- Versioned/shareable request collections in the workspace repo (possible v2 —
  git-tracked collections).
- Auth helpers (OAuth flows, token refresh), environments/variables,
  scripting/pre-request hooks — all Postman features we are NOT chasing.
- Streaming responses / websockets in the panel.

## Open questions (defer until build)

- Response body size cap before we truncate in the UI / KV (history could grow
  large — cap to last N entries, store oversized bodies trimmed).
- Whether to surface request errors (DNS, timeout) as a distinct response state
  vs an HTTP status.
