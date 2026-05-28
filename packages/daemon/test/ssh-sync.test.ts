import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { SyncTracker } from "../src/ssh-sync";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "supergit-ssh-sync-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("SyncTracker", () => {
  test("getTracked returns empty for new tracker", () => {
    const tracker = new SyncTracker(async () => {});
    expect(tracker.getTracked()).toEqual([]);
    tracker.dispose();
  });

  test("startTracking adds file with editing state", async () => {
    const localPath = join(tmpDir, "edit1.txt");
    await writeFile(localPath, "initial content");

    const tracker = new SyncTracker(async () => {});
    tracker.startTracking("user@host:22", "/remote/file.txt", localPath);

    const tracked = tracker.getTracked();
    expect(tracked.length).toBe(1);
    expect(tracked[0]!.state).toBe("editing");
    expect(tracked[0]!.remotePath).toBe("/remote/file.txt");
    expect(tracked[0]!.hostKey).toBe("user@host:22");

    tracker.dispose();
  });

  test("stopTracking removes file", async () => {
    const localPath = join(tmpDir, "edit2.txt");
    await writeFile(localPath, "content");

    const tracker = new SyncTracker(async () => {});
    tracker.startTracking("user@host:22", "/remote/f.txt", localPath);
    expect(tracker.getTracked().length).toBe(1);

    tracker.stopTracking(localPath);
    expect(tracker.getTracked().length).toBe(0);

    tracker.dispose();
  });

  test("getTracked filters by hostKey", async () => {
    const path1 = join(tmpDir, "filter1.txt");
    const path2 = join(tmpDir, "filter2.txt");
    await writeFile(path1, "a");
    await writeFile(path2, "b");

    const tracker = new SyncTracker(async () => {});
    tracker.startTracking("host-a:22", "/a.txt", path1);
    tracker.startTracking("host-b:22", "/b.txt", path2);

    expect(tracker.getTracked("host-a:22").length).toBe(1);
    expect(tracker.getTracked("host-b:22").length).toBe(1);
    expect(tracker.getTracked().length).toBe(2);

    tracker.dispose();
  });

  test("duplicate startTracking for same path is a no-op", async () => {
    const localPath = join(tmpDir, "dup.txt");
    await writeFile(localPath, "content");

    const tracker = new SyncTracker(async () => {});
    tracker.startTracking("user@host:22", "/remote/dup.txt", localPath);
    tracker.startTracking("user@host:22", "/remote/dup.txt", localPath);

    expect(tracker.getTracked().length).toBe(1);

    tracker.dispose();
  });

  test("file change triggers upload callback", async () => {
    const localPath = join(tmpDir, "change-trigger.txt");
    await writeFile(localPath, "initial");

    let uploadCalled = false;
    let uploadedHostKey = "";
    let uploadedRemotePath = "";
    let uploadedLocalPath = "";

    const tracker = new SyncTracker(
      async (hostKey, remotePath, localCachePath) => {
        uploadCalled = true;
        uploadedHostKey = hostKey;
        uploadedRemotePath = remotePath;
        uploadedLocalPath = localCachePath;
      },
      { debounceMs: 100 },
    );

    tracker.startTracking("user@host:22", "/remote/file.txt", localPath);

    // Modify the file
    await writeFile(localPath, "modified content");

    // Wait for debounce — state should be "modified" (not auto-uploaded)
    await new Promise((r) => setTimeout(r, 500));

    expect(uploadCalled).toBe(false);
    const tracked = tracker.getTracked();
    expect(tracked[0]!.state).toBe("modified");

    // Now confirm the upload
    await tracker.confirmUpload(localPath);

    expect(uploadCalled).toBe(true);
    expect(uploadedHostKey).toBe("user@host:22");
    expect(uploadedRemotePath).toBe("/remote/file.txt");
    expect(uploadedLocalPath).toBe(localPath);
    expect(tracker.getTracked()[0]!.state).toBe("editing");

    tracker.dispose();
  });

  test("upload error sets error state", async () => {
    const localPath = join(tmpDir, "err-trigger.txt");
    await writeFile(localPath, "initial");

    const tracker = new SyncTracker(
      async () => {
        throw new Error("upload failed");
      },
      { debounceMs: 100 },
    );

    tracker.startTracking("user@host:22", "/remote/err.txt", localPath);

    // Trigger change → goes to "modified"
    await writeFile(localPath, "changed");
    await new Promise((r) => setTimeout(r, 500));
    expect(tracker.getTracked()[0]!.state).toBe("modified");

    // Confirm upload → should fail and go to "error"
    await tracker.confirmUpload(localPath);

    const tracked = tracker.getTracked();
    expect(tracked[0]!.state).toBe("error");
    expect(tracked[0]!.error).toBe("upload failed");

    tracker.dispose();
  });

  test("dismissModified returns to editing without uploading", async () => {
    const localPath = join(tmpDir, "dismiss-trigger.txt");
    await writeFile(localPath, "initial");

    let uploadCalled = false;
    const tracker = new SyncTracker(
      async () => {
        uploadCalled = true;
      },
      { debounceMs: 100 },
    );

    tracker.startTracking("user@host:22", "/remote/dismiss.txt", localPath);

    // Trigger change → goes to "modified"
    await writeFile(localPath, "changed");
    await new Promise((r) => setTimeout(r, 500));
    expect(tracker.getTracked()[0]!.state).toBe("modified");

    // Dismiss — should go back to "editing" without uploading
    tracker.dismissModified(localPath);
    expect(tracker.getTracked()[0]!.state).toBe("editing");
    expect(uploadCalled).toBe(false);

    tracker.dispose();
  });

  test("dispose clears all watchers", async () => {
    const path1 = join(tmpDir, "dispose1.txt");
    const path2 = join(tmpDir, "dispose2.txt");
    await writeFile(path1, "a");
    await writeFile(path2, "b");

    const tracker = new SyncTracker(async () => {});
    tracker.startTracking("h:22", "/a.txt", path1);
    tracker.startTracking("h:22", "/b.txt", path2);

    tracker.dispose();
    expect(tracker.getTracked().length).toBe(0);
  });
});
