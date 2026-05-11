import { join } from "node:path";
import { homedir } from "node:os";
import { Workspace } from "./workspace";
import { listWorktrees } from "./git";

const WORKSPACE_PATH =
  process.env.SUPERGIT_WORKSPACE ??
  join(homedir(), "supergit", "workspaces", "default");

const PORT = Number(process.env.SUPERGIT_PORT ?? 7777);

const workspace = await Workspace.open(WORKSPACE_PATH);

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

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    if (url.pathname === "/api/health") {
      return json({ status: "ok", workspace: WORKSPACE_PATH });
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
        return json(repo, { status: 201 });
      } catch (e) {
        return json({ error: String(e instanceof Error ? e.message : e) }, {
          status: 409,
        });
      }
    }

    const repoMatch = url.pathname.match(/^\/api\/repos\/([^/]+)$/);
    if (repoMatch && req.method === "DELETE") {
      const removed = await workspace.removeRepo(repoMatch[1]!);
      if (!removed) return json({ error: "not found" }, { status: 404 });
      return new Response(null, { status: 204, headers: CORS });
    }

    return json({ error: "not found" }, { status: 404 });
  },
});
