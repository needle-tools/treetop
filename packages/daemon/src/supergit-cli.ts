import type { AgentSession } from "./agents";
import type { TerminalRecord } from "./terminals/types";

export type SupergitSessionState = "running" | "idle" | "awaiting_input" | "stopped";

export interface SupergitSession {
  id: string;
  name: string;
  state: SupergitSessionState;
  agent?: string;
  cwd: string;
  source?: string;
  terminalId?: string;
  lastActive?: string;
}

export interface SupergitMessageReceiver {
  kind?: "session" | "peer";
  sessionId: string;
  label?: string;
  agent?: string;
  source?: string;
  terminalId?: string;
  delivery?: "draft" | "staged" | "sent";
}

export interface SupergitMessageSender {
  kind: "session";
  id: string;
  label?: string;
  agent?: string;
  source?: string;
  terminalId?: string;
}

export interface SupergitPeerSender {
  kind: "peer";
  id: string;
  label?: string;
}

export type SupergitMessageTarget =
  | { kind: "session"; id: string }
  | { kind: "self" }
  | { kind: "inbox" };

export type SupergitMessageSenderMode = "auto" | "me";

export interface SupergitMessageRequest {
  body: string;
  target?: SupergitMessageTarget;
  senderMode: SupergitMessageSenderMode;
  callerPid?: number;
  callerCwd?: string;
}

export type SupergitMessageRequestParseResult =
  | { ok: true; value: SupergitMessageRequest }
  | { ok: false; status: number; error: string };

export interface SupergitTerminalRecord extends TerminalRecord {
  awaitingInput?: boolean;
}

const RUNNING_OUTPUT_MS = 1500;
export const TREETOP_CLI_BIN_NAME = "treetop";
const OPEN_SESSIONS_PREF_KEY = "supergit:openSessions";
const NON_SESSION_SOURCE_PREFIXES = [
  "__files__:",
  "__remote__:",
  "__restore__:",
  "__history__:",
] as const;

export interface SupergitOpenSessionRefs {
  sources: Set<string>;
  sessionIds: Set<string>;
}

function firstLine(input: string | undefined): string {
  return (input ?? "").split(/\r?\n/, 1)[0]!.trim();
}

function fallbackSessionName(s: AgentSession): string {
  const manual = firstLine(s.manualTitle);
  if (manual) return manual;
  const last = firstLine(s.lastUserMessage);
  if (last) return last;
  const title = firstLine(s.title);
  if (title) return title;
  const first = firstLine(s.firstUserMessage);
  if (first) return first;
  return s.sessionId ? `session ${s.sessionId.slice(0, 8)}` : (s.source.split(/[\\/]/).pop() ?? s.source);
}

function displayNameForAgent(s: AgentSession, sessionTitles: Record<string, string>): string {
  return firstLine(sessionTitles[s.source]) || fallbackSessionName(s);
}

function displayNameForTerminal(t: SupergitTerminalRecord, sessionTitles: Record<string, string>): string {
  const sourceTitle =
    (t.ownerId ? firstLine(sessionTitles[t.ownerId]) : "") ||
    firstLine(sessionTitles[`__attached__:shell:${t.id}`]) ||
    firstLine(sessionTitles[`shell:${t.id}`]);
  if (sourceTitle) return sourceTitle;
  const base = t.agent && t.agent !== "shell" ? t.agent : (t.cmd[0]?.split(/[\\/]/).pop() ?? "terminal");
  return `${base} ${t.ownerId ?? t.id}`;
}

function openSessionRefAllowed(source: string): boolean {
  return !NON_SESSION_SOURCE_PREFIXES.some((p) => source.startsWith(p));
}

export function openSessionRefsFromPrefs(prefs: Record<string, string>): SupergitOpenSessionRefs {
  const refs: SupergitOpenSessionRefs = { sources: new Set(), sessionIds: new Set() };
  const raw = prefs[OPEN_SESSIONS_PREF_KEY];
  if (!raw) return refs;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refs;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refs;
  for (const value of Object.values(parsed)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      if (typeof o.source === "string" && o.source.length > 0 && openSessionRefAllowed(o.source)) {
        refs.sources.add(o.source);
      }
      if (typeof o.resumeSessionId === "string" && o.resumeSessionId.length > 0) {
        refs.sessionIds.add(o.resumeSessionId);
      }
      if (typeof o.preassignedSessionId === "string" && o.preassignedSessionId.length > 0) {
        refs.sessionIds.add(o.preassignedSessionId);
      }
    }
  }
  return refs;
}

function terminalState(t: SupergitTerminalRecord, nowMs: number): SupergitSessionState {
  if (t.exitedAt) return "stopped";
  if (t.awaitingInput) return "awaiting_input";
  const last = Date.parse(t.lastOutputAt);
  if (Number.isFinite(last) && nowMs - last <= RUNNING_OUTPUT_MS) return "running";
  return "idle";
}

export function buildSupergitSessions(opts: {
  terminals: SupergitTerminalRecord[];
  agents: AgentSession[];
  openSessionRefs?: SupergitOpenSessionRefs;
  sessionTitles?: Record<string, string>;
  includeAll?: boolean;
  nowMs?: number;
}): SupergitSession[] {
  const nowMs = opts.nowMs ?? Date.now();
  const sessionTitles = opts.sessionTitles ?? {};
  const openSessionRefs = opts.openSessionRefs;
  const restrictToOpenSessions = !!openSessionRefs && !opts.includeAll;
  const hasOpenSessionRefs = !!openSessionRefs && (openSessionRefs.sources.size > 0 || openSessionRefs.sessionIds.size > 0);
  const agentsBySessionId = new Map<string, AgentSession>();
  const liveSessionIds = new Set<string>();
  for (const a of opts.agents) {
    if (a.sessionId) agentsBySessionId.set(a.sessionId, a);
  }

  const out: SupergitSession[] = [];
  for (const t of opts.terminals) {
    const agentMeta = t.ownerId ? agentsBySessionId.get(t.ownerId) : undefined;
    const attachedShellSource = `__attached__:shell:${t.id}`;
    if (
      restrictToOpenSessions &&
      hasOpenSessionRefs &&
      !openSessionRefs.sources.has(attachedShellSource) &&
      (!agentMeta || !openSessionRefs.sources.has(agentMeta.source)) &&
      (!t.ownerId || (!openSessionRefs.sessionIds.has(t.ownerId) && !openSessionRefs.sources.has(t.ownerId)))
    ) {
      continue;
    }
    const id = t.ownerId ?? t.id;
    if (t.ownerId) liveSessionIds.add(t.ownerId);
    out.push({
      id,
      name: agentMeta ? displayNameForAgent(agentMeta, sessionTitles) : displayNameForTerminal(t, sessionTitles),
      state: terminalState(t, nowMs),
      ...(t.agent ? { agent: t.agent } : {}),
      cwd: t.cwd,
      ...(agentMeta?.source ? { source: agentMeta.source } : {}),
      terminalId: t.id,
      lastActive: t.lastOutputAt,
    });
  }

  for (const a of opts.agents) {
    const id = a.sessionId ?? a.source;
    if (liveSessionIds.has(id)) continue;
    if (
      restrictToOpenSessions &&
      hasOpenSessionRefs &&
      !openSessionRefs.sources.has(a.source) &&
      (!a.sessionId || !openSessionRefs.sessionIds.has(a.sessionId))
    ) {
      continue;
    }
    if (restrictToOpenSessions && !hasOpenSessionRefs) continue;
    out.push({
      id,
      name: displayNameForAgent(a, sessionTitles),
      state: "stopped",
      agent: a.agent,
      cwd: a.cwd,
      source: a.source,
      lastActive: a.lastActive,
    });
  }

  return out;
}

export function resolveSupergitSession(
  sessions: SupergitSession[],
  id: string,
): SupergitSession | undefined {
  return sessions.find((s) =>
    s.id === id ||
    s.terminalId === id ||
    s.source === id
  );
}

export function resolveSupergitCallerSession(
  sessions: SupergitSession[],
  terminals: SupergitTerminalRecord[],
  callerPid: number | undefined,
  callerAncestorPids: number[] = [],
): SupergitSession | undefined {
  const pids = new Set(
    [callerPid, ...callerAncestorPids].filter(
      (pid): pid is number => typeof pid === "number" && Number.isFinite(pid),
    ),
  );
  if (pids.size === 0) return undefined;
  const terminal = terminals.find((t) => pids.has(t.pid));
  if (!terminal) return undefined;
  return resolveSupergitSession(sessions, terminal.ownerId ?? terminal.id);
}

function comparablePath(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (trimmed === "/") return trimmed;
  return trimmed.replace(/[\\/]+$/, "");
}

export function resolveSupergitSelfSession(
  sessions: SupergitSession[],
  terminals: SupergitTerminalRecord[],
  opts: { callerPid?: number; callerAncestorPids?: number[]; callerCwd?: string },
): SupergitSession | undefined {
  const byPid = resolveSupergitCallerSession(
    sessions,
    terminals,
    opts.callerPid,
    opts.callerAncestorPids,
  );
  if (byPid) return byPid;

  const callerCwd = comparablePath(opts.callerCwd);
  if (!callerCwd) return undefined;
  const sameCwdLive = sessions.filter((s) =>
    comparablePath(s.cwd) === callerCwd &&
    s.state !== "stopped"
  );
  if (sameCwdLive.length === 1) return sameCwdLive[0];
  const sameCwdRunning = sameCwdLive.filter((s) => s.state === "running");
  if (sameCwdRunning.length === 1) return sameCwdRunning[0];
  return undefined;
}

export function supergitSelfResolutionError(): string {
  return "Could not resolve current session. Are you running outside a Treetop terminal? Use `treetop message <sessionId> --content ...` after `treetop session list --all --json`. Use `treetop message me ...` only when you want an inbox note.";
}

function parseMessageTarget(value: unknown): SupergitMessageTarget | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (o.kind === "inbox") return { kind: "inbox" };
  if (o.kind === "self") return { kind: "self" };
  if (o.kind === "session" && typeof o.id === "string" && o.id.trim()) {
    return { kind: "session", id: o.id.trim() };
  }
  return null;
}

export function parseSupergitMessageRequest(input: unknown): SupergitMessageRequestParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, status: 400, error: "JSON object required" };
  }
  const o = input as Record<string, unknown>;
  if (typeof o.body !== "string") {
    return { ok: false, status: 400, error: "body is required" };
  }
  const messageBody = o.body;
  if (!messageBody.trim()) {
    return { ok: false, status: 400, error: "body is required" };
  }
  const target = parseMessageTarget(o.target);
  if (target === null) {
    return { ok: false, status: 400, error: "target must be {kind:'session',id}, {kind:'self'}, or {kind:'inbox'}" };
  }
  const sender = o.sender;
  let senderMode: SupergitMessageSenderMode = "auto";
  if (sender !== undefined) {
    if (typeof sender !== "object" || sender === null || Array.isArray(sender)) {
      return { ok: false, status: 400, error: "sender must be an object" };
    }
    const mode = (sender as Record<string, unknown>).mode;
    if (mode === undefined || mode === "auto") senderMode = "auto";
    else if (mode === "me") senderMode = "me";
    else return { ok: false, status: 400, error: "sender.mode must be one of: auto, me" };
  }
  const caller = o.caller;
  let callerPid: number | undefined;
  let callerCwd: string | undefined;
  if (caller !== undefined) {
    if (typeof caller !== "object" || caller === null || Array.isArray(caller)) {
      return { ok: false, status: 400, error: "caller must be an object" };
    }
    const c = caller as Record<string, unknown>;
    callerPid = typeof c.pid === "number" && Number.isFinite(c.pid) ? c.pid : undefined;
    callerCwd = typeof c.cwd === "string" ? c.cwd : undefined;
  }
  return {
    ok: true,
    value: {
      body: messageBody,
      ...(target ? { target } : {}),
      senderMode,
      ...(callerPid !== undefined ? { callerPid } : {}),
      ...(callerCwd !== undefined ? { callerCwd } : {}),
    },
  };
}

export function receiverForSession(s: SupergitSession): SupergitMessageReceiver {
  return {
    kind: "session",
    sessionId: s.id,
    label: s.name,
    ...(s.agent ? { agent: s.agent } : {}),
    ...(s.source ? { source: s.source } : {}),
    ...(s.terminalId ? { terminalId: s.terminalId } : {}),
    delivery: "draft",
  };
}

export function senderForSession(s: SupergitSession): SupergitMessageSender {
  return {
    kind: "session",
    id: s.id,
    label: s.name,
    ...(s.agent ? { agent: s.agent } : {}),
    ...(s.source ? { source: s.source } : {}),
    ...(s.terminalId ? { terminalId: s.terminalId } : {}),
  };
}

export function resolveSupergitMessageSender(opts: {
  senderMode: SupergitMessageSenderMode;
  target?: SupergitMessageTarget;
  callerSession?: SupergitSession;
  peerIdentity?: { id: string; label?: string } | null;
}): SupergitMessageSender | SupergitPeerSender | undefined {
  if (opts.senderMode === "auto" && opts.callerSession) {
    return senderForSession(opts.callerSession);
  }
  if (
    (opts.senderMode === "me" ||
      (opts.senderMode === "auto" && opts.target?.kind === "inbox")) &&
    opts.peerIdentity
  ) {
    return {
      kind: "peer",
      id: opts.peerIdentity.id,
      label: opts.peerIdentity.label,
    };
  }
  return undefined;
}

export function buildSupergitCliScript(opts: { defaultDaemonUrl: string }): string {
  const defaultUrl = JSON.stringify(opts.defaultDaemonUrl);
  return `#!/usr/bin/env node
const DEFAULT_DAEMON_URL = ${defaultUrl};

function help() {
  console.log(\`treetop experimental terminal CLI

Commands:
  treetop list [--all] [--json]
  treetop session list [--all] [--json]
      List open Treetop UI sessions with ids, names, and state.
      Use --all to include older detected sessions.

  treetop message [--from auto|me] [sessionId|self|me] <content...>
      Create a Treetop note, optionally addressed to a session.
      Omitting the target is the same as self: message the session running this command.
      Use self for the session running this command.
      Use me only when you explicitly want an inbox note.
      Legacy --content "content as md" is still accepted.
\`);
}

function sessionHelp() {
  console.log(\`treetop session

Usage:
  treetop session list [--all] [--json]

Options:
  --all   Include older detected sessions, not just open UI sessions.
  --json  Print machine-readable JSON.
\`);
}

function messageHelp() {
  console.log(\`treetop message

Usage:
  treetop message [--from auto|me] [sessionId|self|me] <content...>
  treetop message [--from auto|me] --to <sessionId|self|me> <content...>

Targets:
  Omitting the target is the same as self.
  no target  Same as self: address the Treetop session running this command.
  self       Address the note to the Treetop session running this command.
  me         Send the note to your own inbox. Only use this for explicit inbox notes.
  --to       Address a session id, self, or me without positional ambiguity.

Content:
  Positional words become markdown content.
  Legacy --content "content as md" is still accepted.

Options:
  --from auto  Use the Treetop session running this command (default).
  --from me    Use this machine's peer identity as sender.
\`);
}

function argValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return "";
  return args[i + 1] || "";
}

function buildMessageBody(content, args) {
  const text = content.trimEnd();
  const extras = text
    ? args.map((x) => x.trim()).filter(Boolean).join("\\n")
    : args.map((x) => x.trim()).filter(Boolean).join(" ");
  if (text && extras) return \`\${text}\\n\\n\${extras}\`;
  return text || extras;
}

function targetFromArg(value) {
  const lower = value.trim().toLowerCase();
  if (!lower) return undefined;
  if (lower === "self") return { kind: "self" };
  if (lower === "me") return { kind: "inbox" };
  return { kind: "session", id: value.trim() };
}

async function request(path, init) {
  const base = DEFAULT_DAEMON_URL.replace(/\\/$/, "");
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body && typeof body === "object" && body.error ? body.error : \`HTTP \${res.status}\`;
    throw new Error(msg);
  }
  return body;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    help();
    return;
  }
  if (
    (args[0] === "session" && (args[1] === "--help" || args[1] === "-h" || args[1] === "help")) ||
    (args[0] === "session" && args[1] === "list" && (args[2] === "--help" || args[2] === "-h")) ||
    (args[0] === "list" && (args[1] === "--help" || args[1] === "-h"))
  ) {
    sessionHelp();
    return;
  }
  if (args[0] === "session" && args[1] !== "list") {
    console.error("session requires a subcommand");
    sessionHelp();
    process.exitCode = 2;
    return;
  }
  if ((args[0] === "session" && args[1] === "list") || args[0] === "list") {
    const body = await request(args.includes("--all") ? "/api/supergit/sessions?all=1" : "/api/supergit/sessions");
    if (args.includes("--json")) {
      console.log(JSON.stringify(body.sessions, null, 2));
      return;
    }
    for (const s of body.sessions) {
      const agent = s.agent ? \` \${s.agent}\` : "";
      console.log(\`\${s.id}\\t\${s.state}\${agent}\\t\${s.name}\`);
    }
    return;
  }
  if (args[0] === "message") {
    if (args[1] === "--help" || args[1] === "-h" || args[1] === "help") {
      messageHelp();
      return;
    }
    const explicitFrom = args.includes("--from");
    const fromMode = explicitFrom ? argValue(args, "--from") : "auto";
    if (fromMode !== "auto" && fromMode !== "me") {
      console.error("--from must be one of: auto, me");
      process.exitCode = 2;
      return;
    }
    const fromIndex = args.indexOf("--from");
    const contentIndex = args.indexOf("--content");
    const toIndex = args.indexOf("--to");
    const optionIndexes = new Set([0]);
    if (fromIndex >= 0) {
      optionIndexes.add(fromIndex);
      optionIndexes.add(fromIndex + 1);
    }
    if (contentIndex >= 0) {
      optionIndexes.add(contentIndex);
      optionIndexes.add(contentIndex + 1);
    }
    if (toIndex >= 0) {
      optionIndexes.add(toIndex);
      optionIndexes.add(toIndex + 1);
    }
    const targetFromOption = argValue(args, "--to");
    if (toIndex >= 0 && !targetFromOption.trim()) {
      console.error("--to requires one of: sessionId, self, me");
      process.exitCode = 2;
      return;
    }
    const positional = args
      .map((x, i) => ({ x, i }))
      .filter(({ x, i }) => i > 0 && !optionIndexes.has(i) && !x.startsWith("-"));
    const firstPositional = positional[0];
    const firstTarget = firstPositional ? targetFromArg(firstPositional.x) : undefined;
    const firstIsNamedTarget =
      firstTarget && (firstTarget.kind === "self" || firstTarget.kind === "inbox");
    const firstIsLegacySessionTarget =
      firstTarget && firstTarget.kind === "session" && contentIndex >= 0 && toIndex < 0;
    const targetArg = targetFromOption || (firstIsNamedTarget || firstIsLegacySessionTarget ? firstPositional.x : "");
    const hasReceiver = targetArg.trim() !== "";
    const content = argValue(args, "--content");
    const used = new Set(optionIndexes);
    if (!targetFromOption && hasReceiver && firstPositional) used.add(firstPositional.i);
    const extraArgs = args.filter((_x, i) => !used.has(i));
    const messageBody = buildMessageBody(content, extraArgs);
    const target = hasReceiver ? targetFromArg(targetArg) : { kind: "self" };
    const body = await request("/api/supergit/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: messageBody,
        ...(target ? { target } : {}),
        sender: { mode: fromMode },
        caller: { pid: process.ppid, cwd: process.cwd() },
      }),
    });
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  help();
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exitCode = 1;
});
`;
}
