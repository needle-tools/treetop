/**
 * Serve local image files referenced from chat sessions
 * (e.g. "[Image: source: /var/folders/.../shot.png]"). Extracted from the
 * server handler so the validation + lookup logic is unit-testable.
 *
 * Allowlist by extension only — keeps the endpoint from becoming a
 * general-purpose file-read. CORS already pins the daemon to the dashboard
 * origin.
 */

import sharp from "sharp";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const RESIZABLE_IMAGE_EXT_RE = /\.(png|jpe?g|webp|bmp)$/i;

export type ServeImageResult =
  | { status: 400; error: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 500; error: string }
  | { status: 200; file: ReturnType<typeof Bun.file> }
  | { status: 200; bytes: Uint8Array; mimeType: string };

/**
 * Resolve a `?path` query parameter against the safety rules and produce
 * either an error or the Bun.file handle the server should stream.
 */
export async function serveImage(
  path: string | null | undefined,
  options: { maxSide?: number } = {},
): Promise<ServeImageResult> {
  if (typeof path !== "string" || path.length === 0) {
    return { status: 400, error: "?path required" };
  }
  if (!IMAGE_EXT_RE.test(path)) {
    return { status: 400, error: "not an image extension" };
  }
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { status: 404, error: "not found" };
    }
    if (options.maxSide !== undefined) {
      return await resizeImageFile(path, file, options.maxSide);
    }
    return { status: 200, file };
  } catch {
    return { status: 500, error: "cannot read file" };
  }
}

async function resizeImageFile(
  path: string,
  file: ReturnType<typeof Bun.file>,
  maxSide: number,
): Promise<ServeImageResult> {
  if (!Number.isFinite(maxSide) || maxSide <= 0) {
    return { status: 400, error: "?max must be a positive number" };
  }
  const roundedMax = Math.floor(maxSide);
  if (roundedMax <= 0)
    return { status: 400, error: "?max must be a positive number" };
  if (!RESIZABLE_IMAGE_EXT_RE.test(path)) {
    return { status: 200, file };
  }
  try {
    const original = new Uint8Array(await file.arrayBuffer());
    const image = sharp(original, { animated: false });
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width <= 0 || height <= 0) {
      return { status: 500, error: "failed to read image dimensions" };
    }
    if (Math.max(width, height) <= roundedMax) {
      return { status: 200, file };
    }
    const bytes = await image
      .resize({
        width: roundedMax,
        height: roundedMax,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toBuffer();
    return { status: 200, bytes, mimeType: file.type || "image/png" };
  } catch {
    return { status: 500, error: "failed to resize image" };
  }
}
