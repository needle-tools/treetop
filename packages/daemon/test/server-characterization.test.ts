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

// stripThinkingArtifacts / defaultLoginShell / sanitiseMachineId / decodeHtmlEntities / extractIconHrefs / urlPriority / URL_RE / detectCommandUrl / parseKind / parseTarget moved to server-helpers.test.ts (real behavioral tests after extraction).

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
// 10a. Activity tail startup — background scan shares in-flight detectAgents
// ---------------------------------------------------------------------------
describe("activity tail startup", () => {
  test("uses sharedDetectAgents instead of kicking off a duplicate cold scan", () => {
    expect(SERVER_TS).toMatch(
      /startActivityTail\(\{\s*detectAgents:\s*sharedDetectAgents,\s*\}\)/,
    );
  });

  test("agent detection shares only in-flight scans, not completed results", () => {
    expect(SERVER_TS).toContain("let agentsInflight");
    expect(SERVER_TS).not.toContain("AGENTS_CACHE_MS");
    expect(SERVER_TS).not.toContain("let agentsCache");
  });
});

// ---------------------------------------------------------------------------
// 10b. /api/repos streaming — start() must not await the full enrich pass
// ---------------------------------------------------------------------------
describe("/api/repos streaming startup", () => {
  test("ReadableStream.start stays synchronous so the manifest can flush early", () => {
    const start = SERVER_TS.indexOf("function reposNDJSONFresh");
    const end = SERVER_TS.indexOf("async function reposNDJSONResponse");
    const fnBody = SERVER_TS.slice(start, end);
    expect(fnBody).toContain("start(controller)");
    expect(fnBody).not.toContain("async start(controller)");
    expect(fnBody).toContain("void (async () => {");
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
    expect(
      val,
      "GRACE_MS must be >= 60000 to survive page-reload round trips",
    ).toBeGreaterThanOrEqual(60_000);
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
    expect(
      getSessionCallLine,
      "getSessionResponseJson invocation not found",
    ).toBeGreaterThan(0);
    expect(
      quickEtagLine,
      "stat()-based ETag must be built before the heavier getSessionResponseJson call",
    ).toBeLessThan(getSessionCallLine);
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
    const m = SERVER_TS.match(
      /maxRequestBodySize\s*:\s*(\d+\s*\*\s*\d+\s*\*\s*\d+)/,
    );
    expect(
      m,
      "maxRequestBodySize constant expression not found",
    ).not.toBeNull();
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
    const guardLine = SERVER_TS.match(/\([\^\|].*?zsh.*?[\-\_\|].*?\)/);
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
    const fnBody = SERVER_TS.match(/const shutdown = async[\s\S]*?\n\};/)?.[0];
    expect(fnBody, "shutdown function not found").toBeTruthy();
    expect(fnBody).toContain("shuttingDown");
    expect(fnBody).toContain("if (shuttingDown) return");
    expect(fnBody).toContain("shuttingDown = true");
  });

  test("hard-exit timer fires after 2s to guarantee port release", () => {
    const fnBody = SERVER_TS.match(/const shutdown = async[\s\S]*?\n\};/)?.[0];
    expect(fnBody).toContain("2000");
    expect(fnBody).toContain("process.exit");
  });

  test("hard-exit timer is unref()'d so it doesn't pin the event loop", () => {
    const fnBody = SERVER_TS.match(/const shutdown = async[\s\S]*?\n\};/)?.[0];
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

// ---------------------------------------------------------------------------
// 21. /api/repos includes agents in the initial enriched rows
// ---------------------------------------------------------------------------
describe("/api/repos agent enrichment", () => {
  test("fresh repo stream starts sharedDetectAgents before worktree enrichment", () => {
    const start = SERVER_TS.indexOf("function reposNDJSONFresh");
    const end = SERVER_TS.indexOf("async function reposNDJSONResponse", start);
    const fnBody = start >= 0 && end > start ? SERVER_TS.slice(start, end) : "";
    const agentsAt = fnBody.indexOf("sharedDetectAgents()");
    const detailsAt = fnBody.indexOf("getWorktreeDetails(wt.path)");
    const agentsForWtAt = fnBody.indexOf("agentsForWorktree(wt.path, titled)");
    expect(agentsAt).toBeGreaterThan(-1);
    expect(detailsAt).toBeGreaterThan(-1);
    expect(agentsForWtAt).toBeGreaterThan(-1);
    expect(agentsAt).toBeLessThan(detailsAt);
  });
});
