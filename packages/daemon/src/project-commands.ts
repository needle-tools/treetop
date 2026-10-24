import { resolve } from "node:path";
import type { Workspace, CommandRunMode } from "./workspace";
import type { PtyBackend, SpawnOptions } from "./terminals/types";
import { internalCommandTerminalArgs } from "./server-helpers";
import { listWorktrees } from "./git";

export interface CommandDefinition {
  repoId: string;
  linkId: string;
  repoPath: string;
  cwd: string;
  cmd: string;
  name?: string;
  runMode: CommandRunMode;
}
export interface CommandLaunch {
  pid?: number;
  termId?: string;
  via?: string;
  exited?: Promise<unknown>;
  stop?: () => Promise<void>;
}
interface RunningCommand extends CommandDefinition {
  pid?: number;
  termId?: string;
  startedAt: string;
  status: "running" | "stopping" | "external_untracked";
}
type CommandAction = "start" | "stop" | "restart";

async function waitForExit(
  exited: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Command exit was not confirmed; refusing to launch a replacement",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** One registry and operation lock for dashboard HTTP routes and MCP. */
export class ProjectCommands {
  private running = new Map<
    string,
    {
      definition: CommandDefinition;
      info: RunningCommand;
      process: CommandLaunch;
    }
  >();
  private pending = new Set<string>();
  constructor(
    private options: {
      workspace: Pick<Workspace, "listRepos">;
      launch: (definition: CommandDefinition) => Promise<CommandLaunch>;
      changed?: (change: Record<string, unknown>) => void;
      exitTimeoutMs?: number;
    },
  ) {}

  list(): RunningCommand[] {
    return [...this.running.values()]
      .filter((entry) => entry.info.status !== "external_untracked")
      .map((entry) => ({ ...entry.info }));
  }
  untracked(): RunningCommand[] {
    return [...this.running.values()]
      .filter((entry) => entry.info.status === "external_untracked")
      .map((entry) => ({ ...entry.info }));
  }

  async control(
    action: CommandAction,
    repoId: string,
    linkId: string,
    repoPath?: string,
    onReady?: (result: Record<string, unknown>) => Promise<void>,
  ) {
    const key = `${repoId}\0${linkId}`;
    if (this.pending.has(key))
      throw new Error("Command operation already in progress");
    this.pending.add(key);
    try {
      const repo = (await this.options.workspace.listRepos()).find(
        (repo) => repo.id === repoId,
      );
      if (!repo) throw new Error("Saved command project not found");
      const link = repo.customLinks?.find((link) => link.id === linkId);
      if (!link || link.kind !== "command")
        throw new Error("Saved command not found in this project");
      const samePath = (left: string, right: string) =>
        process.platform === "win32"
          ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
          : resolve(left) === resolve(right);
      if (
        repoPath &&
        !samePath(repoPath, repo.path) &&
        !(await listWorktrees(repo.path)).some(
          (wt) => !wt.bare && samePath(wt.path, repoPath),
        )
      )
        throw new Error(
          "Command directory must be a registered project worktree",
        );
      const base = repoPath ?? repo.path;
      const definition: CommandDefinition = {
        repoId,
        linkId,
        repoPath: base,
        cwd: resolve(base, link.cwd ?? ""),
        cmd: link.cmd,
        name: link.name,
        runMode: link.runMode ?? "internal",
      };
      const current = this.running.get(key);
      if (action === "start" && current) {
        const result = this.result(
          current.info,
          current.info.status === "external_untracked"
            ? "external_untracked"
            : "already_running",
        );
        await onReady?.(result);
        return result;
      }
      if (action !== "start") {
        if ((current?.info.runMode ?? definition.runMode) === "external")
          throw new Error(
            "External terminal processes are untracked; stop them manually. Exit cannot be confirmed, so automatic restart is unavailable",
          );
        if (current) {
          current.info.status = "stopping";
          await waitForExit(
            (async () => {
              await current.process.stop!();
              await current.process.exited!;
            })(),
            this.options.exitTimeoutMs ?? 10_000,
          );
          if (this.running.get(key) === current) this.running.delete(key);
        }
        if (action === "stop")
          return {
            ok: true,
            status: current ? "stopped" : "not_running",
            repoId,
            linkId,
            commandId: linkId,
            confirmed: true,
            pid: current?.info.pid,
            termId: current?.info.termId,
          };
      }
      // A restart keeps the original worktree/cwd and run mode even if the UI's
      // default worktree changed while that process was running.
      const target =
        action === "restart" && current ? current.definition : definition;
      const launched = await this.options.launch(target);
      if (target.runMode !== "external" && (!launched.exited || !launched.stop))
        throw new Error("Command launcher did not supply a monitored process");
      const info: RunningCommand = {
        ...target,
        pid: launched.pid,
        termId: launched.termId,
        startedAt: new Date().toISOString(),
        status:
          target.runMode === "external" ? "external_untracked" : "running",
      };
      const entry = { definition: target, info, process: launched };
      this.running.set(key, entry);
      void launched.exited?.then(() => {
        if (this.running.get(key) !== entry) return;
        this.running.delete(key);
        this.options.changed?.({
          kind: "command_exit",
          linkId,
          repoId,
          termId: info.termId,
        });
      });
      this.options.changed?.({ kind: "command_start", ...info });
      const result = {
        ...this.result(
          info,
          info.status === "external_untracked" ? info.status : "started",
        ),
        via: launched.via,
      };
      await onReady?.(result);
      return result;
    } finally {
      this.pending.delete(key);
    }
  }

  private result(info: RunningCommand, status: string) {
    return {
      ok: true,
      ...info,
      commandId: info.linkId,
      mode: info.runMode,
      status,
    };
  }
}

/** Existing launch modes, with an explicit exit promise for managed processes. */
export function createCommandLauncher(options: {
  terminalBackend: Pick<PtyBackend, "spawn">;
  openExternal: (cwd: string, command: string) => Promise<{ via: string }>;
  terminalEnv: () => SpawnOptions["env"];
  /** Persistent brokers keep hidden commands under the same PTY/helper owner. */
  backgroundViaPty?: boolean;
  backgroundEnv: () => Record<string, string | undefined>;
  onInternalSpawn?: (
    handle: Awaited<ReturnType<PtyBackend["spawn"]>>,
    definition: CommandDefinition,
    spawnCmd: string[],
  ) => void;
}) {
  return async (definition: CommandDefinition): Promise<CommandLaunch> => {
    if (definition.runMode === "external")
      return options.openExternal(definition.cwd, definition.cmd);
    if (definition.runMode === "internal" || options.backgroundViaPty) {
      const spawnCmd = internalCommandTerminalArgs(
        definition.cmd,
        process.platform,
        process.env.SHELL || "/bin/sh",
        process.env.COMSPEC ?? "cmd.exe",
      );
      const handle = await options.terminalBackend.spawn({
        cmd: spawnCmd,
        cwd: definition.cwd,
        agent: "shell",
        size: { cols: 120, rows: 30 },
        env: options.terminalEnv(),
      });
      let unsubscribe = () => {};
      let finished = false;
      const exited = new Promise<void>((resolveExit) => {
        unsubscribe = handle.subscribe({
          onData() {},
          onExit() {
            finished = true;
            unsubscribe();
            resolveExit();
          },
        });
      });
      if (finished) unsubscribe();
      options.onInternalSpawn?.(handle, definition, spawnCmd);
      return {
        pid: handle.pid,
        termId: handle.id,
        exited,
        stop: async () => {
          if (!handle.isAlive()) return;
          handle.write("\x03");
          try {
            await waitForExit(exited, 1500);
          } catch {
            if (handle.isAlive()) await handle.kill();
          }
        },
      };
    }
    const proc = Bun.spawn(
      process.platform === "win32"
        ? [process.env.COMSPEC ?? "cmd.exe", "/c", definition.cmd]
        : ["sh", "-c", definition.cmd],
      {
        windowsHide: true,
        cwd: definition.cwd,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: options.backgroundEnv(),
        detached: process.platform !== "win32",
      },
    );
    return {
      pid: proc.pid,
      exited: proc.exited,
      stop: async () => {
        if (proc.exitCode !== null) return;
        if (process.platform === "win32") {
          const killed = Bun.spawn(
            ["taskkill", "/PID", String(proc.pid), "/T", "/F"],
            { windowsHide: true, stdout: "ignore", stderr: "ignore" },
          );
          if ((await killed.exited) !== 0 && proc.exitCode === null)
            throw new Error("Failed to stop command process tree");
        } else {
          process.kill(-proc.pid, "SIGTERM");
          try {
            await waitForExit(proc.exited, 2000);
          } catch {
            /* Escalate the process group below. */
          }
          // The shell may exit before a watcher that ignores SIGTERM. The group
          // still identifies those children after its original leader has gone.
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      },
    };
  };
}
