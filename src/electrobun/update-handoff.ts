import { readFile, writeFile, rename } from "node:fs/promises";
import { join, win32, posix } from "node:path";
import { createServer, createConnection } from "node:net";

/** The OS releases this endpoint on exit, including crashes. A second launch
 * asks the existing tray owner to reopen, before creating any native windows. */
export async function claimDesktopInstance(port: number, reopen: () => void | Promise<void>): Promise<{ close: () => Promise<void> } | null> {
  const server = createServer(socket => {
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => {});
    socket.once("data", data => {
      if (data.toString() !== "open") { socket.destroy(); return; }
      void Promise.resolve().then(reopen).then(() => socket.end("opened"), () => socket.destroy());
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host: "127.0.0.1", exclusive: true }, () => { server.removeListener("error", reject); resolve(); });
    });
    server.unref();
    return { close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
  } catch (error: any) {
    if (error.code !== "EADDRINUSE") throw error;
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ port, host: "127.0.0.1" }, () => socket.write("open"));
      socket.setTimeout(15_000, () => socket.destroy(new Error("Existing Treetop window host did not respond")));
      socket.once("error", reject);
      socket.once("data", data => {
        socket.end();
        if (data.toString() === "opened") resolve();
        else reject(new Error("Unexpected response from existing Treetop window host"));
      });
      socket.once("end", () => reject(new Error("Existing Treetop window host closed before reopening")));
    });
    return null;
  }
}

export function updateInstallParent(executable: string, kind: "ui" | "daemon"): string | undefined {
  const macSuffix = kind === "ui" ? "/Contents/MacOS/bun" : "/Contents/Resources/app/supergit";
  if (executable.endsWith(`/Treetop.app${macSuffix}`)) {
    return posix.join(posix.dirname(executable.slice(0, -macSuffix.length)), ".treetop-installer");
  }
  const suffix = kind === "ui" ? "\\app\\bin\\bun.exe" : "\\app\\resources\\app\\supergit.exe";
  const normalized = win32.normalize(executable);
  return normalized.toLowerCase().endsWith(suffix) ? normalized.slice(0, -suffix.length) : undefined;
}

export class UpdateHandoff {
  private prepared?: string;
  private exiting = false;
  constructor(private pid: number, private prepare: () => unknown, private exit: () => unknown) {}
  async handle(request: any): Promise<"ready" | "exiting" | undefined> {
    if (!request || typeof request.id !== "string" || !/^[\w-]{1,80}$/.test(request.id) ||
      !Array.isArray(request.pids) || !request.pids.includes(this.pid) ||
      !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now() ||
      request.expiresAt > Date.now() + 120_000 || this.exiting) return;
    if (request.phase === "prepare") {
      if (this.prepared !== request.id) { await this.prepare(); this.prepared = request.id; }
      return "ready";
    }
    if (request.phase === "exit" && this.prepared === request.id) {
      this.exiting = true;
      await this.exit();
      return "exiting";
    }
  }
}

/** Same-user installation-local IPC; no network shutdown endpoint. The installer
 * targets an explicit PID snapshot and expires requests after two minutes. */
export function watchForUpdate(installParent: string, options: {
  prepare: () => unknown; exit: () => unknown; log: (message: string) => void;
}) {
  const handoff = new UpdateHandoff(process.pid, options.prepare, options.exit);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    let request: any;
    try {
      request = JSON.parse(await readFile(join(installParent, "update-request.json"), "utf8"));
      const state = await handoff.handle(request);
      if (state) {
        const target = join(installParent, `update-${request.id}-${process.pid}.json`);
        await writeFile(target + ".tmp", JSON.stringify({id:request.id,pid:process.pid,state}));
        await rename(target + ".tmp", target);
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") {
        options.log(`update handoff failed: ${error}`);
        if (request && /^[\w-]{1,80}$/.test(request.id ?? "") && request.pids?.includes(process.pid)) {
          await writeFile(join(installParent, `update-${request.id}-${process.pid}.json`), JSON.stringify({id:request.id,pid:process.pid,state:"error",error:String(error)})).catch(() => {});
        }
      }
    } finally { busy = false; }
  }, 500);
  timer.unref();
  return () => clearInterval(timer);
}
