import { Client } from "ssh2";
import type { SFTPWrapper } from "ssh2";
import { readFileSync } from "node:fs";
import { $ } from "bun";

export interface SshPoolOptions {
  idleTimeoutMs?: number;
}

interface PoolEntry {
  client: Client;
  sftp: SFTPWrapper;
  timer: ReturnType<typeof setTimeout>;
}

export class SshPool {
  private pool = new Map<string, PoolEntry>();
  private connecting = new Map<string, Promise<SFTPWrapper>>();
  private idleMs: number;

  constructor(opts?: SshPoolOptions) {
    this.idleMs = opts?.idleTimeoutMs ?? 60_000;
  }

  hostKey(user: string | undefined, host: string, port: number): string {
    return user ? `${user}@${host}:${port}` : `${host}:${port}`;
  }

  hasCachedConnection(key: string): boolean {
    return this.pool.has(key);
  }

  async connect(
    user: string | undefined,
    host: string,
    port: number,
    privateKeyPath?: string,
  ): Promise<SFTPWrapper> {
    const key = this.hostKey(user, host, port);

    const existing = this.pool.get(key);
    if (existing) {
      this.resetIdleTimer(key, existing);
      return existing.sftp;
    }

    let inflight = this.connecting.get(key);
    if (inflight) return inflight;

    inflight = this.doConnect(key, user, host, port, privateKeyPath);
    this.connecting.set(key, inflight);
    try {
      return await inflight;
    } finally {
      this.connecting.delete(key);
    }
  }

  disconnect(key: string): void {
    const entry = this.pool.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.client.end();
    this.pool.delete(key);
  }

  disconnectAll(): void {
    for (const [key] of this.pool) {
      this.disconnect(key);
    }
  }

  private async doConnect(
    key: string,
    user: string | undefined,
    host: string,
    port: number,
    privateKeyPath?: string,
  ): Promise<SFTPWrapper> {
    const agentSock = privateKeyPath ? undefined : await resolveAgent(host);
    const client = new Client();

    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.on("error", (err: Error) => {
        this.pool.delete(key);
        reject(err);
      });

      client.on("close", () => {
        const entry = this.pool.get(key);
        if (entry) {
          clearTimeout(entry.timer);
          this.pool.delete(key);
        }
      });

      client.on("ready", () => {
        client.sftp((err, sftp) => {
          if (err) {
            client.end();
            return reject(err);
          }

          const entry: PoolEntry = {
            client,
            sftp,
            timer: setTimeout(() => this.disconnect(key), this.idleMs),
          };
          this.pool.set(key, entry);
          resolve(sftp);
        });
      });

      const connectOpts: Record<string, unknown> = {
        host,
        port,
        username: user ?? process.env.USER ?? "root",
      };

      if (privateKeyPath) {
        connectOpts.privateKey = readFileSync(privateKeyPath);
      } else {
        connectOpts.agent = agentSock;
      }

      client.connect(connectOpts);
    });
  }

  /** Execute a command on the remote and return stdout. */
  async exec(
    user: string | undefined,
    host: string,
    port: number,
    command: string,
  ): Promise<string> {
    const key = this.hostKey(user, host, port);
    const entry = this.pool.get(key);
    if (!entry) throw new Error(`No connection for ${key}`);

    this.resetIdleTimer(key, entry);

    return new Promise<string>((resolve, reject) => {
      entry.client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let out = "";
        stream.on("data", (chunk: Buffer) => {
          out += chunk.toString();
        });
        stream.stderr.on("data", () => {});
        stream.on("close", () => resolve(out));
      });
    });
  }

  private resetIdleTimer(key: string, entry: PoolEntry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.disconnect(key), this.idleMs);
  }
}

/**
 * Resolve the SSH agent socket for a given host.
 *
 * macOS/Linux: reads `ssh -G <host>` for custom IdentityAgent
 * (1Password, Secretive, etc.), falls back to SSH_AUTH_SOCK.
 *
 * Windows: uses the OpenSSH agent named pipe, or reads ssh -G
 * for custom agent paths.
 */
async function resolveAgent(host: string): Promise<string | undefined> {
  try {
    const result = await $`ssh -G ${host}`.quiet().nothrow();
    const text = result.stdout.toString();
    for (const line of text.split("\n")) {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith("identityagent ")) {
        const val = line.trim().slice("identityagent ".length).trim();
        if (val && val !== "SSH_AUTH_SOCK") return val;
      }
    }
  } catch {
    // best-effort
  }

  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;

  // Windows: OpenSSH agent uses a named pipe
  if (process.platform === "win32") return "\\\\.\\pipe\\openssh-ssh-agent";

  return undefined;
}
