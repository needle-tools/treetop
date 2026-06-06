import { test, expect, describe } from "bun:test";
import { listDrives } from "../src/drives";

/**
 * Enumerating filesystem roots for the picker's "This PC" view. Pure — the
 * existence check + platform are injected, so the Windows drive-letter probe
 * is tested without a real Windows disk.
 */

describe("listDrives", () => {
  test("posix: a single root", () => {
    expect(listDrives({ platform: "linux", exists: () => true })).toEqual(["/"]);
    expect(listDrives({ platform: "darwin", exists: () => true })).toEqual([
      "/",
    ]);
  });

  test("windows: only the drive letters that exist", () => {
    const present = new Set(["C:\\", "D:\\"]);
    expect(
      listDrives({ platform: "win32", exists: (p) => present.has(p) }),
    ).toEqual(["C:\\", "D:\\"]);
  });

  test("windows: probes A-Z (system drive isn't always C:)", () => {
    const present = new Set(["E:\\"]); // system on E:, no C:
    expect(
      listDrives({ platform: "win32", exists: (p) => present.has(p) }),
    ).toEqual(["E:\\"]);
  });

  test("windows: degenerate fallback to C:\\ when probing finds nothing", () => {
    expect(listDrives({ platform: "win32", exists: () => false })).toEqual([
      "C:\\",
    ]);
  });
});
