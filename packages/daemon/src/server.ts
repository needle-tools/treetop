import { join } from "node:path";
import { homedir } from "node:os";
import { Workspace } from "./workspace";
import {
  listWorktrees,
  getWorktreeDetails,
  listCommits,
  getDiff,
  getCommitDiff,
  fetchAll,
  type DiffKind,
} from "./git";
import { detectAgents, agentsForWorktree } from "./agents";
import { startActivityTail, onActivity } from "./activity";
import { pickFolder } from "./picker";
import { openIn, detectEditors } from "./open";
import { EventLog } from "./events";
import { handleMcp, mcpServerInfo, type JsonRpcRequest } from "./mcp";

const WORKSPACE_PATH =
  process.env.SUPERGIT_WORKSPACE ??
  join(homedir(), "supergit", "workspaces", "default");

const PORT = Number(process.env.SUPERGIT_PORT ?? 7777);

const workspace = await Workspace.open(WORKSPACE_PATH);
const events = await EventLog.open(WORKSPACE_PATH);

console.log(`supergit daemon: workspace = ${WORKSPACE_PATH}`);
console.log(`supergit daemon: listening on http://localhost:${PORT}`);

// CORS allowlist. The wildcard `*` is a real attack surface: with `*` any
// website you visit could call localhost:7777 from your browser and read the
// responses (list repos, trigger openIn, etc.). We allowlist the Vite dev
// origin and nothing else. Programmatic clients (curl, agents, MCP) ignore
// CORS, so they keep working.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.SUPERGIT_EXTRA_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) ?? []),
]);

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

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
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

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === "/api/health") {
      return json({ status: "ok", workspace: WORKSPACE_PATH });
    }

    if (url.pathname === "/api" || url.pathname === "/api/") {
      return json({
        name: "supergit",
        version: "0.0.0",
        workspace: WORKSPACE_PATH,
        endpoints: [
          { method: "GET", path: "/api", description: "this index (agent-discoverable route list)" },
          { method: "GET", path: "/api/health", description: "liveness + workspace path" },
          { method: "GET", path: "/api/repos", description: "list registered repos with their worktrees, each enriched with detected agents" },
          { method: "GET", path: "/api/agents", description: "scan ~/.claude, ~/.codex, VSCode workspaceStorage for active AI agent sessions" },
          { method: "POST", path: "/api/fetch", description: "trigger an immediate git fetch of all registered repos" },
          { method: "POST", path: "/api/repos", body: { path: "string (absolute)" }, description: "add a repo to the workspace" },
          { method: "DELETE", path: "/api/repos/:id", description: "remove a repo from the workspace" },
          { method: "POST", path: "/api/repos/:id/rename", body: { name: "string" }, description: "rename a repo (undoable)" },
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
          { method: "GET", path: "/mcp", description: "MCP server info" },
          { method: "POST", path: "/mcp", description: "MCP JSON-RPC: initialize, tools/list, tools/call" },
        ],
        note: "All routes reachable at http://localhost:7777/api/* (daemon direct) or http://localhost:5173/api/* (Vite dev proxy). CORS is locked to the dev UI origin — set SUPERGIT_EXTRA_ORIGINS to allow others. Programmatic clients (curl, agents, MCP) ignore CORS and work either way.",
      });
    }

    if (url.pathname === "/api/repos" && req.method === "GET") {
      const [repos, agents] = await Promise.all([
        workspace.listRepos(),
        detectAgents(),
      ]);
      const enriched = await Promise.all(
        repos.map(async (repo) => {
          const worktrees = await listWorktrees(repo.path);
          const withDetails = await Promise.all(
            worktrees.map(async (wt) => ({
              ...wt,
              ...(await getWorktreeDetails(wt.path)),
              agents: agentsForWorktree(wt.path, agents),
            })),
          );
          return { ...repo, worktrees: withDetails };
        }),
      );
      return json(enriched);
    }

    if (url.pathname === "/api/agents" && req.method === "GET") {
      return json(await detectAgents());
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
        return json(repo, { status: 201 });
      } catch (e) {
        return json({ error: String(e instanceof Error ? e.message : e) }, {
          status: 409,
        });
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

    return json({ error: "not found" }, { status: 404 });
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
