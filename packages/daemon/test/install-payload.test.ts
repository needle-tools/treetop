import { test, expect, describe } from "bun:test";
import { join, resolve } from "node:path";
import { resolveInstallPayload } from "../src/install-payload";

/**
 * Locating the install payload — the source tree the local daemon ships to
 * a box to provision a remote daemon (tar-over-ssh → install.sh --no-pull).
 *
 * The crux is "from a built app": the packaged Supergit.app / .exe ships
 * only compiled current-platform binaries, so auto-provision needs the
 * SOURCE bundled under Resources/install-payload. A dev checkout uses the
 * live repo instead. All filesystem facts are injected so the resolution
 * order is unit-tested without a real bundle.
 */

const SCRIPT = join("deploy", "install.sh");

describe("resolveInstallPayload", () => {
  test("packaged: finds install-payload/ next to the binary (Resources)", () => {
    const execDir = "/Applications/Supergit.app/Contents/Resources";
    const loc = resolveInstallPayload({
      env: {},
      execDir,
      sourceRoot: "/nonexistent/repo",
      exists: (p) => p === join(execDir, "install-payload", SCRIPT),
    });
    expect(loc.mode).toBe("packaged");
    expect(loc.root).toBe(join(execDir, "install-payload"));
    expect(loc.installScript).toBe(join(execDir, "install-payload", SCRIPT));
  });

  test("dev: falls back to the live repo root when no bundle is present", () => {
    const sourceRoot = "/Users/me/git/supergit";
    const loc = resolveInstallPayload({
      env: {},
      execDir: "/tmp/bun-exec",
      sourceRoot,
      exists: (p) => p === join(sourceRoot, SCRIPT),
    });
    expect(loc.mode).toBe("dev");
    expect(loc.root).toBe(sourceRoot);
    expect(loc.installScript).toBe(join(sourceRoot, SCRIPT));
  });

  test("packaged wins over dev when both are present", () => {
    const execDir = "/app/Resources";
    const sourceRoot = "/repo";
    const loc = resolveInstallPayload({
      env: {},
      execDir,
      sourceRoot,
      exists: () => true, // both the bundle and the repo look present
    });
    expect(loc.mode).toBe("packaged");
    expect(loc.root).toBe(join(execDir, "install-payload"));
  });

  test("none: neither a bundle nor a repo checkout → auto-provision unavailable", () => {
    const loc = resolveInstallPayload({
      env: {},
      execDir: "/app/Resources",
      sourceRoot: "/repo",
      exists: () => false,
    });
    expect(loc.mode).toBe("none");
    expect(loc.root).toBeUndefined();
    expect(loc.installScript).toBeUndefined();
  });

  test("SUPERGIT_INSTALL_PAYLOAD_DIR override is trusted (like SUPERGIT_UI_DIR), no exists check", () => {
    const loc = resolveInstallPayload({
      env: { SUPERGIT_INSTALL_PAYLOAD_DIR: "/custom/payload" },
      execDir: "/app/Resources",
      sourceRoot: "/repo",
      exists: () => false, // override must win even when nothing exists on disk
    });
    // The override is run through path.resolve(), so the expectation must be
    // too — on Windows resolve("/custom/payload") is "C:\\custom\\payload",
    // on POSIX it's "/custom/payload" unchanged.
    const expectedRoot = resolve("/custom/payload");
    expect(loc.mode).toBe("packaged");
    expect(loc.root).toBe(expectedRoot);
    expect(loc.installScript).toBe(join(expectedRoot, SCRIPT));
  });
});
