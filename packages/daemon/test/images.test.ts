import { test, expect, describe } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveImage } from "../src/images";

// Minimal PNG header (8 bytes) — enough that Bun.file.exists() is true
// and Bun.file.size > 0.
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

async function writeTempPng(name = "shot.png"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "supergit-img-"));
  const path = join(dir, name);
  await writeFile(path, PNG_HEADER);
  return path;
}

describe("serveImage", () => {
  test("400 when no path is given", async () => {
    expect((await serveImage(null)).status).toBe(400);
    expect((await serveImage(undefined)).status).toBe(400);
    expect((await serveImage("")).status).toBe(400);
  });

  test("400 when the extension isn't on the image allowlist", async () => {
    const r = await serveImage("/tmp/secret.txt");
    expect(r.status).toBe(400);
    if (r.status === 400) expect(r.error).toContain("image extension");
  });

  test("400 even when the path has an image extension stem but ends differently", async () => {
    // Avoid extension-bypass tricks like "foo.png.txt".
    expect((await serveImage("/tmp/x.png.txt")).status).toBe(400);
  });

  test("404 when the file doesn't exist", async () => {
    const r = await serveImage("/tmp/supergit-test-does-not-exist.png");
    expect(r.status).toBe(404);
  });

  test("200 + Bun.file for an existing PNG", async () => {
    const path = await writeTempPng();
    const r = await serveImage(path);
    expect(r.status).toBe(200);
    if (r.status === 200) {
      expect(r.file.size).toBeGreaterThan(0);
    }
  });

  test("works for paths containing spaces (e.g. macOS screencapture outputs)", async () => {
    // Mimics "Screenshot 2026-05-12 at 04.12.14.png" naming.
    const path = await writeTempPng("Screenshot 2026-05-12 at 04.12.14.png");
    const r = await serveImage(path);
    expect(r.status).toBe(200);
  });

  test("accepts each image extension on the allowlist", async () => {
    for (const ext of [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "svg",
      "bmp",
      "ico",
    ]) {
      const path = await writeTempPng(`probe.${ext}`);
      const r = await serveImage(path);
      expect(r.status).toBe(200);
    }
  });
});
