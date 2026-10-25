import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace";
import {
  ProjectCommands,
  createCommandLauncher,
} from "../src/project-commands";
import { NodePtyBackend } from "../src/terminals/node-pty-backend";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "treetop-project-commands-"));
  const workspace = await Workspace.open(join(root, "workspace"));
  const repo = await workspace.addRepo(root);
  const link = await workspace.addCustomLink(repo.id, {
    kind: "command",
    cmd: "test command",
    cwd: "package",
    runMode: "internal",
  });
  return { root, workspace, repo, link };
}

test("validates project/command IDs before launch and serializes concurrent starts", async () => {
  const { workspace, repo, link } = await setup();
  let launches = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commands = new ProjectCommands({
    workspace,
    launch: async (definition) => {
      launches++;
      expect(definition.cwd).toBe(join(repo.path, "package"));
      expect(definition.runMode).toBe("internal");
      await ready;
      return {
        pid: 1,
        termId: "pty",
        exited: new Promise(() => {}),
        stop: async () => {},
      };
    },
  });
  await expect(
    commands.control("start", "wrong-project", link.id),
  ).rejects.toThrow("project");
  await expect(
    commands.control("start", repo.id, "wrong-command"),
  ).rejects.toThrow("command");
  await expect(
    commands.control("start", repo.id, link.id, tmpdir()),
  ).rejects.toThrow("worktree");
  const first = commands.control("start", repo.id, link.id);
  await expect(commands.control("start", repo.id, link.id)).rejects.toThrow(
    "in progress",
  );
  release();
  await first;
  expect(await commands.control("start", repo.id, link.id)).toMatchObject({
    status: "already_running",
    termId: "pty",
  });
  expect(launches).toBe(1);
  expect(commands.list()).toMatchObject([
    {
      repoId: repo.id,
      linkId: link.id,
      runMode: "internal",
      cwd: join(repo.path, "package"),
      termId: "pty",
    },
  ]);
});

test("restart waits for confirmed exit and retains the running command cwd and run mode", async () => {
  const { workspace, repo, link } = await setup();
  let exit!: () => void;
  let stopped!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const definitions: any[] = [];
  const commands = new ProjectCommands({
    workspace,
    launch: async (definition) => {
      definitions.push(definition);
      return {
        pid: definitions.length,
        termId: `pty-${definitions.length}`,
        exited: new Promise<void>((resolve) => {
          exit = resolve;
        }),
        stop: async () => {
          stopped();
        },
      };
    },
  });
  await commands.control("start", repo.id, link.id);
  const finishFirst = exit;
  const restart = commands.control("restart", repo.id, link.id);
  await stopRequested;
  expect(definitions).toHaveLength(1);
  expect(commands.list()[0]?.status).toBe("stopping");
  finishFirst();
  expect(await restart).toMatchObject({ status: "started", termId: "pty-2" });
  expect(definitions[1]).toEqual(definitions[0]);
  expect(commands.list()).toHaveLength(1);
  exit();
  await Promise.resolve();
  expect(commands.list()).toEqual([]);
});

test.each([false, true])(
  "a stop timeout prevents restart or a duplicate launch (stop callback hangs: %s)",
  async (hangs) => {
    const { workspace, repo, link } = await setup();
    let launches = 0;
    const commands = new ProjectCommands({
      workspace,
      exitTimeoutMs: 10,
      launch: async () => {
        launches++;
        return {
          pid: 1,
          exited: new Promise(() => {}),
          stop: async () => {
            if (hangs) await new Promise(() => {});
          },
        };
      },
    });
    await commands.control("start", repo.id, link.id);
    await expect(commands.control("restart", repo.id, link.id)).rejects.toThrow(
      "exit",
    );
    expect(launches).toBe(1);
    expect((await commands.control("start", repo.id, link.id)).status).toBe(
      "already_running",
    );
    expect(commands.list()[0]?.status).toBe("stopping");
  },
);

test("external commands keep their run mode and cannot falsely confirm stop/restart", async () => {
  const { workspace, repo } = await setup();
  const link = await workspace.addCustomLink(repo.id, {
    kind: "command",
    cmd: "external command",
    runMode: "external",
  });
  let launches = 0;
  const commands = new ProjectCommands({
    workspace,
    launch: async (definition) => {
      expect(definition.runMode).toBe("external");
      launches++;
      return { via: "test external boundary" };
    },
  });
  expect(await commands.control("start", repo.id, link.id)).toMatchObject({
    status: "external_untracked",
    mode: "external",
  });
  await commands.control("start", repo.id, link.id);
  await expect(commands.control("stop", repo.id, link.id)).rejects.toThrow(
    "External",
  );
  await expect(commands.control("restart", repo.id, link.id)).rejects.toThrow(
    "External",
  );
  expect(launches).toBe(1);
  expect(commands.list()).toEqual([]);
  expect(commands.untracked()).toMatchObject([
    { linkId: link.id, status: "external_untracked" },
  ]);
});

test("a failed launch releases the command lock without claiming a running process", async () => {
  const { workspace, repo, link } = await setup();
  let attempts = 0;
  const commands = new ProjectCommands({
    workspace,
    launch: async () => {
      if (++attempts === 1) throw new Error("fixture launch failed");
      return { pid: 1, exited: new Promise(() => {}), stop: async () => {} };
    },
  });
  await expect(commands.control("start", repo.id, link.id)).rejects.toThrow(
    "launch failed",
  );
  expect(commands.list()).toEqual([]);
  expect(await commands.control("start", repo.id, link.id)).toMatchObject({
    status: "started",
  });
  expect(attempts).toBe(2);
});

test("publishing an internal terminal stays inside the same operation lock", async () => {
  const { workspace, repo, link } = await setup();
  let publishing!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    publishing = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const commands = new ProjectCommands({
    workspace,
    launch: async () => ({
      pid: 1,
      exited: new Promise(() => {}),
      stop: async () => {},
    }),
  });
  const start = commands.control(
    "start",
    repo.id,
    link.id,
    undefined,
    async () => {
      publishing();
      await gate;
    },
  );
  await entered;
  await expect(commands.control("restart", repo.id, link.id)).rejects.toThrow(
    "in progress",
  );
  finish();
  await start;
});

test.each(["internal", "shell"] as const)(
  "the production %s launcher tracks a real process and confirms exit before replacement",
  async (runMode) => {
    const { workspace, repo } = await setup();
    await writeFile(
      join(repo.path, "fixture.cjs"),
      "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(()=>{},1000);",
    );
    const link = await workspace.addCustomLink(repo.id, {
      kind: "command",
      cmd: "node fixture.cjs",
      runMode,
    });
    const childPid = async (previous?: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          const pid = Number(
            await readFile(join(repo.path, "child.pid"), "utf8"),
          );
          if (pid > 0 && pid !== previous) return pid;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Test command child did not start");
    };
    const backend = new NodePtyBackend();
    const commands = new ProjectCommands({
      workspace,
      launch: createCommandLauncher({
        terminalBackend: backend,
        openExternal: async () => {
          throw new Error("External launch not authorized in test");
        },
        terminalEnv: () =>
          Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
        backgroundEnv: () => process.env,
      }),
    });
    try {
      const first = await commands.control("start", repo.id, link.id);
      const firstChild = await childPid();
      expect(commands.list()[0]?.pid).toBe(first.pid);
      const replacement = await commands.control("restart", repo.id, link.id);
      expect(() => process.kill(firstChild, 0)).toThrow();
      const secondChild = await childPid(firstChild);
      if (runMode === "internal")
        expect(backend.get(first.termId!)?.isAlive()).toBe(false);
      else expect(() => process.kill(first.pid!, 0)).toThrow();
      expect(replacement.pid).not.toBe(first.pid);
      expect(commands.list()).toHaveLength(1);
      await commands.control("stop", repo.id, link.id);
      expect(() => process.kill(secondChild, 0)).toThrow();
      if (runMode === "internal")
        expect(backend.get(replacement.termId!)?.isAlive()).toBe(false);
      else expect(() => process.kill(replacement.pid!, 0)).toThrow();
      expect(commands.list()).toEqual([]);
    } finally {
      await commands.control("stop", repo.id, link.id).catch(() => {});
      await backend.shutdown();
    }
  },
  20_000,
);
import { commandShellHeaders } from "../src/project-commands";

test("live internal commands restore shell markers without a recorded shell transcript", () => {
  const base = { repoId: "repo", linkId: "dev", repoPath: "C:/project", cwd: "C:/project/app", cmd: "npm run dev", runMode: "internal" as const, startedAt: "2026-10-25T12:00:00Z", status: "running" as const, termId: "live" };
  expect(commandShellHeaders([base], new Set(["live"]))).toEqual([{
    kind: "header", termId: "live", wt: "C:/project", spawnCwd: "C:/project/app", createdAt: base.startedAt,
  }]);
  expect(commandShellHeaders([base], new Set())).toEqual([]);
  expect(commandShellHeaders([{...base, runMode: "external"}], new Set(["live"]))).toEqual([]);
});
