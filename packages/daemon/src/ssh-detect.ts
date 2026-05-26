import { $ } from "bun";

export interface SshSession {
  sshPid: number;
  user: string | undefined;
  host: string;
  port: number;
}

/**
 * Parse an SSH command line into user/host/port.
 * Handles: ssh [flags] [-p port] [user@]host [remote-command...]
 */
export function parseSshArgs(
  args: string,
): { user: string | undefined; host: string; port: number } | null {
  const tokens = args.trim().split(/\s+/);
  if (tokens.length === 0) return null;

  const cmd = tokens[0]!.split("/").pop() || tokens[0]!;
  if (cmd !== "ssh") return null;
  if (tokens.length < 2) return null;

  let port = 22;
  let host: string | undefined;
  let user: string | undefined;

  const FLAGS_WITH_ARG = new Set([
    "-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J",
    "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w",
  ]);

  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i]!;

    if (tok === "-p" && i + 1 < tokens.length) {
      port = Number(tokens[i + 1]) || 22;
      i += 2;
      continue;
    }

    if (FLAGS_WITH_ARG.has(tok)) {
      i += 2;
      continue;
    }

    if (tok.startsWith("-")) {
      i++;
      continue;
    }

    // First non-flag, non-option token is the [user@]host
    if (!host) {
      const at = tok.indexOf("@");
      if (at !== -1) {
        user = tok.slice(0, at);
        host = tok.slice(at + 1);
      } else {
        host = tok;
      }
    } else {
      break; // everything after host is the remote command
    }

    i++;
  }

  if (!host) return null;
  return { user, host, port };
}

/**
 * Detect SSH child processes for a set of PTY parent pids.
 * Returns a map: ptyPid → SshSession.
 */
export async function detectSshChildren(
  ptyPids: number[],
): Promise<Map<number, SshSession>> {
  const result = new Map<number, SshSession>();
  if (ptyPids.length === 0) return result;
  if (process.platform === "win32") return result;

  try {
    const ps = await $`ps -ax -o pid=,ppid=,args=`.quiet().nothrow();
    const text = ps.stdout.toString();
    const ptySet = new Set(ptyPids);

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const args = m[3]!;

      const parsed = parseSshArgs(args);
      if (!parsed) continue;

      // Case 1: ssh is a child of the PTY (user typed `ssh` in a shell)
      if (ptySet.has(ppid)) {
        result.set(ppid, {
          sshPid: pid,
          user: parsed.user,
          host: parsed.host,
          port: parsed.port,
        });
      }

      // Case 2: ssh IS the PTY process (`sh -c "ssh ..."` exec'd into ssh)
      if (ptySet.has(pid) && !result.has(pid)) {
        result.set(pid, {
          sshPid: pid,
          user: parsed.user,
          host: parsed.host,
          port: parsed.port,
        });
      }
    }
  } catch {
    // best-effort
  }

  return result;
}
