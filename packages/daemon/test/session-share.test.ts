import { test, expect, describe } from "bun:test";
import {
  normalizeRemote,
  stripToolOutputs,
  rewritePaths,
  validateManifest,
  type SessionShareManifest,
} from "../src/session-share";

describe("normalizeRemote", () => {
  test("strips .git suffix", () => {
    expect(normalizeRemote("https://github.com/foo/bar.git")).toBe(
      "https://github.com/foo/bar",
    );
  });

  test("folds ssh form into https form", () => {
    expect(normalizeRemote("git@github.com:foo/bar.git")).toBe(
      "https://github.com/foo/bar",
    );
  });

  test("folds ssh:// form into https form", () => {
    expect(normalizeRemote("ssh://git@github.com/foo/bar.git")).toBe(
      "https://github.com/foo/bar",
    );
  });

  test("lowercases host", () => {
    expect(normalizeRemote("https://GitHub.com/Foo/Bar.git")).toBe(
      "https://github.com/Foo/Bar",
    );
  });

  test("idempotent on already-normalised", () => {
    const n = normalizeRemote("https://github.com/foo/bar");
    expect(normalizeRemote(n)).toBe(n);
  });

  test("preserves non-github hosts", () => {
    expect(normalizeRemote("git@gitlab.example.com:team/repo.git")).toBe(
      "https://gitlab.example.com/team/repo",
    );
  });

  test("returns input unchanged when not a recognisable git url", () => {
    expect(normalizeRemote("not a url")).toBe("not a url");
  });

  test("empty string stays empty", () => {
    expect(normalizeRemote("")).toBe("");
  });
});

describe("stripToolOutputs", () => {
  test("replaces Claude tool_result blocks while preserving everything else", () => {
    const secret = "sk-SUPER-SECRET-KEY-DO-NOT-LEAK";
    const lines = [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "running env" },
            { type: "tool_use", id: "u1", name: "bash", input: { cmd: "env" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "u1",
              content: `OPENAI_API_KEY=${secret}`,
            },
          ],
        },
      }),
    ];
    const input = lines.join("\n");

    const { jsonl, strippedCount } = stripToolOutputs(input);

    expect(strippedCount).toBe(1);
    expect(jsonl.includes(secret)).toBe(false);
    expect(jsonl.includes('"text":"hello"')).toBe(true);
    expect(jsonl.includes('"text":"running env"')).toBe(true);
    expect(jsonl.includes('"type":"tool_use"')).toBe(true);
    expect(jsonl.includes('"name":"bash"')).toBe(true);
    // Placeholder shape preserved
    expect(jsonl.includes('"stripped":true')).toBe(true);
    expect(jsonl.includes('"tool_use_id":"u1"')).toBe(true);
  });

  test("handles array-form tool_result content (Anthropic block form)", () => {
    const secret = "ghp_TOKEN_GOES_HERE";
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "u2",
            content: [
              { type: "text", text: `gh auth status:\nToken: ${secret}` },
            ],
          },
        ],
      },
    });
    const { jsonl, strippedCount } = stripToolOutputs(line);
    expect(strippedCount).toBe(1);
    expect(jsonl.includes(secret)).toBe(false);
  });

  test("counts multiple tool_results across lines", () => {
    const mk = (id: string, body: string) =>
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: id, content: body },
          ],
        },
      });
    const input = [mk("a", "AAA"), mk("b", "BBB"), mk("c", "CCC")].join("\n");
    const { jsonl, strippedCount } = stripToolOutputs(input);
    expect(strippedCount).toBe(3);
    expect(jsonl.includes("AAA")).toBe(false);
    expect(jsonl.includes("BBB")).toBe(false);
    expect(jsonl.includes("CCC")).toBe(false);
  });

  test("no tool_results → input unchanged, count 0", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const { jsonl, strippedCount } = stripToolOutputs(line);
    expect(strippedCount).toBe(0);
    expect(JSON.parse(jsonl)).toEqual(JSON.parse(line));
  });

  test("malformed JSON lines pass through untouched", () => {
    const input = "not json\n" + JSON.stringify({ type: "user" });
    const { jsonl, strippedCount } = stripToolOutputs(input);
    expect(strippedCount).toBe(0);
    expect(jsonl.startsWith("not json\n")).toBe(true);
  });

  test("empty input → empty output, count 0", () => {
    expect(stripToolOutputs("")).toEqual({ jsonl: "", strippedCount: 0 });
  });
});

describe("rewritePaths", () => {
  test("rewrites the repo-root prefix in every JSON line", () => {
    const from = "/Users/marcel/git/bar";
    const to = "/home/desktop/code/bar";
    const input = [
      JSON.stringify({ cwd: `${from}/src` }),
      JSON.stringify({
        message: {
          content: [
            { type: "text", text: `read ${from}/src/file.ts ok` },
          ],
        },
      }),
    ].join("\n");

    const out = rewritePaths(input, {
      from,
      to,
      fromPlatform: "darwin",
      toPlatform: "linux",
    });

    expect(out.includes(from)).toBe(false);
    expect(out.includes(`${to}/src`)).toBe(true);
    expect(out.includes(`${to}/src/file.ts`)).toBe(true);
  });

  test("Windows-origin → POSIX receiver normalises separators", () => {
    const from = "C:\\Users\\marcel\\git\\bar";
    const to = "/Users/marcel/git/bar";
    const input = JSON.stringify({
      msg: `opened ${from}\\src\\file.ts for edit`,
    });
    const out = rewritePaths(input, {
      from,
      to,
      fromPlatform: "win32",
      toPlatform: "darwin",
    });
    expect(out.includes("C:\\\\")).toBe(false);
    expect(out.includes(`${to}/src/file.ts`)).toBe(true);
  });

  test("POSIX-origin → Windows receiver normalises separators", () => {
    const from = "/Users/marcel/git/bar";
    const to = "C:\\dev\\bar";
    const input = JSON.stringify({ msg: `${from}/src/file.ts` });
    const out = rewritePaths(input, {
      from,
      to,
      fromPlatform: "darwin",
      toPlatform: "win32",
    });
    expect(out.includes(from)).toBe(false);
    // JSON-encoded backslashes appear doubled — match the escaped form
    expect(out.includes("C:\\\\dev\\\\bar\\\\src\\\\file.ts")).toBe(true);
  });

  test("does not rewrite unrelated paths that merely share a prefix substring", () => {
    const from = "/Users/marcel/git/bar";
    const to = "/home/desktop/code/bar";
    const input = JSON.stringify({
      a: `${from}/file.ts`,
      b: "/Users/marcel/git/barbershop/other.ts",
    });
    const out = rewritePaths(input, {
      from,
      to,
      fromPlatform: "darwin",
      toPlatform: "darwin",
    });
    const parsed = JSON.parse(out);
    expect(parsed.a).toBe(`${to}/file.ts`);
    expect(parsed.b).toBe("/Users/marcel/git/barbershop/other.ts");
  });

  test("empty input → empty output", () => {
    expect(
      rewritePaths("", {
        from: "/a",
        to: "/b",
        fromPlatform: "darwin",
        toPlatform: "darwin",
      }),
    ).toBe("");
  });
});

describe("validateManifest", () => {
  const valid = (): SessionShareManifest => ({
    offerId: "offer-1",
    sid: "sid-1",
    title: "t",
    agent: "claude",
    turnCount: 4,
    originMachine: "host",
    originMachineLabel: "Host",
    originPlatform: "darwin",
    originRepoRemote: "https://github.com/foo/bar",
    originRepoName: "bar",
    originRepoPath: "/Users/marcel/git/bar",
    createdAt: "2026-05-21T10:14:00Z",
    sentAt: "2026-05-21T14:02:00Z",
    bytes: 100,
    toolOutputs: "stripped",
    strippedCount: 0,
  });

  test("accepts a well-formed manifest", () => {
    const r = validateManifest(valid());
    expect(r.ok).toBe(true);
  });

  test("rejects missing offerId", () => {
    const m = valid();
    delete (m as Partial<SessionShareManifest>).offerId;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/offerId/);
  });

  test("rejects non-absolute originRepoPath", () => {
    const m = valid();
    m.originRepoPath = "relative/path";
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/originRepoPath/);
  });

  test("accepts Windows absolute path", () => {
    const m = valid();
    m.originRepoPath = "C:\\dev\\bar";
    m.originPlatform = "win32";
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
  });

  test("rejects oversized payload", () => {
    const m = valid();
    m.bytes = 200 * 1024 * 1024;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/bytes/);
  });

  test("rejects unknown toolOutputs value", () => {
    const m = valid() as SessionShareManifest & { toolOutputs: string };
    m.toolOutputs = "encrypted" as never;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
  });

  test("rejects unknown agent", () => {
    const m = valid() as SessionShareManifest & { agent: string };
    m.agent = "skynet" as never;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
  });
});
