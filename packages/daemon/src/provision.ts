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

/** Target OS family — decides which remote shell + installer we drive.
 *  "posix" ships tar|bash for Linux/macOS; "windows" ships cmd/PowerShell
 *  for a Windows box (whose default ssh shell is cmd.exe). Default posix. */
export type TargetOs = "posix" | "windows";

export interface ProvisionTarget {
  host: string;
  /** Admin user on the box (e.g. "root"). Omit to use ssh's own default. */
  user?: string;
  sshPort?: number;
  /** Explicit admin identity; omit to use the user's ssh agent/config. */
  identityPath?: string;
  /** Where the source lands on the box. Defaults to the installer's APP_DIR
   *  (/opt/supergit on posix, C:\supergit on windows). */
  remoteDir?: string;
  /** Args passed to the installer. Defaults to the OS installer's "use the
   *  code already here" flag (["--no-pull"] posix / ["-NoPull"] windows). */
  installArgs?: string[];
  /** OS family of the box. Default "posix". */
  os?: TargetOs;
}

export interface ShipCommand {
  bin: string;
  args: string[];
}

/**
 * git-archive pathspec for the shipped source: everything tracked EXCEPT the
 * repo's lone symlink and the internal docs / AI-agent rules the box doesn't
 * need to build the daemon. Shared by the packaged build (build-native.ts)
 * and the dev ship (buildShipCommand) so they can't drift. Appended after
 * `git archive … HEAD --`.
 */
export function installPayloadPathspec(): string[] {
  return [
    ".",
    ":!AGENTS.md", // symlink → CLAUDE.md; Windows tar can't even extract it
    ":!CLAUDE.md", // AI-agent dev rules — internal, not needed on the box
    ":!plans", // internal design docs
    ":!demos", // sample content
    ":!artifacts", // scratch / build artifacts
  ];
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
 * BOTH produce a GZIP stream (packaged via `tar -z`, dev via
 * `git archive --format=tar.gz`) and the remote side always extracts with
 * `tar -x -z`. We do NOT rely on tar auto-detecting compression: some tar
 * builds refuse to auto-detect gzip on a non-seekable pipe ("Archive is
 * compressed. Use -z option"), so ship and extract must agree explicitly.
 */
export function buildShipCommand(
  payloadRoot: string,
  mode: "packaged" | "dev",
): ShipCommand {
  if (mode === "dev") {
    return {
      bin: "git",
      args: [
        "-C",
        payloadRoot,
        "archive",
        "--format=tar.gz",
        "HEAD",
        "--",
        ...installPayloadPathspec(),
      ],
    };
  }
  // packaged: install-payload/ is already the pruned source (build-native.ts
  // applied the same pathspec) — gzip it straight up.
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
 *   1. ship — local gzip archive piped to ssh stdin; the remote extracts it
 *      with `tar -x -z` (ship is always gzip — see buildShipCommand). No tty
 *      (a pty corrupts the binary stream).
 *   2. run — the installer, with a tty for live output. Foreground, so
 *      closing the ssh SIGHUPs a half-finished install — recoverable because
 *      install.sh --no-pull is idempotent.
 *
 * Splitting ship from run is what lets us have BOTH a binary-safe stdin pipe
 * AND a tty for streaming — a single combined ssh can't do both.
 */
export function buildProvisionPlan(target: ProvisionTarget): ProvisionPlan {
  const dest = destination(target);
  if ((target.os ?? "posix") === "windows") return windowsPlan(target, dest);

  const remoteDir = target.remoteDir ?? "/opt/supergit";
  const installArgs = target.installArgs ?? ["--no-pull"];

  const shipRemote = `mkdir -p ${remoteDir} && tar -x -z -f - -C ${remoteDir}`;
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
 * The Windows variant of buildProvisionPlan. A Windows box's default ssh
 * subsystem is cmd.exe, which rejects the POSIX plan (`mkdir -p … && … bash`)
 * with "The syntax of the command is incorrect." So:
 *
 *   - ship runs through `cmd /c`. Two reasons it beats PowerShell here:
 *     (1) it works whether the box's DefaultShell is cmd.exe or PowerShell
 *     (sshd wraps either, and cmd is always present), and (2) cmd hands the
 *     piped binary tar to tar.exe's stdin untouched — PowerShell re-encodes
 *     stdin as text and corrupts the archive. Windows 10/11 ship tar.exe
 *     (bsdtar) in System32; like the posix side it extracts gzip with -z.
 *     We use a single `mkdir` (cmd makes intermediate dirs by default — no
 *     `-p`) guarded by `if not exist`, then `&` (not `&&`) to run tar next
 *     regardless, since the guard already made the success path exit 0.
 *
 *   - run uses PowerShell to execute install.ps1 (a real script, no binary
 *     stdin) with -tt for live output, mirroring the posix tty rationale.
 *     `-ExecutionPolicy Bypass` lets the unsigned, just-shipped script run.
 */
function windowsPlan(target: ProvisionTarget, dest: string): ProvisionPlan {
  const remoteDir = target.remoteDir ?? "C:\\supergit";
  const installArgs = target.installArgs ?? ["-NoPull"];

  const shipRemote =
    `cmd /c if not exist ${remoteDir} mkdir ${remoteDir} & ` +
    `tar -x -z -f - -C ${remoteDir}`;
  const runRemote =
    `powershell -NoProfile -ExecutionPolicy Bypass -File ` +
    `${remoteDir}\\deploy\\install.ps1 ${installArgs.join(" ")}`;

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
