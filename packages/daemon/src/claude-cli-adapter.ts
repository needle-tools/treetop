import { stat as fsStat, unlink as fsUnlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  NativeAgentAdapter,
  NativeAgentRun,
  NativeAgentTurnRequest,
} from "./native-agent-adapters";

export interface ClaudeSpawnOptions {
  cmd: string[];
  cwd: string;
}

export interface ClaudeSpawnedProcess {
  pid: number;
  exited: Promise<unknown>;
  kill(signal?: string): void;
}

export interface ClaudeCliAdapterOptions {
  spawn?: (opts: ClaudeSpawnOptions) => ClaudeSpawnedProcess;
  stat?: (path: string) => Promise<unknown>;
  unlink?: (path: string) => Promise<unknown>;
}

function defaultSpawn(opts: ClaudeSpawnOptions): ClaudeSpawnedProcess {
  const proc = Bun.spawn({
    cmd: opts.cmd,
    cwd: opts.cwd,
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: (signal?: string) =>
      proc.kill(signal as Parameters<typeof proc.kill>[0]),
  };
}

export class ClaudeCliAdapter implements NativeAgentAdapter {
  readonly agent = "claude" as const;

  private readonly spawnProc: (
    opts: ClaudeSpawnOptions,
  ) => ClaudeSpawnedProcess;
  private readonly stat: (path: string) => Promise<unknown>;
  private readonly unlink: (path: string) => Promise<unknown>;

  constructor(opts: ClaudeCliAdapterOptions = {}) {
    this.spawnProc = opts.spawn ?? defaultSpawn;
    this.stat = opts.stat ?? fsStat;
    this.unlink = opts.unlink ?? fsUnlink;
  }

  sendTurn(req: NativeAgentTurnRequest): NativeAgentRun {
    if (!req.sessionId) throw new Error("claude needs sessionId");

    const lockCandidates = [
      join(req.cwd, "bun.lockb"),
      join(req.cwd, "bun.lock"),
    ];
    const preExistedPromise = Promise.all(
      lockCandidates.map(async (path) => {
        try {
          await this.stat(path);
          return true;
        } catch {
          return false;
        }
      }),
    );

    const proc = this.spawnProc({
      cmd: [
        "claude",
        "-p",
        "-r",
        req.sessionId,
        "--permission-mode",
        "bypassPermissions",
        req.text,
      ],
      cwd: req.cwd,
    });

    const exited = proc.exited.then(
      async (value) => {
        await this.cleanupAddedLocks(lockCandidates, await preExistedPromise);
        return value;
      },
      async (err) => {
        await this.cleanupAddedLocks(lockCandidates, await preExistedPromise);
        throw err;
      },
    );

    return {
      pid: proc.pid,
      exited,
      kill: (signal?: string) => proc.kill(signal),
    };
  }

  private async cleanupAddedLocks(
    lockCandidates: string[],
    preExisted: boolean[],
  ): Promise<void> {
    for (let i = 0; i < lockCandidates.length; i++) {
      if (preExisted[i]) continue;
      const path = lockCandidates[i]!;
      try {
        await this.stat(path);
        await this.unlink(path);
      } catch {
        // Missing or failed cleanup is non-fatal; the send already completed.
      }
    }
  }
}
