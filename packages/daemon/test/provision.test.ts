import { test, expect, describe } from "bun:test";
import {
  extractConnectionToken,
  buildShipCommand,
  buildProvisionPlan,
  isUpdateAvailable,
  installPayloadPathspec,
} from "../src/provision";

/**
 * Pure provisioning helpers: parsing the installer's connection token out of
 * its stdout, building the ssh + tar argv that ships the source and runs the
 * installer on the box, and deciding when a remote daemon is out of date.
 *
 * All three are pure — the orchestrator (server.ts) does the spawning,
 * streaming, and registration around them. Keeping these pure is what makes
 * "did we build the right ssh command / parse the right token" testable
 * without a real box.
 */

describe("extractConnectionToken", () => {
  test("pulls the supergit1: token out of a noisy banner", () => {
    const out = `
==========================================================================
 supergit remote daemon is up.
     supergit1:eyJob3N0IjoiMS4yLjMuNCJ9
 (treat it as a secret)
`;
    expect(extractConnectionToken(out)).toBe(
      "supergit1:eyJob3N0IjoiMS4yLjMuNCJ9",
    );
  });

  test("returns null when there is no token", () => {
    expect(extractConnectionToken("nothing to see here\n")).toBeNull();
  });

  test("stops at whitespace / quotes — only base64url chars belong to the token", () => {
    expect(extractConnectionToken('  "supergit1:ab-_CD9" trailing')).toBe(
      "supergit1:ab-_CD9",
    );
  });

  test("prefers the last token when the installer prints it more than once", () => {
    const out = "supergit1:FIRSTtoken\n...later...\nsupergit1:LASTtoken\n";
    expect(extractConnectionToken(out)).toBe("supergit1:LASTtoken");
  });

  test("honors an explicit SUPERGIT_CONNECT= marker line", () => {
    const out =
      "noise\nSUPERGIT_CONNECT=supergit1:MARKERtok\nmore banner supergit1:bannertok\n";
    expect(extractConnectionToken(out)).toBe("supergit1:MARKERtok");
  });
});

describe("installPayloadPathspec", () => {
  test("includes the tree but excludes the symlink + internal docs", () => {
    const ps = installPayloadPathspec();
    expect(ps[0]).toBe(".");
    expect(ps).toContain(":!AGENTS.md"); // symlink Windows tar can't extract
    expect(ps).toContain(":!CLAUDE.md"); // AI-agent rules, internal
    expect(ps).toContain(":!plans"); // internal design docs
  });

  test("excludes packages/ui — UI runs on operator's laptop, not the remote box", () => {
    // The daemon serves API only on a remote box; the operator's local
    // Treetop renders the UI and proxies through the SSH tunnel. Shipping
    // the UI tree once broke the Windows installer (a sticker path crossed
    // the ustar 100-char limit and electrobun's extractor.exe rejected the
    // resulting GNU LongLink header). The no-ui-imports.test.ts boundary
    // ensures the daemon can never grow a dependency on UI source that
    // would force re-bundling it.
    expect(installPayloadPathspec()).toContain(":!packages/ui");
  });
});

describe("buildShipCommand", () => {
  test("packaged: gzip-tar the already-pruned bundle straight to stdout", () => {
    expect(buildShipCommand("/app/install-payload", "packaged")).toEqual({
      bin: "tar",
      args: ["-c", "-z", "-f", "-", "-C", "/app/install-payload", "."],
    });
  });

  test("dev: git archive (gzip) the tracked tree, excluding internals (repo has node_modules)", () => {
    const cmd = buildShipCommand("/repo", "dev");
    expect(cmd.bin).toBe("git");
    // tar.gz, not plain tar — the remote always extracts with -z (some tar
    // builds won't auto-detect gzip on a pipe).
    expect(cmd.args.slice(0, 6)).toEqual([
      "-C",
      "/repo",
      "archive",
      "--format=tar.gz",
      "HEAD",
      "--",
    ]);
    expect(cmd.args).toContain(".");
    expect(cmd.args).toContain(":!CLAUDE.md");
    expect(cmd.args).toContain(":!AGENTS.md");
  });
});

describe("buildProvisionPlan", () => {
  test("ship step: extracts the piped archive, NO tty (a pty corrupts binary stdin)", () => {
    const plan = buildProvisionPlan({ host: "box.example", user: "root" });
    expect(plan.ship.ssh).toContain("BatchMode=yes");
    // Bounded connect so a firewall-dropped SYN fails fast, not after ~75s.
    expect(plan.ship.ssh).toContain("ConnectTimeout=15");
    expect(plan.ship.ssh).toContain("root@box.example");
    expect(plan.ship.ssh).not.toContain("-tt");
    expect(plan.ship.ssh[plan.ship.ssh.length - 1]).toBe(plan.ship.remoteCommand);
    // make the dir + extract the gzip stdin explicitly (-z; ship is always
    // gzip and tar auto-detect over a pipe is unreliable). NOT the installer.
    expect(plan.ship.remoteCommand).toContain("mkdir -p /opt/supergit");
    expect(plan.ship.remoteCommand).toContain("tar -x -z -f - -C /opt/supergit");
    expect(plan.ship.remoteCommand).not.toContain("install.sh");
  });

  test("run step: installs WITH a tty so output streams live", () => {
    const plan = buildProvisionPlan({ host: "box.example", user: "root" });
    expect(plan.run.ssh).toContain("-tt");
    expect(plan.run.ssh).toContain("root@box.example");
    expect(plan.run.ssh[plan.run.ssh.length - 1]).toBe(plan.run.remoteCommand);
    expect(plan.run.remoteCommand).toContain("cd /opt/supergit");
    expect(plan.run.remoteCommand).toContain("deploy/install.sh --no-pull");
    // Sandboxed by default — no SUPERGIT_USER override.
    expect(plan.run.remoteCommand).not.toContain("SUPERGIT_USER");
  });

  test("runAsRoot: install.sh runs with SUPERGIT_USER=root (full box access)", () => {
    const plan = buildProvisionPlan({ host: "h", runAsRoot: true });
    expect(plan.run.remoteCommand).toContain(
      "SUPERGIT_USER=root bash deploy/install.sh --no-pull",
    );
  });

  test("host-only destination when no user is given", () => {
    const plan = buildProvisionPlan({ host: "h" });
    expect(plan.ship.ssh).toContain("h");
    expect(plan.ship.ssh).not.toContain("@h");
  });

  test("adds -p / -i only when sshPort / identityPath are provided (run step)", () => {
    const bare = buildProvisionPlan({ host: "h" });
    expect(bare.run.ssh).not.toContain("-p");
    expect(bare.run.ssh).not.toContain("-i");

    const full = buildProvisionPlan({
      host: "h",
      sshPort: 2222,
      identityPath: "/keys/admin",
    });
    expect(full.run.ssh).toContain("-p");
    expect(full.run.ssh).toContain("2222");
    expect(full.run.ssh).toContain("-i");
    expect(full.run.ssh).toContain("/keys/admin");
  });

  test("honors a custom remote dir and extra install args", () => {
    const plan = buildProvisionPlan({
      host: "h",
      remoteDir: "/srv/supergit",
      installArgs: ["--no-pull", "--no-restart"],
    });
    expect(plan.ship.remoteCommand).toContain("mkdir -p /srv/supergit");
    expect(plan.run.remoteCommand).toContain("cd /srv/supergit");
    expect(plan.run.remoteCommand).toContain(
      "deploy/install.sh --no-pull --no-restart",
    );
  });

  test("posix is the default when os is unset", () => {
    const plan = buildProvisionPlan({ host: "h" });
    expect(plan.ship.remoteCommand).toContain("mkdir -p /opt/supergit");
    expect(plan.run.remoteCommand).toContain("bash deploy/install.sh");
  });
});

describe("buildProvisionPlan — Windows target", () => {
  // A Windows box's default ssh shell is cmd.exe, which rejects POSIX
  // (`mkdir -p`, `&&`, `bash`) with "The syntax of the command is
  // incorrect." So a windows target needs cmd/PowerShell-native commands.
  const win = { host: "nuc", user: "needle", os: "windows" as const };

  test("ship: cmd /c so it works under cmd.exe AND passes binary tar stdin", () => {
    const plan = buildProvisionPlan(win);
    // No tty (a pty corrupts the piped tar) — same rule as posix.
    expect(plan.ship.ssh).not.toContain("-tt");
    expect(plan.ship.ssh).toContain("needle@nuc");
    // cmd /c, not bash; mkdir without the posix -p; tar.exe extracts stdin.
    expect(plan.ship.remoteCommand).toContain("cmd /c");
    expect(plan.ship.remoteCommand).toContain("C:\\supergit");
    expect(plan.ship.remoteCommand).toContain("tar -x -z -f - -C C:\\supergit");
    expect(plan.ship.remoteCommand).not.toContain("mkdir -p");
    expect(plan.ship.remoteCommand).not.toContain("&&");
  });

  test("run: PowerShell runs install.ps1 WITHOUT a tty (ConPTY swallows output)", () => {
    const plan = buildProvisionPlan(win);
    // No -tt on Windows: a forced pty + PowerShell ate the output (blank log,
    // exit 0). Plain pipes capture it. POSIX keeps -tt for live streaming.
    expect(plan.run.ssh).not.toContain("-tt");
    expect(plan.run.remoteCommand).toContain("powershell");
    expect(plan.run.remoteCommand).toContain("-ExecutionPolicy Bypass");
    expect(plan.run.remoteCommand).toContain("deploy\\install.ps1");
    expect(plan.run.remoteCommand).toContain("-NoPull");
    expect(plan.run.remoteCommand).not.toContain("bash");
    expect(plan.run.remoteCommand).not.toContain("install.sh");
  });

  test("honors a custom remote dir (Windows path) + install args", () => {
    const plan = buildProvisionPlan({
      host: "nuc",
      os: "windows",
      remoteDir: "D:\\apps\\supergit",
      installArgs: ["-NoPull", "-Force"],
    });
    expect(plan.ship.remoteCommand).toContain("D:\\apps\\supergit");
    expect(plan.run.remoteCommand).toContain("D:\\apps\\supergit\\deploy\\install.ps1");
    expect(plan.run.remoteCommand).toContain("-NoPull -Force");
  });

  test("shares the ssh hardening flags with posix (BatchMode, ConnectTimeout)", () => {
    const plan = buildProvisionPlan(win);
    expect(plan.ship.ssh).toContain("BatchMode=yes");
    expect(plan.ship.ssh).toContain("ConnectTimeout=15");
    expect(plan.run.ssh[plan.run.ssh.length - 1]).toBe(plan.run.remoteCommand);
  });
});

describe("isUpdateAvailable", () => {
  test("local build newer than remote → update available", () => {
    expect(
      isUpdateAvailable("2026-06-02T10:00:00.000Z", "2026-06-01T09:00:00.000Z"),
    ).toBe(true);
  });

  test("local same or older → no update", () => {
    expect(
      isUpdateAvailable("2026-06-01T09:00:00.000Z", "2026-06-01T09:00:00.000Z"),
    ).toBe(false);
    expect(
      isUpdateAvailable("2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z"),
    ).toBe(false);
  });

  test("comparison is chronological, not lexicographic (ms vs no-ms)", () => {
    // "…00Z" vs "…00.000Z" are the SAME instant; a string compare would
    // wrongly order them. local has no ms, remote has ms — still not newer.
    expect(
      isUpdateAvailable("2026-06-01T09:00:00Z", "2026-06-01T09:00:00.000Z"),
    ).toBe(false);
  });

  test("unknown build times → no nag", () => {
    expect(isUpdateAvailable(undefined, "2026-06-01T09:00:00.000Z")).toBe(false);
    expect(isUpdateAvailable("2026-06-01T09:00:00.000Z", undefined)).toBe(false);
    expect(isUpdateAvailable("not-a-date", "also-bad")).toBe(false);
  });
});
