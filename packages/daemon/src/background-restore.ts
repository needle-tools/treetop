import { basename } from "node:path";

export interface RestoreCandidate {
  id: string;
  kind: "terminal" | "command";
  title: string;
  cwd: string;
  selected: boolean;
  terminal?: any;
  command?: any;
}

/** Display-only recovery names: preserve explicit titles without promoting AI
 * suggestions into saved names or matching another session merely by its cwd. */
export function restoreCandidateTitles(
  candidates: RestoreCandidate[],
  explicitTitles: Record<string, string>,
  openSessions: { source?: string; transcriptSource?: string; attachTermId?: string; resumeSessionId?: string }[],
  aiTitles: ReadonlyMap<string, string>,
): Record<string, string> {
  const knownSources = [...Object.keys(explicitTitles), ...aiTitles.keys()];
  return Object.fromEntries(candidates.map(row => {
    const terminal = row.terminal;
    if (!terminal) return [row.id, row.title];
    const owner = terminal.ownerId as string | undefined;
    const session = openSessions.find(session => session.attachTermId === terminal.id ||
      (!!owner && (session.source === owner || session.resumeSessionId === owner)));
    const source = owner ? knownSources.find(source => {
      const stem = source.replace(/\\/g, "/").split("/").pop()!.replace(/\.jsonl$/i, "").toLowerCase();
      const id = owner.toLowerCase();
      return stem === id || (/^[0-9a-f-]{36}$/i.test(id) && stem.endsWith(`-${id}`));
    }) : undefined;
    const keys = [session?.source, session?.transcriptSource, source, owner, `shell:${terminal.id}`]
      .filter((key): key is string => !!key);
    const explicit = keys.map(key => explicitTitles[key]?.trim()).find(Boolean);
    const suggested = keys.map(key => aiTitles.get(key.toLowerCase())?.trim()).find(Boolean);
    const generic = terminal.agent === "shell" ? "Terminal" : terminal.agent ?? "Terminal";
    const alreadyNamed = row.title !== generic && row.title !== `${generic}${owner ? ` (${owner.slice(0, 8)})` : ""}`;
    return [row.id, explicit || (alreadyNamed ? row.title : suggested || row.title)];
  }));
}

export function resumeTerminalCommand(record: any): string[] {
  let command = [...(record.resumeCmd ?? record.cmd)];
  if (record.agent !== "codex" && record.agent !== "claude") return command;
  const binary = basename(command[0] ?? "").replace(/\.(exe|cmd)$/i, "");
  if (binary !== record.agent)
    throw new Error("Wrapped agent command needs a manual resume");
  const owner = record.ownerId;
  if (typeof owner !== "string" || !owner || owner.startsWith("__new__:"))
    throw new Error("No provider session ID; resume this session manually");
  if (record.agent === "codex") {
    // These are launch-time choices, not the latest model selected inside
    // the CLI. Codex restores its session model when no override is supplied.
    const restored: string[] = [];
    for (let i = 0; i < command.length; i++) {
      const arg = command[i]!;
      if (arg === "--") { restored.push(...command.slice(i)); break; }
      if (arg === "--model" || arg === "-m") { i++; continue; }
      if (arg.startsWith("--model=") || /^-m.+/.test(arg)) continue;
      if (arg === "-c" || arg === "--config") {
        const value = command[++i]!;
        if (!/^model\s*=/.test(value)) restored.push(arg, value);
        continue;
      }
      if (/^(--config=|-c)model\s*=/.test(arg)) continue;
      restored.push(arg);
    }
    command = restored;
  }
  if (
    command.includes(owner) &&
    (command.includes("resume") || command.includes("--resume"))
  )
    return command;
  return record.agent === "codex"
    ? [command[0], "resume", ...command.slice(1), owner]
    : [command[0], "--resume", owner, ...command.slice(1)];
}

export function restoreCandidates(snapshot: any): RestoreCandidate[] {
  const commands: any[] = Array.isArray(snapshot?.commands)
    ? snapshot.commands
    : [];
  const commandTerminals = new Set(commands.map((command) => command.termId));
  return [
    ...(Array.isArray(snapshot?.terminals) ? snapshot.terminals : [])
      .filter((record: any) => !commandTerminals.has(record.id))
      .map((terminal: any) => ({
        id: `terminal:${terminal.id}`,
        kind: "terminal" as const,
        title:
          terminal.agent === "shell"
            ? "Terminal"
            : (terminal.agent ?? "Terminal"),
        cwd: terminal.cwd,
        selected:
          ["codex", "claude"].includes(terminal.agent) &&
          !!terminal.ownerId &&
          !terminal.ownerId.startsWith("__new__:"),
        terminal,
      })),
    ...commands.map((command) => ({
      id: `command:${command.repoId}:${command.linkId}`,
      kind: "command" as const,
      title: command.name ?? "Project command",
      cwd: command.cwd,
      selected: false,
      command,
    })),
  ];
}
