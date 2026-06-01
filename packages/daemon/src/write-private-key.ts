/**
 * Write an SSH private key to disk with permissions OpenSSH will accept.
 *
 * On POSIX, `mode: 0o600` is enough. On **Windows that mode is ignored** —
 * OpenSSH checks NTFS ACLs instead, and a freshly-written file inherits
 * the parent's ACEs (SYSTEM, Administrators, sandbox groups, …). ssh then
 * refuses the key: "bad permissions … this private key will be ignored …
 * Permission denied". This bug made the daemon-managed tunnel fail with a
 * key that worked fine from an interactive shell (where the user had
 * chmod/icacls'd their own copy). See plans/PLAN-REMOTE-DAEMON.md.
 *
 * So on Windows we additionally lock the ACL down to the current user via
 * `icacls`: strip inheritance, grant only `%USERNAME%` read. The icacls
 * invocation is injected so the logic is unit-testable without touching a
 * real filesystem or running icacls.
 */

import { writeFile } from "node:fs/promises";

/** Runs an ACL command; returns its exit code. Injected for tests. */
export type AclRunner = (exe: string, args: string[]) => Promise<number>;

export interface WriteKeyDeps {
  platform?: NodeJS.Platform;
  /** Defaults to the real fs writeFile. */
  write?: (path: string, data: string, mode: number) => Promise<void>;
  /** Defaults to spawning icacls. Only called on win32. */
  runAcl?: AclRunner;
  /** Current username for the icacls grant. Defaults to env USERNAME. */
  username?: string;
}

/** Build the icacls argv that locks a file to a single user (read-only):
 *  remove inheritance, grant only that user `R`. Pure + exported so the
 *  exact flags are asserted in tests. */
export function buildIcaclsArgs(path: string, username: string): string[] {
  return [path, "/inheritance:r", "/grant:r", `${username}:R`];
}

/**
 * Write `key` (ensuring a trailing newline) to `path` at mode 0600, then —
 * on Windows — lock its ACL to the current user so OpenSSH accepts it.
 * Throws if the Windows ACL lockdown can't be applied (a key ssh will
 * reject is worse than a clear failure at write time).
 */
export async function writePrivateKey(
  path: string,
  key: string,
  deps: WriteKeyDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const write =
    deps.write ??
    ((p, data, mode) => writeFile(p, data, { mode }));
  const body = key.endsWith("\n") ? key : key + "\n";
  await write(path, body, 0o600);

  if (platform !== "win32") return; // POSIX mode 0600 is sufficient

  const username = deps.username ?? process.env.USERNAME ?? "";
  if (!username) {
    throw new Error(
      "cannot secure the key on Windows: no USERNAME to grant ACL to",
    );
  }
  const runAcl =
    deps.runAcl ??
    (async (exe, args) => {
      const proc = Bun.spawn([exe, ...args], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return proc.exited;
    });
  const code = await runAcl("icacls", buildIcaclsArgs(path, username));
  if (code !== 0) {
    throw new Error(
      `failed to lock down key permissions on Windows (icacls exit ${code}); ` +
        `OpenSSH would reject the key as "bad permissions"`,
    );
  }
}
