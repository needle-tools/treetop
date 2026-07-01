import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseDevWorkspaceArgs, seedWorkspaceIfMissing } from "../../../dev";

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
      await expect(
        readFile(join(target, "daemon.log"), "utf-8"),
      ).rejects.toThrow();
      expect(await readFile(join(target, "notes.json"), "utf-8")).toContain(
        join(target, "attachments", "paste.txt"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
