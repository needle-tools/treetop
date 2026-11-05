import { expect, test } from "bun:test";
import {
  restoreCandidates,
  resumeTerminalCommand,
  restoreCandidateTitles,
} from "../src/background-restore";

test("recovery labels prefer explicit names, then cached AI titles, then existing fallbacks", () => {
  const owner = "01a16c86-aaaa-bbbb-cccc-000000000001";
  const other = "01a16c86-aaaa-bbbb-cccc-000000000002";
  const source = `C:\\sessions\\rollout-2026-11-05-${owner}.jsonl`;
  const otherSource = `C:\\sessions\\${other}.jsonl`;
  const rows = restoreCandidates({ terminals: [
    { id: "ai", agent: "codex", ownerId: owner, cwd: "/repo" },
    { id: "unknown", agent: "codex", ownerId: "different", cwd: "/repo" },
    { id: "shell", agent: "shell", cwd: "/repo" },
  ], commands: [{ repoId: "r", linkId: "dev", name: "Worker launcher", cwd: "/repo" }] });
  rows[0]!.title = `codex (${owner.slice(0, 8)})`;
  const ai = new Map([[source.toLowerCase(), "Editor performance fixes"], [otherSource.toLowerCase(), "Other session"]]);
  const before = JSON.stringify(rows);
  expect(restoreCandidateTitles(rows, {}, [], ai)).toEqual({
    "terminal:ai": "Editor performance fixes", "terminal:unknown": "codex", "terminal:shell": "Terminal", "command:r:dev": "Worker launcher",
  });
  // An explicitly chosen generic-looking title must still override AI.
  const explicit = restoreCandidateTitles(rows, { [source]: "codex" }, [], ai);
  expect(explicit["terminal:ai"]).toBe("codex");
  expect(restoreCandidateTitles([{ ...rows[0]!, title: "Previously named session" }], {}, [], ai)["terminal:ai"])
    .toBe("Previously named session");
  const linked = restoreCandidateTitles(rows, { "custom-source": "My chosen title", "shell:shell": "SSH forum" },
    [{ source: "custom-source", attachTermId: "ai" }], ai);
  expect(linked["terminal:ai"]).toBe("My chosen title");
  expect(linked["terminal:shell"]).toBe("SSH forum");
  expect(JSON.stringify(rows)).toBe(before);
  expect(restoreCandidateTitles(rows, {}, [], new Map([[source.toLowerCase(), "  "]]))["terminal:ai"]).toBe(rows[0]!.title);
});

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
    "session",
  ]);
  expect(
    resumeTerminalCommand({ ...terminal, cmd: ["codex", "resume", "session"] }),
  ).toEqual(["codex", "resume", "session"]);
  expect(() =>
    resumeTerminalCommand({ ...terminal, cmd: ["bash", "-c", "codex"] }),
  ).toThrow();
});

test("automatic Codex restore drops old model flags while retaining permissions and other settings", () => {
  for (const flags of [["--model", "gpt-6-astra"], ["-m", "gpt-6-astra"], ["--model=gpt-6-astra"], ["-c", 'model="gpt-6-astra"'], ["--config=model=\"gpt-6-astra\""]]) {
    expect(resumeTerminalCommand({ agent: "codex", ownerId: "session", resumeCmd: ["codex", "resume", ...flags, "--sandbox", "workspace-write", "-c", 'approvals_reviewer="auto_review"', "session"] }))
      .toEqual(["codex", "resume", "--sandbox", "workspace-write", "-c", 'approvals_reviewer="auto_review"', "session"]);
  }
  expect(resumeTerminalCommand({ agent: "claude", ownerId: "session", cmd: ["claude", "--model", "sonnet"] }))
    .toEqual(["claude", "--resume", "session", "--model", "sonnet"]);
});
