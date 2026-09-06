import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseDevWorkspaceArgs,
  seedWorkspaceIfMissing,
  waitForDevChildren,
} from "../../../dev";

function pendingChild() {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  let killed = false;
  return {
    child: {
      exited,
      kill: () => {
        killed = true;
        resolveExit(0);
      },
    },
    exit: resolveExit,
    wasKilled: () => killed,
  };
}

describe("dev workspace arguments", () => {
  test("maps a workspace name to the user's supergit workspace root", () => {
    const opts = parseDevWorkspaceArgs(["--workspace", "perf-scroll"], {});
    expect(opts.name).toBe("perf-scroll");
    expect(opts.workspacePath).toMatch(
      /supergit[/\\]workspaces[/\\]perf-scroll$/,
    );
    expect(opts.readonly).toBe(false);
    expect(opts.daemonPort).toBe(17777);
    expect(opts.uiPort).toBe(17779);
  });

  test("accepts positional name, readonly, and explicit ports", () => {
    const opts = parseDevWorkspaceArgs([
      "w1",
      "--readonly",
      "--port",
      "18877",
      "--ui-port",
      "18879",
    ]);
    expect(opts.name).toBe("w1");
    expect(opts.readonly).toBe(true);
    expect(opts.daemonPort).toBe(18877);
    expect(opts.uiPort).toBe(18879);
  });

  test("rejects path traversal in named workspaces", () => {
    expect(() => parseDevWorkspaceArgs(["--workspace", "../prod"])).toThrow(
      /workspace name/,
    );
  });
});

describe("seedWorkspaceIfMissing", () => {
  test("creates an empty named workspace when no copy source is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "treetop-ws-test-"));
    try {
      const target = join(root, "empty");
      await expect(
        seedWorkspaceIfMissing({ workspacePath: target }),
      ).resolves.toBe("created-empty");
      await expect(
        seedWorkspaceIfMissing({ workspacePath: target }),
      ).resolves.toBe("existing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("copies persisted data from a source workspace and skips runtime files", async () => {
    const root = await mkdtemp(join(tmpdir(), "treetop-ws-copy-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      await mkdir(join(source, "attachments"), { recursive: true });
      await writeFile(join(source, "repos.json"), '{"repos":[]}');
      const recordedAt = new Date("2026-08-29T15:47:32.000Z");
      await utimes(join(source, "repos.json"), recordedAt, recordedAt);
      await writeFile(join(source, "daemon.log"), "runtime log");
      await writeFile(
        join(source, "notes.json"),
        JSON.stringify({
          path: join(source, "attachments", "paste.txt"),
        }),
      );

      await expect(
        seedWorkspaceIfMissing({ workspacePath: target, copyFrom: source }),
      ).resolves.toBe("copied");

      expect(await readFile(join(target, "repos.json"), "utf-8")).toBe(
        '{"repos":[]}',
      );
      expect((await stat(join(target, "repos.json"))).mtimeMs).toBe(
        recordedAt.getTime(),
      );
      await expect(
        readFile(join(target, "daemon.log"), "utf-8"),
      ).rejects.toThrow();
      const copiedNotes = JSON.parse(
        await readFile(join(target, "notes.json"), "utf-8"),
      ) as { path?: string };
      expect(copiedNotes.path).toBe(join(target, "attachments", "paste.txt"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("dev child lifecycle", () => {
  test("stops Vite when the daemon exits instead of leaving a broken proxy alive", async () => {
    const daemon = pendingChild();
    const ui = pendingChild();
    const waiting = waitForDevChildren(daemon.child, ui.child);

    daemon.exit(1);

    await expect(waiting).rejects.toThrow("daemon exited with code 1");
    expect(ui.wasKilled()).toBe(true);
  });
});
