import { test, expect, describe } from "bun:test";
import {
  healLegacyStrippedToolResults,
  normalizeRemote,
  STRIPPED_MARKER_PREFIX,
  stripToolOutputs,
  rewritePaths,
  validateManifest,
  prepareOutgoingJsonl,
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
    // Stripped marker embedded inside `content` (not as an extra key).
    expect(jsonl.includes(STRIPPED_MARKER_PREFIX)).toBe(true);
    expect(jsonl.includes('"tool_use_id":"u1"')).toBe(true);
  });

  test("emits only API-valid keys on the tool_result block — no `stripped` / `originalBytes` siblings", () => {
    // Anthropic's API rejects tool_result blocks with keys other than
    // `type`, `tool_use_id`, `content`, `is_error`, `cache_control`.
    // The old strip format emitted `stripped: true` + `originalBytes`
    // which made the resumed session unsendable. Lock the shape down.
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "u-keep",
            content: "huge command output here",
            is_error: true,
          },
        ],
      },
    });
    const { jsonl } = stripToolOutputs(line);
    const parsed = JSON.parse(jsonl) as {
      message: { content: Array<Record<string, unknown>> };
    };
    const block = parsed.message.content[0]!;
    expect(Object.keys(block).sort()).toEqual(
      ["content", "is_error", "tool_use_id", "type"].sort(),
    );
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("u-keep");
    expect(block.is_error).toBe(true);
    expect(typeof block.content).toBe("string");
    expect((block.content as string).startsWith(STRIPPED_MARKER_PREFIX)).toBe(
      true,
    );
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
          content: [{ type: "tool_result", tool_use_id: id, content: body }],
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

  test("healLegacyStrippedToolResults rewrites old shape to API-valid shape", () => {
    // Simulate a JSONL written by the v1 strip code: tool_result has
    // `stripped: true` + `originalBytes` siblings, no `content`.
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            stripped: true,
            originalBytes: 4096,
            tool_use_id: "u-old",
            is_error: true,
          },
        ],
      },
    });
    const { jsonl, healedCount } = healLegacyStrippedToolResults(line);
    expect(healedCount).toBe(1);
    const parsed = JSON.parse(jsonl) as {
      message: { content: Array<Record<string, unknown>> };
    };
    const block = parsed.message.content[0]!;
    expect(Object.keys(block).sort()).toEqual(
      ["content", "is_error", "tool_use_id", "type"].sort(),
    );
    expect(block.content).toBe(`${STRIPPED_MARKER_PREFIX}4096]`);
    expect(block.is_error).toBe(true);
    expect(block.tool_use_id).toBe("u-old");
  });

  test("healLegacyStrippedToolResults is idempotent on already-healed input", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "u-new",
            content: `${STRIPPED_MARKER_PREFIX}123]`,
          },
        ],
      },
    });
    const r = healLegacyStrippedToolResults(line);
    expect(r.healedCount).toBe(0);
    expect(r.jsonl).toBe(line);
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
          content: [{ type: "text", text: `read ${from}/src/file.ts ok` }],
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

  test("trailing slash on `from` (POSIX) still rewrites both root and nested paths", () => {
    const from = "/Users/marcel/git/bar/"; // trailing slash
    const to = "/home/desktop/code/bar";
    const input = [
      JSON.stringify({ cwd: "/Users/marcel/git/bar" }),
      JSON.stringify({ cwd: "/Users/marcel/git/bar/packages/daemon" }),
    ].join("\n");
    const out = rewritePaths(input, {
      from,
      to,
      fromPlatform: "darwin",
      toPlatform: "darwin",
    });
    expect(out.includes("/Users/marcel/git/bar")).toBe(false);
    expect(out.includes(`"cwd":"${to}"`)).toBe(true);
    expect(out.includes(`"cwd":"${to}/packages/daemon"`)).toBe(true);
  });

  test("trailing slash on both `from` and `to` does not duplicate the separator", () => {
    const from = "/Users/marcel/git/bar/";
    const to = "/home/desktop/code/bar/";
    const input = JSON.stringify({ cwd: "/Users/marcel/git/bar/sub" });
    const out = rewritePaths(input, {
      from,
      to,
      fromPlatform: "darwin",
      toPlatform: "darwin",
    });
    expect(out).toBe(JSON.stringify({ cwd: "/home/desktop/code/bar/sub" }));
  });

  test("trailing backslash on Windows `from` still rewrites", () => {
    const from = "C:\\Users\\marcel\\git\\bar\\"; // trailing backslash
    const to = "/Users/marcel/git/bar";
    const input = [
      JSON.stringify({ cwd: "C:\\Users\\marcel\\git\\bar" }),
      JSON.stringify({ cwd: "C:\\Users\\marcel\\git\\bar\\packages\\ui" }),
    ].join("\n");
    const out = rewritePaths(input, {
      from,
      to,
      fromPlatform: "win32",
      toPlatform: "darwin",
    });
    expect(out.includes("C:\\\\")).toBe(false);
    expect(out.includes(`"cwd":"${to}"`)).toBe(true);
    expect(out.includes(`"cwd":"${to}/packages/ui"`)).toBe(true);
  });

  // Regression: a real shared session from Windows kept its dead
  // `C:\git\needle-haystack` cwd after import because the sender captured
  // `originRepoPath` with forward slashes (git's `--show-toplevel` form,
  // `C:/git/needle-haystack`) while Claude Code records the cwd with
  // backslashes (`C:\git\needle-haystack`). The win32 `from` pattern only
  // handled backslash-style separators, so it matched zero occurrences and
  // the rewrite silently no-op'd — leaving a cwd that doesn't exist on the
  // receiver, which later made the terminal spawn fail with a misleading
  // `fork/exec /bin/bash: no such file or directory`.
  test("Windows `from` with forward slashes rewrites backslash data", () => {
    const from = "C:/git/needle-haystack"; // git --show-toplevel form
    const to = "/Users/marcel/git/needle-logs-view";
    const input = [
      JSON.stringify({ cwd: "C:\\git\\needle-haystack" }),
      JSON.stringify({ cwd: "C:\\git\\needle-haystack\\src\\app.ts" }),
    ].join("\n");
    const out = rewritePaths(input, {
      from,
      to,
      fromPlatform: "win32",
      toPlatform: "darwin",
    });
    expect(out.includes("needle-haystack")).toBe(false);
    expect(out.includes(`"cwd":"${to}"`)).toBe(true);
    expect(out.includes(`"cwd":"${to}/src/app.ts"`)).toBe(true);
  });

  test("Windows `from` with mixed separators rewrites backslash data", () => {
    const from = "C:/git\\needle-haystack"; // mixed, as tooling sometimes emits
    const to = "/Users/marcel/git/needle-logs-view";
    const input = JSON.stringify({ cwd: "C:\\git\\needle-haystack" });
    const out = rewritePaths(input, {
      from,
      to,
      fromPlatform: "win32",
      toPlatform: "darwin",
    });
    expect(out).toBe(JSON.stringify({ cwd: to }));
  });
});

describe("prepareOutgoingJsonl — strip + redact composed", () => {
  const ghToken = "ghp_" + "x".repeat(36);
  const stripSecret = "OPENAI_API_KEY=sk-proj-" + "y".repeat(60);
  const buildLines = () =>
    [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `let me use ${ghToken}` },
            { type: "tool_use", id: "u1", name: "bash", input: { cmd: "env" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "u1", content: stripSecret },
          ],
        },
      }),
    ].join("\n");

  test("default: strips tool_result AND redacts secrets", () => {
    const out = prepareOutgoingJsonl(buildLines());
    expect(out.strippedCount).toBe(1);
    expect(out.jsonl.includes(stripSecret)).toBe(false);
    expect(out.jsonl.includes(ghToken)).toBe(false);
    expect(out.jsonl.includes("[REDACTED:github_token]")).toBe(true);
    expect(out.redactions.find((r) => r.kind === "github_token")?.count).toBe(
      1,
    );
  });

  test("includeToolOutputs:true keeps tool_result, still redacts secrets", () => {
    const out = prepareOutgoingJsonl(buildLines(), {
      includeToolOutputs: true,
    });
    expect(out.strippedCount).toBe(0);
    // The OPENAI key is inside the tool_result — still redacted by
    // the secrets layer, which runs independently of strip.
    expect(out.jsonl.includes(stripSecret)).toBe(false);
    expect(out.jsonl.includes("[REDACTED:openai_project_key]")).toBe(true);
    // The github token in the sibling text block is also redacted.
    expect(out.jsonl.includes(ghToken)).toBe(false);
    expect(out.jsonl.includes("[REDACTED:github_token]")).toBe(true);
  });

  test("redactSecrets:false strips tool_result but leaves secrets in text", () => {
    const out = prepareOutgoingJsonl(buildLines(), { redactSecrets: false });
    expect(out.strippedCount).toBe(1);
    // tool_result content is gone (so the OPENAI secret inside it
    // doesn't leak anyway).
    expect(out.jsonl.includes(stripSecret)).toBe(false);
    // But the github token in the assistant text block is NOT
    // redacted — the user explicitly asked for raw text.
    expect(out.jsonl.includes(ghToken)).toBe(true);
    expect(out.redactions).toEqual([]);
  });

  test("both toggles off: full transcript, raw", () => {
    const out = prepareOutgoingJsonl(buildLines(), {
      includeToolOutputs: true,
      redactSecrets: false,
    });
    expect(out.strippedCount).toBe(0);
    expect(out.redactions).toEqual([]);
    // Everything passes through unchanged.
    expect(out.jsonl.includes(stripSecret)).toBe(true);
    expect(out.jsonl.includes(ghToken)).toBe(true);
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

  // These three fields are interpolated into filesystem paths
  // (`storePendingOffer` / `acceptOffer`), so a `..` or separator
  // would escape the intended directory and let a LAN peer write a
  // file anywhere the daemon can. Reject anything outside a strict
  // identifier charset.
  for (const field of ["offerId", "sid", "originMachine"] as const) {
    test(`rejects path traversal in ${field}`, () => {
      const m = valid();
      m[field] = "../../../../tmp/evil";
      const r = validateManifest(m);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toMatch(new RegExp(field));
    });

    test(`rejects path separators in ${field}`, () => {
      const m = valid();
      m[field] = "a/b";
      const r = validateManifest(m);
      expect(r.ok).toBe(false);
    });

    test(`rejects backslash separators in ${field}`, () => {
      const m = valid();
      m[field] = "a\\b";
      const r = validateManifest(m);
      expect(r.ok).toBe(false);
    });

    test(`rejects literal "${field}" with a bare ".."`, () => {
      const m = valid();
      m[field] = "..";
      const r = validateManifest(m);
      expect(r.ok).toBe(false);
    });
  }

  test("accepts safe identifier characters in path fields", () => {
    const m = valid();
    m.offerId = "offer_2026-05-21.abc";
    m.sid = "a1b2c3-d4e5.f6";
    m.originMachine = "Mac-Studio_01";
    const r = validateManifest(m);
    expect(r.ok).toBe(true);
  });
});
