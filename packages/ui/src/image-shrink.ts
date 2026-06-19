/**
 * Browser-side image downscaler for dropped/pasted attachments.
 *
 * Why: Claude (and most vision models) tokenize images by pixel area
 * — roughly (W × H) / 750, after an internal resize to ~1568 px on
 * the longest side. To actually reduce token cost we have to shrink
 * BELOW that internal cap, which is a quality tradeoff.
 *
 * We use two caps:
 *  - DEFAULT_MAX_SIDE (1280): applied to any oversized image. About
 *    1/3 fewer tokens than the model's internal 1568 cap; UI text is
 *    still legible.
 *  - HI_DPI_MAX_SIDE (1024): applied when we can prove the source is
 *    a 2x ("Retina") asset via the PNG pHYs chunk. We know the
 *    pixels have a built-in 2× redundancy already, so a tighter cap
 *    is safe — about 2.4× fewer tokens vs the internal cap.
 *
 * Implementation: native `createImageBitmap` + `OffscreenCanvas`, no
 * deps. SVG (vector) and GIF (animation — canvas only keeps frame 0)
 * are left untouched. If the source is already within the cap, we
 * return the original Blob byte-for-byte.
 */

export const DEFAULT_MAX_SIDE = 1280;
export const HI_DPI_MAX_SIDE = 1024;
/** Threshold (in DPI) above which we treat a PNG as a 2x asset. 140
 *  rather than 144 so we don't miss densities that got rounded during
 *  encoding (e.g. 5669 px/m → 143.99 dpi). */
export const HI_DPI_THRESHOLD_DPI = 140;

/**
 * Pure: compute the target dimensions for a downscale to `maxSide`
 * on the longest edge, preserving aspect ratio. Returns `null` if no
 * resize is needed (source already fits).
 */
export function targetDimensions(
  srcW: number,
  srcH: number,
  maxSide: number,
): { w: number; h: number } | null {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH)) return null;
  if (srcW <= 0 || srcH <= 0) return null;
  const longest = Math.max(srcW, srcH);
  if (longest <= maxSide) return null;
  const scale = maxSide / longest;
  // Pin the dominant axis exactly to `maxSide` (float multiply +
  // floor would otherwise leave it at 1279 for a 2x source) and round
  // the other axis so aspect ratio stays within ±0.5 px.
  if (srcW >= srcH) {
    return { w: maxSide, h: Math.max(1, Math.round(srcH * scale)) };
  }
  return { w: Math.max(1, Math.round(srcW * scale)), h: maxSide };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32BE(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function readUint32LE(b: Uint8Array, o: number): number {
  return ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0;
}

function chunkTypeEquals(
  bytes: Uint8Array,
  offset: number,
  type: string,
): boolean {
  return (
    bytes[offset] === type.charCodeAt(0) &&
    bytes[offset + 1] === type.charCodeAt(1) &&
    bytes[offset + 2] === type.charCodeAt(2) &&
    bytes[offset + 3] === type.charCodeAt(3)
  );
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

/**
 * Pure: read the PNG `pHYs` chunk and return the X pixel density in
 * DPI, or `null` if the bytes aren't a PNG, the chunk is missing, the
 * unit is "unknown" (so the densities are aspect-only), or the file
 * is truncated. macOS Retina screencaps write `pHYs` with unit=1 and
 * 5669 px/m on each axis (≈144 dpi).
 */
export function pngPixelDensityDpi(bytes: Uint8Array): number | null {
  if (!isPng(bytes)) return null;
  let p = 8;
  // Chunks: 4-byte length + 4-byte type + N data + 4-byte CRC.
  while (p + 12 <= bytes.length) {
    const len = readUint32BE(bytes, p);
    const t0 = bytes[p + 4];
    const t1 = bytes[p + 5];
    const t2 = bytes[p + 6];
    const t3 = bytes[p + 7];
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) return null;
    // pHYs
    if (t0 === 0x70 && t1 === 0x48 && t2 === 0x59 && t3 === 0x73 && len === 9) {
      const xPpu = readUint32BE(bytes, dataStart);
      const unit = bytes[dataStart + 8];
      if (unit !== 1) return null; // 0 = aspect-only, not real DPI
      return xPpu * 0.0254; // pixels per meter → dots per inch
    }
    // IDAT marks the start of image data; pHYs (if present) must
    // appear before it, so we can stop scanning.
    if (t0 === 0x49 && t1 === 0x44 && t2 === 0x41 && t3 === 0x54) return null;
    p = dataEnd + 4;
  }
  return null;
}

function pngHasAlpha(bytes: Uint8Array): boolean {
  if (!isPng(bytes)) return false;
  let p = 8;
  while (p + 12 <= bytes.length) {
    const len = readUint32BE(bytes, p);
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) return false;
    if (chunkTypeEquals(bytes, p + 4, "IHDR") && len >= 10) {
      const colorType = bytes[dataStart + 9];
      if (colorType === 4 || colorType === 6) return true;
    }
    if (chunkTypeEquals(bytes, p + 4, "tRNS")) return true;
    if (chunkTypeEquals(bytes, p + 4, "IDAT")) return false;
    p = dataEnd + 4;
  }
  return false;
}

function isWebp(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    chunkTypeEquals(bytes, 0, "RIFF") &&
    chunkTypeEquals(bytes, 8, "WEBP")
  );
}

function webpHasAlpha(bytes: Uint8Array): boolean {
  if (!isWebp(bytes)) return false;
  let p = 12;
  while (p + 8 <= bytes.length) {
    const len = readUint32LE(bytes, p + 4);
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    if (dataEnd > bytes.length) return false;
    if (chunkTypeEquals(bytes, p, "VP8X") && len >= 1) {
      return (bytes[dataStart] & 0x10) !== 0;
    }
    if (chunkTypeEquals(bytes, p, "ALPH")) return true;
    if (chunkTypeEquals(bytes, p, "VP8L") && len >= 5) {
      return ((readUint32LE(bytes, dataStart + 1) >>> 28) & 1) === 1;
    }
    p = dataEnd + (len % 2);
  }
  return false;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.slice(0, 512))
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith("<svg") ||
    (head.startsWith("<?xml") && head.includes("<svg"))
  );
}

export function imageBytesHaveAlpha(
  bytes: Uint8Array,
  mimeType: string = "",
): boolean {
  const mime = mimeType.toLowerCase();
  if (mime.includes("svg") || looksLikeSvg(bytes)) return true;
  if (mime.includes("png") || isPng(bytes)) return pngHasAlpha(bytes);
  if (mime.includes("webp") || isWebp(bytes)) return webpHasAlpha(bytes);
  return false;
}

async function decodedImageHasTransparentPixel(blob: Blob): Promise<boolean> {
  if (typeof createImageBitmap !== "function") return false;
  if (typeof OffscreenCanvas !== "function") return false;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 255) return true;
    }
    return false;
  } finally {
    bitmap.close();
  }
}

export async function imageBlobHasAlpha(blob: Blob): Promise<boolean> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!imageBytesHaveAlpha(bytes, blob.type)) return false;
    const mime = blob.type.toLowerCase();
    if (mime.includes("svg") || looksLikeSvg(bytes)) return true;
    return await decodedImageHasTransparentPixel(blob);
  } catch {
    return false;
  }
}

/** MIME types we'll process. SVG is vector, GIF may be animated. */
function isResizableImage(mime: string): boolean {
  if (!mime.startsWith("image/")) return false;
  if (mime === "image/svg+xml") return false;
  if (mime === "image/gif") return false;
  return true;
}

/**
 * Best-effort downscale. On any failure (decoder error, no
 * OffscreenCanvas, etc.) we return the original blob so the upload
 * still goes through.
 */
export async function shrinkImageBlob(blob: Blob): Promise<Blob> {
  if (!isResizableImage(blob.type)) return blob;
  if (typeof createImageBitmap !== "function") return blob;
  if (typeof OffscreenCanvas !== "function") return blob;

  // Read bytes up front: needed for pHYs sniffing, and `createImageBitmap`
  // is happy to take either a Blob or a fresh one we make from bytes.
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    return blob;
  }

  // Pick the cap: hi-DPI PNGs get the tighter one.
  let maxSide = DEFAULT_MAX_SIDE;
  if (blob.type === "image/png") {
    const dpi = pngPixelDensityDpi(bytes);
    if (dpi !== null && dpi >= HI_DPI_THRESHOLD_DPI) {
      maxSide = HI_DPI_MAX_SIDE;
    }
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }

  try {
    const target = targetDimensions(bitmap.width, bitmap.height, maxSide);
    if (!target) return blob;
    const canvas = new OffscreenCanvas(target.w, target.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return blob;
    ctx.drawImage(bitmap, 0, 0, target.w, target.h);
    // Preserve format. JPEG/WebP get a sensible quality; PNG ignores it.
    const out = await canvas.convertToBlob({
      type: blob.type,
      quality: 0.92,
    });
    return out;
  } catch {
    return blob;
  } finally {
    bitmap.close?.();
  }
}
