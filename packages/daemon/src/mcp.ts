/**
 * Stateless MCP over HTTP, using JSON responses.
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
 * Dashboard mutations broadcast through the same change stream as the UI.
 * No server-initiated MCP streaming, resources, or prompts are advertised.
 */

import type { Workspace } from "./workspace";
import type { EventLog } from "./events";
import { listWorktrees } from "./git";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, relative } from "node:path";
import { NotesStore } from "./notes";
import { detectEditors, findWindowsFork } from "./open";
import { detectAgents, agentsForWorktree, type AgentSession } from "./agents";
import { remindersForWorkspace } from "./reminders";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: "edit_command",
    description: "Edit a saved project command by repo_id and command_id from list_commands. Omitted fields keep their current values; null clears name or command_cwd. Preserves its id and updates the dashboard without executing the command.",
    inputSchema: { type: "object", properties: {
      repo_id: { type: "string" }, command_id: { type: "string" },
      command: { type: "string" }, name: { type: ["string", "null"] },
      command_cwd: { type: ["string", "null"] },
      run_mode: { type: "string", enum: ["internal", "external", "shell"] },
    }, required: ["repo_id", "command_id"] },
  },
  {
    name: "list_events",
    description: "Read Treetop's recorded action/event log, newest first, including payloads and undo/redo metadata. Filter by action type, actor or inclusive timestamps; supports pagination. This is a query of recorded operations, not a live stream or full agent transcript.",
    inputSchema: { type: "object", properties: {
      type: { type: "string", description: "Exact action type, e.g. custom_link_add or custom_link_update." },
      actor: { type: "string", enum: ["user", "agent", "supergit"] },
      after: { type: "string", format: "date-time" }, before: { type: "string", format: "date-time" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      offset: { type: "integer", minimum: 0, default: 0 },
    } },
  },
  ...["get_settings", "export_settings"].map((name): ToolDef => ({
    name,
    description: name === "get_settings"
      ? "Read stored Treetop app setting overrides, Codex agent defaults, project order and project configuration (colors, links and saved commands). Optional repo_id filters projects. Defaults that have never been overridden are defined by the UI and are not included."
      : "Export stored Treetop settings and project configuration as formatted JSON, with a schema version and export timestamp. Includes app overrides, Codex defaults, project order, colors, links and saved commands. Optional repo_id filters projects. The caller can save the JSON to a file; this tool is read-only.",
    inputSchema: { type: "object", properties: { repo_id: { type: "string", description: "Optional project id from list_repos; filters the projects array." } } },
  })),
  {
    name: "schedule_reminder",
    description: "Schedule a one-time Treetop reminder. Supply either at (ISO timestamp with timezone) or delay_seconds. A persistent bottom-right toast appears when due; clicking opens details and optionally focuses repo_id and session_source. Reminders survive daemon restarts; while it is stopped they become due when it starts again. Does not send agent messages or execute commands.",
    inputSchema: { type: "object", properties: {
      title: { type: "string", maxLength: 4096 }, message: { type: "string", maxLength: 4096 },
      details: { type: "string", maxLength: 16384 },
      at: { type: "string", description: "ISO timestamp with Z or explicit timezone offset." },
      delay_seconds: { type: "number", exclusiveMinimum: 0 },
      repo_id: { type: "string", description: "Optional project from list_repos to focus on click." },
      session_source: { type: "string", description: "Optional session source from list_sessions to focus on click." },
    }, required: ["title", "message"] },
  },
  {
    name: "list_reminders",
    description: "List persistent Treetop reminders, earliest first. Filter by project or status; due reminders remain available until dismissed.",
    inputSchema: { type: "object", properties: { repo_id: { type: "string" }, status: { type: "string", enum: ["scheduled", "due", "dismissed", "cancelled"] } } },
  },
  ...["cancel_reminder", "dismiss_reminder"].map((name): ToolDef => ({
    name, description: name === "cancel_reminder" ? "Cancel a scheduled reminder by id without firing it." : "Dismiss a due reminder and remove its alert across Treetop windows.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  })),
  ...["list_sessions", "search_sessions"].map((name): ToolDef => ({
    name,
    description: name === "list_sessions"
      ? "List discovered agent sessions across registered projects, newest first, with optional project, agent, cwd and activity-date filters. Includes session IDs and sources for resuming."
      : "Search sessions across projects by case-insensitive literal text in IDs, titles, paths, and indexed first/recent user prompts. Does not search full transcripts. Supports the same filters as list_sessions.",
    inputSchema: {
      type: "object",
      properties: {
        ...(name === "search_sessions" ? { query: { type: "string", minLength: 1 } } : {}),
        repo_id: { type: "string" },
        agent: { type: "string", enum: ["claude", "codex", "copilot", "ollama"] },
        cwd: { type: "string", description: "Absolute working directory; includes nested folders." },
        after: { type: "string", format: "date-time", description: "Inclusive lastActive lower bound." },
        before: { type: "string", format: "date-time", description: "Inclusive lastActive upper bound." },
        include_unregistered: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      ...(name === "search_sessions" ? { required: ["query"] } : {}),
    },
  })),
  {
    name: "add_command",
    description:
      "Save a command as a project's Treetop action button. Does not execute it. Use repo_id, or cwd to identify its registered project; a Treetop-launched CLI session supplies cwd automatically.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        name: { type: "string" },
        repo_id: { type: "string" },
        cwd: {
          type: "string",
          description: "Absolute working directory identifying the project.",
        },
        command_cwd: {
          type: "string",
          description:
            "Optional working directory for the saved command, absolute or relative to the project.",
        },
        run_mode: {
          type: "string",
          enum: ["internal", "external", "shell"],
          default: "internal",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "list_commands",
    description:
      "Query saved project commands and currently running project commands. Optionally filter by repo_id. Does not execute commands.",
    inputSchema: {
      type: "object",
      properties: { repo_id: { type: "string" } },
    },
  },
  {
    name: "list_connected_apps",
    description:
      "Query detected editors and project app/file/URL links. Optionally filter project links by repo_id.",
    inputSchema: {
      type: "object",
      properties: { repo_id: { type: "string" } },
    },
  },
  {
    name: "list_notes",
    description:
      "Query workspace notes with their content, anchors and tags. Optionally filter anchors by a prefix such as worktree:<path> or session:<source>.",
    inputSchema: {
      type: "object",
      properties: { anchor_prefix: { type: "string" } },
    },
  },
  {
    name: "reorder_repos",
    description:
      "Reorder Treetop projects. Supply every registered repo id exactly once, in display order.",
    inputSchema: {
      type: "object",
      properties: { order: { type: "array", items: { type: "string" } } },
      required: ["order"],
    },
  },
  {
    name: "set_repo_color",
    description:
      "Set a Treetop project's accent color to #rrggbb, or clear it with null.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        color: { type: ["string", "null"] },
      },
      required: ["id", "color"],
    },
  },
  {
    name: "open_session",
    description:
      "Open a Claude, Codex CLI, Copilot CLI, or shell column in a registered Treetop project. Defaults to the project's main working directory; cwd may select one of its worktrees. The CLI starts when the dashboard mounts the column. The request is persisted if the dashboard is closed.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Project id from list_repos or add_repo.",
        },
        agent: {
          type: "string",
          enum: ["claude", "codex", "copilot", "shell"],
        },
        cwd: {
          type: "string",
          description: "Optional absolute path to a worktree of this project.",
        },
        resume_session_id: {
          type: "string",
          description: "Optional existing Claude/Codex session id to resume.",
        },
        model: {
          type: "string",
          description:
            "Optional Codex model or Claude alias (fable, opus, sonnet, haiku).",
        },
      },
      required: ["repo_id", "agent"],
    },
  },
  {
    name: "list_repos",
    description:
      "List repos registered in the supergit workspace, each with its worktrees.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_repo",
    description: "Register a repo path with the supergit workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the git repo's working tree.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "remove_repo",
    description:
      "Remove a repo (by id) from the workspace. The repo itself is untouched on disk.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Repo id from list_repos." },
      },
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

interface McpContext {
  workspace: Workspace;
  events: EventLog;
  changed?: (change: Record<string, unknown>) => void;
  runningCommands?: () => { repoId: string; [key: string]: unknown }[];
  sessionCwd?: string;
  sessions?: () => Promise<AgentSession[]>;
}

const SERVER_INSTRUCTIONS =
  "Treetop is the project dashboard hosting this agent session. Read/export settings with get_settings or export_settings; inspect recorded actions with list_events. Query project commands with list_commands; save/edit project buttons with add_command/edit_command (without running them). Use schedule_reminder for timed alerts with optional repo_id/session_source links. Use the session working directory or pass your current absolute cwd to identify the project; use list_repos to confirm project ids. Tools also manage projects, colors, order, notes and session columns. Never guess another project's id. Only change Treetop state when requested by the user.";

/** Add only this session's MCP connection, preserving other agent settings. */
export function withTreetopMcp(
  cmd: string[],
  endpoint: string,
  cwd?: string,
): string[] {
  const agent = (cmd[0] ?? "")
    .split(/[/\\]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "");
  if (!["codex", "claude", "copilot"].includes(agent)) return cmd;
  const url = new URL(endpoint);
  if (cwd) url.searchParams.set("cwd", cwd);
  const server = { type: "http", url: url.toString() };
  const flags =
    agent === "codex"
      ? [
          "-c",
          `mcp_servers.treetop.url=${JSON.stringify(url.toString())}`,
          "-c",
          "mcp_servers.treetop.enabled=true",
        ]
      : agent === "claude"
        ? [
            "--mcp-config",
            JSON.stringify({ mcpServers: { treetop: server } }),
            "--append-system-prompt",
            `${SERVER_INSTRUCTIONS}${cwd ? ` Session working directory: ${JSON.stringify(cwd)}.` : ""}`,
          ]
        : [
            "--additional-mcp-config",
            JSON.stringify({
              mcpServers: { treetop: { ...server, tools: ["*"] } },
            }),
          ];
  return [cmd[0]!, ...flags, ...cmd.slice(1)];
}

// Concurrent MCP mutations must not overwrite each other's prefs/repo reads.
const mutationQueues = new WeakMap<Workspace, Promise<unknown>>();

export async function handleMcp(
  request: JsonRpcRequest,
  ctx: McpContext,
): Promise<unknown> {
  if (request.method !== "tools/call") return dispatchMcp(request, ctx);
  const previous = mutationQueues.get(ctx.workspace) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => dispatchMcp(request, ctx));
  mutationQueues.set(ctx.workspace, current);
  try {
    return await current;
  } finally {
    if (mutationQueues.get(ctx.workspace) === current)
      mutationQueues.delete(ctx.workspace);
  }
}

async function dispatchMcp(
  request: JsonRpcRequest,
  ctx: McpContext,
): Promise<unknown> {
  if (request.id === undefined && request.method.startsWith("notifications/"))
    return null;
  switch (request.method) {
    case "ping":
      return ok(request.id, {});
    case "initialize":
      return ok(request.id, {
        protocolVersion: [
          "2024-11-05",
          "2025-03-26",
          "2025-06-18",
          "2025-11-25",
        ].includes(
          (request.params as { protocolVersion?: string } | undefined)
            ?.protocolVersion ?? "",
        )
          ? (request.params as { protocolVersion: string }).protocolVersion
          : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "treetop", version: "0.1.0" },
        instructions: `${SERVER_INSTRUCTIONS}${ctx.sessionCwd ? ` Session working directory: ${JSON.stringify(ctx.sessionCwd)}.` : ""}`,
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
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return err(
          request.id,
          -32602,
          "tools/call: arguments must be an object",
        );
      }

      try {
        switch (name) {
          case "list_events": {
            for (const field of ["type", "actor", "after", "before"]) {
              if (args[field] !== undefined && typeof args[field] !== "string")
                return err(request.id, -32602, `${name}: ${field} must be a string`);
            }
            if (args.actor !== undefined && !["user", "agent", "supergit"].includes(args.actor as string))
              return err(request.id, -32602, `${name}: invalid actor`);
            const after = args.after === undefined ? -Infinity : Date.parse(args.after as string);
            const before = args.before === undefined ? Infinity : Date.parse(args.before as string);
            if (Number.isNaN(after) || Number.isNaN(before) || after > before)
              return err(request.id, -32602, `${name}: invalid date range`);
            const limit = args.limit ?? 25, offset = args.offset ?? 0;
            if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
                typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
              return err(request.id, -32602, `${name}: limit must be 1..100 and offset a nonnegative integer`);
            const events = (await ctx.events.list()).reverse().filter(event =>
              (args.type === undefined || event.type === args.type) &&
              (args.actor === undefined || event.actor === args.actor) &&
              Date.parse(event.timestamp) >= after && Date.parse(event.timestamp) <= before
            ).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
            return ok(request.id, textContent(JSON.stringify({ events: events.slice(offset, offset + limit), total: events.length, limit, offset, nextOffset: offset + limit < events.length ? offset + limit : null })));
          }
          case "edit_command": {
            for (const field of ["repo_id", "command_id"]) {
              if (typeof args[field] !== "string" || !(args[field] as string).trim())
                return err(request.id, -32602, `${name}: ${field} is required`);
            }
            if (args.command !== undefined && (typeof args.command !== "string" || !args.command.trim()))
              return err(request.id, -32602, `${name}: command must be nonempty`);
            for (const field of ["name", "command_cwd"]) {
              if (args[field] !== undefined && args[field] !== null && typeof args[field] !== "string")
                return err(request.id, -32602, `${name}: ${field} must be a string or null`);
            }
            if (args.run_mode !== undefined && !["internal", "external", "shell"].includes(args.run_mode as string))
              return err(request.id, -32602, `${name}: invalid run_mode`);
            if (!["command", "name", "command_cwd", "run_mode"].some(field => args[field] !== undefined))
              return err(request.id, -32602, `${name}: supply at least one field to edit`);
            const repo = (await ctx.workspace.listRepos()).find(repo => repo.id === args.repo_id);
            const current = repo?.customLinks?.find(link => link.id === args.command_id);
            if (!current || current.kind !== "command")
              return err(request.id, -32602, `${name}: saved project command not found`);
            const link = await ctx.workspace.updateCustomLink(repo!.id, current.id, {
              kind: "command", cmd: args.command as string | undefined,
              ...(args.name !== undefined ? { name: (args.name ?? "") as string } : {}),
              ...(args.command_cwd !== undefined ? { cwd: (args.command_cwd ?? "") as string } : {}),
              runMode: args.run_mode as "internal" | "external" | "shell" | undefined,
            });
            if (!link) throw new Error("Command was removed before the update");
            await ctx.events.append({ type: "custom_link_update", actor: "agent", payload: { id: repo!.id, linkId: current.id, link } });
            ctx.changed?.({ kind: "custom_link_update", id: repo!.id, linkId: current.id });
            return ok(request.id, textContent(JSON.stringify({ repoId: repo!.id, link })));
          }
          case "get_settings":
          case "export_settings": {
            if (args.repo_id !== undefined && typeof args.repo_id !== "string")
              return err(request.id, -32602, `${name}: repo_id must be a string`);
            const [allProjects, prefs] = await Promise.all([
              ctx.workspace.listRepos(), ctx.workspace.getPrefs(),
            ]);
            const projects = allProjects.filter(project => args.repo_id === undefined || project.id === args.repo_id);
            if (args.repo_id !== undefined && !projects.length)
              return err(request.id, -32602, `${name}: project not found`);
            const storedObject = (key: string): Record<string, unknown> => {
              const value = JSON.parse(prefs[key] ?? "{}");
              if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid settings object: ${key}`);
              return value;
            };
            const projectOrder = JSON.parse(prefs["supergit:repoOrder"] ?? "[]");
            if (!Array.isArray(projectOrder) || projectOrder.some(key => typeof key !== "string"))
              throw new Error("Invalid project order settings");
            const snapshot = {
              schemaVersion: 1,
              ...(name === "export_settings" ? { exportedAt: new Date().toISOString() } : {}),
              settings: storedObject("supergit:settings"),
              agentDefaults: { codex: storedObject("supergit:codexApp:turnSettings") },
              projectOrder,
              projects,
            };
            return ok(request.id, textContent(JSON.stringify(snapshot, null, name === "export_settings" ? 2 : undefined)));
          }
          case "schedule_reminder": {
            for (const field of ["title", "message", "details", "at", "repo_id", "session_source"]) {
              if (args[field] !== undefined && typeof args[field] !== "string")
                return err(request.id, -32602, `${name}: ${field} must be a string`);
            }
            if ((args.at !== undefined) === (args.delay_seconds !== undefined))
              return err(request.id, -32602, `${name}: provide exactly one of at or delay_seconds`);
            if (args.delay_seconds !== undefined && (typeof args.delay_seconds !== "number" || !Number.isFinite(args.delay_seconds) || args.delay_seconds <= 0 || args.delay_seconds > 315360000))
              return err(request.id, -32602, `${name}: delay_seconds must be positive and at most ten years`);
            if (args.repo_id !== undefined && !(await ctx.workspace.listRepos()).some(repo => repo.id === args.repo_id))
              return err(request.id, -32602, `${name}: project not found`);
            const now = Date.now();
            const reminder = await remindersForWorkspace(ctx.workspace.path).schedule({
              title: args.title as string, message: args.message as string, details: args.details as string | undefined,
              dueAt: args.at as string | undefined ?? new Date(now + (args.delay_seconds as number) * 1000).toISOString(),
              repoId: args.repo_id as string | undefined, sessionSource: args.session_source as string | undefined,
            }, now);
            ctx.changed?.({ kind: "reminder_changed", id: reminder.id });
            return ok(request.id, textContent(JSON.stringify(reminder)));
          }
          case "list_reminders": {
            if (args.repo_id !== undefined && typeof args.repo_id !== "string")
              return err(request.id, -32602, `${name}: repo_id must be a string`);
            if (args.status !== undefined && !["scheduled", "due", "dismissed", "cancelled"].includes(args.status as string))
              return err(request.id, -32602, `${name}: invalid status`);
            const items = (await remindersForWorkspace(ctx.workspace.path).list()).filter(item =>
              (args.repo_id === undefined || item.repoId === args.repo_id) && (args.status === undefined || item.status === args.status));
            return ok(request.id, textContent(JSON.stringify(items)));
          }
          case "cancel_reminder":
          case "dismiss_reminder": {
            if (typeof args.id !== "string" || !args.id.trim()) return err(request.id, -32602, `${name}: id is required`);
            const reminder = await remindersForWorkspace(ctx.workspace.path).updateStatus(args.id, name === "cancel_reminder" ? "cancelled" : "dismissed");
            ctx.changed?.({ kind: "reminder_changed", id: reminder.id });
            return ok(request.id, textContent(JSON.stringify(reminder)));
          }
          case "list_sessions":
          case "search_sessions": {
            for (const field of ["repo_id", "agent", "cwd", "after", "before", "query"]) {
              if (args[field] !== undefined && typeof args[field] !== "string")
                return err(request.id, -32602, `${name}: ${field} must be a string`);
            }
            if (name === "search_sessions" && (typeof args.query !== "string" || !args.query.trim()))
              return err(request.id, -32602, `${name}: query is required`);
            if (args.agent !== undefined && !["claude", "codex", "copilot", "ollama"].includes(args.agent as string))
              return err(request.id, -32602, `${name}: invalid agent`);
            if (args.cwd !== undefined && !isAbsolute(args.cwd as string))
              return err(request.id, -32602, `${name}: cwd must be absolute`);
            for (const field of ["after", "before"]) {
              if (args[field] !== undefined && !Number.isFinite(Date.parse(args[field] as string)))
                return err(request.id, -32602, `${name}: ${field} must be a valid timestamp`);
            }
            if (args.after && args.before && Date.parse(args.after as string) > Date.parse(args.before as string))
              return err(request.id, -32602, `${name}: after must not exceed before`);
            if (args.include_unregistered !== undefined && typeof args.include_unregistered !== "boolean")
              return err(request.id, -32602, `${name}: include_unregistered must be boolean`);
            const limit = args.limit ?? 25;
            const offset = args.offset ?? 0;
            if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
                typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
              return err(request.id, -32602, `${name}: limit must be 1..100 and offset a nonnegative integer`);
            const repos = await ctx.workspace.listRepos();
            if (args.repo_id !== undefined && !repos.some(repo => repo.id === args.repo_id))
              return err(request.id, -32602, `${name}: project not found`);
            const [sessions, titles, worktrees] = await Promise.all([
              ctx.sessions ? ctx.sessions() : detectAgents(ctx.workspace.path),
              ctx.workspace.listSessionTitles(),
              Promise.all(repos.map(async repo => ({ repo, worktrees: await listWorktrees(repo.path) }))),
            ]);
            const roots = worktrees.flatMap(entry => entry.worktrees.filter(wt => !wt.bare).map(wt => wt.path));
            const projectBySource = new Map<string, typeof repos[number]>();
            for (const entry of worktrees) {
              for (const wt of entry.worktrees.filter(wt => !wt.bare)) {
                for (const session of agentsForWorktree(wt.path, sessions, roots))
                  projectBySource.set(session.source, entry.repo);
              }
            }
            const cwdSources = args.cwd
              ? new Set(agentsForWorktree(args.cwd as string, sessions).map(session => session.source))
              : undefined;
            const query = (args.query as string | undefined)?.trim().toLowerCase();
            const matches = sessions.flatMap(session => {
              const repo = projectBySource.get(session.source);
              if ((!repo && !args.include_unregistered) || (args.repo_id && repo?.id !== args.repo_id) ||
                  (args.agent && session.agent !== args.agent) || (cwdSources && !cwdSources.has(session.source))) return [];
              const active = Date.parse(session.lastActive);
              if ((args.after && !(active >= Date.parse(args.after as string))) ||
                  (args.before && !(active <= Date.parse(args.before as string)))) return [];
              const manualTitle = titles[session.source] || session.manualTitle;
              const fields = [session.sessionId, session.source, session.cwd, session.title, manualTitle,
                session.aiTitle, session.firstUserMessage, session.lastUserMessage, ...(session.lastUserMessages ?? []), repo?.name, repo?.path];
              if (query && !fields.some(value => value?.toLowerCase().includes(query))) return [];
              return [{ ...session, manualTitle, repoId: repo?.id ?? null, repoName: repo?.name ?? null, repoPath: repo?.path ?? null }];
            }).sort((a, b) => Date.parse(b.lastActive) - Date.parse(a.lastActive) || a.source.localeCompare(b.source));
            return ok(request.id, textContent(JSON.stringify({
              sessions: matches.slice(offset, offset + limit), total: matches.length, limit, offset,
              nextOffset: offset + limit < matches.length ? offset + limit : null,
            })));
          }
          case "add_command": {
            if (typeof args.command !== "string" || !args.command.trim())
              return err(
                request.id,
                -32602,
                "add_command: command is required",
              );
            for (const field of ["repo_id", "cwd", "command_cwd", "name"]) {
              if (args[field] !== undefined && typeof args[field] !== "string")
                return err(
                  request.id,
                  -32602,
                  `add_command: ${field} must be a string`,
                );
            }
            if (
              args.run_mode !== undefined &&
              !["internal", "external", "shell"].includes(
                args.run_mode as string,
              )
            )
              return err(request.id, -32602, "add_command: invalid run_mode");
            const repos = await ctx.workspace.listRepos();
            let repo = args.repo_id
              ? repos.find((repo) => repo.id === args.repo_id)
              : undefined;
            if (args.repo_id && !repo)
              return err(request.id, -32602, "add_command: project not found");
            const cwd = (args.cwd as string | undefined) ?? ctx.sessionCwd;
            if (!repo && cwd) {
              if (!isAbsolute(cwd))
                return err(
                  request.id,
                  -32602,
                  "add_command: cwd must be absolute",
                );
              const matches = [];
              for (const candidate of repos) {
                for (const wt of await listWorktrees(candidate.path)) {
                  const child = relative(wt.path, cwd);
                  if (
                    !wt.bare &&
                    !isAbsolute(child) &&
                    child !== ".." &&
                    !child.startsWith("../") &&
                    !child.startsWith("..\\")
                  )
                    matches.push({ repo: candidate, path: wt.path });
                }
              }
              matches.sort((a, b) => b.path.length - a.path.length);
              repo = matches[0]?.repo;
            }
            if (!repo)
              return err(
                request.id,
                -32602,
                "add_command: supply a repo_id or a cwd inside a registered project",
              );
            const link = await ctx.workspace.addCustomLink(repo.id, {
              kind: "command",
              cmd: args.command,
              name: args.name as string | undefined,
              cwd: args.command_cwd as string | undefined,
              runMode: args.run_mode as
                | "internal"
                | "external"
                | "shell"
                | undefined,
            });
            await ctx.events.append({
              type: "custom_link_add",
              actor: "agent",
              payload: { id: repo.id, link },
            });
            ctx.changed?.({
              kind: "custom_link_add",
              id: repo.id,
              linkId: link.id,
            });
            return ok(
              request.id,
              textContent(JSON.stringify({ repoId: repo.id, link })),
            );
          }
          case "list_commands":
          case "list_connected_apps": {
            if (args.repo_id !== undefined && typeof args.repo_id !== "string")
              return err(request.id, -32602, "repo_id must be a string");
            const repos = (await ctx.workspace.listRepos()).filter(
              (repo) => args.repo_id === undefined || repo.id === args.repo_id,
            );
            if (args.repo_id !== undefined && repos.length === 0)
              return err(request.id, -32602, "project not found");
            const links = repos.flatMap((repo) =>
              (repo.customLinks ?? []).map((link) => ({
                ...link,
                repoId: repo.id,
                repoPath: repo.path,
              })),
            );
            if (name === "list_commands") {
              return ok(
                request.id,
                textContent(
                  JSON.stringify({
                    saved: links.filter((link) => link.kind === "command"),
                    running: (ctx.runningCommands?.() ?? []).filter(
                      (command) =>
                        args.repo_id === undefined ||
                        command.repoId === args.repo_id,
                    ),
                  }),
                ),
              );
            }
            return ok(
              request.id,
              textContent(
                JSON.stringify({
                  editors: await detectEditors(),
                  fork:
                    process.platform === "win32"
                      ? { executable: await findWindowsFork() }
                      : { integration: process.platform === "darwin" },
                  projectLinks: links.filter((link) => link.kind !== "command"),
                }),
              ),
            );
          }
          case "list_notes": {
            if (
              args.anchor_prefix !== undefined &&
              typeof args.anchor_prefix !== "string"
            )
              return err(request.id, -32602, "anchor_prefix must be a string");
            const notes = await NotesStore.open(ctx.workspace.path);
            return ok(
              request.id,
              textContent(
                JSON.stringify(
                  await notes.list({
                    anchorPrefix: args.anchor_prefix as string | undefined,
                  }),
                ),
              ),
            );
          }
          case "reorder_repos": {
            if (
              !Array.isArray(args.order) ||
              !args.order.every((id) => typeof id === "string")
            ) {
              return err(
                request.id,
                -32602,
                "reorder_repos: order must be an array of repo ids",
              );
            }
            const result = await ctx.workspace.reorderRepos(
              args.order as string[],
            );
            const prefs = await ctx.workspace.getPrefs();
            const saved = JSON.parse(
              prefs["supergit:repoOrder"] ?? "[]",
            ) as string[];
            const pending = result.newOrder.map((id) => `local\0${id}`);
            const repoOrder = saved
              .map((key) => (key.startsWith("local\0") ? pending.shift() : key))
              .filter((key): key is string => key !== undefined);
            repoOrder.push(...pending);
            await ctx.workspace.patchPrefs({
              "supergit:repoOrder": JSON.stringify(repoOrder),
            });
            if (
              result.oldOrder.join() !== result.newOrder.join() ||
              JSON.stringify(saved) !== JSON.stringify(repoOrder)
            )
              ctx.changed?.({ kind: "repos_reorder", repoOrder });
            return ok(request.id, textContent(JSON.stringify(result)));
          }
          case "set_repo_color": {
            if (
              typeof args.id !== "string" ||
              (typeof args.color !== "string" && args.color !== null)
            ) {
              return err(
                request.id,
                -32602,
                "set_repo_color: id and color (#rrggbb or null) are required",
              );
            }
            const result = await ctx.workspace.setRepoColor(
              args.id,
              args.color,
            );
            if (result.oldColor !== result.newColor)
              ctx.changed?.({
                kind: "repo_color",
                id: args.id,
                color: result.newColor,
              });
            return ok(
              request.id,
              textContent(JSON.stringify({ id: args.id, ...result })),
            );
          }
          case "open_session": {
            if (
              typeof args.repo_id !== "string" ||
              !["claude", "codex", "copilot", "shell"].includes(
                args.agent as string,
              )
            ) {
              return err(
                request.id,
                -32602,
                "open_session: repo_id and agent (claude, codex, copilot or shell) are required",
              );
            }
            for (const field of ["cwd", "model", "resume_session_id"]) {
              if (
                args[field] !== undefined &&
                (typeof args[field] !== "string" ||
                  !(args[field] as string).trim())
              ) {
                return err(
                  request.id,
                  -32602,
                  `open_session: ${field} must be a non-empty string`,
                );
              }
            }
            if (
              ["shell", "copilot"].includes(args.agent as string) &&
              (args.model || args.resume_session_id)
            ) {
              return err(
                request.id,
                -32602,
                "open_session: model and resume_session_id apply to Claude/Codex only",
              );
            }
            if (
              args.agent === "claude" &&
              args.model &&
              !["fable", "opus", "sonnet", "haiku"].includes(
                args.model as string,
              )
            )
              return err(
                request.id,
                -32602,
                "open_session: invalid Claude model alias",
              );
            const repo = (await ctx.workspace.listRepos()).find(
              (repo) => repo.id === args.repo_id,
            );
            if (!repo)
              return err(request.id, -32602, "open_session: project not found");
            const target = (args.cwd as string | undefined) ?? repo.path;
            if (!isAbsolute(target))
              return err(
                request.id,
                -32602,
                "open_session: cwd must be absolute",
              );
            const normalize = (path: string) =>
              process.platform === "win32"
                ? resolve(path).toLowerCase()
                : resolve(path);
            const worktrees = await listWorktrees(repo.path);
            const worktree = worktrees.find(
              (wt) => normalize(wt.path) === normalize(target),
            );
            if (!worktree || worktree.bare)
              return err(
                request.id,
                -32602,
                "open_session: cwd must be a working tree of this project",
              );
            const session: Record<string, unknown> = {
              agent: args.agent,
              source: `__new__:${args.agent}:${randomUUID()}`,
            };
            if (args.resume_session_id)
              session.resumeSessionId = args.resume_session_id;
            else if (args.agent === "claude")
              session.preassignedSessionId = randomUUID();
            if (args.model)
              session[args.agent === "claude" ? "claudeModel" : "codexModel"] =
                args.model;
            const prefs = await ctx.workspace.getPrefs();
            const sessions = JSON.parse(prefs["supergit:openSessions"] ?? "{}");
            sessions[worktree.path] = [
              session,
              ...(sessions[worktree.path] ?? []),
            ];
            const visible = JSON.parse(
              prefs["supergit:visibleWorktrees"] ?? "{}",
            );
            // The UI defaults to just the first worktree when there is no preference.
            const visiblePaths = visible[repo.id] ?? [worktrees[0]!.path];
            if (!visiblePaths.includes(worktree.path))
              visiblePaths.push(worktree.path);
            visible[repo.id] = visiblePaths;
            const folded = JSON.parse(
              prefs["supergit:foldedRows"] ?? "[]",
            ) as string[];
            await ctx.workspace.patchPrefs({
              "supergit:openSessions": JSON.stringify(sessions),
              "supergit:visibleWorktrees": JSON.stringify(visible),
              "supergit:foldedRows": JSON.stringify(
                folded.filter((key) => key !== `${repo.id}|${worktree.path}`),
              ),
            });
            const opened = { repoId: repo.id, cwd: worktree.path, session };
            await ctx.events.append({
              type: "mcp_open_session",
              actor: "agent",
              payload: opened,
            });
            ctx.changed?.({ kind: "mcp_open_session", ...opened });
            return ok(request.id, textContent(JSON.stringify(opened)));
          }
          case "list_repos": {
            const repos = await ctx.workspace.listRepos();
            const enriched = await Promise.all(
              repos.map(async (r) => ({
                ...r,
                worktrees: await listWorktrees(r.path),
              })),
            );
            return ok(
              request.id,
              textContent(JSON.stringify(enriched, null, 2)),
            );
          }
          case "add_repo": {
            const path = args.path;
            if (typeof path !== "string" || path.length === 0) {
              return err(
                request.id,
                -32602,
                "add_repo: arguments.path (string) is required",
              );
            }
            if (!isAbsolute(path))
              return err(request.id, -32602, "add_repo: path must be absolute");
            const repo = await ctx.workspace.addRepo(path);
            await ctx.events.append({
              type: "add_repo",
              actor: "agent",
              payload: { path },
              inverse: { repo },
            });
            ctx.changed?.({ kind: "add_repo", id: repo.id });
            return ok(request.id, textContent(JSON.stringify(repo, null, 2)));
          }
          case "remove_repo": {
            const id = args.id;
            if (typeof id !== "string" || id.length === 0) {
              return err(
                request.id,
                -32602,
                "remove_repo: arguments.id (string) is required",
              );
            }
            const repos = await ctx.workspace.listRepos();
            const repo = repos.find((r) => r.id === id);
            if (!repo)
              return err(
                request.id,
                -32602,
                `remove_repo: no repo with id ${id}`,
              );
            const removed = await ctx.workspace.removeRepo(id);
            if (!removed)
              return err(
                request.id,
                -32602,
                `remove_repo: failed to remove ${id}`,
              );
            await ctx.events.append({
              type: "remove_repo",
              actor: "agent",
              payload: { id },
              inverse: { repo },
            });
            ctx.changed?.({ kind: "remove_repo", id });
            return ok(request.id, textContent(`removed ${repo.name}`));
          }
          default:
            return err(request.id, -32601, `unknown tool: ${name}`);
        }
      } catch (e) {
        return ok(request.id, {
          ...textContent(e instanceof Error ? e.message : String(e)),
          isError: true,
        });
      }
    }

    default:
      return err(request.id, -32601, `method not found: ${request.method}`);
  }
}

export function mcpServerInfo() {
  return {
    name: "treetop",
    version: "0.1.0",
    protocolVersion: "2025-11-25",
    capabilities: { tools: {} },
    tools: TOOLS,
    transport: "http",
    endpoint: "POST /mcp (JSON-RPC 2.0)",
    note: "Stateless MCP HTTP endpoint with JSON responses. No server-initiated MCP SSE stream.",
  };
}

export async function handleMcpHttp(
  req: Request,
  ctx: McpContext,
): Promise<Response> {
  if (req.method === "GET") {
    if (req.headers.get("Accept")?.includes("text/event-stream")) {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    return Response.json(mcpServerInfo());
  }
  if (req.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const body = (await req.json().catch(() => null)) as JsonRpcRequest | null;
  if (
    !body ||
    Array.isArray(body) ||
    body.jsonrpc !== "2.0" ||
    typeof body.method !== "string" ||
    (body.id !== undefined &&
      body.id !== null &&
      typeof body.id !== "string" &&
      typeof body.id !== "number")
  ) {
    return Response.json(err(null, -32600, "invalid JSON-RPC 2.0 request"), {
      status: 400,
    });
  }
  const sessionCwd = new URL(req.url).searchParams.get("cwd") ?? ctx.sessionCwd;
  const result = await handleMcp(body, { ...ctx, sessionCwd });
  return result === null
    ? new Response(null, { status: 202 })
    : Response.json(result);
}
