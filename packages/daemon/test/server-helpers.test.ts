/**
 * Real behavioural tests for the pure helpers extracted from server.ts into
 * server-helpers.ts.  Each test makes a real input→output assertion; no source
 * text inspection, no tests that pass without asserting.
 */

import { test, expect, describe } from "bun:test";
import {
  stripThinkingArtifacts,
  defaultLoginShell,
  URL_RE,
  urlPriority,
  sanitiseMachineId,
  parseKind,
  parseTarget,
  decodeHtmlEntities,
  extractIconHrefs,
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
    expect(stripThinkingArtifacts("thinking stuff<channel|>actual answer")).toBe(
      "actual answer",
    );
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
    expect(
      stripThinkingArtifacts("<THINK>reasoning</THINK>result"),
    ).toBe("result");
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
      if (!shell.includes("powershell") && !shell.includes("pwsh") && !shell.includes("cmd")) {
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
      const result = defaultLoginShell({ platform: "linux", exists: () => false });
      expect(result.shell).toBe("/bin/sh");
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
    expect(parseTarget({ type: "unknown", value: "https://x.com" })).toBeUndefined();
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

  test("&quot; → \"", () => {
    expect(decodeHtmlEntities('say &quot;hello&quot;')).toBe('say "hello"');
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
    expect(extractIconHrefs("<html><head><title>X</title></head></html>")).toEqual([]);
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
