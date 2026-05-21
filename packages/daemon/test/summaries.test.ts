import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SummariesStore, keyForSource } from "../src/summaries";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-summaries-"));
}

describe("keyForSource", () => {
  test("returns a stable 16-hex-char key across calls", () => {
    const k1 = keyForSource("/Users/me/.claude/projects/a/session-1.jsonl");
    const k2 = keyForSource("/Users/me/.claude/projects/a/session-1.jsonl");
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{16}$/);
  });

  test("different paths produce different keys", () => {
    const k1 = keyForSource("/a/session-1.jsonl");
    const k2 = keyForSource("/a/session-2.jsonl");
    expect(k1).not.toBe(k2);
  });

  test("case-insensitive on Windows-style paths (drive letter casing)", () => {
    // Windows filesystems are case-insensitive; the same session
    // referenced via "C:\…" and "c:\…" must hash to the same key
    // so a cached summary survives drive-letter casing drift.
    const k1 = keyForSource("C:\\git\\supergit\\workspaces\\default\\session.jsonl");
    const k2 = keyForSource("c:\\git\\supergit\\workspaces\\default\\session.jsonl");
    expect(k1).toBe(k2);
  });
});

describe("SummariesStore", () => {
  test("creates the summaries/ directory on open and is idempotent", async () => {
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    expect(store.dir).toBe(join(ws, "summaries"));
    const entries = await readdir(store.dir);
    expect(entries).toEqual([]);
    // Opening twice must not throw.
    const again = await SummariesStore.open(ws);
    expect(again.dir).toBe(join(ws, "summaries"));
  });

  test("write → read round-trip preserves frontmatter and body", async () => {
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    const source = "/x/session.jsonl";
    await store.write(source, {
      agent: "claude",
      sessionId: "abc-123",
      model: "llama3.2:3b",
      sourceMtimeMs: 1747841234567,
      generatedAt: "2026-05-21T13:42:11.000Z",
      includedMessages: 28,
      totalMessages: 412,
      truncatedMessages: 3,
      estimatedTokens: 1840,
      elapsedMs: 4231,
      body: "The user worked on **summary** of the session.\n\nA second paragraph.",
    });
    const got = await store.read(source);
    expect(got).not.toBeNull();
    expect(got!.frontmatter.agent).toBe("claude");
    expect(got!.frontmatter.sessionId).toBe("abc-123");
    expect(got!.frontmatter.model).toBe("llama3.2:3b");
    expect(got!.frontmatter.sourceMtimeMs).toBe(1747841234567);
    expect(got!.frontmatter.includedMessages).toBe(28);
    expect(got!.frontmatter.totalMessages).toBe(412);
    expect(got!.body).toBe(
      "The user worked on **summary** of the session.\n\nA second paragraph.",
    );
  });

  test("read returns null when no summary has been written", async () => {
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    expect(await store.read("/never/written.jsonl")).toBeNull();
  });

  test("write replaces a prior summary for the same source", async () => {
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    const source = "/x/session.jsonl";
    await store.write(source, {
      agent: "claude",
      model: "llama3.2:3b",
      sourceMtimeMs: 1,
      generatedAt: "2026-05-21T00:00:00.000Z",
      includedMessages: 10,
      totalMessages: 10,
      truncatedMessages: 0,
      estimatedTokens: 100,
      elapsedMs: 1000,
      body: "first",
    });
    await store.write(source, {
      agent: "claude",
      model: "llama3.2:3b",
      sourceMtimeMs: 2,
      generatedAt: "2026-05-21T00:01:00.000Z",
      includedMessages: 11,
      totalMessages: 11,
      truncatedMessages: 0,
      estimatedTokens: 110,
      elapsedMs: 1100,
      body: "second",
    });
    const got = await store.read(source);
    expect(got!.body).toBe("second");
    expect(got!.frontmatter.sourceMtimeMs).toBe(2);
    // Only one file on disk for one source.
    const files = (await readdir(store.dir)).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
  });

  test("delete removes the summary file and is idempotent", async () => {
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    const source = "/x/session.jsonl";
    await store.write(source, {
      agent: "claude",
      model: "llama3.2:3b",
      sourceMtimeMs: 1,
      generatedAt: "2026-05-21T00:00:00.000Z",
      includedMessages: 1,
      totalMessages: 1,
      truncatedMessages: 0,
      estimatedTokens: 10,
      elapsedMs: 100,
      body: "x",
    });
    expect(await store.delete(source)).toBe(true);
    expect(await store.read(source)).toBeNull();
    // Second delete returns false but doesn't throw.
    expect(await store.delete(source)).toBe(false);
  });

  test("body is preserved verbatim even when it contains a `---` separator", async () => {
    // A summary that happens to include a horizontal rule must not
    // confuse the frontmatter parser.
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    const source = "/x/session.jsonl";
    const body = "First section\n\n---\n\nSecond section after a rule";
    await store.write(source, {
      agent: "codex",
      model: "llama3.2:3b",
      sourceMtimeMs: 1,
      generatedAt: "2026-05-21T00:00:00.000Z",
      includedMessages: 5,
      totalMessages: 5,
      truncatedMessages: 0,
      estimatedTokens: 50,
      elapsedMs: 200,
      body,
    });
    const got = await store.read(source);
    expect(got!.body).toBe(body);
  });

  test("garbage frontmatter on disk → read returns null (treated as missing)", async () => {
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    const key = keyForSource("/x/session.jsonl");
    await writeFile(join(store.dir, `${key}.md`), "this is not yaml\nno frontmatter at all\n");
    expect(await store.read("/x/session.jsonl")).toBeNull();
  });

  test("staleness: equal mtime → not stale, newer source mtime → stale", async () => {
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    const f = await SummariesStore.open(ws); // separate handle, same dir
    expect(f.dir).toBe(store.dir);

    // Fake source file we can stat for mtime.
    const sourcePath = join(ws, "session.jsonl");
    await writeFile(sourcePath, "{}\n");
    const mtimeMs = (await stat(sourcePath)).mtimeMs;

    await store.write(sourcePath, {
      agent: "claude",
      model: "llama3.2:3b",
      sourceMtimeMs: mtimeMs,
      generatedAt: "2026-05-21T00:00:00.000Z",
      includedMessages: 1,
      totalMessages: 1,
      truncatedMessages: 0,
      estimatedTokens: 10,
      elapsedMs: 100,
      body: "x",
    });

    const fresh = await store.staleness(sourcePath);
    expect(fresh.stale).toBe(false);
    expect(fresh.summary).not.toBeNull();

    // Bump the source mtime by rewriting it.
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(sourcePath, "{}\n{}\n");
    const stale = await store.staleness(sourcePath);
    expect(stale.stale).toBe(true);
    expect(stale.summary).not.toBeNull();
  });

  test("staleness: source missing → returns the summary with stale=true", async () => {
    // The session file got deleted but we still have the cached
    // summary. Surface it but mark it stale so the UI can warn.
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    const source = "/does/not/exist.jsonl";
    await store.write(source, {
      agent: "claude",
      model: "llama3.2:3b",
      sourceMtimeMs: 1,
      generatedAt: "2026-05-21T00:00:00.000Z",
      includedMessages: 1,
      totalMessages: 1,
      truncatedMessages: 0,
      estimatedTokens: 10,
      elapsedMs: 100,
      body: "x",
    });
    const out = await store.staleness(source);
    expect(out.summary).not.toBeNull();
    expect(out.stale).toBe(true);
  });

  test("staleness: no summary on disk → both null", async () => {
    const ws = await tempWorkspace();
    const store = await SummariesStore.open(ws);
    const out = await store.staleness("/never/written.jsonl");
    expect(out.summary).toBeNull();
    expect(out.stale).toBe(false);
  });
});
