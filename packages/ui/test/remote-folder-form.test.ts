import { describe, it, expect } from "bun:test";
import {
  emptyRemoteFolderForm,
  validateRemoteFolderForm,
} from "../src/remote-folder-form";

/**
 * Validation for the "add a folder on a remote daemon" dialog (#3). The
 * daemon re-validates the path against ITS filesystem (the box) and returns
 * a 409 on a bad path, so this is UX, not the trust boundary — it just keeps
 * the user from submitting an obviously-empty form or a stale daemon id.
 */

describe("validateRemoteFolderForm", () => {
  const available = ["d1", "d2"];

  it("accepts a daemon + path and returns a trimmed payload", () => {
    const r = validateRemoteFolderForm(
      { daemonId: "d1", path: "  /home/supergit/app  " },
      available,
    );
    expect(r.errors).toEqual({});
    expect(r.payload).toEqual({ daemonId: "d1", path: "/home/supergit/app" });
  });

  it("flags an empty path", () => {
    const r = validateRemoteFolderForm({ daemonId: "d1", path: "   " }, available);
    expect(r.payload).toBeUndefined();
    expect(r.errors.path).toBeTruthy();
  });

  it("flags a missing daemon", () => {
    const r = validateRemoteFolderForm({ daemonId: "", path: "/x" }, available);
    expect(r.payload).toBeUndefined();
    expect(r.errors.daemonId).toBeTruthy();
  });

  it("flags a daemon that is not in the available set (stale/removed)", () => {
    const r = validateRemoteFolderForm(
      { daemonId: "gone", path: "/x" },
      available,
    );
    expect(r.payload).toBeUndefined();
    expect(r.errors.daemonId).toBeTruthy();
  });

  it("reports both errors at once", () => {
    const r = validateRemoteFolderForm({ daemonId: "", path: "" }, available);
    expect(r.errors.daemonId).toBeTruthy();
    expect(r.errors.path).toBeTruthy();
  });

  it("trims the daemon id before checking membership", () => {
    const r = validateRemoteFolderForm(
      { daemonId: "  d2  ", path: "/srv/repo" },
      available,
    );
    expect(r.errors).toEqual({});
    expect(r.payload).toEqual({ daemonId: "d2", path: "/srv/repo" });
  });

  it("preserves a Windows-style remote path verbatim (daemon may be on Windows)", () => {
    const r = validateRemoteFolderForm(
      { daemonId: "d1", path: "C:\\Users\\me\\repo" },
      available,
    );
    expect(r.payload?.path).toBe("C:\\Users\\me\\repo");
  });

  it("emptyRemoteFolderForm seeds the daemon id and a blank path", () => {
    expect(emptyRemoteFolderForm("d2")).toEqual({ daemonId: "d2", path: "" });
    expect(emptyRemoteFolderForm()).toEqual({ daemonId: "", path: "" });
  });
});
