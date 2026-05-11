/**
 * Minimal MCP-over-HTTP stub.
 *
 * Speaks the subset of the Model Context Protocol that lets an agent
 * discover supergit's tools and call them. JSON-RPC 2.0 over POST /mcp.
 *
 * Methods implemented:
 *   - initialize             (returns server info + capabilities)
 *   - tools/list             (returns the catalogue of callable tools)
 *   - tools/call             (dispatches to a tool by name)
 *
 * Anything else returns a -32601 "method not found" error.
 *
 * This is intentionally tiny — the goal is "an agent can discover and call
 * supergit" without pulling in a full MCP SDK. Replace with a real MCP
 * server impl once we want SSE streaming, resources, prompts, etc.
 */

import type { Workspace } from "./workspace";
import type { EventLog } from "./events";
import { listWorktrees } from "./git";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: "list_repos",
    description: "List repos registered in the supergit workspace, each with its worktrees.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_repo",
    description: "Register a repo path with the supergit workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the git repo's working tree." },
      },
      required: ["path"],
    },
  },
  {
    name: "remove_repo",
    description: "Remove a repo (by id) from the workspace. The repo itself is untouched on disk.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Repo id from list_repos." } },
      required: ["id"],
    },
  },
];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

function ok(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}
function err(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

export async function handleMcp(
  request: JsonRpcRequest,
  ctx: { workspace: Workspace; events: EventLog },
): Promise<unknown> {
  switch (request.method) {
    case "initialize":
      return ok(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "supergit", version: "0.0.0" },
      });

    case "tools/list":
      return ok(request.id, { tools: TOOLS });

    case "tools/call": {
      const params = request.params as
        | { name?: unknown; arguments?: unknown }
        | null
        | undefined;
      const name = params?.name;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string") {
        return err(request.id, -32602, "tools/call: missing tool name");
      }

      try {
        switch (name) {
          case "list_repos": {
            const repos = await ctx.workspace.listRepos();
            const enriched = await Promise.all(
              repos.map(async (r) => ({
                ...r,
                worktrees: await listWorktrees(r.path),
              })),
            );
            return ok(request.id, textContent(JSON.stringify(enriched, null, 2)));
          }
          case "add_repo": {
            const path = args.path;
            if (typeof path !== "string" || path.length === 0) {
              return err(request.id, -32602, "add_repo: arguments.path (string) is required");
            }
            const repo = await ctx.workspace.addRepo(path);
            await ctx.events.append({
              type: "add_repo",
              actor: "agent",
              payload: { path },
              inverse: { repo },
            });
            return ok(request.id, textContent(JSON.stringify(repo, null, 2)));
          }
          case "remove_repo": {
            const id = args.id;
            if (typeof id !== "string" || id.length === 0) {
              return err(request.id, -32602, "remove_repo: arguments.id (string) is required");
            }
            const repos = await ctx.workspace.listRepos();
            const repo = repos.find((r) => r.id === id);
            if (!repo) return err(request.id, -32602, `remove_repo: no repo with id ${id}`);
            const removed = await ctx.workspace.removeRepo(id);
            if (!removed) return err(request.id, -32602, `remove_repo: failed to remove ${id}`);
            await ctx.events.append({
              type: "remove_repo",
              actor: "agent",
              payload: { id },
              inverse: { repo },
            });
            return ok(request.id, textContent(`removed ${repo.name}`));
          }
          default:
            return err(request.id, -32601, `unknown tool: ${name}`);
        }
      } catch (e) {
        return err(request.id, -32603, e instanceof Error ? e.message : String(e));
      }
    }

    default:
      return err(request.id, -32601, `method not found: ${request.method}`);
  }
}

export function mcpServerInfo() {
  return {
    name: "supergit",
    version: "0.0.0",
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    tools: TOOLS,
    transport: "http",
    endpoint: "POST /mcp (JSON-RPC 2.0)",
    note: "Minimal MCP-over-HTTP stub. Stream/SSE not implemented yet.",
  };
}
