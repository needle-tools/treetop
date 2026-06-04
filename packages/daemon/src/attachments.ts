import { mkdir, writeFile, stat, open } from "node:fs/promises";
import { join, basename, extname, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

export interface SaveAttachmentOpts {
  /** Original filename from a drop, or undefined for a clipboard paste. */
  filename?: string;
  /** MIME type, used to pick an extension when synthesizing a name. */
  mimeType?: string;
}

export interface SaveAttachmentResult {
  /** Absolute path on disk. The browser writes this into the PTY's
   *  stdin so the agent sees a file reference. */
  path: string;
}

export type ServeAttachmentResult =
  | { status: 400; error: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 500; error: string }
  | { status: 200; file: ReturnType<typeof Bun.file> };

export type ServeAttachmentPreviewResult =
  | { status: 400; error: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 500; error: string }
  | { status: 200; text: string };

/**
 * Persist a pasted / dropped attachment under `attachmentsDir` and
 * return its absolute path. The server hands us `<workspace>/attachments/`
 * — one folder per supergit workspace, sitting next to repos.json /
 * events.jsonl so it's part of the same state silo and gets cleaned
 * up alongside the workspace.
 *
 * Filename rules:
 *  - If `filename` is provided, sanitize it to the basename only (no
 *    path separators) so a malicious drop can't escape the folder.
 *  - If absent (typical for clipboard pastes), synthesize
 *    `paste-<ISO-timestamp>.<ext-from-mime>`.
 *  - On collision, append `-<6 hex>` before the extension.
 */
export async function saveAttachment(
  attachmentsDir: string,
  data: Uint8Array,
  opts: SaveAttachmentOpts = {},
): Promise<SaveAttachmentResult> {
  await mkdir(attachmentsDir, { recursive: true });
  const safeName = sanitizeName(opts.filename, opts.mimeType);
  const finalName = await uniqueName(attachmentsDir, safeName);
  const path = join(attachmentsDir, finalName);
  await writeFile(path, data);
  return { path };
}

export async function serveAttachment(
  attachmentsDir: string,
  path: string | null | undefined,
): Promise<ServeAttachmentResult> {
  const checked = resolveAttachmentPath(attachmentsDir, path);
  if (checked.status !== 200) return checked;
  try {
    const file = Bun.file(checked.path);
    if (!(await file.exists())) {
      return { status: 404, error: "not found" };
    }
    return { status: 200, file };
  } catch {
    return { status: 500, error: "cannot read file" };
  }
}

export async function serveAttachmentPreview(
  attachmentsDir: string,
  path: string | null | undefined,
  opts: { maxBytes?: number } = {},
): Promise<ServeAttachmentPreviewResult> {
  const checked = resolveAttachmentPath(attachmentsDir, path);
  if (checked.status !== 200) return checked;
  const maxBytes = Math.max(1, Math.min(opts.maxBytes ?? 8192, 65536));
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(checked.path, "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return {
      status: 200,
      text: new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, bytesRead)),
    };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { status: 404, error: "not found" };
    return { status: 500, error: "cannot read file" };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function resolveAttachmentPath(
  attachmentsDir: string,
  path: string | null | undefined,
):
  | { status: 400; error: string }
  | { status: 403; error: string }
  | { status: 200; path: string } {
  if (typeof path !== "string" || path.length === 0) {
    return { status: 400, error: "?path required" };
  }
  const root = resolve(attachmentsDir);
  const resolved = resolve(path);
  if (!resolved.startsWith(root + sep)) {
    return { status: 403, error: "outside attachments directory" };
  }
  return { status: 200, path: resolved };
}

function sanitizeName(
  filename: string | undefined,
  mimeType: string | undefined,
): string {
  if (filename) {
    // basename() strips any path component a malicious or naive caller
    // included (e.g. "../../etc/passwd" → "passwd"); then replace any
    // remaining control characters with underscores.
    const base = basename(filename).replace(/[\x00-\x1f\\:*?"<>|]/g, "_");
    if (base && base !== "." && base !== "..") return base;
  }
  // No filename → synthesize from the timestamp + MIME-derived extension.
  // Colons in ISO timestamps are fine on macOS/Linux but illegal on
  // Windows; swap them for hyphens so the same names work everywhere.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `paste-${ts}${extFromMime(mimeType)}`;
}

function extFromMime(mimeType: string | undefined): string {
  if (!mimeType) return ".bin";
  const m = mimeType.toLowerCase();
  if (m === "image/png") return ".png";
  if (m === "image/jpeg") return ".jpg";
  if (m === "image/gif") return ".gif";
  if (m === "image/webp") return ".webp";
  if (m === "image/svg+xml") return ".svg";
  if (m === "image/bmp") return ".bmp";
  if (m === "text/plain") return ".txt";
  if (m === "text/markdown") return ".md";
  if (m === "application/json") return ".json";
  return ".bin";
}

async function uniqueName(dir: string, desiredName: string): Promise<string> {
  const exists = await stat(join(dir, desiredName)).catch(() => null);
  if (!exists) return desiredName;
  const ext = extname(desiredName);
  const stem = desiredName.slice(0, desiredName.length - ext.length);
  // 6 hex chars = 24 bits; collision risk inside a single folder is
  // negligible. We don't loop on a second collision; the suffix is
  // already specific enough.
  const suffix = randomBytes(3).toString("hex");
  return `${stem}-${suffix}${ext}`;
}
