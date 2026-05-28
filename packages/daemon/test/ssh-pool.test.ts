import { test, expect, describe, afterAll } from "bun:test";
import { SshPool } from "../src/ssh-pool";

describe("SshPool", () => {
  test("creates a pool instance", () => {
    const pool = new SshPool();
    expect(pool).toBeTruthy();
    pool.disconnectAll();
  });

  test("disconnectAll on empty pool is a no-op", () => {
    const pool = new SshPool();
    pool.disconnectAll();
  });

  test("disconnect unknown key is a no-op", () => {
    const pool = new SshPool();
    pool.disconnect("nonexistent@host:22");
    pool.disconnectAll();
  });

  test("hostKey format", () => {
    const pool = new SshPool();
    expect(pool.hostKey("user", "host", 22)).toBe("user@host:22");
    expect(pool.hostKey("admin", "10.0.0.1", 2222)).toBe("admin@10.0.0.1:2222");
    expect(pool.hostKey(undefined, "server", 22)).toBe("server:22");
    pool.disconnectAll();
  });

  test("hasCachedConnection returns false for unknown host", () => {
    const pool = new SshPool();
    expect(pool.hasCachedConnection("user@host:22")).toBe(false);
    pool.disconnectAll();
  });

  // Integration test: actual SSH connection
  // Only runs if SSH_TEST_HOST is set (e.g. SSH_TEST_HOST=user@host)
  const sshTestHost = process.env.SSH_TEST_HOST;
  const skipIntegration = !sshTestHost;

  describe.skipIf(skipIntegration)("integration (SSH_TEST_HOST)", () => {
    let pool: SshPool;
    let user: string | undefined;
    let host: string;
    let port: number;

    afterAll(() => pool?.disconnectAll());

    test("connect and list root dir", async () => {
      pool = new SshPool({ idleTimeoutMs: 5000 });
      const parts = sshTestHost!.split("@");
      if (parts.length === 2) {
        user = parts[0];
        host = parts[1]!;
      } else {
        host = parts[0]!;
      }
      port = Number(process.env.SSH_TEST_PORT) || 22;

      const sftp = await pool.connect(user, host, port);
      expect(sftp).toBeTruthy();
      expect(pool.hasCachedConnection(pool.hostKey(user, host, port))).toBe(
        true,
      );
    });
  });
});
