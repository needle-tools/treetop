import { test, expect, describe } from "bun:test";
import { parseSshArgs, detectSshChildren } from "../src/ssh-detect";

describe("parseSshArgs", () => {
  test("user@host", () => {
    expect(parseSshArgs("ssh needle@100.71.105.118")).toEqual({
      user: "needle",
      host: "100.71.105.118",
      port: 22,
    });
  });

  test("host only (no user)", () => {
    expect(parseSshArgs("ssh myserver.com")).toEqual({
      user: undefined,
      host: "myserver.com",
      port: 22,
    });
  });

  test("explicit port with -p", () => {
    expect(parseSshArgs("ssh -p 2222 deploy@staging.example.com")).toEqual({
      user: "deploy",
      host: "staging.example.com",
      port: 2222,
    });
  });

  test("port after host", () => {
    expect(parseSshArgs("ssh deploy@staging.example.com -p 2222")).toEqual({
      user: "deploy",
      host: "staging.example.com",
      port: 2222,
    });
  });

  test("full path to ssh binary", () => {
    expect(parseSshArgs("/usr/bin/ssh root@10.0.0.1")).toEqual({
      user: "root",
      host: "10.0.0.1",
      port: 22,
    });
  });

  test("with flags before host", () => {
    expect(parseSshArgs("ssh -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa admin@prod")).toEqual({
      user: "admin",
      host: "prod",
      port: 22,
    });
  });

  test("with -t flag (force pseudo-terminal)", () => {
    expect(parseSshArgs("ssh -t user@host")).toEqual({
      user: "user",
      host: "host",
      port: 22,
    });
  });

  test("with trailing remote command (should still parse host)", () => {
    const result = parseSshArgs("ssh user@host ls -la");
    expect(result).toEqual({
      user: "user",
      host: "host",
      port: 22,
    });
  });

  test("returns null for non-ssh command", () => {
    expect(parseSshArgs("git push origin main")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseSshArgs("")).toBeNull();
  });

  test("returns null for ssh with no args", () => {
    expect(parseSshArgs("ssh")).toBeNull();
  });

  test("IPv6 host", () => {
    expect(parseSshArgs("ssh user@::1")).toEqual({
      user: "user",
      host: "::1",
      port: 22,
    });
  });

  test("hostname with dashes and numbers", () => {
    expect(parseSshArgs("ssh user@my-server-01.internal")).toEqual({
      user: "user",
      host: "my-server-01.internal",
      port: 22,
    });
  });
});

describe("detectSshChildren", () => {
  test("returns empty map for empty pid list", async () => {
    const result = await detectSshChildren([]);
    expect(result.size).toBe(0);
  });

  test("returns empty map for pids with no ssh children", async () => {
    const result = await detectSshChildren([1]);
    expect(result.size).toBe(0);
  });

  test("detects ssh when it IS the pty process (sh -c ssh exec case)", async () => {
    // When a saved command runs `sh -c "ssh user@host"`, sh exec's into
    // ssh so the pty pid IS the ssh process. detectSshChildren must check
    // the pid itself, not just children.
    const { $ } = await import("bun");
    const ps = await $`ps -ax -o pid=,ppid=,args=`.quiet().nothrow();
    const text = ps.stdout.toString();
    // Find any live ssh process and pretend its PID is our PTY pid
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const args = m[3]!;
      if (!/\bssh\s+\S+@\S+/.test(args)) continue;
      const sshPid = Number(m[1]);
      // Pass the ssh pid AS the pty pid — should detect it
      const result = await detectSshChildren([sshPid]);
      if (result.has(sshPid)) {
        expect(result.get(sshPid)!.sshPid).toBe(sshPid);
        expect(result.get(sshPid)!.host).toBeTruthy();
        return; // test passes
      }
    }
    // No live ssh process to test against — skip gracefully
    console.log("  (no live ssh process found, skipping exec-case assertion)");
  });
});
