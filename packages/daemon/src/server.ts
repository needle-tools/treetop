import { join, resolve, normalize } from "node:path";
import { homedir, totalmem } from "node:os";
import { stat as fsStat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Workspace } from "./workspace";
import {
  listWorktrees,
  getWorktreeDetails,
  listCommits,
  getDiff,
  getCommitDiff,
  fetchAll,
  createWorktree,
  removeWorktree,
  listBranches,
  checkoutBranch,
  listRemotes,
  parseChangedFiles,
  parseUnpushedCommits,
  type DiffKind,
} from "./git";
import { $ } from "bun";
import { detectAgents, agentsForWorktree } from "./agents";
import { startActivityTail, onActivity } from "./activity";
import { getSessionResponseJson, sessionCacheStats } from "./sessions";
import { serveImage } from "./images";
import { pickFolder } from "./picker";
import { openIn, detectEditors } from "./open";
import { EventLog } from "./events";
import { ErrorLog, type ErrorKind, type ErrorSource } from "./errors";
import { ShellsLog } from "./shells";
import { feedShellInput, clearShellInputBuffer } from "./shell-input";
import { handleMcp, mcpServerInfo, type JsonRpcRequest } from "./mcp";
import * as inflight from "./inflight";
import { terminalBackend } from "./terminals/node-pty-backend";
import type { TerminalSubscriber } from "./terminals/types";
import { watchWorktree } from "./worktree-watcher";
import { saveAttachment } from "./attachments";
import { sampleProcs, sampleCwds, renameArgv, resolveAgentBinary } from "./procs";
import { NotesStore, type AttachmentKind, type LinkTarget } from "./notes";

const WORKSPACE_PATH =
  process.env.SUPERGIT_WORKSPACE ??
  join(homedir(), "supergit", "workspaces", "default");

// Port resolution order:
//   1. SUPERGIT_PORT — explicit override, wins.
//   2. PORT          — set by portless (and most npm tooling) when
//                      wrapping us; lets `portless` inject its own port.
//   3. 7777          — default.
const PORT = Number(
  process.env.SUPERGIT_PORT ?? process.env.PORT ?? 7777,
);

/** Path to a built UI's `dist/` directory. When non-null the daemon
 *  serves static files from it for any GET that doesn't match an API
 *  route (with a SPA fallback to index.html for client-side routes).
 *  Resolution order:
 *    0. SUPERGIT_NO_UI_DIR=1 — force null (dev posture). dev.ts sets
 *       this so a stale `packages/ui/dist` doesn't accidentally flip
 *       the dev daemon into prod-style static serving.
 *    1. SUPERGIT_UI_DIR env — explicit override.
 *    2. ../../ui/dist relative to this file — auto-detected when the
 *       SPA has been built (handy when portless / a sidecar invokes
 *       the daemon's own start script and bypasses the root env vars).
 *    3. null — dev mode, Vite handles UI hosting.
 */
const UI_DIR = ((): string | null => {
  if (process.env.SUPERGIT_NO_UI_DIR === "1") return null;
  if (process.env.SUPERGIT_UI_DIR) {
    return resolve(process.cwd(), process.env.SUPERGIT_UI_DIR);
  }
  const sibling = resolve(import.meta.dir, "../../ui/dist");
  return existsSync(sibling) ? sibling : null;
})();
if (UI_DIR) console.log(`supergit daemon: serving UI from ${UI_DIR}`);

// Set a readable process title so `ps`, `top`, `htop`, and macOS
// Activity Monitor's command column show "supergit dev" / "supergit
// prod" instead of "bun run src/server.ts". Dev = no built UI in
// front of us; prod = we're serving the dist. The explicit env
// SUPERGIT_PROCESS_TITLE wins if set (handy for one-off runs).
process.title =
  process.env.SUPERGIT_PROCESS_TITLE ??
  (UI_DIR ? "supergit prod" : "supergit dev");

const workspace = await Workspace.open(WORKSPACE_PATH);
const events = await EventLog.open(WORKSPACE_PATH);
const errors = await ErrorLog.open(WORKSPACE_PATH);
const shells = await ShellsLog.open(WORKSPACE_PATH);
const notes = await NotesStore.open(WORKSPACE_PATH);

console.log(`supergit daemon: workspace = ${WORKSPACE_PATH}`);
console.log(`supergit daemon: listening on http://localhost:${PORT}`);

// CORS allowlist. The wildcard `*` is a real attack surface: with `*` any
// website you visit could call localhost:7777 from your browser and read the
// responses (list repos, trigger openIn, etc.). We allowlist the Vite dev
// origin and nothing else. Programmatic clients (curl, agents, MCP) ignore
// CORS, so they keep working.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:7779",
  "http://127.0.0.1:7779",
  // `portless` setups (https://github.com/vercel-labs/portless) put the
  // browser on `*.localhost`. Same-origin fetches from inside the SPA
  // bypass CORS already; we allowlist these explicitly so external
  // tools / curl with a forged Origin still work.
  "http://supergit.localhost",
  "https://supergit.localhost",
  "http://supergit-dev.localhost",
  "https://supergit-dev.localhost",
  ...(process.env.SUPERGIT_EXTRA_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) ?? []),
]);

/** Coerce an untyped /api/notes payload field into the AttachmentKind
 *  the store expects. Anything other than the two known values
 *  returns undefined — the store then treats it as "leave the existing
 *  kind alone" on PUT, and "default to note" on POST. */
function parseKind(v: unknown): AttachmentKind | undefined {
  return v === "note" || v === "link" ? v : undefined;
}

/** Same posture for `target`. The whole object is dropped if any field
 *  is malformed; we don't half-accept (a note with a recognised type
 *  but an empty value would render as a broken chip in the UI). */
function parseTarget(v: unknown): LinkTarget | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as { type?: unknown; value?: unknown };
  if (typeof obj.value !== "string" || obj.value.length === 0) return undefined;
  if (
    obj.type === "url" ||
    obj.type === "commit" ||
    obj.type === "session" ||
    obj.type === "file"
  ) {
    return { type: obj.type, value: obj.value };
  }
  return undefined;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
  }
  // No Origin header (same-origin / programmatic): no CORS headers needed.
  // Disallowed origins get nothing back, so browsers refuse the response.
  return {};
}

// SSE subscriber registry. Mutating routes call broadcast() so connected
// clients refresh without polling.
const sseSubscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sseEncoder = new TextEncoder();

function broadcast(event: string, data: unknown): void {
  const payload = sseEncoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
  for (const ctrl of sseSubscribers) {
    try {
      ctrl.enqueue(payload);
    } catch {
      sseSubscribers.delete(ctrl);
    }
  }
}

// FS watcher registry. One watcher per worktree path; events from the
// watcher debounce to a single broadcast("change", ...) so the UI
// re-fetches /api/repos and the affected row refreshes its status +
// open diffs. Watcher ignores node_modules/ and .git/ — see
// worktree-watcher.ts. Reconciled at startup and after any route that
// adds/removes a repo or worktree.
const worktreeWatchers = new Map<string, () => void>();

async function reconcileWorktreeWatchers(): Promise<void> {
  const repos = await workspace.listRepos();
  const wanted = new Set<string>();
  for (const repo of repos) {
    try {
      const wts = await listWorktrees(repo.path);
      for (const wt of wts) wanted.add(wt.path);
    } catch {
      // repo dir gone — skip silently; the next mutation will clean
      // it from the workspace anyway.
    }
  }
  // Stop watchers for paths no longer in the workspace.
  for (const [path, stop] of worktreeWatchers) {
    if (!wanted.has(path)) {
      stop();
      worktreeWatchers.delete(path);
    }
  }
  // Start watchers for new paths.
  for (const path of wanted) {
    if (worktreeWatchers.has(path)) continue;
    const stop = watchWorktree(path, () => {
      broadcast("change", { kind: "fs_change", path });
    });
    worktreeWatchers.set(path, stop);
  }
}

async function recordServerError(
  req: Request,
  status: number,
  err: unknown,
): Promise<void> {
  const url = new URL(req.url);
  const entry = await errors.append({
    kind: "server",
    source: "daemon",
    route: url.pathname,
    method: req.method,
    status,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  broadcast("error", entry);
}

// Per-terminal grace timers. When the last WS subscriber detaches we
// don't kill the PTY immediately — we wait `GRACE_MS` so a page reload
// can reconnect without losing the agent. Closing the panel for real
// just lets the timer fire and the PTY dies cleanly.
//
// 30s instead of 3s: with the Terminal-column reattach flow (GET
// /api/shells on mount, then attach via WS), the round-trip from
// "reload pressed" to "WS open frame" is dominated by browser cache
// behaviour and the SPA's JS evaluation — easily 5–10s on a cold
// devtools-disabled reload. 3s killed every shell before the new tab
// could attach. 30s is generous; a column the user actually closed
// will linger for that long but cost nothing.
const GRACE_MS = 30_000;
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Per-shell live cwd cache. We sample `lsof -p <pid> -d cwd` every
// SHELL_CWD_INTERVAL_MS and remember the latest path so GET /api/shells
// can surface where the user has `cd`-ed to. In-memory only — a daemon
// restart kills the helper which kills every PTY, so there's nothing
// to persist across restarts. Map key is termId, not pid, so the
// /api/shells lookup is a direct hit.
//
// Hoisted above `Bun.serve(...)` (rather than next to its sampler at
// the bottom of the file) because route handlers close over it and
// requests landing during module init would otherwise hit a TDZ
// `ReferenceError: Cannot access 'shellCwds' before initialization`.
const SHELL_CWD_INTERVAL_MS = 5_000;
const shellCwds = new Map<string, string>();
/** Termids of currently-live shell PTYs. Used as an O(1) gate in the
 *  hot WS keystroke path before we do any line-buffer work. Same TDZ
 *  hoist reason as shellCwds. */
const shellTermIds = new Set<string>();

function cancelGrace(termId: string) {
  const t = graceTimers.get(termId);
  if (!t) return;
  clearTimeout(t);
  graceTimers.delete(termId);
}

function startGraceIfIdle(termId: string) {
  const handle = terminalBackend.get(termId);
  if (!handle) return;
  if (handle.subscriberCount() > 0) return;
  if (graceTimers.has(termId)) return;
  const timer = setTimeout(() => {
    graceTimers.delete(termId);
    const h = terminalBackend.get(termId);
    if (!h) return;
    if (h.subscriberCount() === 0 && h.isAlive()) void h.kill();
  }, GRACE_MS);
  graceTimers.set(termId, timer);
}

interface TermWsData {
  termId: string;
  unsubscribe: (() => void) | null;
}

const server = Bun.serve<TermWsData, never>({
  port: PORT,
  // Bun's default per-request idle timeout is 10s. Some of our routes —
  // /api/diff on a large changeset, /api/session priming the cache on a
  // 100 MB+ JSONL, /api/fetch over a slow network — can legitimately
  // exceed that. When the timeout fires we observed `Bun.serve` (1.3.x)
  // leaving the listener in a broken state where new connections were
  // accepted-but-never-answered (`[Bun.serve]: request timed out…`
  // followed by silent listener death). 30s gives every legitimate
  // operation room and effectively eliminates the wedge in practice.
  idleTimeout: 30,
  // Top-level escape hatch. The fetch handler wraps its body in a
  // try/catch and returns 500 on a thrown error — but if a handler
  // ever returns `undefined` (a missing `return`), or if Bun.serve
  // itself throws synchronously, this is the only place we hear about
  // it. Logged + persisted so the Events popover surfaces it.
  error(err: Error) {
    console.error(`supergit daemon: Bun.serve error: ${err.stack ?? err}`);
    void errors
      .append({
        kind: "server",
        source: "daemon",
        status: 500,
        message: err?.message ?? String(err),
        stack: err?.stack,
      })
      .then((entry) => broadcast("error", entry))
      .catch(() => {});
    return new Response(
      JSON.stringify({ error: err?.message ?? "internal error" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    const CORS = corsHeaders(req);

    const json = (body: unknown, init: ResponseInit = {}): Response =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...CORS,
          ...(init.headers ?? {}),
        },
      });

    try {

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // WebSocket upgrade for terminal I/O — /api/terminals/:id/io.
    // CORS does not apply to WS handshakes, but we still validate the
    // termId exists in our manager before upgrading.
    {
      const m = url.pathname.match(/^\/api\/terminals\/([^/]+)\/io$/);
      if (m) {
        const termId = m[1]!;
        if (!terminalBackend.get(termId)) {
          return json({ error: "terminal not found" }, { status: 404 });
        }
        if (
          srv.upgrade(req, {
            data: { termId, unsubscribe: null },
          })
        ) {
          return undefined as unknown as Response;
        }
        return json({ error: "upgrade failed" }, { status: 500 });
      }
    }

    if (url.pathname === "/api/health") {
      // `totalMemBytes` lets the UI scale TUI-hot/warm thresholds to a
      // fraction of the user's RAM instead of a hardcoded MB number —
      // a 16 GB MacBook and a 96 GB Linux workstation shouldn't trip
      // the same alert. Static for the lifetime of the daemon, so the
      // UI caches it after the first /api/health response.
      return json({
        status: "ok",
        workspace: WORKSPACE_PATH,
        totalMemBytes: totalmem(),
      });
    }

    // The user's default login shell — populated from $SHELL with a
    // /bin/zsh fallback (macOS default). The frontend hits this once
    // on mount so the "Terminal" entry in the new-session picker can
    // spawn the right shell without hardcoding bash/zsh in the UI.
    if (url.pathname === "/api/shell-default") {
      return json({ shell: process.env.SHELL || "/bin/zsh" });
    }

    // Diagnostics: snapshot of the /api/session cache. Shows entries,
    // bounds, per-entry sizes, total bytes held. Used to find out where
    // heapUsed is actually going when the totals don't match the cache cap.
    if (url.pathname === "/api/debug/session-cache") {
      return json(sessionCacheStats());
    }

    // Diagnostics: process.memoryUsage() + an optional forced sync GC.
    // When ?gc=1 we run a full GC first and report the after-GC numbers so
    // you can tell V8-reserved-but-unused pages apart from a true working
    // set. Bounded, no side effects beyond GC pressure.
    if (url.pathname === "/api/debug/mem") {
      const force = url.searchParams.get("gc") === "1";
      const before = process.memoryUsage();
      let gcMs = 0;
      if (force) {
        const t = performance.now();
        Bun.gc(true);
        gcMs = performance.now() - t;
      }
      const after = process.memoryUsage();
      return json({
        pid: process.pid,
        uptimeSec: process.uptime(),
        gcRanMs: force ? gcMs : null,
        before,
        after,
      });
    }

    // Diagnostics: env snapshot of a spawned PTY. ?id=<termId> picks a
    // specific terminal; omitted = a list of every alive PTY with its
    // snapshot. Used to verify what env the helper actually handed to
    // the shell — primary use case is confirming whether the
    // SHELL_SESSIONS_DISABLE / TERM_PROGRAM / TERM_SESSION_ID combo
    // matches what we expect after a helper restart.
    if (url.pathname === "/api/debug/pty-env") {
      const id = url.searchParams.get("id");
      if (id) {
        const env = terminalBackend.getEnvSnapshot(id);
        if (!env) return json({ error: `unknown or pre-helper-restart termId: ${id}` }, { status: 404 });
        const rec = terminalBackend.list().find((t) => t.id === id);
        return json({ id, cmd: rec?.cmd, env });
      }
      const all = terminalBackend.list().map((t) => ({
        id: t.id,
        cmd: t.cmd,
        pid: t.pid,
        agent: t.agent,
        env: terminalBackend.getEnvSnapshot(t.id) ?? null,
      }));
      return json({ count: all.length, terminals: all });
    }

    if (url.pathname === "/api/attach" && req.method === "POST") {
      // Browser-side TerminalView posts a multipart form here when the
      // user pastes an image or drops a file onto an xterm column. We
      // write the bytes under `<workspace>/attachments/` and return the
      // absolute path so the client can write it into the PTY's stdin —
      // exactly the dance the VSCode terminal-image-paste extensions
      // do, with the upload going through the daemon instead of an
      // extension host. The agent then sees the path on its input line
      // and can attach it like any other file reference.
      //
      // The destination is daemon-owned (one folder per workspace);
      // callers can't influence where bytes land, so no worktree-path
      // validation needed.
      const form = await req.formData().catch(() => null);
      if (!form) {
        return json({ error: "multipart/form-data body required" }, {
          status: 400,
        });
      }
      const file = form.get("file");
      if (!(file instanceof File)) {
        return json({ error: "file (Blob) is required" }, { status: 400 });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const filename = file.name && file.name !== "blob" ? file.name : undefined;
      const mimeType = file.type || undefined;
      const result = await saveAttachment(
        join(WORKSPACE_PATH, "attachments"),
        bytes,
        { filename, mimeType },
      );
      return json(result, { status: 201 });
    }

    if (url.pathname === "/api/image" && req.method === "GET") {
      // Serve a local image file referenced from a Claude session message
      // (e.g. "[Image: source: /var/folders/.../shot.png]"). The validation
      // + lookup lives in serveImage() so it's unit-testable.
      const result = await serveImage(url.searchParams.get("path"));
      if (result.status !== 200) {
        return json({ error: result.error }, { status: result.status });
      }
      return new Response(result.file, {
        headers: {
          ...CORS,
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    if (url.pathname === "/api" || url.pathname === "/api/") {
      return json({
        name: "supergit",
        version: "0.0.0",
        workspace: WORKSPACE_PATH,
        endpoints: [
          { method: "GET", path: "/api", description: "this index (agent-discoverable route list)" },
          { method: "GET", path: "/api/health", description: "liveness + workspace path" },
          { method: "GET", path: "/api/shell-default", description: "the user's default login shell ($SHELL, falling back to /bin/zsh). Used by the new-session picker's 'Terminal' entry." },
          { method: "GET", path: "/api/debug/mem", description: "process.memoryUsage() snapshot. ?gc=1 runs a full sync GC first and reports both before/after — lets you tell V8-reserved-idle pages apart from true working set." },
          { method: "GET", path: "/api/image", description: "serve a local image file (?path=) for inline rendering in chat sessions" },
          { method: "POST", path: "/api/attach", body: "multipart: file=<Blob>", description: "save a pasted/dropped attachment under <workspace>/attachments/; returns { path: absolute }" },
          { method: "GET", path: "/api/repos", description: "list registered repos with their worktrees, each enriched with detected agents" },
          { method: "GET", path: "/api/agents", description: "scan ~/.claude, ~/.codex, VSCode workspaceStorage for active AI agent sessions" },
          { method: "GET", path: "/api/session", description: "?source=<file>: normalized message stream for a known session (Claude or Codex)" },
          { method: "POST", path: "/api/session/send", body: { agent: "claude", sessionId: "uuid", cwd: "string", text: "string" }, description: "send a prompt to an agent's session (claude only for now). Fire-and-forget: agent writes to its JSONL, UI polls for new messages. Returns the in-flight record id." },
          { method: "POST", path: "/api/session/title", body: { source: "string", title: "string" }, description: "set a manual title for the session keyed by `source`. Empty title clears." },
          { method: "GET", path: "/api/session-titles", description: "return the full `{ [source]: title }` map of every saved manual title (including titles stored against synthetic `__new__:`/`__attached__:` sources)." },
          { method: "POST", path: "/api/session/title/migrate", body: { oldSource: "string", newSource: "string" }, description: "move a saved manual title from `oldSource` to `newSource`. Used when a transient column's source flips to a new identity (shell PTY spawn, agent JSONL appears) so the user's typed title doesn't get orphaned." },
          { method: "GET", path: "/api/active-sends", description: "list claude subprocesses still in flight from /api/session/send. Optional ?sessionId=<id> to filter." },
          { method: "DELETE", path: "/api/active-sends/:id", description: "SIGTERM (then SIGKILL after 500ms) the claude subprocess for an in-flight send." },
          { method: "POST", path: "/api/terminals", body: { cmd: ["string"], cwd: "string", cols: "number?", rows: "number?", ownerId: "string?" }, description: "spawn a PTY via the supernode helper. Returns { id, pid }." },
          { method: "GET", path: "/api/terminals", description: "list active terminals. Optional ?ownerId=<id> filter." },
          { method: "GET", path: "/api/shells", description: "list every shell-column transcript we have on disk (`<workspace>/shells/<termId>.jsonl`), with `alive: true` for those whose PTY is still running and `alive: false` for past sessions the UI can render in read-mode." },
          { method: "GET", path: "/api/shell-transcript", description: "?termId=<id> — full transcript: header, every captured command, exit info, last cwd. Used by ShellView for past-shell read mode + the Resume button." },
          { method: "DELETE", path: "/api/terminals/:id", description: "SIGTERM (then SIGKILL after 500ms) the PTY." },
          { method: "WS", path: "/api/terminals/:id/io", description: "bidirectional byte stream: binary frames are PTY bytes both ways; text frames are JSON control (e.g. {type:'resize',cols,rows})." },
          { method: "GET", path: "/api/processes", description: "list of currently-alive PTYs with a live cpu%/memory sample per pid. Feeds the dashboard's TUIs popover." },
          { method: "POST", path: "/api/fetch", description: "trigger an immediate git fetch of all registered repos" },
          { method: "POST", path: "/api/repos", body: { path: "string (absolute)" }, description: "add a repo to the workspace" },
          { method: "DELETE", path: "/api/repos/:id", description: "remove a repo from the workspace" },
          { method: "POST", path: "/api/repos/:id/rename", body: { name: "string" }, description: "rename a repo (undoable)" },
          { method: "POST", path: "/api/repos/:id/color", body: { color: "#rrggbb hex string or null" }, description: "set or clear a repo's accent color (used wherever the name renders)" },
          { method: "POST", path: "/api/repos/:id/worktrees", body: { branch: "string", base: "string?" }, description: "create a new worktree for the repo on a new branch (at ~/wt/<repo>/<branch>)" },
          { method: "DELETE", path: "/api/repos/:id/worktrees", body: { path: "string", force: "boolean?" }, description: "remove a worktree directory + its .git slot. Refuses on dirty state unless force=true. Returns 409 with {dirty:true} if uncommitted/untracked work exists." },
          { method: "GET", path: "/api/repos/:id/branches", description: "list local + remote branches and the currently checked-out branch. Optional ?path=<wt> to query a specific worktree's HEAD (default: the repo's main worktree)." },
          { method: "POST", path: "/api/repos/:id/checkout", body: { path: "string", branch: "string", force: "boolean?" }, description: "run `git checkout <branch>` in the given worktree. Refuses on dirty state unless force=true. Remote-style branches (origin/foo) get an implicit `-t` to create a tracking local branch." },
          { method: "POST", path: "/api/pick-folder", description: "open OS-native folder picker, returns chosen path or 204 if cancelled" },
          { method: "GET", path: "/api/editors", description: "list editors detected on PATH (cursor, code, rider, ...)" },
          { method: "GET", path: "/api/commits", description: "list commits for a worktree: ?path=<wt>&before=<sha>&limit=<n>" },
          { method: "GET", path: "/api/diff", description: "git diff text for a worktree: ?path=<wt>&kind=workdir|staged" },
          { method: "GET", path: "/api/commit", description: "git show output for one commit: ?path=<wt>&sha=<sha>" },
          { method: "POST", path: "/api/open", body: { path: "string", app: "fork | terminal | <editor cmd>" }, description: "open a path in Fork / terminal / a detected editor via OS shell-out" },
          { method: "GET", path: "/api/stream", description: "Server-Sent Events stream; emits 'change' on every mutation so clients can refresh" },
          { method: "GET", path: "/api/events", description: "list recent events (mutations + observations) with undone/reversible flags" },
          { method: "POST", path: "/api/events/:id/undo", description: "reverse a reversible event" },
          { method: "POST", path: "/api/events/:id/redo", description: "re-apply a previously undone event" },
          { method: "GET", path: "/api/errors", description: "list recent errors (server 5xx, browser fetch failures, uncaught exceptions). Optional ?limit=<n>." },
          { method: "POST", path: "/api/errors", body: { kind: "string?", source: "string?", message: "string", stack: "string?", route: "string?", method: "string?", status: "number?", extra: "object?" }, description: "report a browser-side error so it lands in the workspace errors.jsonl and the Events popover." },
          { method: "DELETE", path: "/api/errors", description: "clear the recorded error log" },
          { method: "GET", path: "/api/notes", description: "list workspace notes (newest first). Optional ?anchorPrefix=<prefix> filters to notes whose anchors startsWith() the prefix (e.g. anchorPrefix=worktree:/abs/path to get every note pinned to a worktree)." },
          { method: "POST", path: "/api/notes", body: { id: "string?", body: "string", anchors: "string[]?", tags: "string[]?" }, description: "create a new note as <workspace>/notes/<id>.md. id is auto-generated as <yyyy-mm-dd>-<hex8> if omitted." },
          { method: "PUT", path: "/api/notes/:id", body: { body: "string?", anchors: "string[]?", tags: "string[]?" }, description: "update a note's body/anchors/tags; bumps updatedAt." },
          { method: "DELETE", path: "/api/notes/:id", description: "delete a note file." },
          { method: "GET", path: "/mcp", description: "MCP server info" },
          { method: "POST", path: "/mcp", description: "MCP JSON-RPC: initialize, tools/list, tools/call" },
        ],
        note: "All routes reachable at http://localhost:7777/api/* (daemon direct) or http://localhost:7779/api/* (Vite dev proxy). CORS is locked to the dev UI origin — set SUPERGIT_EXTRA_ORIGINS to allow others. Programmatic clients (curl, agents, MCP) ignore CORS and work either way.",
      });
    }

    if (url.pathname === "/api/repos" && req.method === "GET") {
      const [repos, agents, titles] = await Promise.all([
        workspace.listRepos(),
        detectAgents(),
        workspace.listSessionTitles(),
      ]);
      const titled = agents.map((s) =>
        titles[s.source] ? { ...s, manualTitle: titles[s.source] } : s,
      );
      const enriched = await Promise.all(
        repos.map(async (repo) => {
          const [worktrees, remotes] = await Promise.all([
            listWorktrees(repo.path),
            listRemotes(repo.path),
          ]);
          const withDetails = await Promise.all(
            worktrees.map(async (wt) => ({
              ...wt,
              ...(await getWorktreeDetails(wt.path)),
              agents: agentsForWorktree(wt.path, titled),
            })),
          );
          return { ...repo, worktrees: withDetails, remotes };
        }),
      );
      return json(enriched);
    }

    if (url.pathname === "/api/agents" && req.method === "GET") {
      const [agents, titles] = await Promise.all([
        detectAgents(),
        workspace.listSessionTitles(),
      ]);
      return json(
        agents.map((s) =>
          titles[s.source] ? { ...s, manualTitle: titles[s.source] } : s,
        ),
      );
    }

    if (url.pathname === "/api/session/title" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { source?: unknown; title?: unknown }
        | null;
      const source = body?.source;
      const title = body?.title;
      if (typeof source !== "string" || source.length === 0) {
        return json(
          { error: "body.source (non-empty string) is required" },
          { status: 400 },
        );
      }
      if (typeof title !== "string") {
        return json(
          { error: "body.title (string; empty clears) is required" },
          { status: 400 },
        );
      }
      try {
        await workspace.setSessionTitle(source, title);
        const titles = await workspace.listSessionTitles();
        broadcast("change", { kind: "session_title", source });
        return json({ source, title: titles[source] ?? "" });
      } catch (e) {
        return json(
          { error: String(e instanceof Error ? e.message : e) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/session-titles" && req.method === "GET") {
      // Expose the full title map so the UI can pre-populate its
      // in-memory cache for synthetic `__new__:` / `__attached__:`
      // sources after a page reload (the per-source titles still flow
      // through `/api/repos` for real JSONL paths, but synthetic-source
      // titles are never surfaced there because the daemon doesn't
      // know about transient client-side columns).
      const titles = await workspace.listSessionTitles();
      return json(titles);
    }

    if (url.pathname === "/api/session/title/migrate" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { oldSource?: unknown; newSource?: unknown }
        | null;
      const oldSource = body?.oldSource;
      const newSource = body?.newSource;
      if (typeof oldSource !== "string" || oldSource.length === 0) {
        return json(
          { error: "body.oldSource (non-empty string) is required" },
          { status: 400 },
        );
      }
      if (typeof newSource !== "string" || newSource.length === 0) {
        return json(
          { error: "body.newSource (non-empty string) is required" },
          { status: 400 },
        );
      }
      try {
        await workspace.migrateSessionTitle(oldSource, newSource);
        const titles = await workspace.listSessionTitles();
        broadcast("change", { kind: "session_title_migrate", oldSource, newSource });
        return json({ oldSource, newSource, title: titles[newSource] ?? "" });
      } catch (e) {
        return json(
          { error: String(e instanceof Error ? e.message : e) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/session" && req.method === "GET") {
      const source = url.searchParams.get("source");
      if (!source) {
        return json(
          { error: "?source=<session-file> required" },
          { status: 400 },
        );
      }
      // Allowlist: source must live under one of the agent roots we know
      // how to parse. Keeps this endpoint from becoming an arbitrary file
      // read, without depending on detectAgents() to currently re-find
      // the same file (which races with file-system updates).
      const home = process.env.HOME ?? "";
      const claudeRoot = `${home}/.claude/projects/`;
      const codexRoots = [
        `${home}/.codex/sessions/`,
        `${home}/.config/openai-codex/sessions/`,
      ];
      let agentKind: "claude" | "codex" | null = null;
      if (source.startsWith(claudeRoot)) agentKind = "claude";
      else if (codexRoots.some((r) => source.startsWith(r))) agentKind = "codex";
      if (!agentKind) {
        return json(
          { error: "source is outside any known agent root" },
          { status: 403 },
        );
      }
      // Use the JSON-string cache: on a cache hit this skips readFile,
      // parsing, *and* JSON.stringify, which were the three large allocations
      // that ballooned RSS for big (30k-message) Claude sessions.
      const titles = await workspace.listSessionTitles();
      const body = await getSessionResponseJson(
        agentKind,
        source,
        titles[source],
      );
      return new Response(body, {
        headers: { "Content-Type": "application/json", ...CORS },
      });
    }

    if (url.pathname === "/api/session/send" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { agent?: string; sessionId?: string; cwd?: string; text?: string }
        | null;
      const agent = body?.agent;
      const sessionId = body?.sessionId;
      const cwd = body?.cwd;
      const text = body?.text;
      if (!agent || !cwd || !text || typeof text !== "string" || !text.trim()) {
        return json(
          { error: "agent, cwd, text required" },
          { status: 400 },
        );
      }
      if (agent !== "claude") {
        // Only Claude wired up in v0; codex/copilot follow once we know
        // their non-interactive resume invocation.
        return json(
          { error: `sending to ${agent} not supported yet` },
          { status: 501 },
        );
      }
      if (!sessionId) {
        return json({ error: "claude needs sessionId" }, { status: 400 });
      }
      // Fire-and-forget. Claude appends to its own JSONL on disk; the UI's
      // existing 2s session poll picks the new messages up naturally.
      //
      // `--permission-mode bypassPermissions` is needed because we run with
      // `-p` (print, headless): there's no TTY for the user to approve edit
      // / bash / network permissions, so without bypass claude would block
      // forever waiting for a confirmation it can never receive. The user
      // explicitly typed a prompt in this session, which is consent enough
      // for v0. We can surface granular per-call approvals from the UI later.
      // The claude CLI is itself a Bun-compiled standalone binary, so
      // when it runs in a project cwd Bun's package-resolution machinery
      // happily writes a `bun.lockb` / `bun.lock` there. We don't want
      // those polluting the worktree, so snapshot what's there before
      // spawn and unlink anything claude added once it exits.
      const lockCandidates = [join(cwd, "bun.lockb"), join(cwd, "bun.lock")];
      const preExisted = await Promise.all(
        lockCandidates.map(async (p) => {
          try {
            await fsStat(p);
            return true;
          } catch {
            return false;
          }
        }),
      );

      try {
        const proc = Bun.spawn({
          cmd: [
            "claude",
            "-p",
            "-r",
            sessionId,
            "--permission-mode",
            "bypassPermissions",
            text,
          ],
          cwd,
          stdout: "ignore",
          stderr: "ignore",
        });
        const rec = inflight.register({
          agent,
          sessionId,
          cwd,
          text,
          proc,
        });
        void proc.exited.then(async () => {
          for (let i = 0; i < lockCandidates.length; i++) {
            if (preExisted[i]) continue;
            const p = lockCandidates[i]!;
            try {
              await fsStat(p);
              await unlink(p);
            } catch {
              // not there, or unlink failed; nothing to do
            }
          }
        });
        return json({ ok: true, id: rec.id, pid: rec.pid });
      } catch (e) {
        return json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/api/terminals" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | {
            cmd?: string[];
            cwd?: string;
            cols?: number;
            rows?: number;
            ownerId?: string;
            procName?: string;
          }
        | null;
      if (!body || !Array.isArray(body.cmd) || body.cmd.length === 0 || !body.cwd) {
        return json({ error: "cmd[] and cwd required" }, { status: 400 });
      }
      // Detect the agent label from the ORIGINAL cmd before we wrap.
      // Otherwise wrapping with `bash -c '…'` would make the backend
      // see cmd[0]="bash" and mis-label every TUI as a shell.
      const head0 = body.cmd[0]?.split(/[\\/]/).pop()?.toLowerCase();
      const agentHint = ((): string | undefined => {
        if (!head0) return undefined;
        if (head0 === "claude") return "claude";
        if (head0 === "codex") return "codex";
        if (head0 === "bash" || head0 === "zsh" || head0 === "sh" || head0 === "fish") return "shell";
        return undefined;
      })();
      // If cmd[0] is a BARE agent name (no path separators), resolve it
      // to an absolute path picking the newest install across known
      // prefixes. This sidesteps the "two installs of codex, PATH
      // points at the old one" trap: codex's self-update writes to
      // `~/.bun/bin/`, but a pre-existing `/opt/homebrew/bin/codex`
      // shadows it on PATH. resolveAgentBinary returns the newest
      // mtime, so a freshly-bun-installed codex wins.
      let resolvedCmd = body.cmd.slice();
      if (head0 && !body.cmd[0]!.includes("/") && (head0 === "claude" || head0 === "codex")) {
        const abs = await resolveAgentBinary(head0);
        if (abs) resolvedCmd[0] = abs;
      }
      // Optional argv[0] rename via `bash -c 'exec -a NAME …'` so the PTY
      // shows up in `ps`/`top`/`htop` (and macOS Activity Monitor's
      // command column) as e.g. "supergit-tui-abc12345-claude" instead
      // of just "claude". Unix only; Windows ignores the hint.
      //
      // Critical exception for zsh shells: zsh reads its argv[0] to
      // decide its emulation mode. If the basename doesn't contain
      // "zsh" / "ksh" / "csh", zsh starts in **sh emulation** — no
      // /etc/zshrc, no ~/.zshrc, no zle line editor, prompt becomes
      // a bare "$ " (sh default). That's the "cursor on empty line
      // below the $, only last keypress visible" symptom on resume.
      // Prepend "zsh-" to the procName when the underlying command
      // is a zsh shell so zsh's name-based mode detection picks
      // "zsh" out of the renamed argv[0]. The ps-readable suffix
      // (and the rename-for-Activity-Monitor benefit) is preserved.
      let effectiveProcName = body.procName;
      const innerCmd0Base = (resolvedCmd[0] ?? "").split("/").pop() ?? "";
      if (
        effectiveProcName &&
        process.platform !== "win32" &&
        (innerCmd0Base === "zsh" || /^zsh-\d/.test(innerCmd0Base)) &&
        !/(^|[-_/])zsh([-_]|$)/.test(effectiveProcName)
      ) {
        effectiveProcName = `zsh-${effectiveProcName}`;
      }
      const cmd =
        effectiveProcName && process.platform !== "win32"
          ? renameArgv(effectiveProcName, resolvedCmd)
          : resolvedCmd;
      try {
        const handle = await terminalBackend.spawn({
          cmd,
          cwd: body.cwd,
          ownerId: body.ownerId,
          agent: agentHint,
          size: { cols: body.cols ?? 80, rows: body.rows ?? 24 },
        });
        // For shell PTYs, persist a header into <workspace>/shells/<id>.jsonl
        // so the workspace (not the browser's localStorage) is the source
        // of truth for "which Terminal columns are open." On reload the UI
        // hits GET /api/shells, gets the live set, and reattaches.
        if (agentHint === "shell") {
          await shells
            .writeHeader({
              kind: "header",
              termId: handle.id,
              wt: body.cwd,
              spawnCwd: body.cwd,
              createdAt: new Date().toISOString(),
            })
            .catch((err) => {
              console.error(
                `supergit daemon: shells.writeHeader failed for ${handle.id}: ${err}`,
              );
            });
          shellTermIds.add(handle.id);
          // Cleanup-only subscriber: when the PTY exits we drop the
          // in-memory bookkeeping and append a closing `exit` entry so
          // the JSONL becomes a complete transcript. We ignore onData
          // here — keystroke capture happens in the WS message handler.
          const cleanup = handle.subscribe({
            onData() {},
            onExit(info) {
              shellTermIds.delete(handle.id);
              clearShellInputBuffer(handle.id);
              shellCwds.delete(handle.id);
              void shells
                .append(handle.id, {
                  kind: "exit",
                  ts: new Date().toISOString(),
                  code: info.code,
                  signal: info.signal,
                })
                .catch(() => {});
              cleanup();
            },
          });
        }
        return json({ id: handle.id, pid: handle.pid });
      } catch (e) {
        return json(
          { error: e instanceof Error ? e.message : String(e) },
          { status: 500 },
        );
      }
    }

    // List currently-live shell columns (PTY still alive AND its header
    // file is still present in `<workspace>/shells/`). The UI calls this
    // on mount to repopulate Terminal columns after a reload.
    if (url.pathname === "/api/shells" && req.method === "GET") {
      const headers = await shells.listHeaders();
      // Pull manual titles keyed by `shell:<termId>` so past-shell columns
      // can show / edit a user-set name (same workspace storage the AI
      // session titles use, just a different key prefix).
      const titles = await workspace.listSessionTitles();
      const records = headers.map((h) => {
        const alive = terminalBackend.get(h.termId) !== undefined;
        return {
          termId: h.termId,
          wt: h.wt,
          spawnCwd: h.spawnCwd,
          createdAt: h.createdAt,
          // The cwd sampler hasn't necessarily run yet for a freshly
          // spawned shell — fall back to spawnCwd so the UI can show
          // *something* immediately and refine on the next poll cycle.
          currentCwd: shellCwds.get(h.termId) ?? h.spawnCwd,
          alive,
          manualTitle: titles[`shell:${h.termId}`],
        };
      });
      // Newest first so the UI's restore loop renders recent shells at
      // the front of each worktree's column strip.
      records.sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
      return json(records);
    }

    // Full transcript of one shell — header + every captured command +
    // the exit entry if the PTY has ended. Powers the read-mode column
    // (ShellView) that lets the user re-read past shell sessions and
    // resume a new one at the last cwd.
    if (url.pathname === "/api/shell-transcript" && req.method === "GET") {
      const termId = url.searchParams.get("termId");
      if (!termId) {
        return json({ error: "?termId required" }, { status: 400 });
      }
      const transcript = await shells.readTranscript(termId);
      if (!transcript) {
        return json({ error: "shell not found" }, { status: 404 });
      }
      const titles = await workspace.listSessionTitles();
      return json({
        ...transcript,
        alive: terminalBackend.get(termId) !== undefined,
        currentCwd: shellCwds.get(termId) ?? transcript.lastCwd,
        manualTitle: titles[`shell:${termId}`],
      });
    }

    if (url.pathname === "/api/terminals" && req.method === "GET") {
      const ownerId = url.searchParams.get("ownerId") ?? undefined;
      const records = terminalBackend.list();
      return json(ownerId ? records.filter((r) => r.ownerId === ownerId) : records);
    }

    if (url.pathname === "/api/processes" && req.method === "GET") {
      // Same set as /api/terminals, plus a live cpu/mem sample per pid.
      // Used by the "TUIs" popover in the dashboard header to give a
      // global view of everything supergit is running.
      const records = terminalBackend.list().filter((r) => !r.exitedAt);
      const samples = await sampleProcs(records.map((r) => r.pid));
      return json(
        records.map((r) => {
          const s = samples.get(r.pid);
          return {
            id: r.id,
            pid: r.pid,
            agent: r.agent,
            cmd: r.cmd,
            cwd: r.cwd,
            ownerId: r.ownerId,
            createdAt: r.createdAt,
            lastOutputAt: r.lastOutputAt,
            cpuPercent: s?.cpuPercent ?? 0,
            memBytes: s?.memBytes ?? 0,
          };
        }),
      );
    }

    if (url.pathname.startsWith("/api/terminals/") && req.method === "DELETE") {
      const termId = url.pathname.slice("/api/terminals/".length);
      const handle = terminalBackend.get(termId);
      if (!handle) return json({ error: "not found" }, { status: 404 });
      cancelGrace(termId);
      void handle.kill();
      return json({ ok: true });
    }

    if (url.pathname === "/api/agents/installed" && req.method === "GET") {
      // Which interactive agent CLIs are installed? Uses
      // `resolveAgentBinary` so multi-install setups (e.g. homebrew
      // codex + bun-installed codex from a self-update) report the
      // newest binary, not whatever PATH order happens to pick.
      const candidates = ["claude", "codex"];
      const installed: { name: string; path: string }[] = [];
      for (const name of candidates) {
        const path = await resolveAgentBinary(name);
        if (path) installed.push({ name, path });
      }
      return json({ installed });
    }

    if (url.pathname === "/api/active-sends" && req.method === "GET") {
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      return json(inflight.list({ sessionId }));
    }

    // Trailing-id pattern: /api/active-sends/:id for DELETE.
    if (url.pathname.startsWith("/api/active-sends/") && req.method === "DELETE") {
      const id = url.pathname.slice("/api/active-sends/".length);
      const ok = inflight.kill(id);
      if (!ok) return json({ error: "not found" }, { status: 404 });
      return json({ ok: true });
    }

    if (url.pathname === "/api/fetch" && req.method === "POST") {
      // Kick off an immediate fetch cycle. Returns immediately; the SSE
      // stream emits "change" when fetches complete.
      void runFetchCycle();
      return json({ status: "queued" });
    }

    if (url.pathname === "/api/repos" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { path?: unknown }
        | null;
      const path = body?.path;
      if (typeof path !== "string" || path.length === 0) {
        return json({ error: "body.path (non-empty string) is required" }, {
          status: 400,
        });
      }
      try {
        const repo = await workspace.addRepo(path);
        await events.append({
          type: "add_repo",
          actor: "user",
          payload: { path },
          inverse: { repo },
        });
        broadcast("change", { kind: "add_repo", repo });
        void reconcileWorktreeWatchers();
        return json(repo, { status: 201 });
      } catch (e) {
        return json({ error: String(e instanceof Error ? e.message : e) }, {
          status: 409,
        });
      }
    }

    const wtCreateMatch = url.pathname.match(
      /^\/api\/repos\/([^/]+)\/worktrees$/,
    );
    if (wtCreateMatch && req.method === "POST") {
      const id = wtCreateMatch[1]!;
      const body = (await req.json().catch(() => null)) as
        | { branch?: unknown; base?: unknown }
        | null;
      const branch = body?.branch;
      if (typeof branch !== "string" || branch.trim().length === 0) {
        return json(
          { error: "body.branch (non-empty string) is required" },
          { status: 400 },
        );
      }
      const base = typeof body?.base === "string" ? body.base : undefined;
      const repos = await workspace.listRepos();
      const repo = repos.find((r) => r.id === id);
      if (!repo) return json({ error: "repo not found" }, { status: 404 });
      try {
        const created = await createWorktree(repo.path, branch.trim(), {
          base,
        });
        await events.append({
          type: "create_worktree",
          actor: "user",
          payload: { repoId: id, branch: created.branch, path: created.path },
        });
        broadcast("change", { kind: "create_worktree", path: created.path });
        void reconcileWorktreeWatchers();
        return json(created, { status: 201 });
      } catch (e) {
        return json(
          { error: String(e instanceof Error ? e.message : e) },
          { status: 409 },
        );
      }
    }

    if (wtCreateMatch && req.method === "DELETE") {
      const id = wtCreateMatch[1]!;
      const body = (await req.json().catch(() => null)) as
        | { path?: unknown; force?: unknown }
        | null;
      const wtPath = body?.path;
      const force = body?.force === true;
      if (typeof wtPath !== "string" || wtPath.trim().length === 0) {
        return json(
          { error: "body.path (worktree path) is required" },
          { status: 400 },
        );
      }
      const repos = await workspace.listRepos();
      const repo = repos.find((r) => r.id === id);
      if (!repo) return json({ error: "repo not found" }, { status: 404 });
      try {
        await removeWorktree(repo.path, wtPath, { force });
        await events.append({
          type: "remove_worktree",
          actor: "user",
          payload: { repoId: id, path: wtPath, force },
        });
        broadcast("change", { kind: "remove_worktree", path: wtPath });
        void reconcileWorktreeWatchers();
        return json({ ok: true });
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        // Surface dirty-state errors with a recognizable shape so the UI
        // can offer a "force" retry.
        const isDirty = /uncommitted|modified|untracked|locked/i.test(msg);
        return json(
          { error: msg, dirty: isDirty },
          { status: 409 },
        );
      }
    }

    {
      const m = url.pathname.match(/^\/api\/repos\/([^/]+)\/branches$/);
      if (m && req.method === "GET") {
        const id = m[1]!;
        const path = url.searchParams.get("path");
        const repos = await workspace.listRepos();
        const repo = repos.find((r) => r.id === id);
        if (!repo) return json({ error: "repo not found" }, { status: 404 });
        const target = path && path.length > 0 ? path : repo.path;
        try {
          const branches = await listBranches(target);
          return json(branches);
        } catch (e) {
          return json(
            { error: String(e instanceof Error ? e.message : e) },
            { status: 500 },
          );
        }
      }
    }

    {
      const m = url.pathname.match(/^\/api\/repos\/([^/]+)\/checkout$/);
      if (m && req.method === "POST") {
        const id = m[1]!;
        const body = (await req.json().catch(() => null)) as
          | { path?: unknown; branch?: unknown; force?: unknown; preStash?: unknown }
          | null;
        const wtPath = body?.path;
        const branch = body?.branch;
        const force = body?.force === true;
        const preStash = body?.preStash === true;
        if (
          typeof wtPath !== "string" ||
          wtPath.trim().length === 0 ||
          typeof branch !== "string" ||
          branch.trim().length === 0
        ) {
          return json(
            { error: "body.path and body.branch are required" },
            { status: 400 },
          );
        }
        const repos = await workspace.listRepos();
        const repo = repos.find((r) => r.id === id);
        if (!repo) return json({ error: "repo not found" }, { status: 404 });
        try {
          const result = await checkoutBranch(wtPath, branch.trim(), {
            force,
            preStash,
          });
          await events.append({
            type: "checkout_branch",
            actor: "user",
            payload: {
              repoId: id,
              path: wtPath,
              branch: branch.trim(),
              force,
              stashed: result.stashed,
            },
          });
          broadcast("change", { kind: "checkout_branch", path: wtPath });
          return json({ ok: true, stashed: result.stashed });
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          const isDirty = /uncommitted|untracked|stash/i.test(msg);
          return json({ error: msg, dirty: isDirty }, { status: 409 });
        }
      }
    }

    const colorMatch = url.pathname.match(/^\/api\/repos\/([^/]+)\/color$/);
    if (colorMatch && req.method === "POST") {
      const id = colorMatch[1]!;
      const body = (await req.json().catch(() => null)) as
        | { color?: unknown }
        | null;
      // `color: null` clears; a string sets. Missing => 400.
      const raw = body?.color;
      const color =
        raw === null
          ? null
          : typeof raw === "string"
            ? raw
            : undefined;
      if (color === undefined) {
        return json(
          { error: "body.color (#rrggbb hex string or null) is required" },
          { status: 400 },
        );
      }
      try {
        const { oldColor, newColor } = await workspace.setRepoColor(id, color);
        if (oldColor !== newColor) {
          broadcast("change", { kind: "repo_color", id, color: newColor });
        }
        return json({ id, oldColor, newColor });
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        return json({ error: msg }, { status: /not found/.test(msg) ? 404 : 400 });
      }
    }

    const renameMatch = url.pathname.match(/^\/api\/repos\/([^/]+)\/rename$/);
    if (renameMatch && req.method === "POST") {
      const id = renameMatch[1]!;
      const body = (await req.json().catch(() => null)) as
        | { name?: unknown }
        | null;
      const newName = body?.name;
      if (typeof newName !== "string" || newName.trim().length === 0) {
        return json(
          { error: "body.name (non-empty string) is required" },
          { status: 400 },
        );
      }
      try {
        const { oldName, newName: nn } = await workspace.renameRepo(id, newName);
        if (oldName !== nn) {
          await events.append({
            type: "rename_repo",
            actor: "user",
            payload: { id, newName: nn },
            inverse: { id, oldName },
          });
          broadcast("change", { kind: "rename_repo", id, newName: nn });
        }
        return json({ id, oldName, newName: nn });
      } catch (e) {
        return json(
          { error: String(e instanceof Error ? e.message : e) },
          { status: 400 },
        );
      }
    }

    const repoMatch = url.pathname.match(/^\/api\/repos\/([^/]+)$/);
    if (repoMatch && req.method === "DELETE") {
      const id = repoMatch[1]!;
      const repos = await workspace.listRepos();
      const repo = repos.find((r) => r.id === id);
      if (!repo) return json({ error: "not found" }, { status: 404 });
      const removed = await workspace.removeRepo(id);
      if (!removed) return json({ error: "not found" }, { status: 404 });
      await events.append({
        type: "remove_repo",
        actor: "user",
        payload: { id },
        inverse: { repo },
      });
      broadcast("change", { kind: "remove_repo", id });
      void reconcileWorktreeWatchers();
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/editors" && req.method === "GET") {
      return json(await detectEditors());
    }

    if (url.pathname === "/api/commit" && req.method === "GET") {
      const path = url.searchParams.get("path");
      const sha = url.searchParams.get("sha");
      const ctxParam = url.searchParams.get("context");
      const context = ctxParam ? Number(ctxParam) : 2;
      if (!path || !sha) {
        return json(
          { error: "?path=<worktree-path>&sha=<commit-sha> required" },
          { status: 400 },
        );
      }
      const content = await getCommitDiff(path, sha, context);
      return new Response(content, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...CORS,
        },
      });
    }

    if (url.pathname === "/api/wt-summary" && req.method === "GET") {
      // Feeds the hover-tooltip on the worktree row's status + ahead
      // badges. Two git calls, in parallel, both cheap: porcelain
      // status for the file lists, log @{u}..HEAD for the commit
      // subjects we haven't pushed yet. `nothrow()` on the log call
      // because git errors on missing upstream — we just return [].
      const path = url.searchParams.get("path");
      if (!path) {
        return json(
          { error: "?path=<worktree-path> is required" },
          { status: 400 },
        );
      }
      // %H<NUL>%s<NUL>%an<NUL>%ar — NUL between fields so subjects can
      // contain any whitespace and survive round-trip. We fetch BOTH
      // directions of the divergence: ahead (commits we haven't pushed)
      // and behind (commits we'd get on the next fetch/pull). Each is
      // capped at 20; the UI tooltip further caps at the first 10.
      const fmt = "%H%x00%s%x00%an%x00%ar";
      const [statusOut, aheadOut, behindOut] = await Promise.all([
        $`git -C ${path} status --porcelain`.quiet().nothrow().text(),
        $`git -C ${path} log @{u}..HEAD --pretty=format:${fmt} -n 20`
          .quiet()
          .nothrow()
          .text(),
        $`git -C ${path} log HEAD..@{u} --pretty=format:${fmt} -n 20`
          .quiet()
          .nothrow()
          .text(),
      ]);
      const files = parseChangedFiles(statusOut);
      const unpushedCommits = parseUnpushedCommits(aheadOut);
      const unfetchedCommits = parseUnpushedCommits(behindOut);
      return json({ ...files, unpushedCommits, unfetchedCommits });
    }

    if (url.pathname === "/api/diff" && req.method === "GET") {
      const path = url.searchParams.get("path");
      const kindParam = url.searchParams.get("kind");
      const kind: DiffKind = kindParam === "staged" ? "staged" : "workdir";
      const ctxParam = url.searchParams.get("context");
      const context = ctxParam ? Number(ctxParam) : 2;
      if (!path) {
        return json(
          { error: "?path=<worktree-path> is required" },
          { status: 400 },
        );
      }
      const diff = await getDiff(path, kind, context);
      return new Response(diff, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...CORS,
        },
      });
    }

    if (url.pathname === "/api/commits" && req.method === "GET") {
      const path = url.searchParams.get("path");
      const before = url.searchParams.get("before") ?? undefined;
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Math.max(1, Math.min(200, Number.parseInt(limitParam, 10))) : 20;
      if (!path) {
        return json({ error: "?path=<worktree-path> is required" }, { status: 400 });
      }
      const commits = await listCommits(path, { before, limit });
      return json(commits);
    }

    if (url.pathname === "/api/open" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | { path?: unknown; app?: unknown }
        | null;
      if (typeof body?.path !== "string" || typeof body?.app !== "string") {
        return json(
          { error: "body.path (string) and body.app (string) required" },
          { status: 400 },
        );
      }
      try {
        const result = await openIn(body.path, body.app);
        return json(result);
      } catch (e) {
        return json(
          { error: String(e instanceof Error ? e.message : e) },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/api/stream" && req.method === "GET") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          sseSubscribers.add(controller);
          // Initial hello so the connection's open and the client knows it
          controller.enqueue(sseEncoder.encode(`: connected\n\n`));
        },
        cancel(controllerOrReason) {
          // Best-effort cleanup; broadcast() also prunes failed controllers.
          for (const ctrl of sseSubscribers) {
            try {
              // The actual controller isn't passed to cancel; we let broadcast
              // prune it on the next attempted enqueue.
            } catch {
              sseSubscribers.delete(ctrl);
            }
          }
        },
      });
      return new Response(stream, {
        headers: {
          ...CORS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (url.pathname === "/api/pick-folder" && req.method === "POST") {
      try {
        const result = await pickFolder();
        if ("cancelled" in result) {
          return new Response(null, { status: 204, headers: CORS });
        }
        return json(result);
      } catch (e) {
        return json(
          { error: String(e instanceof Error ? e.message : e) },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      const all = await events.list();
      // newest first for the UI's benefit
      return json(all.slice().reverse());
    }

    if (url.pathname === "/api/errors" && req.method === "GET") {
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Math.max(1, Number(limitParam)) : undefined;
      return json(await errors.list(limit ? { limit } : {}));
    }

    if (url.pathname === "/api/errors" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | {
            id?: string;
            kind?: ErrorKind;
            source?: ErrorSource;
            route?: string;
            method?: string;
            status?: number;
            message?: string;
            stack?: string;
            extra?: Record<string, unknown>;
          }
        | null;
      if (!body || typeof body.message !== "string" || !body.message) {
        return json({ error: "body.message (string) is required" }, { status: 400 });
      }
      const entry = await errors.append({
        kind: body.kind ?? "uncaught",
        source: body.source ?? "browser",
        route: body.route,
        method: body.method,
        status: body.status,
        message: body.message,
        stack: body.stack,
        extra: body.extra,
      }, body.id);
      broadcast("error", entry);
      return json(entry);
    }

    if (url.pathname === "/api/errors" && req.method === "DELETE") {
      await errors.clear();
      broadcast("error_clear", { ts: new Date().toISOString() });
      return json({ ok: true });
    }

    const toggleMatch = url.pathname.match(
      /^\/api\/events\/([^/]+)\/(undo|redo)$/,
    );
    if (toggleMatch && req.method === "POST") {
      const id = toggleMatch[1]!;
      const toggle = toggleMatch[2] as "undo" | "redo";
      const original = await events.findById(id);
      if (!original) return json({ error: "event not found" }, { status: 404 });
      if (original.type === "undo" || original.type === "redo")
        return json({ error: `cannot ${toggle} a toggle event` }, { status: 400 });
      if (!original.reversible || original.inverse === undefined)
        return json({ error: "event is not reversible" }, { status: 400 });
      if (toggle === "undo" && original.undone)
        return json({ error: "already undone" }, { status: 409 });
      if (toggle === "redo" && !original.undone)
        return json(
          { error: "nothing to redo (event is currently applied)" },
          { status: 409 },
        );

      try {
        if (toggle === "undo") {
          // Apply the inverse
          if (original.type === "add_repo") {
            const inv = original.inverse as { repo: { id: string } };
            const removed = await workspace.removeRepo(inv.repo.id);
            if (!removed) {
              return json(
                { error: "inverse failed: repo no longer exists" },
                { status: 409 },
              );
            }
          } else if (original.type === "remove_repo") {
            const inv = original.inverse as {
              repo: import("./workspace").Repo;
            };
            await workspace.restoreRepo(inv.repo);
          } else if (original.type === "rename_repo") {
            const inv = original.inverse as { id: string; oldName: string };
            await workspace.renameRepo(inv.id, inv.oldName);
          } else if (original.type === "create_note") {
            const inv = original.inverse as { note: { id: string } };
            await notes.remove(inv.note.id);
          } else if (original.type === "remove_note") {
            const inv = original.inverse as {
              note: { id: string; body: string; anchors: string[]; tags: string[] };
            };
            await notes.create({
              id: inv.note.id,
              body: inv.note.body,
              anchors: inv.note.anchors,
              tags: inv.note.tags,
            });
          } else {
            return json(
              { error: `no inverse handler for type: ${original.type}` },
              { status: 501 },
            );
          }
        } else {
          // redo: re-apply the original effect (using inverse.repo to preserve id)
          if (original.type === "add_repo") {
            const inv = original.inverse as {
              repo: import("./workspace").Repo;
            };
            await workspace.restoreRepo(inv.repo);
          } else if (original.type === "remove_repo") {
            const inv = original.inverse as { repo: { id: string } };
            const removed = await workspace.removeRepo(inv.repo.id);
            if (!removed) {
              return json(
                { error: "redo failed: repo no longer exists" },
                { status: 409 },
              );
            }
          } else if (original.type === "rename_repo") {
            const p = original.payload as { id: string; newName: string };
            await workspace.renameRepo(p.id, p.newName);
          } else if (original.type === "create_note") {
            const inv = original.inverse as {
              note: { id: string; body: string; anchors: string[]; tags: string[] };
            };
            await notes.create({
              id: inv.note.id,
              body: inv.note.body,
              anchors: inv.note.anchors,
              tags: inv.note.tags,
            });
          } else if (original.type === "remove_note") {
            const inv = original.inverse as { note: { id: string } };
            await notes.remove(inv.note.id);
          } else {
            return json(
              { error: `no redo handler for type: ${original.type}` },
              { status: 501 },
            );
          }
        }

        const toggleEv = await events.append({
          type: toggle,
          actor: "user",
          payload: { eventId: id },
        });
        broadcast("change", { kind: toggle, eventId: id });
        return json({ [toggle]: id, by: toggleEv.id });
      } catch (e) {
        return json(
          { error: String(e instanceof Error ? e.message : e) },
          { status: 500 },
        );
      }
    }

    if (url.pathname === "/api/notes" && req.method === "GET") {
      const anchorPrefix = url.searchParams.get("anchorPrefix") ?? undefined;
      const list = await notes.list(
        anchorPrefix !== null && anchorPrefix !== undefined && anchorPrefix.length > 0
          ? { anchorPrefix }
          : {},
      );
      return json(list);
    }

    if (url.pathname === "/api/notes" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | {
            id?: unknown;
            body?: unknown;
            anchors?: unknown;
            tags?: unknown;
            kind?: unknown;
            target?: unknown;
          }
        | null;
      if (!body || typeof body.body !== "string") {
        return json(
          { error: "body.body (string) is required" },
          { status: 400 },
        );
      }
      try {
        const note = await notes.create({
          id: typeof body.id === "string" ? body.id : undefined,
          body: body.body,
          anchors: Array.isArray(body.anchors)
            ? (body.anchors as unknown[]).filter(
                (x): x is string => typeof x === "string",
              )
            : undefined,
          tags: Array.isArray(body.tags)
            ? (body.tags as unknown[]).filter(
                (x): x is string => typeof x === "string",
              )
            : undefined,
          kind: parseKind(body.kind),
          target: parseTarget(body.target),
        });
        const ev = await events.append({
          type: "create_note",
          actor: "user",
          payload: { note },
          inverse: { note },
        });
        broadcast("change", { kind: "note_create", id: note.id, eventId: ev.id });
        return json({ ...note, eventId: ev.id }, { status: 201 });
      } catch (e) {
        return json(
          { error: String(e instanceof Error ? e.message : e) },
          { status: 409 },
        );
      }
    }

    {
      const m = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
      if (m && req.method === "PUT") {
        const id = m[1]!;
        const body = (await req.json().catch(() => null)) as
          | {
              body?: unknown;
              anchors?: unknown;
              tags?: unknown;
              kind?: unknown;
              target?: unknown;
            }
          | null;
        if (!body) {
          return json({ error: "JSON body required" }, { status: 400 });
        }
        try {
          // Distinguish "client did not send target" (leave intact)
          // from "client sent target: null" (clear the existing target).
          // `in` keeps the tri-state intent crisp at this boundary.
          const targetField: LinkTarget | null | undefined =
            "target" in body && body.target === null
              ? null
              : parseTarget(body.target);
          const note = await notes.update(id, {
            body: typeof body.body === "string" ? body.body : undefined,
            anchors: Array.isArray(body.anchors)
              ? (body.anchors as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : undefined,
            tags: Array.isArray(body.tags)
              ? (body.tags as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : undefined,
            kind: parseKind(body.kind),
            target: targetField,
          });
          broadcast("change", { kind: "note_update", id: note.id });
          return json(note);
        } catch (e) {
          const msg = String(e instanceof Error ? e.message : e);
          const status = /not found/.test(msg) ? 404 : 400;
          return json({ error: msg }, { status });
        }
      }
      if (m && req.method === "DELETE") {
        const id = m[1]!;
        // Read the full note before deletion so we have the inverse
        // payload needed for undo. If it's missing, treat as 404
        // identically to NotesStore.remove() returning false.
        const existing = await notes.get(id);
        if (!existing) return json({ error: "note not found" }, { status: 404 });
        const removed = await notes.remove(id);
        if (!removed) return json({ error: "note not found" }, { status: 404 });
        const ev = await events.append({
          type: "remove_note",
          actor: "user",
          payload: { id },
          inverse: { note: existing },
        });
        broadcast("change", { kind: "note_delete", id, eventId: ev.id });
        return json({ ok: true, eventId: ev.id });
      }
    }

    if (url.pathname === "/mcp" && req.method === "GET") {
      return json(mcpServerInfo());
    }

    if (url.pathname === "/mcp" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as
        | JsonRpcRequest
        | null;
      if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
        return json(
          {
            jsonrpc: "2.0",
            id: body?.id ?? null,
            error: { code: -32600, message: "invalid JSON-RPC 2.0 request" },
          },
          { status: 400 },
        );
      }
      const result = await handleMcp(body, { workspace, events });
      return json(result);
    }

    // Production UI fallback: when SUPERGIT_UI_DIR is set, serve the
    // built SPA from there for any GET request that didn't match an
    // /api/* route. In dev mode UI_DIR is unset and Vite handles UI
    // hosting, so this block is a no-op.
    if (UI_DIR && req.method === "GET") {
      // Resolve safely — normalize and reject anything escaping UI_DIR.
      const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const candidate = resolve(UI_DIR, "." + normalize(reqPath));
      if (candidate === UI_DIR || candidate.startsWith(UI_DIR + "/")) {
        const file = Bun.file(candidate);
        if (await file.exists()) {
          // Same-origin response, no CORS headers needed.
          return new Response(file);
        }
      }
      // SPA fallback: unknown route → serve index.html so the client
      // router can take over. We never reach this for /api/* paths
      // because they're handled above.
      const index = Bun.file(join(UI_DIR, "index.html"));
      if (await index.exists()) return new Response(index);
    }

    return json({ error: "not found" }, { status: 404 });
    } catch (err) {
      // An exception escaped a route handler. Log with stack so the
      // browser-side Events popover can surface it for debugging, then
      // return a generic 500 to the caller.
      await recordServerError(req, 500, err).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, { status: 500 });
    }
  },

  websocket: {
    /** Subscribe the connecting client to the terminal's byte stream.
     *  Stays attached for the WS lifetime; on close we detach and start
     *  a grace timer that disposes the PTY if nothing else attaches. */
    open(ws) {
      const { termId } = ws.data;
      const handle = terminalBackend.get(termId);
      if (!handle) {
        ws.close(1011, "terminal not found");
        return;
      }
      cancelGrace(termId);
      const sub: TerminalSubscriber = {
        onData(chunk) {
          // Binary frame — raw PTY bytes for xterm.js.
          ws.send(chunk);
        },
        onState(state) {
          // Text frame carrying daemon-detected terminal state (e.g.
          // "awaiting input"). The UI uses this to outline the column.
          try {
            ws.send(JSON.stringify({ type: "state", ...state }));
          } catch {
            // ws may be mid-close; ignore
          }
        },
        onExit(info) {
          ws.send(JSON.stringify({ type: "exit", ...info }));
          // Give the client a beat to render the exit notice, then close.
          setTimeout(() => {
            try { ws.close(1000, "exited"); } catch {}
          }, 50);
        },
      };
      ws.data.unsubscribe = handle.subscribe(sub);
    },

    /** Client messages: binary = bytes to write to the PTY (keystrokes).
     *  Text = JSON control frames; currently just `{type:"resize",cols,rows}`. */
    message(ws, msg) {
      const handle = terminalBackend.get(ws.data.termId);
      if (!handle) return;
      if (typeof msg === "string") {
        try {
          const parsed = JSON.parse(msg);
          if (parsed?.type === "resize") {
            handle.resize({
              cols: Number(parsed.cols) || 80,
              rows: Number(parsed.rows) || 24,
            });
          }
        } catch {
          // ignore garbage control frames
        }
        return;
      }
      // Binary keystrokes from xterm.js — write through to the PTY.
      const buf = msg instanceof Uint8Array ? msg : new Uint8Array(msg as ArrayBuffer);
      // For shell PTYs, also feed the keystrokes into the per-shell
      // line buffer. Any Enter-terminated lines get appended to the
      // shell's JSONL as `kind: "cmd"` entries — the command history
      // transcript. cwd at log time comes from the cwd sampler's
      // latest known value for this shell (falls back to "" if it
      // hasn't sampled yet).
      const termId = ws.data.termId;
      if (shellTermIds.has(termId)) {
        const lines = feedShellInput(termId, buf);
        if (lines.length > 0) {
          const ts = new Date().toISOString();
          const cwd = shellCwds.get(termId) ?? "";
          for (const line of lines) {
            void shells
              .append(termId, { kind: "cmd", ts, line, cwd })
              .catch(() => {});
          }
        }
      }
      handle.write(buf);
    },

    close(ws) {
      const termId = ws.data.termId;
      try { ws.data.unsubscribe?.(); } catch {}
      ws.data.unsubscribe = null;
      // If this was the last subscriber, schedule a grace-then-dispose.
      startGraceIfIdle(termId);
    },
  },
});

// Release the port cleanly when --watch restarts us, or on Ctrl-C.
const shutdown = async (signal: string) => {
  console.log(`supergit daemon: ${signal} -> stopping`);
  if (fetchTimer) clearInterval(fetchTimer);
  stopActivity();
  await server.stop(true);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// Periodic auto-fetch so ahead/behind stays accurate. Disable with
// SUPERGIT_FETCH_INTERVAL_MS=0.
const FETCH_INTERVAL_MS = Number(
  process.env.SUPERGIT_FETCH_INTERVAL_MS ?? 5 * 60 * 1000,
);
let fetchTimer: ReturnType<typeof setInterval> | null = null;
let fetchInFlight = false;

async function runFetchCycle(): Promise<void> {
  if (fetchInFlight) return;
  fetchInFlight = true;
  try {
    const repos = await workspace.listRepos();
    if (repos.length === 0) return;
    const results = await Promise.allSettled(
      repos.map((r) => fetchAll(r.path)),
    );
    const ok = results.filter(
      (r) => r.status === "fulfilled" && r.value,
    ).length;
    console.log(
      `supergit daemon: auto-fetch — ${ok}/${repos.length} repos updated`,
    );
    broadcast("change", { kind: "fetch_complete", ok, total: repos.length });
  } finally {
    fetchInFlight = false;
  }
}

// Live tail of agent session JSONLs. New entries within a session arrive
// here and we forward each as an "activity" SSE event so the dashboard can
// render a live activity line per worktree.
const stopActivity = await startActivityTail();
onActivity((ev) => broadcast("activity", ev));
console.log("supergit daemon: agent activity tail started");

await reconcileWorktreeWatchers();
console.log(
  `supergit daemon: watching ${worktreeWatchers.size} worktree(s) for FS changes`,
);

if (FETCH_INTERVAL_MS > 0) {
  // Kick off shortly after startup so the dashboard doesn't show stale
  // ahead/behind on first load.
  setTimeout(() => void runFetchCycle(), 4_000);
  fetchTimer = setInterval(() => void runFetchCycle(), FETCH_INTERVAL_MS);
  console.log(
    `supergit daemon: auto-fetch every ${Math.round(FETCH_INTERVAL_MS / 1000)}s`,
  );
} else {
  console.log("supergit daemon: auto-fetch disabled (SUPERGIT_FETCH_INTERVAL_MS=0)");
}

// shellCwds, shellTermIds, and SHELL_CWD_INTERVAL_MS are declared above
// Bun.serve(...) — see the TDZ comment near `graceTimers`. The sampler
// and its interval live here because they only run after module init,
// so they don't share that hazard.
async function sampleShellCwds(): Promise<void> {
  // Filter terminalBackend's full list to shell PTYs only — no point
  // running lsof on a Claude/Codex agent process.
  const shellRecords = terminalBackend
    .list()
    .filter((r) => r.agent === "shell");
  if (shellRecords.length === 0) return;
  const pidToTerm = new Map<number, string>();
  for (const r of shellRecords) pidToTerm.set(r.pid, r.id);
  const cwds = await sampleCwds([...pidToTerm.keys()]);
  for (const [pid, cwd] of cwds) {
    const termId = pidToTerm.get(pid);
    if (termId) shellCwds.set(termId, cwd);
  }
  // Drop entries for shells that have exited (their pid is gone from
  // pidToTerm). Iterate the cache, not the live set, so we don't keep
  // them indefinitely.
  for (const termId of [...shellCwds.keys()]) {
    if (!shellRecords.some((r) => r.id === termId)) shellCwds.delete(termId);
  }
}
setInterval(() => {
  void sampleShellCwds();
}, SHELL_CWD_INTERVAL_MS);
