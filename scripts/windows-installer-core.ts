import { access, rename, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";

export class InstallationRecoveryError extends Error {}

// Legacy brokers inherited app/bin as cwd. Windows locks that directory even
// though their executable is elsewhere. Leave directories in place and move
// only files, retaining every replaced file for rollback. Never overwrite a
// loaded binary: a file lock still fails the transaction and restores the old app.
async function replaceFiles(options: {
  app: string; staged: string; backup: string; verify: () => Promise<void>;
}) {
  async function files(root: string, relative = ""): Promise<string[]> {
    const result: string[] = [];
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) result.push(...await files(root, name));
      else if (entry.isFile()) result.push(name);
      else throw Error(`Unsupported installation entry: ${name}`);
    }
    return result;
  }
  const oldFiles = await files(options.app), newFiles = await files(options.staged);
  const moved: Array<[string, string]> = [];
  async function move(from: string, to: string) {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    moved.push([from, to]);
  }
  try {
    for (const name of oldFiles) await move(join(options.app, name), join(options.backup, name));
    for (const name of newFiles) await move(join(options.staged, name), join(options.app, name));
    await options.verify();
  } catch (error) {
    const failures: string[] = [];
    for (const [from, to] of moved.reverse()) {
      try { await rename(to, from); } catch (rollbackError) { failures.push(String(rollbackError)); }
    }
    if (failures.length) throw new InstallationRecoveryError(`Update failed: ${error}. Rollback incomplete: ${failures.join("; ")}. Recovery files retained in ${options.backup} and ${options.staged}`);
    throw error;
  }
}

/** Never copy over live binaries or delete the old installation. A failed
 * rename/verification restores the original directory before reporting failure. */
export async function replaceInstallation(options: {
  app: string; staged: string; backup: string;
  assertStopped: () => Promise<void>; verify: () => Promise<void>;
  log?: (message: string) => Promise<void>;
}) {
  const {app, staged, backup} = options;
  if (new Set([app,staged,backup].map(p=>resolve(p).toLowerCase())).size !== 3 ||
    dirname(resolve(app)) !== dirname(resolve(backup))) throw Error("Invalid installation transaction paths");
  await options.assertStopped();
  let hadApp = false, installed = false;
  try { await access(app); hadApp = true; } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  // Never overwrite an existing rollback copy.
  try { await access(backup); throw Error("Rollback destination already exists"); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  if (hadApp) {
    try { await rename(app, backup); }
    catch (error: any) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      await options.assertStopped();
      await options.log?.("Installation directory is held open; preserving directories and replacing files with rollback");
      await replaceFiles(options);
      return;
    }
  }
  try {
    await rename(staged, app); installed = true;
    await options.verify();
  } catch (error) {
    if (installed) await rename(app, staged);
    if (hadApp) await rename(backup, app);
    throw error;
  }
}
