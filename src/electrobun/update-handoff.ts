import { readFile, writeFile, rename } from "node:fs/promises";
import { join, win32 } from "node:path";

export function updateInstallParent(executable: string, kind: "ui" | "daemon"): string | undefined {
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
