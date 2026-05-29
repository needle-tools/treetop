/**
 * Characterization tests for the behaviours documented in the restructuring
 * map for packages/daemon/src/server.ts.
 *
 * Because the functions under test are private (not exported from the 7597-line
 * monolith), these tests use the same source-text inspection strategy as
 * server-resilience.test.ts: read the file once, then assert the load-bearing
 * code patterns are present and haven't drifted.  This is intentional — the
 * tests serve as a refactoring safety net, not as behavioural unit tests.
 * Behavioural unit tests become possible after each extraction seam lands;
 * the `deferred` section of the restructuring map lists them.
 *
 * Tests are grouped by the concern / design-decision they guard.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_TS = readFileSync(
  join(import.meta.dir, "../src/server.ts"),
  "utf-8",
);

/** Return the 1-based line number of the FIRST line matching needle, -1 if
 *  not found. */
function lineOf(needle: RegExp | string): number {
  const re = typeof needle === "string" ? new RegExp(needle) : needle;
  const lines = SERVER_TS.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) return i + 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 1. stripThinkingArtifacts — dual-mode stripping logic
// ---------------------------------------------------------------------------
describe("stripThinkingArtifacts", () => {
  test("handles gemma4 <channel|> separator (lastIndexOf — last occurrence wins)", () => {
    // The implementation uses lastIndexOf('<channel|>'), not indexOf, so the
    // last separator wins.  Pin that the correct method is used.
    const fnBody = SERVER_TS.match(
      /function stripThinkingArtifacts[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "stripThinkingArtifacts function not found").toBeTruthy();
    expect(fnBody).toContain("lastIndexOf");
    expect(fnBody).toContain("<channel|>");
  });

  test("strips deepseek/qwen <think>...</think> XML blocks (case-insensitive)", () => {
    const fnBody = SERVER_TS.match(
      /function stripThinkingArtifacts[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "stripThinkingArtifacts function not found").toBeTruthy();
    // Must use the /gi flags to handle upper/lower <THINK> variants.
    expect(fnBody).toMatch(/<think>[\s\S]*?\/think>/);
    expect(fnBody).toContain("gi");
  });

  test("trims the result before returning", () => {
    const fnBody = SERVER_TS.match(
      /function stripThinkingArtifacts[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain(".trim()");
  });
});

// ---------------------------------------------------------------------------
// 2. defaultLoginShell — platform-aware shell selection
// ---------------------------------------------------------------------------
describe("defaultLoginShell", () => {
  test("returns -NoLogo flag for powershell/pwsh", () => {
    const fnBody = SERVER_TS.match(
      /function defaultLoginShell[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "defaultLoginShell not found").toBeTruthy();
    expect(fnBody).toContain("-NoLogo");
    expect(fnBody).toContain("powershell");
    expect(fnBody).toContain("pwsh");
  });

  test("returns empty args for cmd.exe", () => {
    const fnBody = SERVER_TS.match(
      /function defaultLoginShell[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain("cmd");
    // The cmd branch returns { shell, args: [] }.  Pin that the empty array
    // literal is present adjacent to the cmd check.
    const cmdBranchIdx =
      fnBody?.indexOf("cmd") ?? -1;
    const emptyArgsIdx = fnBody?.indexOf("args: []") ?? -1;
    expect(cmdBranchIdx).toBeGreaterThan(-1);
    expect(emptyArgsIdx).toBeGreaterThan(-1);
  });

  test("returns -l (login flag) for unix shells (fallthrough)", () => {
    const fnBody = SERVER_TS.match(
      /function defaultLoginShell[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain('"-l"');
  });
});

// ---------------------------------------------------------------------------
// 3. sanitiseMachineId — hostname → safe directory-name coercion
// ---------------------------------------------------------------------------
describe("sanitiseMachineId", () => {
  test("lowercases the input", () => {
    const fnBody = SERVER_TS.match(
      /function sanitiseMachineId[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "sanitiseMachineId not found").toBeTruthy();
    expect(fnBody).toContain(".toLowerCase()");
  });

  test("replaces characters outside [a-z0-9._-] with a dash", () => {
    const fnBody = SERVER_TS.match(
      /function sanitiseMachineId[\s\S]*?\n\}/,
    )?.[0];
    // The regex keeps only a-z, 0-9, dot, dash, underscore.
    expect(fnBody).toContain("[^a-z0-9._-]");
    expect(fnBody).toContain('"-"');
  });

  test("strips leading and trailing dashes", () => {
    const fnBody = SERVER_TS.match(
      /function sanitiseMachineId[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain("^-+|-+$");
  });

  test("truncates to 64 characters", () => {
    const fnBody = SERVER_TS.match(
      /function sanitiseMachineId[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain(".slice(0, 64)");
  });

  test("returns 'unknown' for empty / all-stripped input", () => {
    const fnBody = SERVER_TS.match(
      /function sanitiseMachineId[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain('"unknown"');
  });
});

// ---------------------------------------------------------------------------
// 4. decodeHtmlEntities — HTML entity decoding
// ---------------------------------------------------------------------------
describe("decodeHtmlEntities", () => {
  test("decodes &#x hex entities", () => {
    const fnBody = SERVER_TS.match(
      /function decodeHtmlEntities[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "decodeHtmlEntities not found").toBeTruthy();
    expect(fnBody).toContain("&#x");
    expect(fnBody).toContain("parseInt");
    // hex parsing
    expect(fnBody).toContain("16");
  });

  test("decodes &#decimal; entities", () => {
    const fnBody = SERVER_TS.match(
      /function decodeHtmlEntities[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain("&#");
    // decimal parsing (base 10)
    expect(fnBody).toContain("10");
    expect(fnBody).toContain("parseInt");
  });

  test("decodes the 5 standard named entities", () => {
    const fnBody = SERVER_TS.match(
      /function decodeHtmlEntities[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain("&amp;");
    expect(fnBody).toContain("&lt;");
    expect(fnBody).toContain("&gt;");
    expect(fnBody).toContain("&quot;");
    expect(fnBody).toContain("&apos;");
  });

  test("uses String.fromCodePoint (not String.fromCharCode) for full Unicode", () => {
    const fnBody = SERVER_TS.match(
      /function decodeHtmlEntities[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain("fromCodePoint");
  });
});

// ---------------------------------------------------------------------------
// 5. extractIconHrefs — HTML <link> tag parsing
// ---------------------------------------------------------------------------
describe("extractIconHrefs", () => {
  test("matches <link> tags with rel containing 'icon'", () => {
    const fnBody = SERVER_TS.match(
      /function extractIconHrefs[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "extractIconHrefs not found").toBeTruthy();
    expect(fnBody).toContain("icon");
    // The regex must test for an icon-like rel attribute.
    expect(fnBody).toContain("rel");
  });

  test("uses global case-insensitive regex to find <link> tags", () => {
    const fnBody = SERVER_TS.match(
      /function extractIconHrefs[\s\S]*?\n\}/,
    )?.[0];
    // Must use /gi flags — HTML is case-insensitive.
    expect(fnBody).toContain("gi");
  });

  test("extracts href attribute values only (not the whole tag)", () => {
    const fnBody = SERVER_TS.match(
      /function extractIconHrefs[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain("href");
    // Returns an array of strings pushed as href values.
    expect(fnBody).toContain("out.push");
  });

  test("skips <link> tags without an href or without an icon rel", () => {
    const fnBody = SERVER_TS.match(
      /function extractIconHrefs[\s\S]*?\n\}/,
    )?.[0];
    // The guard is a regex test that continues on mismatch; no href → no push.
    expect(fnBody).toContain("continue");
  });
});

// ---------------------------------------------------------------------------
// 6. urlPriority — LAN > localhost > other sorting
// ---------------------------------------------------------------------------
describe("urlPriority", () => {
  test("function exists and returns a numeric priority", () => {
    const fnBody = SERVER_TS.match(/function urlPriority[\s\S]*?\n\}/)?.[0];
    expect(fnBody, "urlPriority not found").toBeTruthy();
    expect(fnBody).toContain("return 2");  // LAN
    expect(fnBody).toContain("return 1");  // localhost
    expect(fnBody).toContain("return 0");  // fallback
  });

  test("LAN ranges include 192.168.x, 10.x, and 172.16-31.x", () => {
    const fnBody = SERVER_TS.match(/function urlPriority[\s\S]*?\n\}/)?.[0];
    // Source escapes regex metacharacters — check for substrings that are
    // unambiguously part of each range pattern.
    expect(fnBody).toContain("192");
    expect(fnBody).toContain("168");
    expect(fnBody).toContain("10");
    expect(fnBody).toContain("172");
  });

  test("localhost and 127.0.0.1 return priority 1", () => {
    const fnBody = SERVER_TS.match(/function urlPriority[\s\S]*?\n\}/)?.[0];
    expect(fnBody).toContain("localhost");
    expect(fnBody).toContain("127.0.0.1");
  });
});

// ---------------------------------------------------------------------------
// 7. URL_RE — daemon's own PORT is filtered out of detected URLs
// ---------------------------------------------------------------------------
describe("URL_RE and detectCommandUrl PORT filter", () => {
  test("URL_RE covers localhost, 127.0.0.1, and private LAN ranges", () => {
    // URL_RE is declared as a multi-line const; grab the regex literal
    // from the line(s) following `const URL_RE =`.
    const urlReIdx = SERVER_TS.indexOf("const URL_RE =");
    expect(urlReIdx, "URL_RE constant not found").toBeGreaterThan(-1);
    // The pattern lives on the next line — grab a 300-char window.
    const window = SERVER_TS.slice(urlReIdx, urlReIdx + 300);
    expect(window).toContain("localhost");
    expect(window).toContain("127");
    expect(window).toContain("192");
    expect(window).toContain("168");
    expect(window).toContain("10");
    expect(window).toContain("172");
  });

  test("detectCommandUrl skips URLs matching the daemon PORT", () => {
    // The guard `if (Number(new URL(url).port) === PORT) continue;` must be
    // present so the dashboard link doesn't surface its own address.
    const fnBody = SERVER_TS.match(
      /function detectCommandUrl[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "detectCommandUrl not found").toBeTruthy();
    expect(fnBody).toContain("=== PORT");
    expect(fnBody).toContain("continue");
  });

  test("detected URLs are sorted descending by urlPriority (LAN first)", () => {
    const fnBody = SERVER_TS.match(
      /function detectCommandUrl[\s\S]*?\n\}/,
    )?.[0];
    // Sort uses urlPriority(b) - urlPriority(a) → descending.
    expect(fnBody).toContain("urlPriority(b)");
    expect(fnBody).toContain("urlPriority(a)");
  });
});

// ---------------------------------------------------------------------------
// 8. CORS allowlist — explicit Set, not wildcard '*'
// ---------------------------------------------------------------------------
describe("CORS allowlist security boundary", () => {
  test("ALLOWED_ORIGINS is a Set, not a wildcard string", () => {
    expect(SERVER_TS).toContain("const ALLOWED_ORIGINS = new Set([");
  });

  test("corsHeaders() returns empty object for non-matching Origins", () => {
    const fnBody = SERVER_TS.match(/function corsHeaders[\s\S]*?\n\}/)?.[0];
    expect(fnBody, "corsHeaders function not found").toBeTruthy();
    // Non-matching path must return empty object — not headers with '*'.
    expect(fnBody).toContain("return {};");
    expect(fnBody).not.toContain('"*"');
  });

  test("SUPERGIT_EXTRA_ORIGINS env var extends the allowlist", () => {
    expect(SERVER_TS).toContain("SUPERGIT_EXTRA_ORIGINS");
  });

  test("corsHeaders() checks ALLOWED_ORIGINS.has(origin)", () => {
    const fnBody = SERVER_TS.match(/function corsHeaders[\s\S]*?\n\}/)?.[0];
    expect(fnBody).toContain("ALLOWED_ORIGINS.has(origin)");
  });
});

// ---------------------------------------------------------------------------
// 9. peerModeEnabled LAN access gate
// ---------------------------------------------------------------------------
describe("peerModeEnabled LAN access gate", () => {
  test("non-loopback requests get 403 when peerMode is off", () => {
    // Pin the gate pattern: check peerModeEnabled before any route handler.
    expect(SERVER_TS).toContain('{ error: "peer mode is off" }');
    expect(SERVER_TS).toContain("status: 403");
  });

  test("isLoopback recognises 127.0.0.1, ::1, and ::ffff:127.0.0.1", () => {
    const fnBody = SERVER_TS.match(/function isLoopback[\s\S]*?\n\}/)?.[0];
    expect(fnBody, "isLoopback not found").toBeTruthy();
    expect(fnBody).toContain("127.0.0.1");
    expect(fnBody).toContain("::1");
    expect(fnBody).toContain("::ffff:127.0.0.1");
  });

  test("peer gate is evaluated before reaching any route handler", () => {
    // The peerModeEnabled check must come before the first route (e.g.
    // /api/health) inside the fetch handler body.
    const peerGateLine = lineOf(/peerModeEnabled/);
    const healthLine = lineOf(/\/api\/health/);
    expect(peerGateLine).toBeGreaterThan(0);
    expect(healthLine).toBeGreaterThan(0);
    expect(peerGateLine).toBeLessThan(healthLine);
  });
});

// ---------------------------------------------------------------------------
// 10. repsCacheGen generation counter — stale inflight guard
// ---------------------------------------------------------------------------
describe("repsCacheGen generation counter", () => {
  test("repsCacheGen is incremented inside invalidateReposCache()", () => {
    const fnBody = SERVER_TS.match(
      /function invalidateReposCache[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "invalidateReposCache not found").toBeTruthy();
    expect(fnBody).toContain("repsCacheGen++");
  });

  test("reposNDJSONFresh guards cache write with myGen === repsCacheGen", () => {
    // Without this, a slow inflight that completes after a mutation would
    // overwrite the post-mutation cache.
    expect(SERVER_TS).toContain("myGen === repsCacheGen");
  });

  test("invalidateReposCache also nulls out reposCache and reposInflight", () => {
    const fnBody = SERVER_TS.match(
      /function invalidateReposCache[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain("reposCache = null");
    expect(fnBody).toContain("reposInflight = null");
  });
});

// ---------------------------------------------------------------------------
// 11. GRACE_MS — 60s PTY grace timer (not the old 3s)
// ---------------------------------------------------------------------------
describe("PTY grace timer (GRACE_MS)", () => {
  test("GRACE_MS is set to 60_000 ms (not the old 3s)", () => {
    const m = SERVER_TS.match(/const GRACE_MS\s*=\s*([\d_]+)/);
    expect(m, "GRACE_MS constant not found").not.toBeNull();
    const val = Number(m![1]!.replace(/_/g, ""));
    expect(val, "GRACE_MS must be >= 60000 to survive page-reload round trips").toBeGreaterThanOrEqual(60_000);
  });

  test("startGraceIfIdle only starts a timer when subscriberCount() is 0", () => {
    const fnBody = SERVER_TS.match(
      /function startGraceIfIdle[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "startGraceIfIdle not found").toBeTruthy();
    expect(fnBody).toContain("subscriberCount()");
    expect(fnBody).toContain("return");
  });
});

// ---------------------------------------------------------------------------
// 12. /api/session stat()-based ETag short-circuit
// ---------------------------------------------------------------------------
describe("/api/session stat()-based ETag short-circuit", () => {
  test("stat() is called on the source path to produce a cheap ETag", () => {
    // The quickEtag combines mtimeMs + size from a single stat() call.
    expect(SERVER_TS).toContain("mtimeMs");
    expect(SERVER_TS).toContain("st.size");
    expect(SERVER_TS).toContain("quickEtag");
  });

  test("304 is returned before getSessionResponseJson CALL when ETag matches", () => {
    // Pin that the fast-path 304 return appears before the actual invocation
    // of getSessionResponseJson (not the import/definition at the top).
    // quickEtag is constructed on the same line as the stat()-derived ETag;
    // the actual getSessionResponseJson call that does the heavier work must
    // come after.
    const quickEtagLine = lineOf(/const quickEtag\s*=/);
    // Find the first invocation (not the import at line ~54).
    const lines = SERVER_TS.split("\n");
    let getSessionCallLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (
        /await getSessionResponseJson\(/.test(lines[i]!) ||
        /= await getSessionResponseJson/.test(lines[i]!)
      ) {
        getSessionCallLine = i + 1;
        break;
      }
    }
    expect(quickEtagLine, "quickEtag declaration not found").toBeGreaterThan(0);
    expect(getSessionCallLine, "getSessionResponseJson invocation not found").toBeGreaterThan(0);
    expect(quickEtagLine, "stat()-based ETag must be built before the heavier getSessionResponseJson call").toBeLessThan(getSessionCallLine);
  });
});

// ---------------------------------------------------------------------------
// 13. /api/active-sends ETag from inflight.getRevision()
// ---------------------------------------------------------------------------
describe("/api/active-sends ETag from inflight revision", () => {
  test("ETag is built from inflight.getRevision()", () => {
    expect(SERVER_TS).toContain("inflight.getRevision()");
    // The ETag string embeds the revision.
    expect(SERVER_TS).toContain("rev-");
  });

  test("304 is returned when client ETag matches revision ETag", () => {
    // Both /api/session and /api/active-sends return 304 on ETag match.
    const count = (SERVER_TS.match(/status: 304/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 14. maxRequestBodySize is 50 MB
// ---------------------------------------------------------------------------
describe("maxRequestBodySize matches MAX_OFFER_BYTES (50 MB)", () => {
  test("maxRequestBodySize is 50 * 1024 * 1024", () => {
    const m = SERVER_TS.match(/maxRequestBodySize\s*:\s*(\d+\s*\*\s*\d+\s*\*\s*\d+)/);
    expect(m, "maxRequestBodySize constant expression not found").not.toBeNull();
    // Evaluate to verify it is exactly 50 MB.
    // eslint-disable-next-line no-eval
    const bytes: number = eval(m![1]!.replace(/\s/g, ""));
    expect(bytes).toBe(50 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// 15. zsh procName — 'zsh-' prefix when name lacks 'zsh'
// ---------------------------------------------------------------------------
describe("zsh procName 'zsh-' prefix guard", () => {
  test("prepends 'zsh-' when effectiveProcName does not contain 'zsh'", () => {
    // The pattern: if innerCmd is zsh AND procName doesn't match zsh → prepend.
    expect(SERVER_TS).toContain("zsh-${effectiveProcName}");
  });

  test("uses a regex to detect 'zsh' in the basename with word-boundary logic", () => {
    // Must NOT match 'zshare', 'mkzsh', etc. — uses (^|[-_/])zsh([-_]|$)
    expect(SERVER_TS).toContain("zsh");
    // The guard regex rejects false positives (e.g. 'zshare').
    const guardLine = SERVER_TS.match(
      /\([\^\|].*?zsh.*?[\-\_\|].*?\)/,
    );
    expect(guardLine).not.toBeNull();
  });

  test("'zsh-' prefix is only added on non-Windows platforms", () => {
    // The condition wraps the prepend in a platform check.
    const block = SERVER_TS.match(
      /effectiveProcName[\s\S]{0,600}zsh-\$\{effectiveProcName\}/,
    )?.[0];
    expect(block).toBeTruthy();
    expect(block).toContain("win32");
  });
});

// ---------------------------------------------------------------------------
// 16. shutdown() re-entry guard
// ---------------------------------------------------------------------------
describe("shutdown() re-entry guard", () => {
  test("shuttingDown bool prevents double execution", () => {
    const fnBody = SERVER_TS.match(
      /const shutdown = async[\s\S]*?\n\};/,
    )?.[0];
    expect(fnBody, "shutdown function not found").toBeTruthy();
    expect(fnBody).toContain("shuttingDown");
    expect(fnBody).toContain("if (shuttingDown) return");
    expect(fnBody).toContain("shuttingDown = true");
  });

  test("hard-exit timer fires after 2s to guarantee port release", () => {
    const fnBody = SERVER_TS.match(
      /const shutdown = async[\s\S]*?\n\};/,
    )?.[0];
    expect(fnBody).toContain("2000");
    expect(fnBody).toContain("process.exit");
  });

  test("hard-exit timer is unref()'d so it doesn't pin the event loop", () => {
    const fnBody = SERVER_TS.match(
      /const shutdown = async[\s\S]*?\n\};/,
    )?.[0];
    expect(fnBody).toContain(".unref");
  });

  test("all three signals are wired to shutdown()", () => {
    expect(SERVER_TS).toContain('"SIGTERM"');
    expect(SERVER_TS).toContain('"SIGINT"');
    expect(SERVER_TS).toContain('"SIGHUP"');
    expect(SERVER_TS).toContain('shutdown("SIGTERM")');
    expect(SERVER_TS).toContain('shutdown("SIGINT")');
    expect(SERVER_TS).toContain('shutdown("SIGHUP")');
  });
});

// ---------------------------------------------------------------------------
// 17. sampleShellCwds / sampleSshSessions — headless early-return guard
// ---------------------------------------------------------------------------
describe("sampleShellCwds headless early-return (sseSubscribers.size guard)", () => {
  test("sampleShellCwds returns immediately when sseSubscribers.size === 0", () => {
    const fnBody = SERVER_TS.match(
      /async function sampleShellCwds[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "sampleShellCwds not found").toBeTruthy();
    expect(fnBody).toContain("sseSubscribers.size === 0");
    expect(fnBody).toContain("return");
  });

  test("sampleSshSessions also guards on sseSubscribers.size === 0", () => {
    const fnBody = SERVER_TS.match(
      /async function sampleSshSessions[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "sampleSshSessions not found").toBeTruthy();
    expect(fnBody).toContain("sseSubscribers.size === 0");
  });
});

// ---------------------------------------------------------------------------
// 18. resolveSessionAgent — imported-sessions uses second-from-last segment
// ---------------------------------------------------------------------------
describe("resolveSessionAgent imported-sessions path extraction", () => {
  test("agent kind is extracted from parts[parts.length - 2]", () => {
    const fnBody = SERVER_TS.match(
      /function resolveSessionAgent[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody, "resolveSessionAgent not found").toBeTruthy();
    // The segment at length-2 encodes the agent kind.
    expect(fnBody).toContain("parts.length - 2");
  });

  test("only 'claude' and 'codex' are accepted inside the imported-sessions branch", () => {
    const fnBody = SERVER_TS.match(
      /function resolveSessionAgent[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain('"claude"');
    expect(fnBody).toContain('"codex"');
    // The imported-sessions branch checks agentSeg === "claude" || agentSeg === "codex".
    // 'ollama' is handled in the ollamaRoot branch, not the importedRoot branch.
    // Pin the conditional: the agentSeg check must list exactly these two values.
    expect(fnBody).toContain('agentSeg === "claude" || agentSeg === "codex"');
  });

  test("recognises ~/.claude/projects as the claude root", () => {
    const fnBody = SERVER_TS.match(
      /function resolveSessionAgent[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain(".claude");
    expect(fnBody).toContain("projects");
  });

  test("recognises ~/.codex/sessions as a codex root", () => {
    const fnBody = SERVER_TS.match(
      /function resolveSessionAgent[\s\S]*?\n\}/,
    )?.[0];
    expect(fnBody).toContain(".codex");
    expect(fnBody).toContain("sessions");
  });
});

// ---------------------------------------------------------------------------
// 19. ollamaChatAborts — keyed by termId (per-conversation cancel)
// ---------------------------------------------------------------------------
describe("ollamaChatAborts keyed by termId", () => {
  test("ollamaChatAborts Map is declared at module scope", () => {
    expect(SERVER_TS).toContain("ollamaChatAborts");
    // Must be a Map (or similar) keyed by termId, not a global bool.
    expect(SERVER_TS).toMatch(/ollamaChatAborts\s*=\s*new Map/);
  });
});

// ---------------------------------------------------------------------------
// 20. repoSummaryInflight — single-flight Map per repoId
// ---------------------------------------------------------------------------
describe("repoSummaryInflight single-flight", () => {
  test("repoSummaryInflight is a Map at module scope", () => {
    expect(SERVER_TS).toContain("repoSummaryInflight");
    expect(SERVER_TS).toMatch(/repoSummaryInflight\s*=\s*new Map/);
  });

  test("concurrent POSTs join the existing promise via .get(repoId)", () => {
    // The single-flight pattern: check the Map before spawning a new call.
    const block = SERVER_TS.match(
      /repoSummaryInflight[\s\S]{0,400}\.get\([\w]+\)/,
    )?.[0];
    expect(block, "repoSummaryInflight.get() not found").toBeTruthy();
  });
});
