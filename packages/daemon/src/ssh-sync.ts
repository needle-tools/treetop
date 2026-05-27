import { watch, type FSWatcher } from "node:fs";

export type SyncState = "downloading" | "editing" | "modified" | "uploading" | "synced" | "error";

export interface TrackedFile {
  hostKey: string;
  remotePath: string;
  localCachePath: string;
  state: SyncState;
  error?: string;
}

export type UploadFn = (
  hostKey: string,
  remotePath: string,
  localCachePath: string,
) => Promise<void>;

interface TrackedEntry {
  hostKey: string;
  remotePath: string;
  localCachePath: string;
  state: SyncState;
  error?: string;
  watcher: FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export interface SyncTrackerOptions {
  debounceMs?: number;
}

export class SyncTracker {
  private tracked = new Map<string, TrackedEntry>();
  private uploadFn: UploadFn;
  private debounceMs: number;

  constructor(uploadFn: UploadFn, opts?: SyncTrackerOptions) {
    this.uploadFn = uploadFn;
    this.debounceMs = opts?.debounceMs ?? 500;
  }

  startTracking(
    hostKey: string,
    remotePath: string,
    localCachePath: string,
  ): void {
    if (this.tracked.has(localCachePath)) return;

    const watcher = watch(localCachePath, () => {
      this.onFileChange(localCachePath);
    });

    this.tracked.set(localCachePath, {
      hostKey,
      remotePath,
      localCachePath,
      state: "editing",
      watcher,
      debounceTimer: null,
    });
  }

  stopTracking(localCachePath: string): void {
    const entry = this.tracked.get(localCachePath);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.watcher.close();
    this.tracked.delete(localCachePath);
  }

  getTracked(hostKey?: string): TrackedFile[] {
    const out: TrackedFile[] = [];
    for (const entry of this.tracked.values()) {
      if (hostKey && entry.hostKey !== hostKey) continue;
      out.push({
        hostKey: entry.hostKey,
        remotePath: entry.remotePath,
        localCachePath: entry.localCachePath,
        state: entry.state,
        error: entry.error,
      });
    }
    return out;
  }

  /** Confirm upload for a file in "modified" state. */
  async confirmUpload(localCachePath: string): Promise<void> {
    const entry = this.tracked.get(localCachePath);
    if (!entry || entry.state !== "modified") return;
    await this.doUpload(entry);
  }

  /** Dismiss a "modified" notification — go back to editing without uploading. */
  dismissModified(localCachePath: string): void {
    const entry = this.tracked.get(localCachePath);
    if (!entry || entry.state !== "modified") return;
    entry.state = "editing";
  }

  dispose(): void {
    for (const [path] of this.tracked) {
      this.stopTracking(path);
    }
  }

  private onFileChange(localCachePath: string): void {
    const entry = this.tracked.get(localCachePath);
    if (!entry) return;

    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      entry.state = "modified";
    }, this.debounceMs);
  }

  private async doUpload(entry: TrackedEntry): Promise<void> {
    entry.state = "uploading";
    entry.error = undefined;

    try {
      await this.uploadFn(entry.hostKey, entry.remotePath, entry.localCachePath);
      entry.state = "editing";
    } catch (err: unknown) {
      entry.state = "error";
      entry.error = err instanceof Error ? err.message : String(err);
    }
  }
}
