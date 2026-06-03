import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotesStore, parseNoteFile, serializeNoteFile } from "../src/notes";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "supergit-notes-test-"));
}

describe("parseNoteFile", () => {
  test("parses frontmatter with id, anchors, tags and body", () => {
    const raw = [
      "---",
      "id: 2026-05-13-audio-merge",
      "anchors:",
      "  - repo:needle-engine/src/audio/AudioSource.ts:42",
      "  - repo:needle-engine/src/audio/",
      "  - commit:abc123",
      "tags: [followup, xr]",
      "createdAt: 2026-05-13T10:00:00.000Z",
      "updatedAt: 2026-05-13T12:00:00.000Z",
      "---",
      "Body. Standard **markdown** — supergit renders it.",
      "",
      "Second paragraph.",
    ].join("\n");
    const parsed = parseNoteFile(raw);
    expect(parsed.id).toBe("2026-05-13-audio-merge");
    expect(parsed.anchors).toEqual([
      "repo:needle-engine/src/audio/AudioSource.ts:42",
      "repo:needle-engine/src/audio/",
      "commit:abc123",
    ]);
    expect(parsed.tags).toEqual(["followup", "xr"]);
    expect(parsed.createdAt).toBe("2026-05-13T10:00:00.000Z");
    expect(parsed.updatedAt).toBe("2026-05-13T12:00:00.000Z");
    expect(parsed.body).toBe(
      "Body. Standard **markdown** — supergit renders it.\n\nSecond paragraph.",
    );
  });

  test("accepts empty anchors/tags blocks", () => {
    const raw = [
      "---",
      "id: empty",
      "anchors: []",
      "tags: []",
      "---",
      "Body",
    ].join("\n");
    const parsed = parseNoteFile(raw);
    expect(parsed.anchors).toEqual([]);
    expect(parsed.tags).toEqual([]);
    expect(parsed.body).toBe("Body");
  });

  test("treats missing frontmatter as a parse error", () => {
    expect(() => parseNoteFile("no frontmatter here")).toThrow(/frontmatter/);
  });

  test("treats missing id as a parse error", () => {
    expect(() => parseNoteFile("---\nanchors: []\n---\nbody")).toThrow(/id/);
  });

  test("round-trips through serializeNoteFile", () => {
    const raw = serializeNoteFile({
      id: "n1",
      anchors: ["repo:foo/src/a.ts:1", "commit:abc"],
      tags: ["bug"],
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      body: "Hello\n\nWorld",
    });
    const parsed = parseNoteFile(raw);
    expect(parsed.id).toBe("n1");
    expect(parsed.anchors).toEqual(["repo:foo/src/a.ts:1", "commit:abc"]);
    expect(parsed.tags).toEqual(["bug"]);
    expect(parsed.body).toBe("Hello\n\nWorld");
  });
});

describe("NotesStore", () => {
  test("opens an empty notes dir", async () => {
    const store = await NotesStore.open(await tempDir());
    expect(await store.list()).toEqual([]);
  });

  test("create persists a note as <id>.md under notes/", async () => {
    const path = await tempDir();
    const store = await NotesStore.open(path);
    const note = await store.create({
      body: "Hello world",
      anchors: ["repo:foo/src/a.ts:1"],
      tags: ["x"],
    });
    expect(note.id).toMatch(/^[0-9a-z-]+$/);
    expect(note.body).toBe("Hello world");
    expect(note.anchors).toEqual(["repo:foo/src/a.ts:1"]);
    expect(note.tags).toEqual(["x"]);
    expect(Date.parse(note.createdAt)).not.toBeNaN();
    expect(note.createdAt).toBe(note.updatedAt);

    const onDisk = await readdir(join(path, "notes"));
    expect(onDisk).toEqual([`${note.id}.md`]);
    const raw = await readFile(join(path, "notes", `${note.id}.md`), "utf-8");
    expect(raw.startsWith("---\n")).toBe(true);
    expect(raw).toContain(`id: ${note.id}`);
    expect(raw.endsWith("Hello world")).toBe(true);
  });

  test("create honors an explicit id when valid + unique", async () => {
    const store = await NotesStore.open(await tempDir());
    const note = await store.create({
      id: "2026-05-14-my-note",
      body: "x",
    });
    expect(note.id).toBe("2026-05-14-my-note");
  });

  test("create rejects an id with disallowed characters", async () => {
    const store = await NotesStore.open(await tempDir());
    await expect(store.create({ id: "bad/id", body: "x" })).rejects.toThrow(
      /id/,
    );
    await expect(store.create({ id: "bad id", body: "x" })).rejects.toThrow(
      /id/,
    );
    await expect(store.create({ id: "", body: "x" })).rejects.toThrow(/id/);
  });

  test("create rejects a duplicate id", async () => {
    const store = await NotesStore.open(await tempDir());
    await store.create({ id: "dup", body: "a" });
    await expect(store.create({ id: "dup", body: "b" })).rejects.toThrow(
      /exists/,
    );
  });

  test("list returns every note sorted by createdAt desc", async () => {
    const store = await NotesStore.open(await tempDir());
    const a = await store.create({ body: "a" });
    // small wait so createdAt timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ body: "b" });
    const all = await store.list();
    expect(all.map((n) => n.id)).toEqual([b.id, a.id]);
  });

  test("list with anchorPrefix filters notes by anchor", async () => {
    const store = await NotesStore.open(await tempDir());
    await store.create({ body: "x", anchors: ["repo:foo/a.ts:1"] });
    await store.create({ body: "y", anchors: ["repo:bar/b.ts:1"] });
    await store.create({ body: "z", anchors: ["commit:abc123"] });
    const foo = await store.list({ anchorPrefix: "repo:foo/" });
    expect(foo.map((n) => n.body)).toEqual(["x"]);
    const cms = await store.list({ anchorPrefix: "commit:" });
    expect(cms.map((n) => n.body)).toEqual(["z"]);
  });

  test("get returns null for unknown id", async () => {
    const store = await NotesStore.open(await tempDir());
    expect(await store.get("nope")).toBeNull();
  });

  test("update changes body, anchors, tags; bumps updatedAt", async () => {
    const store = await NotesStore.open(await tempDir());
    const note = await store.create({ body: "old", tags: ["a"] });
    await new Promise((r) => setTimeout(r, 5));
    const updated = await store.update(note.id, {
      body: "new",
      anchors: ["repo:foo/x.ts:1"],
      tags: ["b"],
    });
    expect(updated.body).toBe("new");
    expect(updated.anchors).toEqual(["repo:foo/x.ts:1"]);
    expect(updated.tags).toEqual(["b"]);
    expect(updated.createdAt).toBe(note.createdAt);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(
      Date.parse(note.updatedAt),
    );
  });

  test("update with no fields is a no-op (preserves updatedAt)", async () => {
    const store = await NotesStore.open(await tempDir());
    const note = await store.create({ body: "x" });
    const same = await store.update(note.id, {});
    expect(same.updatedAt).toBe(note.updatedAt);
  });

  test("update throws on unknown id", async () => {
    const store = await NotesStore.open(await tempDir());
    await expect(store.update("nope", { body: "x" })).rejects.toThrow(
      /not found/,
    );
  });

  test("remove deletes the file and returns true", async () => {
    const path = await tempDir();
    const store = await NotesStore.open(path);
    const note = await store.create({ body: "x" });
    expect(await store.remove(note.id)).toBe(true);
    expect(await readdir(join(path, "notes"))).toEqual([]);
    expect(await store.get(note.id)).toBeNull();
  });

  test("remove returns false for an unknown id", async () => {
    const store = await NotesStore.open(await tempDir());
    expect(await store.remove("nope")).toBe(false);
  });

  test("ignores non-.md files and unparseable .md files when listing", async () => {
    const path = await tempDir();
    const store = await NotesStore.open(path);
    await store.create({ id: "ok", body: "ok" });
    await writeFile(join(path, "notes", "stray.txt"), "not a note");
    await writeFile(join(path, "notes", "broken.md"), "no frontmatter");
    const all = await store.list();
    expect(all.map((n) => n.id)).toEqual(["ok"]);
  });

  test("notes persist across re-opens of the same workspace", async () => {
    const path = await tempDir();
    const a = await NotesStore.open(path);
    const note = await a.create({ body: "persist me", tags: ["t"] });
    const b = await NotesStore.open(path);
    const all = await b.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(note.id);
    expect(all[0]?.body).toBe("persist me");
  });

  test("create lazily creates the notes/ directory if missing", async () => {
    const path = await tempDir();
    // open does not require the dir to exist; create makes it
    const store = await NotesStore.open(path);
    await store.create({ body: "hi" });
    const stat = await readdir(join(path, "notes"));
    expect(stat.length).toBe(1);
  });

  test("create + roundtrip preserves kind=link and target", async () => {
    const path = await tempDir();
    const a = await NotesStore.open(path);
    const created = await a.create({
      body: "",
      anchors: ["worktree:/tmp/wt"],
      kind: "link",
      target: { type: "url", value: "https://example.com/x" },
    });
    expect(created.kind).toBe("link");
    expect(created.target).toEqual({
      type: "url",
      value: "https://example.com/x",
    });
    // Reopen the store to force a re-read from disk — exercises the
    // parser path that picks kind/targetType/targetValue out of
    // frontmatter, not just the in-memory pass-through.
    const b = await NotesStore.open(path);
    const round = await b.get(created.id);
    expect(round?.kind).toBe("link");
    expect(round?.target).toEqual({
      type: "url",
      value: "https://example.com/x",
    });
  });

  test("preserves target snapshot fields (label/subtitle/meta) on round-trip", async () => {
    const path = await tempDir();
    const a = await NotesStore.open(path);
    const created = await a.create({
      body: "",
      kind: "link",
      target: {
        type: "commit",
        value: "abc1234deadbeef",
        label: "Fix: handle the edge case in renderer",
        subtitle: "alice",
        meta: "2d",
      },
    });
    expect(created.target?.label).toBe("Fix: handle the edge case in renderer");
    // Re-open the store so we exercise the serialize → parse roundtrip
    // (not just the in-memory pass-through).
    const b = await NotesStore.open(path);
    const round = await b.get(created.id);
    expect(round?.target?.label).toBe("Fix: handle the edge case in renderer");
    expect(round?.target?.subtitle).toBe("alice");
    expect(round?.target?.meta).toBe("2d");
  });

  test("preserves command link target fields on round-trip", async () => {
    const path = await tempDir();
    const a = await NotesStore.open(path);
    const created = await a.create({
      body: "",
      kind: "link",
      target: {
        type: "command",
        value: "cmd-build-launch",
        label: "build:launch",
        repoId: "repo-1",
        cwd: "/tmp/project",
        command: "npm run build:launch",
        runMode: "internal",
      },
    });

    const b = await NotesStore.open(path);
    const round = await b.get(created.id);
    expect(round?.target).toEqual({
      type: "command",
      value: "cmd-build-launch",
      label: "build:launch",
      repoId: "repo-1",
      cwd: "/tmp/project",
      command: "npm run build:launch",
      runMode: "internal",
    });
  });

  test("create + roundtrip preserves message receiver fields", async () => {
    const path = await tempDir();
    const a = await NotesStore.open(path);
    const created = await a.create({
      body: "Please review this diff.",
      anchors: ["worktree:/tmp/project", "session:/tmp/session.jsonl"],
      receiver: {
        sessionId: "ses-123",
        label: "Fix auth flow",
        agent: "codex",
        source: "/tmp/session.jsonl",
        terminalId: "t_live",
        delivery: "draft",
      },
    });

    const b = await NotesStore.open(path);
    const round = await b.get(created.id);
    expect(round?.receiver).toEqual({
      sessionId: "ses-123",
      label: "Fix auth flow",
      agent: "codex",
      source: "/tmp/session.jsonl",
      terminalId: "t_live",
      delivery: "draft",
    });
  });

  test("create + roundtrip preserves peer receiver and sender fields", async () => {
    const w = await tempDir();
    const store = await NotesStore.open(w);
    const created = await store.create({
      body: "hello peer",
      receiver: {
        kind: "peer",
        peerId: "peer-b",
        label: "Peer B",
        host: "127.0.0.1",
        port: 7777,
        delivery: "draft",
      },
      sender: {
        kind: "peer",
        id: "peer-a",
        label: "Me",
      },
    });

    const reopened = await NotesStore.open(w);
    const round = await reopened.get(created.id);
    expect(round?.receiver).toEqual({
      kind: "peer",
      peerId: "peer-b",
      label: "Peer B",
      host: "127.0.0.1",
      port: 7777,
      delivery: "draft",
    });
    expect(round?.sender).toEqual({
      kind: "peer",
      id: "peer-a",
      label: "Me",
    });
  });

  test("create + update + roundtrip preserves message stamp id", async () => {
    const w = await tempDir();
    const store = await NotesStore.open(w);
    const created = await store.create({
      body: "hello with a stamp",
      stampId: 37,
    });
    expect(created.stampId).toBe(37);

    const changed = await store.update(created.id, { stampId: 112 });
    expect(changed.stampId).toBe(112);

    const cleared = await store.update(created.id, { stampId: null });
    expect(cleared.stampId).toBeUndefined();

    const restored = await store.update(created.id, { stampId: 5 });
    const reopened = await NotesStore.open(w);
    const round = await reopened.get(restored.id);
    expect(round?.stampId).toBe(5);
  });

  test("survives newlines in snapshot fields (collapses to space)", async () => {
    const store = await NotesStore.open(await tempDir());
    const created = await store.create({
      body: "",
      kind: "link",
      target: {
        type: "session",
        value: "/x/s.jsonl",
        // Multi-line label — without the serializer's sanitize step
        // the second line would be interpreted as a new frontmatter
        // key and the parser would silently drop the rest.
        label: "First line\nSecond line",
        subtitle: "claude",
        meta: "5 msg",
      },
    });
    const reopened = await NotesStore.open(store.workspacePath);
    const round = await reopened.get(created.id);
    expect(round?.target?.label).toBe("First line Second line");
    expect(round?.target?.subtitle).toBe("claude");
    expect(round?.target?.meta).toBe("5 msg");
  });

  test("update can flip a note to a link and back", async () => {
    const store = await NotesStore.open(await tempDir());
    const note = await store.create({ body: "draft" });
    expect(note.kind).toBeUndefined();
    const linked = await store.update(note.id, {
      kind: "link",
      target: { type: "commit", value: "abc1234" },
      body: "",
    });
    expect(linked.kind).toBe("link");
    expect(linked.target).toEqual({ type: "commit", value: "abc1234" });
    // null target clears it (and the kind flip back to "note" makes
    // the chip-vs-sticky decision in the UI fall through to default).
    const back = await store.update(note.id, {
      kind: "note",
      target: null,
      body: "second thought",
    });
    expect(back.kind).toBe("note");
    expect(back.target).toBeUndefined();
    expect(back.body).toBe("second thought");
  });

  test("create + roundtrip preserves secret=true", async () => {
    const store = await NotesStore.open(await tempDir());
    const created = await store.create({ body: "hush", secret: true });
    expect(created.secret).toBe(true);
    const round = await store.get(created.id);
    expect(round?.secret).toBe(true);
  });

  test("update can toggle secret on and off", async () => {
    const store = await NotesStore.open(await tempDir());
    const note = await store.create({ body: "draft" });
    expect(note.secret).toBeUndefined();
    const hidden = await store.update(note.id, { secret: true });
    expect(hidden.secret).toBe(true);
    const shown = await store.update(note.id, { secret: false });
    expect(shown.secret).toBeUndefined();
    const round = await store.get(note.id);
    expect(round?.secret).toBeUndefined();
  });

  test("serialiser omits secret unless true (no churn on plain notes)", () => {
    const raw = serializeNoteFile({
      id: "n",
      anchors: [],
      tags: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      body: "hi",
    });
    expect(raw).not.toContain("secret:");
    const secretRaw = serializeNoteFile({
      id: "n",
      anchors: [],
      tags: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      body: "hi",
      secret: true,
    });
    expect(secretRaw).toContain("secret: true");
    expect(parseNoteFile(secretRaw).secret).toBe(true);
  });

  test("legacy note files without kind/target round-trip unchanged", async () => {
    // The serialiser should NOT emit kind/target keys on a plain note,
    // so workspaces that already have hundreds of notes don't see a
    // diff churn the next time someone touches one.
    const raw = serializeNoteFile({
      id: "n",
      anchors: [],
      tags: [],
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      body: "hi",
    });
    expect(raw).not.toContain("kind:");
    expect(raw).not.toContain("targetType:");
    expect(parseNoteFile(raw).kind).toBeUndefined();
  });

  test("rehydrates an externally-edited note file from disk", async () => {
    const path = await tempDir();
    await mkdir(join(path, "notes"), { recursive: true });
    const raw = [
      "---",
      "id: external",
      "anchors:",
      "  - repo:foo/a.ts:7",
      "tags: [manual]",
      "---",
      "Wrote this by hand.",
    ].join("\n");
    await writeFile(join(path, "notes", "external.md"), raw);
    const store = await NotesStore.open(path);
    const note = await store.get("external");
    expect(note).not.toBeNull();
    expect(note?.anchors).toEqual(["repo:foo/a.ts:7"]);
    expect(note?.tags).toEqual(["manual"]);
    expect(note?.body).toBe("Wrote this by hand.");
  });
});
