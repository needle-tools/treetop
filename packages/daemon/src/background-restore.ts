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

export function resumeTerminalCommand(record: any): string[] {
  const command = [...(record.resumeCmd ?? record.cmd)];
  if (record.agent !== "codex" && record.agent !== "claude") return command;
  const binary = basename(command[0] ?? "").replace(/\.(exe|cmd)$/i, "");
  if (binary !== record.agent)
    throw new Error("Wrapped agent command needs a manual resume");
  const owner = record.ownerId;
  if (typeof owner !== "string" || !owner || owner.startsWith("__new__:"))
    throw new Error("No provider session ID; resume this session manually");
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
