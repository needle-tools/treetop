import { test, expect, describe } from "bun:test";
import {
  OpenSessionsStore,
  filterToExistingSessions,
  type KVStore,
  type PersistedSession,
} from "../src/storage";
import { joinPath, formatSize, formatMtime } from "../src/file-browser-utils";

class MemStore implements KVStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

describe("joinPath", () => {
  test("joins without double slash", () => {
    expect(joinPath("/Users/test", "src")).toBe("/Users/test/src");
  });

  test("handles trailing slash on base", () => {
    expect(joinPath("/Users/test/", "src")).toBe("/Users/test/src");
  });

  test("handles root path", () => {
    expect(joinPath("/", "Users")).toBe("/Users");
  });

  test("handles nested joins", () => {
    const first = joinPath("/repo", "packages");
    const second = joinPath(first, "ui");
    expect(second).toBe("/repo/packages/ui");
  });
});

describe("formatSize", () => {
  test("returns empty string for undefined", () => {
    expect(formatSize(undefined)).toBe("");
  });

  test("formats zero bytes", () => {
    expect(formatSize(0)).toBe("0 B");
  });

  test("formats bytes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  test("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
  });

  test("formats megabytes", () => {
    expect(formatSize(1048576)).toBe("1.0 MB");
    expect(formatSize(5 * 1048576)).toBe("5.0 MB");
  });

  test("formats gigabytes", () => {
    expect(formatSize(1073741824)).toBe("1.0 GB");
  });
});

describe("formatMtime", () => {
  test("returns empty string for undefined", () => {
    expect(formatMtime(undefined)).toBe("");
  });

  test("returns 'just now' for recent timestamps", () => {
    const now = new Date().toISOString();
    expect(formatMtime(now)).toBe("just now");
  });

  test("returns minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatMtime(fiveMinAgo)).toBe("5m ago");
  });

  test("returns hours ago", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(formatMtime(threeHoursAgo)).toBe("3h ago");
  });

  test("returns days ago", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(formatMtime(twoDaysAgo)).toBe("2d ago");
  });
});

describe("files agent persistence", () => {
  test("OpenSessionsStore round-trips files sessions", () => {
    const m = new MemStore();
    const store = new OpenSessionsStore(m, "supergit:openSessions");
    const data: Record<string, PersistedSession[]> = {
      "/repo/wt": [
        { agent: "files", source: "__files__:fb_abc123" },
        { agent: "claude", source: "/path/to/session.jsonl" },
      ],
    };
    store.save(data);
    const loaded = store.load();
    expect(loaded["/repo/wt"]).toHaveLength(2);
    expect(loaded["/repo/wt"]![0]!.agent).toBe("files");
    expect(loaded["/repo/wt"]![0]!.source).toBe("__files__:fb_abc123");
  });

  test("filterToExistingSessions keeps __files__: sources", () => {
    const sessions: PersistedSession[] = [
      { agent: "files", source: "__files__:fb_abc" },
      { agent: "claude", source: "/does/not/exist.jsonl" },
    ];
    const existing = new Set<string>();
    const filtered = filterToExistingSessions(sessions, existing);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.source).toBe("__files__:fb_abc");
  });

  test("files sessions survive de-duplication", () => {
    const m = new MemStore();
    const store = new OpenSessionsStore(m, "supergit:openSessions");
    store.save({
      "/wt": [
        { agent: "files", source: "__files__:fb_1" },
        { agent: "files", source: "__files__:fb_1" },
        { agent: "files", source: "__files__:fb_2" },
      ],
    });
    const loaded = store.load();
    expect(loaded["/wt"]).toHaveLength(2);
    expect(loaded["/wt"]!.map((s) => s.source)).toEqual([
      "__files__:fb_1",
      "__files__:fb_2",
    ]);
  });

  test("multiple file browsers can coexist in one worktree", () => {
    const m = new MemStore();
    const store = new OpenSessionsStore(m, "supergit:openSessions");
    store.save({
      "/wt": [
        { agent: "files", source: "__files__:fb_1" },
        { agent: "claude", source: "/session.jsonl" },
        { agent: "files", source: "__files__:fb_2" },
      ],
    });
    const loaded = store.load();
    expect(loaded["/wt"]).toHaveLength(3);
    const filesBrowsers = loaded["/wt"]!.filter((s) => s.agent === "files");
    expect(filesBrowsers).toHaveLength(2);
  });
});

describe("file browser KV state", () => {
  test("state round-trips through KV", () => {
    const m = new MemStore();
    const key = "supergit:fileBrowser:state";
    const state = {
      "__files__:fb_test": {
        currentDir: "/Users/test/repo/src",
        dirHistory: ["/Users/test/repo"],
        expanded: ["/Users/test/repo/src/lib"],
      },
    };
    m.setItem(key, JSON.stringify(state));
    const raw = m.getItem(key);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed["__files__:fb_test"].currentDir).toBe("/Users/test/repo/src");
    expect(parsed["__files__:fb_test"].dirHistory).toEqual(["/Users/test/repo"]);
    expect(parsed["__files__:fb_test"].expanded).toEqual(["/Users/test/repo/src/lib"]);
  });

  test("multiple file browser states are independent", () => {
    const m = new MemStore();
    const key = "supergit:fileBrowser:state";
    const state = {
      "__files__:fb_1": { currentDir: "/repo/src", dirHistory: ["/repo"], expanded: [] },
      "__files__:fb_2": { currentDir: "/repo/docs", dirHistory: ["/repo"], expanded: [] },
    };
    m.setItem(key, JSON.stringify(state));
    const parsed = JSON.parse(m.getItem(key)!);
    expect(parsed["__files__:fb_1"].currentDir).toBe("/repo/src");
    expect(parsed["__files__:fb_2"].currentDir).toBe("/repo/docs");
  });

  test("corrupt KV data doesn't crash", () => {
    const m = new MemStore();
    const key = "supergit:fileBrowser:state";
    m.setItem(key, "not valid json{{{");
    const raw = m.getItem(key);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw!);
    } catch {
      parsed = null;
    }
    expect(parsed).toBeNull();
  });
});
