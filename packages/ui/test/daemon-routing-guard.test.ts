import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findApiCalls, type ApiCall } from "../src/api-call-audit";

/**
 * THE ANTI-"HALF-AND-HALF" GUARD.
 *
 * Phase B routes daemon requests through `apiUrl(path, daemonId?)` /
 * `apiWsUrl(path, host, proto, daemonId?)`. A request that targets a
 * specific repo/worktree MUST carry a `daemonId` so a remote folder row's
 * terminal / diff / status / files reach the right daemon. A
 * workspace-global request (events, prefs, editors, the daemon registry
 * itself) must stay local and carry none.
 *
 * The failure mode this guards against: a UI where the repo list is
 * daemon-aware but a row's terminal silently hits the LOCAL daemon. That
 * "half-and-half" state is worse than no remote support at all. This test
 * makes it impossible to ship green:
 *
 *   For every apiUrl/apiWsUrl call in packages/ui/src, the call must
 *   EITHER pass a daemonId, OR its endpoint must be on the explicit
 *   GLOBAL_ALLOWLIST below.
 *
 * A bare call to an endpoint that isn't allowlisted fails the test — which
 * means a NEW endpoint added without a daemonId forces a conscious
 * decision: thread the daemon, or declare it global here. Neither can be
 * skipped silently.
 *
 * The parser is `api-call-audit.ts` (unit-tested separately). Dual-use
 * endpoints (a path that is global for one method and scoped for another,
 * e.g. GET /api/terminals list vs WS /api/terminals/<id>/io) are
 * allowlisted as global because they can't be told apart lexically; the
 * scoped variants still pass because they carry a daemonId anyway.
 */

const SRC_DIR = join(import.meta.dir, "../src");

/**
 * Endpoints that are workspace/board/account-global and always hit the
 * LOCAL daemon. A bare (no-daemonId) call to one of these is correct.
 * Matched by exact path OR as a prefix (so `/api/ollama` covers
 * `/api/ollama/models`, `/api/ollama/chat`, …). Grouped by rationale.
 */
const GLOBAL_ALLOWLIST: string[] = [
  // --- The remote-daemon registry itself: always local by definition. ---
  "/api/daemons",
  // --- Workspace event stream + undo/redo (local daemon's board state). --
  "/api/events",
  "/api/stream",
  // --- Per-device / workspace preferences + layout. ---
  "/api/prefs",
  // --- Editor / shell / agent discovery (about THIS machine). ---
  "/api/editors",
  "/api/shells",
  "/api/shell-default",
  "/api/agents/installed",
  // --- Local LLM (must never leave the machine; not daemon-routed). ---
  "/api/ollama",
  // --- Board-level session metadata (titles live in the local workspace). -
  "/api/session-titles",
  "/api/session/title",
  // --- Native pickers / onboarding / health / peers / usage. ---
  "/api/pick-folder",
  "/api/onboarding",
  "/api/health",
  "/api/peers",
  "/api/peer-discovery",
  "/api/oauth",
  // --- Account-level coding-agent inventory + usage quota (per user
  //     account / local machine, not per repo). ---
  "/api/agents",
  "/api/agent-usage",
  // --- Open a path in the user's LOCAL editor / GUI app. The browser and
  //     the editor run on the user's machine, never the remote box. ---
  "/api/open",
  "/api/open-default",
  // --- LOCAL machine system monitor (process list + kill by pid). ---
  "/api/processes",
  "/api/debug",
  // --- "Open in" launcher helpers about the local machine. ---
  "/api/npm-scripts",
  "/api/config-fix",
  // --- Session-SHARE networking + board-wide session ops (a different
  //     axis from daemon-routing: peer daemons exchanging session offers,
  //     board summaries, repair, invites). All board/account-level. Note
  //     the SINGULAR /api/session* (one agent transcript in one worktree)
  //     is deliberately NOT here — those are repo-scoped and threaded. ---
  "/api/sessions",
  "/api/copy-targets",
  "/api/messages",
  // --- Running-command registry + sticky notes + attachments (board). ---
  "/api/commands",
  "/api/notes",
  "/api/attach",
  // --- SSH file-view feature: a separate axis (local daemon reaching OUT to
  //     an ssh host), not daemon-routing. Always local. ---
  "/api/ssh",
];

/**
 * Dual-use roots that are global ONLY at the EXACT path (optionally with a
 * `?query`) — NOT as a subtree prefix. Their `/<id>/...` sub-paths are
 * repo/worktree-scoped and a bare call to one is a routing bug.
 *
 * Why these can't be plain prefix entries: the list/registry call
 * (`GET /api/repos`, `GET /api/terminals`) is genuinely global, but the
 * per-id calls underneath them (`/api/repos/<id>/color`,
 * `/api/terminals/<id>/io`, `/api/repos/order`, `/api/terminals/persisted`)
 * target one daemon's repo/terminal and MUST thread a daemonId. Allowlisting
 * the whole `/api/repos` / `/api/terminals` prefix (as we did originally)
 * blinded the guard to exactly the half-and-half bugs it exists to catch — a
 * remote row's color/rename/summary/terminal-kill silently hitting the LOCAL
 * daemon (the #1/#4 live bugs slipped through this hole). Exact-only closes it.
 *
 * The spawn POST `/api/terminals` and the local-add POST `/api/repos` share
 * the exact path+method of their global GET twins, so a remote-targeted one
 * that forgot its daemonId can't be told apart lexically here — those rest on
 * their own routing (the spawn threads daemonId) plus dedicated tests.
 */
const GLOBAL_EXACT: string[] = ["/api/repos", "/api/terminals"];

/** True when `path` is allowlisted as global. A GLOBAL_ALLOWLIST entry
 *  matches its whole subtree (exact, `/sub`, or `?query`); a GLOBAL_EXACT
 *  entry matches ONLY the exact path or `?query` (its sub-paths are scoped). */
function isGlobal(path: string | null): boolean {
  if (path == null) return false;
  if (GLOBAL_EXACT.some((g) => path === g || path.startsWith(g + "?"))) {
    return true;
  }
  return GLOBAL_ALLOWLIST.some(
    (g) => path === g || path.startsWith(g + "/") || path.startsWith(g + "?"),
  );
}

function listSourceFiles(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(SRC_DIR)) {
    if (name.endsWith(".svelte") || name.endsWith(".ts")) {
      out.push(join(SRC_DIR, name));
    }
  }
  return out;
}

interface Offender {
  file: string;
  call: ApiCall;
}

/** Every bare (no-daemonId) call whose endpoint is NOT allowlisted — i.e.
 *  a repo/worktree-scoped request that would silently hit the local
 *  daemon. These are the half-and-half bugs. */
function findOffenders(): Offender[] {
  const offenders: Offender[] = [];
  for (const file of listSourceFiles()) {
    const src = readFileSync(file, "utf-8");
    for (const call of findApiCalls(src)) {
      if (call.hasDaemonId) continue; // routed — fine
      if (isGlobal(call.path)) continue; // declared global — fine
      offenders.push({ file: file.replace(SRC_DIR + "/", ""), call });
    }
  }
  return offenders;
}

describe("isGlobal — dual-use roots are global only at the exact path", () => {
  it("treats /api/repos as global only for the list/registry call, NOT per-repo sub-paths", () => {
    expect(isGlobal("/api/repos")).toBe(true); // list + local add
    expect(isGlobal("/api/repos?foo=1")).toBe(true);
    // The blind spot this guard exists to close: a remote repo's scoped
    // mutation that forgot its daemonId must NOT be waved through.
    expect(isGlobal("/api/repos/abc/color")).toBe(false);
    expect(isGlobal("/api/repos/abc/rename")).toBe(false);
    expect(isGlobal("/api/repos/abc/summary")).toBe(false);
    expect(isGlobal("/api/repos/order")).toBe(false);
  });

  it("treats /api/terminals as global only for the list, NOT the per-terminal sub-paths", () => {
    expect(isGlobal("/api/terminals")).toBe(true); // list / spawn
    expect(isGlobal("/api/terminals/xyz/io")).toBe(false);
    expect(isGlobal("/api/terminals/xyz")).toBe(false); // kill by id
    expect(isGlobal("/api/terminals/persisted")).toBe(false);
  });

  it("keeps genuinely workspace-global subtrees global all the way down", () => {
    expect(isGlobal("/api/events")).toBe(true);
    expect(isGlobal("/api/prefs/foo")).toBe(true);
    expect(isGlobal("/api/notes/123")).toBe(true);
    expect(isGlobal("/api/processes/42/kill")).toBe(true);
  });
});

describe("daemon routing guard — no un-routed repo-scoped calls", () => {
  // Longer timeout: this reads and regex-parses every .ts/.svelte file under
  // packages/ui/src synchronously. On a loaded / shared CI runner that file
  // sweep can exceed bun's 5s default even though it's well under a second
  // locally.
  it("every bare apiUrl/apiWsUrl call targets an allowlisted global endpoint", () => {
    const offenders = findOffenders();
    if (offenders.length > 0) {
      const lines = offenders.map(
        (o) =>
          `  ${o.file}:${o.call.line}  ${o.call.fn}(${o.call.path ?? "<computed>"})`,
      );
      const msg =
        `Found ${offenders.length} bare (no-daemonId) call(s) to non-global endpoints.\n` +
        `Each must EITHER pass a daemonId (thread the owning repo's daemon)\n` +
        `OR have its endpoint added to GLOBAL_ALLOWLIST with a rationale:\n` +
        lines.join("\n");
      expect(offenders, msg).toHaveLength(0);
    }
    expect(offenders).toHaveLength(0);
  }, 30_000);
});
