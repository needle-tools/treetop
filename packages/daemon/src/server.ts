import { join } from "node:path";
import { homedir } from "node:os";
import { Workspace } from "./workspace";
import { listWorktrees } from "./git";
import { pickFolder } from "./picker";
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...CORS,
      ...(init.headers ?? {}),
    },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

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
          { method: "GET", path: "/api/repos", description: "list registered repos with their worktrees" },
          { method: "POST", path: "/api/repos", body: { path: "string (absolute)" }, description: "add a repo to the workspace" },
          { method: "DELETE", path: "/api/repos/:id", description: "remove a repo from the workspace" },
          { method: "POST", path: "/api/pick-folder", description: "open OS-native folder picker, returns chosen path or 204 if cancelled" },
          { method: "GET", path: "/api/events", description: "list recent events (mutations + observations) with undone/reversible flags" },
          { method: "POST", path: "/api/events/:id/undo", description: "reverse a reversible event" },
          { method: "GET", path: "/mcp", description: "MCP server info" },
          { method: "POST", path: "/mcp", description: "MCP JSON-RPC: initialize, tools/list, tools/call" },
        ],
        note: "All routes reachable at http://localhost:7777/api/* (daemon direct) or http://localhost:5173/api/* (Vite dev proxy). CORS is open on localhost; agents can call freely.",
      });
    }

    if (url.pathname === "/api/repos" && req.method === "GET") {
      const repos = await workspace.listRepos();
      const enriched = await Promise.all(
        repos.map(async (repo) => ({
          ...repo,
          worktrees: await listWorktrees(repo.path),
        })),
      );
      return json(enriched);
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
        return json(repo, { status: 201 });
      } catch (e) {
        return json({ error: String(e instanceof Error ? e.message : e) }, {
          status: 409,
        });
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
      return new Response(null, { status: 204, headers: CORS });
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

    const undoMatch = url.pathname.match(/^\/api\/events\/([^/]+)\/undo$/);
    if (undoMatch && req.method === "POST") {
      const id = undoMatch[1]!;
      const original = await events.findById(id);
      if (!original) return json({ error: "event not found" }, { status: 404 });
      if (original.type === "undo")
        return json({ error: "cannot undo an undo event" }, { status: 400 });
      if (original.undone)
        return json({ error: "event already undone" }, { status: 409 });
      if (!original.reversible || original.inverse === undefined)
        return json({ error: "event is not reversible" }, { status: 400 });

      try {
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
            repo: { path: string };
          };
          await workspace.addRepo(inv.repo.path);
        } else {
          return json(
            { error: `no inverse handler for type: ${original.type}` },
            { status: 501 },
          );
        }

        const undo = await events.append({
          type: "undo",
          actor: "user",
          payload: { eventId: id },
        });
        return json({ undone: id, by: undo.id });
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
  await server.stop(true);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
