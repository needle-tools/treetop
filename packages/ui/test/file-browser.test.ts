import { test, expect, describe } from "bun:test";
import {
  OpenSessionsStore,
  filterToExistingSessions,
  type KVStore,
  type PersistedSession,
} from "../src/storage";
import { joinPath, formatSize, formatMtime, NavHistory, resolveTermIdFromSource, parseRemoteSource, StarStore, breadcrumbs, normalizePath, computeStarredList } from "../src/file-browser-utils";

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

  test("windows backslash path uses backslash separator", () => {
    expect(joinPath("C:\\git\\needle-cloud", "src")).toBe("C:\\git\\needle-cloud\\src");
  });

  test("windows path with trailing backslash", () => {
    expect(joinPath("C:\\git\\", "src")).toBe("C:\\git\\src");
  });

  test("windows drive root", () => {
    expect(joinPath("C:\\", "Users")).toBe("C:\\Users");
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

describe("NavHistory", () => {
  test("starts at initial path with no back/forward", () => {
    const h = new NavHistory("/repo");
    expect(h.current).toBe("/repo");
    expect(h.canGoBack()).toBe(false);
    expect(h.canGoForward()).toBe(false);
  });

  test("push adds to history and enables back", () => {
    const h = new NavHistory("/repo");
    h.push("/repo/src");
    expect(h.current).toBe("/repo/src");
    expect(h.canGoBack()).toBe(true);
    expect(h.canGoForward()).toBe(false);
  });

  test("back returns to previous path", () => {
    const h = new NavHistory("/repo");
    h.push("/repo/src");
    h.push("/repo/src/lib");
    const prev = h.goBack();
    expect(prev).toBe("/repo/src");
    expect(h.current).toBe("/repo/src");
    expect(h.canGoBack()).toBe(true);
    expect(h.canGoForward()).toBe(true);
  });

  test("forward returns to next path", () => {
    const h = new NavHistory("/repo");
    h.push("/repo/src");
    h.goBack();
    const next = h.goForward();
    expect(next).toBe("/repo/src");
    expect(h.current).toBe("/repo/src");
    expect(h.canGoForward()).toBe(false);
  });

  test("push after back clears forward stack", () => {
    const h = new NavHistory("/repo");
    h.push("/repo/src");
    h.push("/repo/docs");
    h.goBack();
    h.push("/repo/test");
    expect(h.current).toBe("/repo/test");
    expect(h.canGoForward()).toBe(false);
    expect(h.canGoBack()).toBe(true);
    // back should go to /repo/src, not /repo/docs
    expect(h.goBack()).toBe("/repo/src");
  });

  test("back at start returns null", () => {
    const h = new NavHistory("/repo");
    expect(h.goBack()).toBeNull();
    expect(h.current).toBe("/repo");
  });

  test("forward at end returns null", () => {
    const h = new NavHistory("/repo");
    h.push("/repo/src");
    expect(h.goForward()).toBeNull();
  });

  test("multiple back/forward round-trips", () => {
    const h = new NavHistory("/a");
    h.push("/b");
    h.push("/c");
    h.push("/d");
    expect(h.goBack()).toBe("/c");
    expect(h.goBack()).toBe("/b");
    expect(h.goForward()).toBe("/c");
    expect(h.goForward()).toBe("/d");
    expect(h.goForward()).toBeNull();
    expect(h.current).toBe("/d");
  });

  test("push same path as current is a no-op", () => {
    const h = new NavHistory("/repo");
    h.push("/repo");
    expect(h.canGoBack()).toBe(false);
  });

  test("serialize and restore round-trips", () => {
    const h = new NavHistory("/repo");
    h.push("/repo/src");
    h.push("/repo/src/lib");
    h.goBack();
    const data = h.serialize();
    const h2 = NavHistory.fromSerialized(data);
    expect(h2.current).toBe("/repo/src");
    expect(h2.canGoBack()).toBe(true);
    expect(h2.canGoForward()).toBe(true);
    expect(h2.goBack()).toBe("/repo");
    expect(h2.goForward()).toBe("/repo/src");
    expect(h2.goForward()).toBe("/repo/src/lib");
  });

  test("fromSerialized with garbage returns fallback", () => {
    const h = NavHistory.fromSerialized(null as any);
    expect(h.current).toBe("/");
    expect(h.canGoBack()).toBe(false);
  });
});

describe("resolveTermIdFromSource", () => {
  test("resolves from __attached__:shell:<termId>", () => {
    expect(resolveTermIdFromSource("__attached__:shell:t_abc123", {}))
      .toBe("t_abc123");
  });

  test("resolves from newTermIds map for __new__ sources", () => {
    const newTermIds = { "__new__:shell:xyz": "t_real_id" };
    expect(resolveTermIdFromSource("__new__:shell:xyz", newTermIds))
      .toBe("t_real_id");
  });

  test("newTermIds takes precedence over source parsing", () => {
    const newTermIds = { "__attached__:shell:t_old": "t_override" };
    expect(resolveTermIdFromSource("__attached__:shell:t_old", newTermIds))
      .toBe("t_override");
  });

  test("returns undefined for unknown source with no newTermIds entry", () => {
    expect(resolveTermIdFromSource("__new__:shell:unknown", {}))
      .toBeUndefined();
  });

  test("returns undefined for unrelated source", () => {
    expect(resolveTermIdFromSource("some/session/path.jsonl", {}))
      .toBeUndefined();
  });
});

describe("parseRemoteSource", () => {
  test("extracts termId from __remote__:<termId>:<uniqueId>", () => {
    expect(parseRemoteSource("__remote__:t_abc123:rb_xyz"))
      .toBe("t_abc123");
  });

  test("returns undefined for non-remote source", () => {
    expect(parseRemoteSource("__files__:fb_123")).toBeUndefined();
    expect(parseRemoteSource("__attached__:shell:t_123")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(parseRemoteSource("")).toBeUndefined();
  });
});

describe("breadcrumbs", () => {
  test("unix root has no crumbs", () => {
    expect(breadcrumbs("/")).toEqual([]);
  });

  test("unix path emits each segment", () => {
    expect(breadcrumbs("/Users/me/repo")).toEqual([
      { name: "Users", path: "/Users" },
      { name: "me", path: "/Users/me" },
      { name: "repo", path: "/Users/me/repo" },
    ]);
  });

  test("trailing slash on unix is ignored", () => {
    expect(breadcrumbs("/Users/me/")).toEqual([
      { name: "Users", path: "/Users" },
      { name: "me", path: "/Users/me" },
    ]);
  });

  test("windows path with backslashes preserves drive root", () => {
    expect(breadcrumbs("C:\\git\\needle-cloud")).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "git", path: "C:\\git" },
      { name: "needle-cloud", path: "C:\\git\\needle-cloud" },
    ]);
  });

  test("windows path with forward slashes preserves drive root", () => {
    expect(breadcrumbs("C:/git/needle-cloud")).toEqual([
      { name: "C:", path: "C:/" },
      { name: "git", path: "C:/git" },
      { name: "needle-cloud", path: "C:/git/needle-cloud" },
    ]);
  });

  test("windows drive root alone", () => {
    expect(breadcrumbs("C:\\")).toEqual([
      { name: "C:", path: "C:\\" },
    ]);
  });

  test("lowercase drive letter still detected", () => {
    expect(breadcrumbs("d:\\Projects")).toEqual([
      { name: "d:", path: "d:\\" },
      { name: "Projects", path: "d:\\Projects" },
    ]);
  });
});

describe("computeStarredList", () => {
  test("returns items inside wtPath with relative path", () => {
    const stars = new Set(["C:\\git\\repo\\src\\foo.ts"]);
    const list = computeStarredList(stars, "C:\\git\\repo");
    expect(list).toEqual([
      { fullPath: "C:\\git\\repo\\src\\foo.ts", rel: "src\\foo.ts", inWt: true },
    ]);
  });

  test("includes items in PARENT directory of wtPath (not filtered out)", () => {
    // worktree is C:\git\repo\sub; star is one level up in C:\git\repo
    const stars = new Set(["C:\\git\\repo\\package.json"]);
    const list = computeStarredList(stars, "C:\\git\\repo\\sub");
    expect(list.length).toBe(1);
    expect(list[0]!.fullPath).toBe("C:\\git\\repo\\package.json");
    expect(list[0]!.inWt).toBe(false);
  });

  test("includes items in the repo root above wtPath", () => {
    // User has worktree at C:\git\repo\src, stars C:\git\repo\package.json
    const stars = new Set(["C:\\git\\repo\\package.json"]);
    const list = computeStarredList(stars, "C:\\git\\repo\\src");
    expect(list.length).toBe(1);
    expect(list[0]!.fullPath).toBe("C:\\git\\repo\\package.json");
    expect(list[0]!.inWt).toBe(false);
  });

  test("items outside wtPath get full path as rel (no relativization)", () => {
    const stars = new Set(["C:\\git\\other-repo\\file.ts"]);
    const list = computeStarredList(stars, "C:\\git\\repo");
    expect(list[0]!.rel).toBe("C:\\git\\other-repo\\file.ts");
  });

  test("normalizes mixed-separator inputs", () => {
    const stars = new Set(["C:/git/repo/src/foo.ts"]);
    const list = computeStarredList(stars, "C:\\git\\repo");
    expect(list[0]!.fullPath).toBe("C:\\git\\repo\\src\\foo.ts");
    expect(list[0]!.rel).toBe("src\\foo.ts");
    expect(list[0]!.inWt).toBe(true);
  });

  test("sorts in-wt items first, then by path", () => {
    const stars = new Set([
      "C:\\git\\other\\zfile.md",
      "C:\\git\\repo\\zfile.md",
      "C:\\git\\repo\\afile.md",
    ]);
    const list = computeStarredList(stars, "C:\\git\\repo");
    expect(list.map((e) => e.fullPath)).toEqual([
      "C:\\git\\repo\\afile.md",
      "C:\\git\\repo\\zfile.md",
      "C:\\git\\other\\zfile.md",
    ]);
  });

  test("unix paths work too", () => {
    const stars = new Set(["/Users/me/repo/src/foo.ts", "/Users/me/other/bar.ts"]);
    const list = computeStarredList(stars, "/Users/me/repo");
    expect(list).toEqual([
      { fullPath: "/Users/me/repo/src/foo.ts", rel: "src/foo.ts", inWt: true },
      { fullPath: "/Users/me/other/bar.ts", rel: "/Users/me/other/bar.ts", inWt: false },
    ]);
  });

  test("empty star set returns empty list", () => {
    expect(computeStarredList(new Set(), "C:\\repo")).toEqual([]);
  });

  test("prefix-but-not-subpath is treated as outside (avoid string prefix bug)", () => {
    // C:\git\repository starts with C:\git\repo but isn't inside it.
    const stars = new Set(["C:\\git\\repository\\foo.ts"]);
    const list = computeStarredList(stars, "C:\\git\\repo");
    expect(list[0]!.inWt).toBe(false);
    expect(list[0]!.rel).toBe("C:\\git\\repository\\foo.ts");
  });
});

describe("normalizePath", () => {
  test("unix path unchanged", () => {
    expect(normalizePath("/Users/me/repo/src/foo.ts")).toBe("/Users/me/repo/src/foo.ts");
  });

  test("windows path with mixed separators uses backslash", () => {
    expect(normalizePath("C:\\git\\repo/docs\\foo.md")).toBe("C:\\git\\repo\\docs\\foo.md");
  });

  test("windows path with forward slashes converts to backslash", () => {
    expect(normalizePath("C:/git/repo/foo.md")).toBe("C:\\git\\repo\\foo.md");
  });

  test("path without separators unchanged", () => {
    expect(normalizePath("foo.md")).toBe("foo.md");
  });

  test("identifies windows by leading drive letter", () => {
    expect(normalizePath("D:/foo")).toBe("D:\\foo");
  });
});

describe("StarStore", () => {
  const KEY = "supergit:fileBrowser:stars";

  test("starts empty", () => {
    const s = new StarStore(new MemStore(), KEY);
    expect(s.load().size).toBe(0);
  });

  test("save and load round-trips paths", () => {
    const m = new MemStore();
    const s = new StarStore(m, KEY);
    s.save(new Set(["/a", "/b/c", "/d e"]));
    expect([...s.load()].sort()).toEqual(["/a", "/b/c", "/d e"]);
  });

  test("toggle adds when absent, removes when present", () => {
    const m = new MemStore();
    const s = new StarStore(m, KEY);
    let set = s.toggle(new Set(), "/foo");
    expect(set.has("/foo")).toBe(true);
    set = s.toggle(set, "/foo");
    expect(set.has("/foo")).toBe(false);
  });

  test("toggle leaves other entries alone", () => {
    const m = new MemStore();
    const s = new StarStore(m, KEY);
    const set = s.toggle(new Set(["/x", "/y"]), "/z");
    expect([...set].sort()).toEqual(["/x", "/y", "/z"]);
  });

  test("corrupt storage returns empty set", () => {
    const m = new MemStore();
    m.setItem(KEY, "{{{not json");
    const s = new StarStore(m, KEY);
    expect(s.load().size).toBe(0);
  });

  test("non-array stored data returns empty set", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify({ foo: "bar" }));
    const s = new StarStore(m, KEY);
    expect(s.load().size).toBe(0);
  });

  test("filters out non-string entries", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify(["/a", 42, null, "/b"]));
    const s = new StarStore(m, KEY);
    expect([...s.load()].sort()).toEqual(["/a", "/b"]);
  });

  test("toggle normalizes windows path separators (no duplicates)", () => {
    const m = new MemStore();
    const s = new StarStore(m, KEY);
    let set = s.toggle(new Set(), "C:\\git\\repo\\foo.md");
    set = s.toggle(set, "C:/git/repo/foo.md");
    // Both paths are the same file — toggling the second time should
    // REMOVE the entry, not add a duplicate.
    expect(set.size).toBe(0);
  });

  test("load normalizes legacy mixed-separator entries", () => {
    const m = new MemStore();
    m.setItem(KEY, JSON.stringify([
      "C:\\git\\repo\\foo.md",
      "C:/git/repo/foo.md",
      "C:\\git\\repo\\bar.md",
    ]));
    const s = new StarStore(m, KEY);
    expect([...s.load()].sort()).toEqual([
      "C:\\git\\repo\\bar.md",
      "C:\\git\\repo\\foo.md",
    ]);
  });
});
