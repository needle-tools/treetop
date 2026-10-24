import { expect, test } from "bun:test";
import {
  restoreCandidates,
  resumeTerminalCommand,
} from "../src/background-restore";

test("restore lists saved commands once and keeps process restarts opt-in", () => {
  const terminal = {
    id: "pty",
    agent: "codex",
    ownerId: "session",
    cmd: ["codex", "--model", "m"],
    cwd: "/repo",
    size: { cols: 80, rows: 24 },
  };
  const rows = restoreCandidates({
    terminals: [terminal, { ...terminal, id: "command-pty", agent: "shell" }],
    commands: [
      {
        repoId: "r",
        linkId: "dev",
        termId: "command-pty",
        cwd: "/repo",
        name: "Dev",
      },
    ],
  });
  expect(rows.map((row) => [row.id, row.selected])).toEqual([
    ["terminal:pty", true],
    ["command:r:dev", false],
  ]);
  expect(resumeTerminalCommand(terminal)).toEqual([
    "codex",
    "resume",
    "--model",
    "m",
    "session",
  ]);
  expect(
    resumeTerminalCommand({ ...terminal, cmd: ["codex", "resume", "session"] }),
  ).toEqual(["codex", "resume", "session"]);
  expect(() =>
    resumeTerminalCommand({ ...terminal, cmd: ["bash", "-c", "codex"] }),
  ).toThrow();
});
