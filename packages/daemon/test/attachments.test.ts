import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { saveAttachment, serveAttachment } from "../src/attachments";

async function tempAttachmentsDir(): Promise<string> {
  // Real temp dir, no .supergit nesting — saveAttachment treats the
  // given path as the attachments root directly. Server passes
  // <workspace>/attachments/; tests pass a unique temp dir.
  return mkdtemp(join(tmpdir(), "supergit-attach-test-"));
}

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("saveAttachment", () => {
  test("writes the file into attachmentsDir and returns its absolute path", async () => {
    const dir = await tempAttachmentsDir();
    const { path } = await saveAttachment(dir, bytes("hello"), {
      filename: "screenshot.png",
      mimeType: "image/png",
    });
    expect(path).toBe(join(dir, "screenshot.png"));
    expect((await readFile(path)).toString()).toBe("hello");
  });

  test("synthesizes a paste-<timestamp>.<ext> name when filename is missing", async () => {
    const dir = await tempAttachmentsDir();
    const { path } = await saveAttachment(dir, bytes("png-data"), {
      mimeType: "image/png",
    });
    expect(path.startsWith(join(dir, "paste-"))).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect((await stat(path)).size).toBe(8);
  });

  test("uses a text extension for pasted text blobs", async () => {
    const dir = await tempAttachmentsDir();
    const { path } = await saveAttachment(dir, bytes("long paste"), {
      mimeType: "text/plain",
    });

    expect(path.startsWith(join(dir, "paste-"))).toBe(true);
    expect(path.endsWith(".txt")).toBe(true);
    expect((await readFile(path)).toString()).toBe("long paste");
  });

  test("adds a short suffix on filename collision instead of overwriting", async () => {
    const dir = await tempAttachmentsDir();
    const first = await saveAttachment(dir, bytes("a"), { filename: "img.png" });
    const second = await saveAttachment(dir, bytes("b"), { filename: "img.png" });
    expect(first.path).not.toBe(second.path);
    // The original file is untouched.
    expect((await readFile(first.path)).toString()).toBe("a");
    expect((await readFile(second.path)).toString()).toBe("b");
    // Both live in the same folder.
    expect(first.path.startsWith(dir + sep)).toBe(true);
    expect(second.path.startsWith(dir + sep)).toBe(true);
  });

  test("strips path separators from the filename (no escape from the folder)", async () => {
    const dir = await tempAttachmentsDir();
    const { path } = await saveAttachment(dir, bytes("safe"), {
      filename: "../../../etc/passwd",
    });
    // Whatever name we pick, it MUST sit inside the given dir.
    expect(path.startsWith(dir + sep)).toBe(true);
    expect(path).not.toContain("..");
  });

  test("creates the attachments directory if it doesn't exist", async () => {
    const dir = await tempAttachmentsDir();
    // First write proves the dir gets created on demand (even when it
    // already exists from mkdtemp, the recursive mkdir is a no-op —
    // but the same code path works for nested non-existent dirs).
    const nested = join(dir, "deep", "nested");
    const { path } = await saveAttachment(nested, bytes("x"), {
      filename: "first.bin",
    });
    expect((await stat(path)).isFile()).toBe(true);
    expect(path.startsWith(nested + sep)).toBe(true);
  });

  test("serves only files inside the attachments directory", async () => {
    const dir = await tempAttachmentsDir();
    const saved = await saveAttachment(dir, bytes("visible"), {
      filename: "paste.txt",
      mimeType: "text/plain",
    });

    const ok = await serveAttachment(dir, saved.path);
    expect(ok.status).toBe(200);
    if (ok.status === 200) {
      expect(await ok.file.text()).toBe("visible");
    }
    expect((await serveAttachment(dir, join(dir, "..", "secret.txt"))).status).toBe(403);
  });
});
