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
  // --- Repo registry mutations: adding/removing/reordering LOCAL repos and
  //     the top-level repo list. The fan-out call passes a daemonId for
  //     remote repos; these workspace-management calls are local. Dual-use,
  //     so allowlisted. ---
  "/api/repos",
  // --- Terminal registry: GET list / persisted-terminal management are
  //     global. The live I/O socket + per-cwd spawn are scoped and DO carry
  //     a daemonId; this prefix is dual-use so it's allowlisted (the scoped
  //     variants pass via their daemonId regardless). ---
  "/api/terminals",
  // --- SSH file-view feature: a separate axis (local daemon reaching OUT to
  //     an ssh host), not daemon-routing. Always local. ---
  "/api/ssh",
];

/** True when `path` is allowlisted as global (exact or prefix match). */
function isGlobal(path: string | null): boolean {
  if (path == null) return false;
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

describe("daemon routing guard — no un-routed repo-scoped calls", () => {
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
  });
});
