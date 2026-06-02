/**
 * Pure provisioning helpers — the decisions behind "connect a daemon" auto-
 * onboarding. The orchestrator in server.ts does the spawning, streaming, and
 * registration; everything decidable without a real box lives here so it can
 * be unit-tested.
 *
 * The flow these support (A-safe — see plans/PLAN-REMOTE-DAEMON.md):
 *   1. tar the bundled source payload to stdout      → buildProvisionPlan().tar
 *   2. pipe it into the user's OWN ssh, which extracts it and runs
 *      `install.sh --no-pull` in the foreground      → buildProvisionPlan().ssh
 *   3. the installer prints a `supergit1:` token on stdout, which we capture
 *      and register locally                          → extractConnectionToken()
 *   4. later, offer an update when our build is newer → isUpdateAvailable()
 *
 * Safety: we never collect or store admin credentials. `BatchMode=yes` means
 * ssh uses the user's existing key/agent and fails fast rather than prompting
 * for a password — so provisioning is "automate the command you'd type," not
 * "hand the daemon your root password." The only secret stored afterwards is
 * the forward-only tunnel key the installer mints (capability: open the
 * loopback tunnel, nothing else).
 *
 * `remoteDir` / `installArgs` are internal (not user-supplied from the
 * dialog, which only provides host/user/sshPort) — they go into a remote
 * shell command, so they must stay trusted.
 */

/** The `supergit1:` connection string the installer prints. base64url after
 *  the prefix: A–Z a–z 0–9 - _ (no padding). */
const TOKEN = /supergit1:[A-Za-z0-9_-]+/g;
/** A clean machine-readable line the installer can emit so capture doesn't
 *  depend on parsing the human banner: `SUPERGIT_CONNECT=supergit1:…`. */
const MARKER = /SUPERGIT_CONNECT=(supergit1:[A-Za-z0-9_-]+)/g;

/**
 * Find the connection token in installer output. Prefers an explicit
 * `SUPERGIT_CONNECT=` marker line; otherwise takes the last bare token (the
 * authoritative one is printed last). Returns null when none is present.
 */
export function extractConnectionToken(output: string): string | null {
  let m: RegExpExecArray | null;

  let lastMarker: string | null = null;
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(output)) !== null) lastMarker = m[1]!;
  if (lastMarker) return lastMarker;

  let lastToken: string | null = null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(output)) !== null) lastToken = m[0];
  return lastToken;
}

export interface ProvisionTarget {
  host: string;
  /** Admin user on the box (e.g. "root"). Omit to use ssh's own default. */
  user?: string;
  sshPort?: number;
  /** Explicit admin identity; omit to use the user's ssh agent/config. */
  identityPath?: string;
  /** Where the source lands on the box. Defaults to install.sh's APP_DIR. */
  remoteDir?: string;
  /** Args passed to install.sh. Defaults to ["--no-pull"]. */
  installArgs?: string[];
}

export interface ShipCommand {
  bin: string;
  args: string[];
}

/**
 * The local command that streams the source tree (as a tar archive) to
 * stdout, to be piped into the provisioning ssh.
 *
 * The crux is NOT shipping junk:
 *   - "packaged": the bundled `install-payload/` is already a pruned source
 *     tree (no node_modules/build/.git), so tar+gzip it straight up.
 *   - "dev": the payload root is the live REPO root, which DOES contain
 *     node_modules/build/.git. `git archive HEAD` ships exactly the tracked
 *     tree instead — no exclude globs to get wrong, no multi-GB node_modules.
 *
 * Either way the remote side runs `tar -x` with no `-z`, which auto-detects
 * gzip (packaged) vs plain (git archive) — so one remote command fits both.
 */
export function buildShipCommand(
  payloadRoot: string,
  mode: "packaged" | "dev",
): ShipCommand {
  if (mode === "dev") {
    return {
      bin: "git",
      args: ["-C", payloadRoot, "archive", "--format=tar", "HEAD"],
    };
  }
  // create + gzip + to stdout, chdir into the payload, archive everything.
  return { bin: "tar", args: ["-c", "-z", "-f", "-", "-C", payloadRoot, "."] };
}

export interface ProvisionSshStep {
  /** argv (sans the `ssh` binary); the final element is `remoteCommand`. */
  ssh: string[];
  /** The remote shell command ssh executes on the box. */
  remoteCommand: string;
}

export interface ProvisionPlan {
  /** Phase 1 — receive the piped archive on stdin and extract it. */
  ship: ProvisionSshStep;
  /** Phase 2 — run the installer (in the foreground, with a tty). */
  run: ProvisionSshStep;
}

function destination(t: ProvisionTarget): string {
  return t.user ? `${t.user}@${t.host}` : t.host;
}

function baseSshArgs(t: ProvisionTarget, tty: boolean): string[] {
  const a = [
    "-o",
    "BatchMode=yes", // key/agent only — never prompt for a password
    "-o",
    "StrictHostKeyChecking=accept-new",
    // Bound the connect so a firewall DROPPING the SYN fails in ~15s instead
    // of the OS default (~75s+) of silent waiting — the "stuck, no feedback"
    // case. After connect, ServerAlive keeps a live session from wedging.
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  // `-tt` forces a remote pty so the installer LINE-buffers its output and we
  // get live progress; without it the remote block-buffers and nothing shows
  // until exit ("no feedback"). A pty must NOT be used for the ship step,
  // though — it would mangle the binary tar piped to stdin.
  if (tty) a.push("-tt");
  if (t.sshPort != null) a.push("-p", String(t.sshPort));
  if (t.identityPath) a.push("-i", t.identityPath);
  return a;
}

/**
 * Build the two ssh steps for provisioning. They run sequentially:
 *
 *   1. ship — local archive piped to ssh stdin; the remote extracts it.
 *      No tty (a pty corrupts the binary stream). The remote `tar -x` omits
 *      `-z` so it auto-detects gzip (packaged) vs plain (git archive).
 *   2. run — the installer, with a tty for live output. Foreground, so
 *      closing the ssh SIGHUPs a half-finished install — recoverable because
 *      install.sh --no-pull is idempotent.
 *
 * Splitting ship from run is what lets us have BOTH a binary-safe stdin pipe
 * AND a tty for streaming — a single combined ssh can't do both.
 */
export function buildProvisionPlan(target: ProvisionTarget): ProvisionPlan {
  const remoteDir = target.remoteDir ?? "/opt/supergit";
  const installArgs = target.installArgs ?? ["--no-pull"];
  const dest = destination(target);

  const shipRemote = `mkdir -p ${remoteDir} && tar -x -f - -C ${remoteDir}`;
  const runRemote = `cd ${remoteDir} && bash deploy/install.sh ${installArgs.join(" ")}`;

  return {
    ship: {
      ssh: [...baseSshArgs(target, false), dest, shipRemote],
      remoteCommand: shipRemote,
    },
    run: {
      ssh: [...baseSshArgs(target, true), dest, runRemote],
      remoteCommand: runRemote,
    },
  };
}

/**
 * Whether the local app's build is newer than the remote daemon's — i.e.
 * whether to surface an "update available" offer. Compares ISO build
 * timestamps chronologically (not lexicographically: "…00Z" and "…00.000Z"
 * are the same instant). Unknown/unparseable on either side → false (don't
 * nag when we can't be sure).
 */
export function isUpdateAvailable(
  localBuildTime: string | undefined,
  remoteBuildTime: string | undefined,
): boolean {
  if (!localBuildTime || !remoteBuildTime) return false;
  const local = Date.parse(localBuildTime);
  const remote = Date.parse(remoteBuildTime);
  if (Number.isNaN(local) || Number.isNaN(remote)) return false;
  return local > remote;
}
