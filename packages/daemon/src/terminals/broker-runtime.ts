import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  mkdir,
  open,
  readFile,
  unlink,
  copyFile,
  stat,
  readdir,
  rm,
  rename,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { BrokerBackend } from "./broker-backend";
import {
  BROKER_DESCRIPTOR,
  BROKER_PROTOCOL,
  type BrokerDescriptor,
} from "../background-protocol";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
async function descriptor(
  workspace: string,
): Promise<BrokerDescriptor | undefined> {
  let value: BrokerDescriptor;
  try {
    value = JSON.parse(
      await readFile(join(workspace, BROKER_DESCRIPTOR), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      "Broker descriptor is unreadable; no duplicate process was started",
    );
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0)
    throw new Error("Invalid broker identity; refusing a duplicate launch");
  if (!alive(value.pid)) return;
  if (
    value.protocol !== BROKER_PROTOCOL ||
    resolve(value.workspace) !== resolve(workspace)
  )
    throw new Error(
      "Live broker protocol/workspace mismatch; existing sessions left untouched",
    );
  if (
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.url) ||
    typeof value.token !== "string"
  )
    throw new Error("Invalid live broker endpoint");
  const response = await fetch(value.url + "/status", {
    headers: { Authorization: `Bearer ${value.token}` },
    signal: AbortSignal.timeout(2000),
  }).catch(() => undefined);
  if (!response?.ok)
    throw new Error(
      "Live broker is not responding; refusing to start a duplicate",
    );
  const status = (await response.json()) as any;
  if (
    status.protocol !== BROKER_PROTOCOL ||
    status.generation !== value.generation
  )
    throw new Error(
      "Broker identity mismatch; existing sessions left untouched",
    );
  return value;
}

export async function connectPersistentBroker(
  workspace = process.env.SUPERGIT_WORKSPACE ??
    join(homedir(), "supergit", "workspaces", "default"),
  reconnectBackend?: BrokerBackend,
) {
  const connect = (url: string, token: string) =>
    reconnectBackend
      ? reconnectBackend.reconnectTo(url, token)
      : BrokerBackend.connect(url, token);
  workspace = resolve(workspace);
  await mkdir(workspace, { recursive: true });
  const existing = await descriptor(workspace);
  if (existing) {
    console.info(`[background] reusing live broker pid=${existing.pid} generation=${existing.generation}; installed updates do not replace active owners`);
    return connect(existing.url, existing.token);
  }
  const lockPath = join(workspace, "terminal-broker.lock");
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 100 && !lock; attempt++) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(String(process.pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(lockPath, "utf8").catch(() => "0"));
      if (owner > 0 && !alive(owner)) await unlink(lockPath).catch(() => {});
      else {
        await Bun.sleep(100);
        const ready = await descriptor(workspace);
        if (ready) return connect(ready.url, ready.token);
      }
    }
  }
  if (!lock)
    throw new Error(
      "Another Treetop instance is starting the broker; no duplicate was launched",
    );
  try {
    const ready = await descriptor(workspace);
    if (ready) return connect(ready.url, ready.token);
    const exe = process.platform === "win32" ? ".exe" : "";
    const bundled = join(dirname(process.execPath), `terminal-broker${exe}`);
    let cmd: string[];
    if (existsSync(bundled)) {
      // Run from a versioned workspace copy so installers/builds can replace
      // the application bundle while this broker still owns live PTYs.
      const identity = await stat(bundled);
      const directory = join(
        workspace,
        "runtime",
        "brokers",
        `${BROKER_PROTOCOL}-${identity.size}-${Math.floor(identity.mtimeMs)}`,
      );
      await mkdir(directory, { recursive: true });
      const binary = join(directory, `terminal-broker${exe}`);
      if (!existsSync(binary)) await copyFile(bundled, binary);
      const helper = join(dirname(process.execPath), `pty-helper${exe}`);
      if (
        existsSync(helper) &&
        !existsSync(join(directory, `pty-helper${exe}`))
      )
        await copyFile(helper, join(directory, `pty-helper${exe}`));
      if (process.platform !== "win32") {
        const { chmod } = await import("node:fs/promises");
        await chmod(binary, 0o700);
        if (existsSync(join(directory, "pty-helper")))
          await chmod(join(directory, "pty-helper"), 0o700);
      }
      // No other live broker exists under the workspace lock. Keep at most
      // three generated versions, including this one, so upgrades cannot leak disk.
      const versionsRoot = resolve(workspace, "runtime", "brokers");
      const versions = await readdir(versionsRoot, { withFileTypes: true });
      const obsolete = (
        await Promise.all(
          versions
            .filter(
              (entry) =>
                entry.isDirectory() && /^\d+-\d+-\d+$/.test(entry.name),
            )
            .map(async (entry) => ({
              path: resolve(versionsRoot, entry.name),
              mtime: (await stat(join(versionsRoot, entry.name))).mtimeMs,
            })),
        )
      )
        .filter((entry) => entry.path !== resolve(directory))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(2);
      for (const version of obsolete) {
        if (
          !version.path.startsWith(
            versionsRoot + (process.platform === "win32" ? "\\" : "/"),
          )
        )
          throw new Error("Generated broker path escaped workspace");
        await rm(version.path, { recursive: true, force: true });
      }
      cmd = [binary];
    } else {
      const source = resolve(import.meta.dir, "..", "terminal-broker.ts");
      if (!existsSync(source))
        throw new Error(
          "Bundled terminal broker is missing; refusing a nonpersistent fallback",
        );
      cmd = [process.execPath, "run", source];
    }
    const token = crypto.randomUUID() + crypto.randomUUID();
    const launchLogPath = join(workspace, "terminal-broker-launch.log");
    if (
      existsSync(launchLogPath) &&
      (await stat(launchLogPath)).size > 2 * 1024 * 1024
    )
      await rename(launchLogPath, launchLogPath + ".prev");
    const startupLog = await open(launchLogPath, "a", 0o600);
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(cmd, {
        detached: true,
        windowsHide: true,
        stdin: "ignore",
        stdout: startupLog.fd,
        stderr: startupLog.fd,
        env: {
          ...process.env,
          SUPERGIT_WORKSPACE: workspace,
          TREETOP_TERMINAL_BROKER: "0",
          TREETOP_BROKER_TOKEN: token,
        },
      });
    } finally {
      await startupLog.close();
    }
    child.unref();
    console.info(`[background] launched broker pid=${child.pid} executable=${cmd[0]} windowsHide=true`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null)
        throw new Error(
          `Broker startup failed code=${child.exitCode}; inspect terminal-broker.log`,
        );
      const ready = await descriptor(workspace);
      if (ready) return connect(ready.url, ready.token);
      await Bun.sleep(100);
    }
    throw new Error(
      "Broker startup timed out; it retains a bounded fifteen-minute lifetime",
    );
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}
