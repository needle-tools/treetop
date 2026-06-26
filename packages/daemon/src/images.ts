/**
 * Serve local image files referenced from chat sessions
 * (e.g. "[Image: source: /var/folders/.../shot.png]"). Extracted from the
 * server handler so the validation + lookup logic is unit-testable.
 *
 * Allowlist by extension only — keeps the endpoint from becoming a
 * general-purpose file-read. CORS already pins the daemon to the dashboard
 * origin.
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

export type ServeImageResult =
  | { status: 400; error: string }
  | { status: 403; error: string }
  | { status: 404; error: string }
  | { status: 500; error: string }
  | { status: 200; file: ReturnType<typeof Bun.file> };

type ServeImageOptions = { maxSide?: number };

/**
 * Resolve a `?path` query parameter against the safety rules and produce
 * either an error or the Bun.file handle the server should stream.
 */
export async function serveImage(
  path: string | null | undefined,
  options: ServeImageOptions = {},
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
      const maxSide = Math.floor(options.maxSide);
      if (!Number.isFinite(maxSide) || maxSide <= 0) {
        return { status: 400, error: "?max must be a positive number" };
      }
    }
    return { status: 200, file };
  } catch {
    return { status: 500, error: "cannot read file" };
  }
}
