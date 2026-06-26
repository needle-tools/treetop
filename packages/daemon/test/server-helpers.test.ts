/**
 * Real behavioural tests for the pure helpers extracted from server.ts into
 * server-helpers.ts.  Each test makes a real input→output assertion; no source
 * text inspection, no tests that pass without asserting.
 */

import { test, expect, describe } from "bun:test";
import { Buffer } from "node:buffer";
import {
  stripThinkingArtifacts,
  defaultLoginShell,
  availableShells,
  URL_RE,
  urlPriority,
  sanitiseMachineId,
  parseKind,
  parseTarget,
  decodeHtmlEntities,
  extractIconHrefs,
  patchWorktreeDetailsInRepos,
  summarizeRequestCounts,
  codexThreadIdFromTitleSource,
  applyCodexThreadTitleIndex,
  selectedRemoteForRepo,
  envFlag,
  readonlyRouteDecision,
  shouldCopyTempWorkspaceRelativePath,
  debugAnalyzeInstance,
  rewriteTempWorkspaceAttachmentRefs,
} from "../src/server-helpers";

// ---------------------------------------------------------------------------
// stripThinkingArtifacts
// ---------------------------------------------------------------------------
describe("stripThinkingArtifacts", () => {
  test("plain text passthrough — no artifacts in input", () => {
    expect(stripThinkingArtifacts("Hello world")).toBe("Hello world");
  });

  test("trims surrounding whitespace from plain input", () => {
    expect(stripThinkingArtifacts("  answer  ")).toBe("answer");
  });

  test("gemma4 <channel|> separator: takes everything after it", () => {
    expect(
      stripThinkingArtifacts("thinking stuff<channel|>actual answer"),
    ).toBe("actual answer");
  });

  test("gemma4 <channel|> last-occurrence wins (multiple separators)", () => {
    expect(
      stripThinkingArtifacts("first<channel|>middle<channel|>final answer"),
    ).toBe("final answer");
  });

  test("gemma4 <channel|> with no content after it → empty string", () => {
    expect(stripThinkingArtifacts("thought<channel|>")).toBe("");
  });

  test("deepseek/qwen <think>…</think> block is removed", () => {
    expect(
      stripThinkingArtifacts("<think>internal reasoning</think>actual answer"),
    ).toBe("actual answer");
  });

  test("<think> removal is case-insensitive (uppercase <THINK>)", () => {
    expect(stripThinkingArtifacts("<THINK>reasoning</THINK>result")).toBe(
      "result",
    );
  });

  test("multiple <think> blocks are all removed", () => {
    expect(
      stripThinkingArtifacts(
        "<think>first</think>middle<think>second</think>end",
      ),
    ).toBe("middleend");
  });

  test("<think> blocks spanning newlines are removed", () => {
    const input = "<think>\nstep 1\nstep 2\n</think>\nfinal answer";
    expect(stripThinkingArtifacts(input)).toBe("final answer");
  });

  test("gemma channel separator combined with <think> block", () => {
    // channel split happens first, then think blocks within the segment
    const input = "ignore<channel|><think>hidden</think>visible";
    expect(stripThinkingArtifacts(input)).toBe("visible");
  });
});

// ---------------------------------------------------------------------------
// defaultLoginShell
// ---------------------------------------------------------------------------
describe("defaultLoginShell", () => {
  test("returns an object with 'shell' string and 'args' array", () => {
    const result = defaultLoginShell();
    expect(typeof result.shell).toBe("string");
    expect(result.shell.length).toBeGreaterThan(0);
    expect(Array.isArray(result.args)).toBe(true);
  });

  test("unix fallback — non-windows platform returns -l login flag", () => {
    if (process.platform !== "win32") {
      const result = defaultLoginShell();
      // On non-Windows without a powershell/cmd shell the fallthrough branch
      // returns ["-l"].  The real SHELL env may be bash/zsh — check it.
      const shell = result.shell.toLowerCase().replace(/\\/g, "/");
      if (
        !shell.includes("powershell") &&
        !shell.includes("pwsh") &&
        !shell.includes("cmd")
      ) {
        expect(result.args).toEqual(["-l"]);
      }
    }
  });

  test("powershell shell → -NoLogo arg", () => {
    const orig = process.env.SHELL;
    try {
      process.env.SHELL = "/usr/local/bin/pwsh";
      const result = defaultLoginShell();
      expect(result.args).toEqual(["-NoLogo"]);
    } finally {
      if (orig === undefined) delete process.env.SHELL;
      else process.env.SHELL = orig;
    }
  });

  test("cmd shell → empty args array", () => {
    const orig = process.env.SHELL;
    try {
      process.env.SHELL = "C:\\Windows\\System32\\cmd.exe";
      const result = defaultLoginShell();
      expect(result.shell).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(result.args).toEqual([]);
    } finally {
      if (orig === undefined) delete process.env.SHELL;
      else process.env.SHELL = orig;
    }
  });

  test("zsh shell → -l login flag", () => {
    const orig = process.env.SHELL;
    try {
      process.env.SHELL = "/bin/zsh";
      const result = defaultLoginShell();
      expect(result.shell).toBe("/bin/zsh");
      expect(result.args).toEqual(["-l"]);
    } finally {
      if (orig === undefined) delete process.env.SHELL;
      else process.env.SHELL = orig;
    }
  });

  // These pin the POSIX fallback (the remote-daemon case) regardless of the
  // host running the tests, so platform="linux" + cleared SHELL/COMSPEC are
  // injected — otherwise a Windows test host's COMSPEC/win32 branch wins.
  function withCleanShellEnv<T>(fn: () => T): T {
    const sh = process.env.SHELL;
    const cs = process.env.COMSPEC;
    delete process.env.SHELL;
    delete process.env.COMSPEC;
    try {
      return fn();
    } finally {
      if (sh === undefined) delete process.env.SHELL;
      else process.env.SHELL = sh;
      if (cs === undefined) delete process.env.COMSPEC;
      else process.env.COMSPEC = cs;
    }
  }

  test("no SHELL env → picks a shell that EXISTS, not hard-coded zsh", () => {
    // Regression: a fresh Debian remote daemon has no $SHELL and no zsh; the
    // old /bin/zsh fallback spawned a dead terminal. With zsh absent, bash wins.
    withCleanShellEnv(() => {
      const result = defaultLoginShell({
        platform: "linux",
        exists: (p) => p === "/bin/bash",
      });
      expect(result.shell).toBe("/bin/bash");
      expect(result.args).toEqual(["-l"]);
    });
  });

  test("no SHELL, only /bin/sh present → falls through to sh", () => {
    withCleanShellEnv(() => {
      const result = defaultLoginShell({
        platform: "linux",
        exists: (p) => p === "/bin/sh",
      });
      expect(result.shell).toBe("/bin/sh");
    });
  });

  test("no SHELL, nothing detected → still returns /bin/sh (POSIX guarantee)", () => {
    withCleanShellEnv(() => {
      const result = defaultLoginShell({
        platform: "linux",
        exists: () => false,
      });
      expect(result.shell).toBe("/bin/sh");
    });
  });
});

// ---------------------------------------------------------------------------
// availableShells
// ---------------------------------------------------------------------------
describe("availableShells", () => {
  // defaultLoginShell (used by the POSIX branch) reads process.env directly,
  // so clear SHELL/COMSPEC to pin the fallback regardless of the test host.
  function withCleanShellEnv<T>(fn: () => T): T {
    const sh = process.env.SHELL;
    const cs = process.env.COMSPEC;
    delete process.env.SHELL;
    delete process.env.COMSPEC;
    try {
      return fn();
    } finally {
      if (sh === undefined) delete process.env.SHELL;
      else process.env.SHELL = sh;
      if (cs === undefined) delete process.env.COMSPEC;
      else process.env.COMSPEC = cs;
    }
  }

  test("windows → PowerShell first (fixes SSH arrow-key history), then CMD", () => {
    // PowerShell leads because its PSReadLine line editor gives working
    // arrow-up history over SSH, where cmd.exe behind a ConPTY pipe just
    // echoes ^[[A. Both ship with every Windows install, so both always show.
    const shells = availableShells({
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    });
    expect(shells).toEqual([
      { shell: "powershell.exe", args: ["-NoLogo"], label: "PowerShell" },
      { shell: "C:\\Windows\\System32\\cmd.exe", args: [], label: "CMD" },
    ]);
  });

  test("windows without COMSPEC → CMD falls back to bare cmd.exe (PATH-resolved)", () => {
    const shells = availableShells({ platform: "win32", env: {} });
    expect(shells[1]).toEqual({ shell: "cmd.exe", args: [], label: "CMD" });
  });

  test("posix → a single 'Terminal' entry mirroring the default login shell", () => {
    // One shell on POSIX → the picker shows today's single Terminal entry,
    // so Mac/Linux behaviour is unchanged.
    withCleanShellEnv(() => {
      const shells = availableShells({
        platform: "linux",
        exists: (p) => p === "/bin/bash",
      });
      expect(shells).toEqual([
        { shell: "/bin/bash", args: ["-l"], label: "Terminal" },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// URL_RE
// ---------------------------------------------------------------------------
describe("URL_RE", () => {
  test("matches localhost URLs", () => {
    URL_RE.lastIndex = 0;
    const m = "http://localhost:3000".match(URL_RE);
    expect(m).not.toBeNull();
    expect(m![0]).toBe("http://localhost:3000");
  });

  test("matches 127.0.0.1 URLs", () => {
    URL_RE.lastIndex = 0;
    const m = "http://127.0.0.1:8080/path".match(URL_RE);
    expect(m).not.toBeNull();
    expect(m![0]).toBe("http://127.0.0.1:8080/path");
  });

  test("matches 192.168.x.x private LAN URLs", () => {
    URL_RE.lastIndex = 0;
    const m = "http://192.168.1.100:5000".match(URL_RE);
    expect(m).not.toBeNull();
    expect(m![0]).toBe("http://192.168.1.100:5000");
  });

  test("matches 10.x.x.x private LAN URLs", () => {
    URL_RE.lastIndex = 0;
    const m = "http://10.0.0.1:4000".match(URL_RE);
    expect(m).not.toBeNull();
    expect(m![0]).toBe("http://10.0.0.1:4000");
  });

  test("matches 172.16-31.x.x private LAN URLs", () => {
    URL_RE.lastIndex = 0;
    const m = "http://172.16.0.1:9000".match(URL_RE);
    expect(m).not.toBeNull();
    expect(m![0]).toBe("http://172.16.0.1:9000");
  });

  test("does NOT match public internet URLs", () => {
    URL_RE.lastIndex = 0;
    const m = "http://example.com:8080".match(URL_RE);
    expect(m).toBeNull();
  });

  test("matches multiple URLs in a string (global flag)", () => {
    URL_RE.lastIndex = 0;
    const text = "start http://localhost:3000 and http://127.0.0.1:4000 end";
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      matches.push(m[0]);
    }
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe("http://localhost:3000");
    expect(matches[1]).toBe("http://127.0.0.1:4000");
  });
});

// ---------------------------------------------------------------------------
// urlPriority
// ---------------------------------------------------------------------------
describe("urlPriority", () => {
  test("192.168.x.x returns priority 2 (LAN)", () => {
    expect(urlPriority("http://192.168.1.100:3000")).toBe(2);
  });

  test("10.x.x.x returns priority 2 (LAN)", () => {
    expect(urlPriority("http://10.0.0.1:3000")).toBe(2);
  });

  test("172.16.x.x returns priority 2 (LAN)", () => {
    expect(urlPriority("http://172.16.0.1:3000")).toBe(2);
  });

  test("172.31.x.x returns priority 2 (LAN boundary)", () => {
    expect(urlPriority("http://172.31.255.255:3000")).toBe(2);
  });

  test("172.32.x.x returns priority 0 (outside LAN range)", () => {
    expect(urlPriority("http://172.32.0.1:3000")).toBe(0);
  });

  test("localhost returns priority 1", () => {
    expect(urlPriority("http://localhost:3000")).toBe(1);
  });

  test("127.0.0.1 returns priority 1", () => {
    expect(urlPriority("http://127.0.0.1:8080")).toBe(1);
  });

  test("invalid URL returns priority 0 (catch swallows error)", () => {
    expect(urlPriority("not-a-url")).toBe(0);
  });

  test("LAN sorts before localhost in descending priority sort", () => {
    const urls = ["http://localhost:3000", "http://192.168.1.1:3000"];
    const sorted = [...urls].sort((a, b) => urlPriority(b) - urlPriority(a));
    expect(sorted[0]).toBe("http://192.168.1.1:3000");
    expect(sorted[1]).toBe("http://localhost:3000");
  });
});

// ---------------------------------------------------------------------------
// summarizeRequestCounts
// ---------------------------------------------------------------------------
describe("summarizeRequestCounts", () => {
  test("reports total across every route, while top is limited and sorted", () => {
    const report = summarizeRequestCounts(
      [
        ["/api/events", 3],
        ["/api/session", 11],
        ["/api/errors", 7],
      ],
      { windowStartedAt: 1_000, now: 3_000, windowMs: 10_000, limit: 2 },
    );
    expect(report.total).toBe(21);
    expect(report.elapsedMs).toBe(2_000);
    expect(report.perSec).toBe(10.5);
    expect(report.top).toEqual([
      { path: "/api/session", count: 11 },
      { path: "/api/errors", count: 7 },
    ]);
  });

  test("ignores non-positive and non-finite route counts", () => {
    const report = summarizeRequestCounts(
      [
        ["/api/ok", 2],
        ["/api/zero", 0],
        ["/api/bad", Number.NaN],
      ],
      { windowStartedAt: 5_000, now: 5_000, windowMs: 10_000 },
    );
    expect(report.total).toBe(2);
    expect(report.perSec).toBe(0);
    expect(report.top).toEqual([{ path: "/api/ok", count: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// sanitiseMachineId
// ---------------------------------------------------------------------------
describe("sanitiseMachineId", () => {
  test("lowercases the input", () => {
    expect(sanitiseMachineId("MyHost")).toBe("myhost");
  });

  test("replaces disallowed characters with a dash", () => {
    expect(sanitiseMachineId("host name!")).toBe("host-name");
  });

  test("strips leading dashes", () => {
    expect(sanitiseMachineId("!!!host")).toBe("host");
  });

  test("strips trailing dashes", () => {
    expect(sanitiseMachineId("host!!!")).toBe("host");
  });

  test("preserves dots and underscores", () => {
    expect(sanitiseMachineId("my.host_name")).toBe("my.host_name");
  });

  test("consecutive disallowed chars become one dash", () => {
    expect(sanitiseMachineId("host##name")).toBe("host-name");
  });

  test("truncates to 64 characters", () => {
    const long = "a".repeat(100);
    const result = sanitiseMachineId(long);
    expect(result.length).toBe(64);
  });

  test("all-stripped input returns 'unknown'", () => {
    expect(sanitiseMachineId("!!!")).toBe("unknown");
  });

  test("empty string returns 'unknown'", () => {
    expect(sanitiseMachineId("")).toBe("unknown");
  });

  test("typical hostname round-trips unchanged", () => {
    expect(sanitiseMachineId("macbook-pro.local")).toBe("macbook-pro.local");
  });
});

// ---------------------------------------------------------------------------
// parseKind
// ---------------------------------------------------------------------------
describe("parseKind", () => {
  test("'note' returns 'note'", () => {
    expect(parseKind("note")).toBe("note");
  });

  test("'link' returns 'link'", () => {
    expect(parseKind("link")).toBe("link");
  });

  test("'emoji' returns 'emoji'", () => {
    expect(parseKind("emoji")).toBe("emoji");
  });

  test("unknown string returns undefined", () => {
    expect(parseKind("unknown")).toBeUndefined();
  });

  test("null returns undefined", () => {
    expect(parseKind(null)).toBeUndefined();
  });

  test("number returns undefined", () => {
    expect(parseKind(42)).toBeUndefined();
  });

  test("undefined returns undefined", () => {
    expect(parseKind(undefined)).toBeUndefined();
  });

  test("object returns undefined", () => {
    expect(parseKind({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseTarget
// ---------------------------------------------------------------------------
describe("parseTarget", () => {
  test("null returns undefined", () => {
    expect(parseTarget(null)).toBeUndefined();
  });

  test("non-object returns undefined", () => {
    expect(parseTarget("string")).toBeUndefined();
    expect(parseTarget(42)).toBeUndefined();
  });

  test("object without value returns undefined", () => {
    expect(parseTarget({ type: "url" })).toBeUndefined();
  });

  test("object with empty value string returns undefined", () => {
    expect(parseTarget({ type: "url", value: "" })).toBeUndefined();
  });

  test("unknown type returns undefined", () => {
    expect(
      parseTarget({ type: "unknown", value: "https://x.com" }),
    ).toBeUndefined();
  });

  test("url type with valid value returns correct target", () => {
    const result = parseTarget({ type: "url", value: "https://example.com" });
    expect(result).toEqual({ type: "url", value: "https://example.com" });
  });

  test("commit type is accepted", () => {
    const result = parseTarget({ type: "commit", value: "abc123" });
    expect(result).toEqual({ type: "commit", value: "abc123" });
  });

  test("session type is accepted", () => {
    const result = parseTarget({ type: "session", value: "/path/to/sid" });
    expect(result?.type).toBe("session");
  });

  test("file type is accepted", () => {
    const result = parseTarget({ type: "file", value: "/some/file.ts" });
    expect(result?.type).toBe("file");
  });

  test("command type is accepted", () => {
    const result = parseTarget({ type: "command", value: "cmd-id-1" });
    expect(result?.type).toBe("command");
  });

  test("optional label field is included when non-empty", () => {
    const result = parseTarget({
      type: "url",
      value: "https://example.com",
      label: "Example",
    });
    expect(result?.label).toBe("Example");
  });

  test("empty label is omitted", () => {
    const result = parseTarget({
      type: "url",
      value: "https://example.com",
      label: "",
    });
    expect(result?.label).toBeUndefined();
  });

  test("optional subtitle is included when non-empty", () => {
    const result = parseTarget({
      type: "session",
      value: "/path",
      subtitle: "42 msg",
    });
    expect(result?.subtitle).toBe("42 msg");
  });

  test("optional meta is included when non-empty", () => {
    const result = parseTarget({ type: "commit", value: "abc", meta: "2d" });
    expect(result?.meta).toBe("2d");
  });

  test("runMode 'internal' is accepted", () => {
    const result = parseTarget({
      type: "command",
      value: "id",
      runMode: "internal",
    });
    expect(result?.runMode).toBe("internal");
  });

  test("runMode 'external' is accepted", () => {
    const result = parseTarget({
      type: "command",
      value: "id",
      runMode: "external",
    });
    expect(result?.runMode).toBe("external");
  });

  test("runMode 'shell' is accepted", () => {
    const result = parseTarget({
      type: "command",
      value: "id",
      runMode: "shell",
    });
    expect(result?.runMode).toBe("shell");
  });

  test("unknown runMode is omitted from result", () => {
    const result = parseTarget({
      type: "command",
      value: "id",
      runMode: "bad",
    });
    expect(result?.runMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decodeHtmlEntities
// ---------------------------------------------------------------------------
describe("decodeHtmlEntities", () => {
  test("&amp; → &", () => {
    expect(decodeHtmlEntities("a &amp; b")).toBe("a & b");
  });

  test("&lt; → <", () => {
    expect(decodeHtmlEntities("&lt;div&gt;")).toBe("<div>");
  });

  test("&gt; → >", () => {
    expect(decodeHtmlEntities("a&gt;b")).toBe("a>b");
  });

  test('&quot; → "', () => {
    expect(decodeHtmlEntities("say &quot;hello&quot;")).toBe('say "hello"');
  });

  test("&apos; → '", () => {
    expect(decodeHtmlEntities("it&apos;s")).toBe("it's");
  });

  test("decimal numeric entity &#65; → A", () => {
    expect(decodeHtmlEntities("&#65;")).toBe("A");
  });

  test("hex numeric entity &#x41; → A", () => {
    expect(decodeHtmlEntities("&#x41;")).toBe("A");
  });

  test("&#x with uppercase hex digits (&#x4F;) → O", () => {
    // The regex matches [0-9a-fA-F] so uppercase hex digits work.
    expect(decodeHtmlEntities("&#x4F;")).toBe("O");
  });

  test("high codepoint via decimal entity", () => {
    // U+1F600 GRINNING FACE
    expect(decodeHtmlEntities("&#128512;")).toBe("\u{1F600}");
  });

  test("high codepoint via hex entity", () => {
    expect(decodeHtmlEntities("&#x1F600;")).toBe("\u{1F600}");
  });

  test("unknown named entity is left untouched", () => {
    expect(decodeHtmlEntities("&unknown;")).toBe("&unknown;");
  });

  test("plain text passthrough", () => {
    expect(decodeHtmlEntities("Hello world")).toBe("Hello world");
  });

  test("multiple entities in one string", () => {
    expect(decodeHtmlEntities("&lt;b&gt;bold&lt;/b&gt;")).toBe("<b>bold</b>");
  });
});

// ---------------------------------------------------------------------------
// extractIconHrefs
// ---------------------------------------------------------------------------
describe("extractIconHrefs", () => {
  test("extracts href from a standard rel=icon link tag", () => {
    const html = '<link rel="icon" href="/favicon.ico">';
    expect(extractIconHrefs(html)).toEqual(["/favicon.ico"]);
  });

  test("extracts href from rel='shortcut icon'", () => {
    const html = "<link rel='shortcut icon' href='/ico.png'>";
    expect(extractIconHrefs(html)).toEqual(["/ico.png"]);
  });

  test("extracts href from apple-touch-icon", () => {
    const html = '<link rel="apple-touch-icon" href="/apple.png">';
    expect(extractIconHrefs(html)).toEqual(["/apple.png"]);
  });

  test("ignores non-icon link tags (e.g. rel=stylesheet)", () => {
    const html = '<link rel="stylesheet" href="/style.css">';
    expect(extractIconHrefs(html)).toEqual([]);
  });

  test("returns multiple icons when present", () => {
    const html = [
      '<link rel="icon" href="/favicon.ico">',
      '<link rel="apple-touch-icon" href="/apple.png">',
    ].join("\n");
    const result = extractIconHrefs(html);
    expect(result).toHaveLength(2);
    expect(result).toContain("/favicon.ico");
    expect(result).toContain("/apple.png");
  });

  test("case-insensitive — uppercase LINK and REL work", () => {
    const html = '<LINK REL="icon" href="/icon.png">';
    expect(extractIconHrefs(html)).toEqual(["/icon.png"]);
  });

  test("skips link tags without an href attribute", () => {
    const html = '<link rel="icon">';
    expect(extractIconHrefs(html)).toEqual([]);
  });

  test("returns empty array for HTML with no link tags at all", () => {
    expect(
      extractIconHrefs("<html><head><title>X</title></head></html>"),
    ).toEqual([]);
  });

  test("does not include non-icon links even in mixed HTML", () => {
    const html = [
      '<link rel="canonical" href="https://example.com">',
      '<link rel="icon" href="/fav.svg">',
      '<link rel="preload" href="/font.woff2" as="font">',
    ].join("\n");
    expect(extractIconHrefs(html)).toEqual(["/fav.svg"]);
  });
});

// ---------------------------------------------------------------------------
// patchWorktreeDetailsInRepos
//
// Guards the fs_change → live-badge path: when the file watcher recomputes
// one worktree's git state, it patches that worktree's details into the
// cached /api/repos payload IN PLACE (the full reposCache short-circuits the
// route before any rebuild, so a bare cache delete is invisible until the
// payload TTL expires AND a later cache-missing fetch happens). This is what
// keeps push/pull/dirty badges live without paying a detectAgents rebuild.
// ---------------------------------------------------------------------------
describe("patchWorktreeDetailsInRepos", () => {
  function sampleRepos() {
    return [
      {
        id: "r1",
        worktrees: [
          {
            path: "/w/a",
            branch: "main",
            agents: ["claude"],
            fileStatus: { dirtyLines: 0 },
            branchStatus: { ahead: 0, behind: 0 },
          },
          {
            path: "/w/b",
            branch: "feat",
            agents: [],
            fileStatus: { dirtyLines: 0 },
            branchStatus: { ahead: 0, behind: 0 },
          },
        ],
      },
      { id: "r2", worktrees: [{ path: "/w/c", agents: ["codex"] }] },
    ];
  }

  test("overwrites the matching worktree's detail fields", () => {
    const repos = sampleRepos();
    const ok = patchWorktreeDetailsInRepos(repos, "/w/b", {
      fileStatus: { dirtyLines: 7 },
      branchStatus: { ahead: 2, behind: 1 },
      lastCommit: { hash: "abc" },
    });
    expect(ok).toBe(true);
    const wt = repos[0]!.worktrees[1]! as Record<string, unknown>;
    expect(wt.fileStatus).toEqual({ dirtyLines: 7 });
    expect(wt.branchStatus).toEqual({ ahead: 2, behind: 1 });
    expect(wt.lastCommit).toEqual({ hash: "abc" });
  });

  test("preserves non-detail fields (agents, branch, path)", () => {
    const repos = sampleRepos();
    patchWorktreeDetailsInRepos(repos, "/w/a", {
      fileStatus: { dirtyLines: 3 },
      branchStatus: { ahead: 0, behind: 0 },
    });
    const wt = repos[0]!.worktrees[0]! as Record<string, unknown>;
    expect(wt.agents).toEqual(["claude"]);
    expect(wt.branch).toBe("main");
    expect(wt.path).toBe("/w/a");
    expect(wt.fileStatus).toEqual({ dirtyLines: 3 });
  });

  test("matches a worktree in any repo, not just the first", () => {
    const repos = sampleRepos();
    const ok = patchWorktreeDetailsInRepos(repos, "/w/c", {
      fileStatus: { dirtyLines: 1 },
    });
    expect(ok).toBe(true);
    expect(
      (repos[1]!.worktrees[0]! as Record<string, unknown>).fileStatus,
    ).toEqual({ dirtyLines: 1 });
  });

  test("returns false and mutates nothing when the path is unknown", () => {
    const repos = sampleRepos();
    const before = JSON.stringify(repos);
    const ok = patchWorktreeDetailsInRepos(repos, "/w/missing", {
      fileStatus: { dirtyLines: 9 },
    });
    expect(ok).toBe(false);
    expect(JSON.stringify(repos)).toBe(before);
  });

  test("tolerates repos with no worktrees array", () => {
    const repos = [{ id: "r1" }, { id: "r2", worktrees: [{ path: "/w/a" }] }];
    const ok = patchWorktreeDetailsInRepos(repos as never, "/w/a", {
      fileStatus: { dirtyLines: 4 },
    });
    expect(ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectedRemoteForRepo
// ---------------------------------------------------------------------------
describe("selectedRemoteForRepo", () => {
  const remotes = [{ name: "needle" }, { name: "upstream" }];

  test("uses a valid persisted remote selection", () => {
    expect(
      selectedRemoteForRepo({
        repoId: "r1",
        selectedRemotes: { r1: "upstream" },
        remotes,
      }),
    ).toBe("upstream");
  });

  test("falls back to origin when present, otherwise the first repo remote", () => {
    expect(
      selectedRemoteForRepo({ repoId: "r1", selectedRemotes: {}, remotes }),
    ).toBe("needle");
    expect(
      selectedRemoteForRepo({
        repoId: "r1",
        selectedRemotes: {},
        remotes: [{ name: "upstream" }, { name: "origin" }],
      }),
    ).toBe("origin");
  });

  test("returns null when the repo has no remotes", () => {
    expect(
      selectedRemoteForRepo({ repoId: "r1", selectedRemotes: {}, remotes: [] }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Codex session_index title sync
// ---------------------------------------------------------------------------
describe("Codex session_index title sync", () => {
  const id = "019ed710-1a0a-7200-98ec-53f8aa8fab6b";
  const source = `/Users/me/.codex/sessions/2026/06/17/rollout-2026-06-17T21-30-17-${id}.jsonl`;
  const now = "2026-06-21T10:00:00.000Z";

  test("extracts a Codex thread id from JSONL and live app sources", () => {
    expect(codexThreadIdFromTitleSource(source)).toBe(id);
    expect(codexThreadIdFromTitleSource(`__codex_app__:${id}`)).toBe(id);
    expect(
      codexThreadIdFromTitleSource("/tmp/not-a-session.txt"),
    ).toBeUndefined();
  });

  test("creates exactly one title row when the app index is missing the session", () => {
    const existing = `${JSON.stringify({ id: "other", thread_name: "Other" })}\n`;
    const result = applyCodexThreadTitleIndex(
      existing,
      source,
      "Performance Testing",
      now,
    );
    expect(result.changed).toBe(true);
    expect(result.appended).toBe(true);
    const rows = result.raw
      .trim()
      .split(/\n/)
      .map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.id === id)).toEqual([
      {
        id,
        thread_name: "Performance Testing",
        updated_at: now,
      },
    ]);
  });

  test("updates an existing title row without appending another one", () => {
    const existing = `${JSON.stringify({
      id,
      thread_name: "Old",
      updated_at: "2026-06-20T00:00:00.000Z",
    })}\n`;
    const result = applyCodexThreadTitleIndex(
      existing,
      source,
      "Performance Testing",
      now,
    );
    expect(result.changed).toBe(true);
    expect(result.appended).toBe(false);
    const rows = result.raw
      .trim()
      .split(/\n/)
      .map((line) => JSON.parse(line));
    expect(rows).toEqual([
      {
        id,
        thread_name: "Performance Testing",
        updated_at: now,
      },
    ]);
  });

  test("collapses duplicate rows for the same session while updating the title", () => {
    const existing = [
      JSON.stringify({ id, thread_name: "Older" }),
      JSON.stringify({ id: "other", thread_name: "Other" }),
      JSON.stringify({ id, thread_name: "Newer", cwd: "/repo" }),
    ].join("\n");
    const result = applyCodexThreadTitleIndex(
      `${existing}\n`,
      source,
      "Performance Testing",
      now,
    );
    const rows = result.raw
      .trim()
      .split(/\n/)
      .map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.id === id)).toEqual([
      {
        id,
        thread_name: "Performance Testing",
        cwd: "/repo",
        updated_at: now,
      },
    ]);
    expect(rows.filter((row) => row.id === "other")).toHaveLength(1);
  });

  test("clears thread_name on an existing row and leaves missing blank titles alone", () => {
    const existing = `${JSON.stringify({ id, thread_name: "Old" })}\n`;
    const cleared = applyCodexThreadTitleIndex(existing, source, "", now);
    expect(cleared.changed).toBe(true);
    expect(JSON.parse(cleared.raw).thread_name).toBeUndefined();

    const missing = applyCodexThreadTitleIndex("", source, "", now);
    expect(missing.changed).toBe(false);
    expect(missing.raw).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Read-only route policy
// ---------------------------------------------------------------------------
describe("read-only daemon route policy", () => {
  test("envFlag treats explicit false-y values as disabled", () => {
    expect(envFlag(undefined)).toBe(false);
    expect(envFlag("")).toBe(false);
    expect(envFlag("0")).toBe(false);
    expect(envFlag("false")).toBe(false);
    expect(envFlag("off")).toBe(false);
    expect(envFlag("1")).toBe(true);
    expect(envFlag("true")).toBe(true);
    expect(envFlag("yes")).toBe(true);
  });

  test("allows normal read requests", () => {
    expect(readonlyRouteDecision("GET", "/api/repos")).toEqual({
      allowed: true,
    });
    expect(readonlyRouteDecision("HEAD", "/")).toEqual({ allowed: true });
    expect(readonlyRouteDecision("OPTIONS", "/api/repos")).toEqual({
      allowed: true,
    });
  });

  test("allows body-based read routes and instance diagnostics the UI already uses", () => {
    expect(readonlyRouteDecision("POST", "/api/sessions/batch")).toEqual({
      allowed: true,
    });
    expect(readonlyRouteDecision("POST", "/api/exists")).toEqual({
      allowed: true,
    });
    expect(readonlyRouteDecision("POST", "/api/errors")).toEqual({
      allowed: true,
    });
  });

  test("allows side-instance terminal and command runtime", () => {
    expect(readonlyRouteDecision("POST", "/api/terminals")).toEqual({
      allowed: true,
    });
    expect(readonlyRouteDecision("GET", "/api/terminals/t-1/io")).toEqual({
      allowed: true,
    });
    expect(readonlyRouteDecision("POST", "/api/command/run")).toEqual({
      allowed: true,
    });
    expect(readonlyRouteDecision("POST", "/api/command/stop")).toEqual({
      allowed: true,
    });
    expect(readonlyRouteDecision("DELETE", "/api/terminals/persisted")).toEqual(
      {
        allowed: true,
      },
    );
    expect(readonlyRouteDecision("DELETE", "/api/terminals/t-1")).toEqual({
      allowed: true,
    });
    expect(
      readonlyRouteDecision("POST", "/api/terminals/persisted/remove"),
    ).toEqual({ allowed: true });
  });

  test("blocks workspace and repo mutations", () => {
    expect(readonlyRouteDecision("POST", "/api/fetch").allowed).toBe(false);
    expect(readonlyRouteDecision("PATCH", "/api/prefs").allowed).toBe(false);
    expect(readonlyRouteDecision("DELETE", "/api/errors").allowed).toBe(false);
    expect(readonlyRouteDecision("POST", "/api/open-default").allowed).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Debug analyze instance identity
// ---------------------------------------------------------------------------
describe("debugAnalyzeInstance", () => {
  test("marks temporary workspace copies as side instances", () => {
    expect(
      debugAnalyzeInstance({
        workspace: "/tmp/treetop-copy",
        port: 17777,
        temporaryWorkspace: true,
        sourceWorkspace: "/Users/me/supergit/workspaces/default",
        readonly: false,
      }),
    ).toEqual({
      workspace: "/tmp/treetop-copy",
      port: 17777,
      temporaryWorkspace: true,
      sourceWorkspace: "/Users/me/supergit/workspaces/default",
      readonly: false,
      sideInstance: true,
    });
  });

  test("marks normal writable prod as the primary instance", () => {
    expect(
      debugAnalyzeInstance({
        workspace: "/Users/me/supergit/workspaces/default",
        port: 27787,
        temporaryWorkspace: false,
        sourceWorkspace: null,
        readonly: false,
      }),
    ).toMatchObject({
      port: 27787,
      temporaryWorkspace: false,
      sourceWorkspace: null,
      readonly: false,
      sideInstance: false,
    });
  });
});

describe("temporary workspace copy policy", () => {
  test("copies persisted workspace data", () => {
    expect(shouldCopyTempWorkspaceRelativePath("repos.json")).toBe(true);
    expect(shouldCopyTempWorkspaceRelativePath("prefs.json")).toBe(true);
    expect(shouldCopyTempWorkspaceRelativePath("events.jsonl")).toBe(true);
    expect(shouldCopyTempWorkspaceRelativePath("notes.json")).toBe(true);
    expect(shouldCopyTempWorkspaceRelativePath("summaries/session.md")).toBe(
      true,
    );
  });

  test("skips live runtime, logs, peer identity, and local secret/cache state", () => {
    expect(shouldCopyTempWorkspaceRelativePath("active-terminals.json")).toBe(
      false,
    );
    expect(shouldCopyTempWorkspaceRelativePath("shells/t-1.jsonl")).toBe(false);
    expect(shouldCopyTempWorkspaceRelativePath("daemon.log")).toBe(false);
    expect(shouldCopyTempWorkspaceRelativePath("errors.jsonl")).toBe(false);
    expect(shouldCopyTempWorkspaceRelativePath("peer-identity.json")).toBe(
      false,
    );
    expect(shouldCopyTempWorkspaceRelativePath("keys/id_ed25519")).toBe(false);
    expect(shouldCopyTempWorkspaceRelativePath(".remote-cache/host/file")).toBe(
      false,
    );
    expect(shouldCopyTempWorkspaceRelativePath("repos.json.tmp")).toBe(false);
  });
});

describe("rewriteTempWorkspaceAttachmentRefs", () => {
  function attachmentRef(payload: object): string {
    return `supergit://attachment/${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  }

  function decodeAttachmentRef(ref: string): { path: string } {
    const payload = ref.match(/supergit:\/\/attachment\/([A-Za-z0-9_-]+)/)?.[1];
    if (!payload) throw new Error("missing attachment payload");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      path: string;
    };
  }

  test("rewrites copied attachment paths to the temporary workspace", () => {
    expect(
      rewriteTempWorkspaceAttachmentRefs(
        '{"path":"/source/ws/attachments/paste.txt"}',
        "/source/ws",
        "/tmp/ws-copy",
      ),
    ).toBe('{"path":"/tmp/ws-copy/attachments/paste.txt"}');
  });

  test("keeps non-attachment workspace references unchanged", () => {
    expect(
      rewriteTempWorkspaceAttachmentRefs(
        '{"workspace":"/source/ws","repo":"/source/ws-repo"}',
        "/source/ws",
        "/tmp/ws-copy",
      ),
    ).toBe('{"workspace":"/source/ws","repo":"/source/ws-repo"}');
  });

  test("rewrites Windows-style attachment paths too", () => {
    expect(
      rewriteTempWorkspaceAttachmentRefs(
        String.raw`{"path":"C:\\source\\ws\\attachments\\paste.txt"}`,
        String.raw`C:\source\ws`,
        String.raw`D:\tmp\ws-copy`,
      ),
    ).toBe(String.raw`{"path":"D:\\tmp\\ws-copy\\attachments\\paste.txt"}`);
  });

  test("rewrites attachment paths inside supergit attachment links", () => {
    const ref = attachmentRef({
      kind: "text",
      path: "/source/ws/attachments/pasted-content.txt",
      filename: "pasted-content.txt",
    });

    const rewritten = rewriteTempWorkspaceAttachmentRefs(
      `[Pasted Content](${ref})`,
      "/source/ws",
      "/tmp/ws-copy",
    );
    const rewrittenRef = rewritten.match(
      /supergit:\/\/attachment\/[A-Za-z0-9_-]+/,
    )?.[0];

    expect(rewrittenRef).toBeTruthy();
    expect(decodeAttachmentRef(rewrittenRef!).path).toBe(
      "/tmp/ws-copy/attachments/pasted-content.txt",
    );
  });
});
