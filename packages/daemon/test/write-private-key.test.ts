import { test, expect, describe } from "bun:test";
import {
  writePrivateKey,
  buildIcaclsArgs,
} from "../src/write-private-key";

/**
 * Writing the stored tunnel key with permissions OpenSSH accepts. The
 * Windows path is the one that bit us live: mode 0600 is ignored there, so
 * the daemon must icacls-lock the key or ssh rejects it ("bad
 * permissions"). All I/O (write + icacls) is injected so this runs on any
 * platform without a real filesystem.
 */

function recorder() {
  const writes: Array<{ path: string; data: string; mode: number }> = [];
  const acls: Array<{ exe: string; args: string[] }> = [];
  return {
    writes,
    acls,
    write: async (path: string, data: string, mode: number) => {
      writes.push({ path, data, mode });
    },
    runAcl: async (exe: string, args: string[]) => {
      acls.push({ exe, args });
      return 0;
    },
  };
}

describe("buildIcaclsArgs", () => {
  test("strips inheritance and grants only the user read", () => {
    expect(buildIcaclsArgs("C:\\k\\key", "marcel")).toEqual([
      "C:\\k\\key",
      "/inheritance:r",
      "/grant:r",
      "marcel:R",
    ]);
  });
});

describe("writePrivateKey — POSIX", () => {
  test("writes mode 0600 and does NOT run icacls", async () => {
    const r = recorder();
    await writePrivateKey("/ws/keys/abc", "KEYDATA", {
      platform: "linux",
      write: r.write,
      runAcl: r.runAcl,
    });
    expect(r.writes).toHaveLength(1);
    expect(r.writes[0]!.mode).toBe(0o600);
    expect(r.acls).toHaveLength(0);
  });

  test("appends a trailing newline when missing", async () => {
    const r = recorder();
    await writePrivateKey("/k", "no-newline", {
      platform: "linux",
      write: r.write,
      runAcl: r.runAcl,
    });
    expect(r.writes[0]!.data).toBe("no-newline\n");
  });

  test("doesn't double a newline that's already there", async () => {
    const r = recorder();
    await writePrivateKey("/k", "has-newline\n", {
      platform: "linux",
      write: r.write,
      runAcl: r.runAcl,
    });
    expect(r.writes[0]!.data).toBe("has-newline\n");
  });
});

describe("writePrivateKey — Windows", () => {
  test("writes the file AND locks the ACL to the current user", async () => {
    const r = recorder();
    await writePrivateKey("C:\\ws\\keys\\abc", "KEYDATA", {
      platform: "win32",
      username: "marcel",
      write: r.write,
      runAcl: r.runAcl,
    });
    expect(r.writes).toHaveLength(1);
    expect(r.acls).toHaveLength(1);
    expect(r.acls[0]!.exe).toBe("icacls");
    expect(r.acls[0]!.args).toEqual([
      "C:\\ws\\keys\\abc",
      "/inheritance:r",
      "/grant:r",
      "marcel:R",
    ]);
  });

  test("throws when icacls fails (a key ssh would reject is worse than a clear error)", async () => {
    await expect(
      writePrivateKey("C:\\k", "KEYDATA", {
        platform: "win32",
        username: "marcel",
        write: async () => {},
        runAcl: async () => 1, // icacls failure
      }),
    ).rejects.toThrow(/lock down key permissions/);
  });

  test("throws when there is no username to grant to", async () => {
    await expect(
      writePrivateKey("C:\\k", "KEYDATA", {
        platform: "win32",
        username: "",
        write: async () => {},
        runAcl: async () => 0,
      }),
    ).rejects.toThrow(/USERNAME/);
  });
});
