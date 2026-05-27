import { test, expect, describe } from "bun:test";
import { cachePathFor, listRemoteDir, downloadFile, uploadFile } from "../src/ssh-files";
import { SshPool } from "../src/ssh-pool";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("cachePathFor", () => {
  const normalize = (p: string) => p.replace(/\\/g, "/");

  test("assembles cache path from parts", () => {
    expect(normalize(cachePathFor("/workspace", "user@host:22", "/home/user/file.txt"))).toBe(
      "/workspace/.remote-cache/user@host:22/home/user/file.txt",
    );
  });

  test("handles root path", () => {
    expect(normalize(cachePathFor("/workspace", "root@srv:22", "/etc/nginx.conf"))).toBe(
      "/workspace/.remote-cache/root@srv:22/etc/nginx.conf",
    );
  });

  test("handles nested directories", () => {
    expect(normalize(cachePathFor("/ws", "u@h:22", "/a/b/c/d.txt"))).toBe(
      "/ws/.remote-cache/u@h:22/a/b/c/d.txt",
    );
  });
});

const sshTestHost = process.env.SSH_TEST_HOST;
const skipIntegration = !sshTestHost;

describe.skipIf(skipIntegration)("SFTP integration (SSH_TEST_HOST)", () => {
  let pool: SshPool;
  let user: string | undefined;
  let host: string;
  let port: number;
  let tmpDir: string;

  test("setup", async () => {
    pool = new SshPool({ idleTimeoutMs: 10000 });
    const parts = sshTestHost!.split("@");
    if (parts.length === 2) {
      user = parts[0];
      host = parts[1]!;
    } else {
      host = parts[0]!;
    }
    port = Number(process.env.SSH_TEST_PORT) || 22;
    tmpDir = await mkdtemp(join(tmpdir(), "supergit-ssh-files-"));
    await pool.connect(user, host, port);
  });

  test("listRemoteDir returns entries with correct shape", async () => {
    const sftp = await pool.connect(user!, host, port);
    const entries = await listRemoteDir(sftp, "/");
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.name).toBeTruthy();
      expect(["file", "directory", "symlink"]).toContain(e.type);
    }
  });

  test("listRemoteDir sorts directories first", async () => {
    const sftp = await pool.connect(user!, host, port);
    const entries = await listRemoteDir(sftp, "/");
    const dirs = entries.filter((e) => e.type === "directory");
    const files = entries.filter((e) => e.type !== "directory");
    if (dirs.length > 0 && files.length > 0) {
      const lastDirIdx = entries.lastIndexOf(dirs[dirs.length - 1]!);
      const firstFileIdx = entries.indexOf(files[0]!);
      expect(lastDirIdx).toBeLessThan(firstFileIdx);
    }
  });

  test("downloadFile + uploadFile round-trip", async () => {
    const sftp = await pool.connect(user!, host, port);
    // Resolve remote home: works on both Unix ($HOME) and Windows (%USERPROFILE%)
    const homeProbe = await pool.exec(user, host, port, "echo %USERPROFILE%");
    let remoteHome = homeProbe.trim();
    if (remoteHome === "%USERPROFILE%") {
      // Not Windows — try $HOME
      remoteHome = (await pool.exec(user, host, port, "echo $HOME")).trim() || "/tmp";
    }
    // Normalize backslashes to forward slashes for SFTP
    remoteHome = remoteHome.replace(/\\/g, "/");
    const remotePath = remoteHome + "/supergit-ssh-test-" + Date.now() + ".txt";
    const localPath = join(tmpDir, "round-trip.txt");

    // Create file on remote via SFTP write
    const { writeFile: wf } = await import("node:fs/promises");
    const uploadPath = join(tmpDir, "upload-seed.txt");
    await wf(uploadPath, "hello supergit\n");
    await uploadFile(sftp, uploadPath, remotePath);

    // Download
    await downloadFile(sftp, remotePath, localPath);
    const content = await readFile(localPath, "utf-8");
    expect(content.trim()).toBe("hello supergit");

    // Modify locally
    await wf(localPath, "modified by supergit\n");

    // Upload back
    await uploadFile(sftp, localPath, remotePath);

    // Download again to verify
    const verifyPath = join(tmpDir, "verify.txt");
    await downloadFile(sftp, remotePath, verifyPath);
    const verified = await readFile(verifyPath, "utf-8");
    expect(verified.trim()).toBe("modified by supergit");

    // Cleanup via SFTP unlink
    await new Promise<void>((resolve) => {
      sftp.unlink(remotePath, () => resolve());
    });
  });

  test("cleanup", async () => {
    pool.disconnectAll();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
