/**
 * Locate the install payload — the SOURCE TREE the local daemon ships to a
 * remote box to provision a daemon there (tar-over-ssh → `install.sh
 * --no-pull`, which `bun install`s / `bun run build`s / `go build`s the
 * helper ON the box).
 *
 * Why a payload at all: the packaged app (build-native.ts → Supergit.app /
 * the .exe) ships only COMPILED, current-platform binaries — the wrong arch
 * for a Linux box and with no build inputs. So to auto-provision FROM the
 * packaged app we bundle the source under `Resources/install-payload` and
 * ship THAT. In a dev checkout the live repo already IS the payload.
 *
 * Resolution mirrors UI_DIR in server.ts:
 *   1. SUPERGIT_INSTALL_PAYLOAD_DIR override — trusted, like SUPERGIT_UI_DIR.
 *   2. Packaged: `<execDir>/install-payload/` next to the binary (Resources).
 *   3. Dev: the repo root, where `deploy/install.sh` lives.
 *   4. none — auto-provision is unavailable in this build.
 *
 * Pure: every filesystem fact (execDir, sourceRoot, exists) is injected, so
 * the decision logic is unit-tested without a real bundle. server.ts wires
 * the real process.execPath / import.meta.dir / fs.existsSync.
 */

import { join, resolve } from "node:path";

export type InstallPayloadMode = "packaged" | "dev" | "none";

export interface InstallPayloadLocation {
  mode: InstallPayloadMode;
  /** Directory to tar + ship (contains deploy/install.sh, packages/…).
   *  Absent when mode is "none". */
  root?: string;
  /** Absolute path to install.sh within `root`. Absent when mode is "none". */
  installScript?: string;
}

export interface ResolveInstallPayloadDeps {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** dirname(process.execPath) — where a packaged binary + Resources live. */
  execDir: string;
  /** Repo root in a dev checkout — resolve(import.meta.dir, "../../.."). */
  sourceRoot: string;
  /** Existence check, injected for tests (server passes fs.existsSync). */
  exists: (p: string) => boolean;
}

/** install.sh's path relative to the payload root (same in dev and bundle). */
const SCRIPT_REL = join("deploy", "install.sh");

export function resolveInstallPayload(
  deps: ResolveInstallPayloadDeps,
): InstallPayloadLocation {
  const env = deps.env ?? process.env;

  // 1. Explicit override — trusted, no exists check (mirrors SUPERGIT_UI_DIR).
  const override = env.SUPERGIT_INSTALL_PAYLOAD_DIR;
  if (override) {
    const root = resolve(override);
    return { mode: "packaged", root, installScript: join(root, SCRIPT_REL) };
  }

  // 2. Packaged: install-payload/ sits next to the binary, in Resources.
  const bundled = join(deps.execDir, "install-payload");
  if (deps.exists(join(bundled, SCRIPT_REL))) {
    return {
      mode: "packaged",
      root: bundled,
      installScript: join(bundled, SCRIPT_REL),
    };
  }

  // 3. Dev checkout: the live repo root is the payload.
  if (deps.exists(join(deps.sourceRoot, SCRIPT_REL))) {
    return {
      mode: "dev",
      root: deps.sourceRoot,
      installScript: join(deps.sourceRoot, SCRIPT_REL),
    };
  }

  // 4. Nothing to ship — auto-provision unavailable in this build.
  return { mode: "none" };
}
