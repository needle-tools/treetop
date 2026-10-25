import { access, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Never copy over live binaries or delete the old installation. A failed
 * rename/verification restores the original directory before reporting failure. */
export async function replaceInstallation(options: {
  app: string; staged: string; backup: string;
  assertStopped: () => Promise<void>; verify: () => Promise<void>;
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
  if (hadApp) await rename(app, backup);
  try {
    await rename(staged, app); installed = true;
    await options.verify();
  } catch (error) {
    if (installed) await rename(app, staged);
    if (hadApp) await rename(backup, app);
    throw error;
  }
}
