import { describe, test, expect } from "bun:test";
import {
  targetDimensions,
  pngPixelDensityDpi,
  imageBytesHaveAlpha,
  DEFAULT_MAX_SIDE,
  HI_DPI_MAX_SIDE,
  HI_DPI_THRESHOLD_DPI,
} from "../src/image-shrink";

describe("targetDimensions", () => {
  test("returns null when source already fits the cap", () => {
    expect(targetDimensions(1280, 800, 1280)).toBeNull();
    expect(targetDimensions(100, 100, 1280)).toBeNull();
    expect(targetDimensions(800, 1280, 1280)).toBeNull();
  });

  test("scales landscape images so the longest side equals the cap", () => {
    // 2880×1800 Retina screenshot → cap longest side at 1280.
    const t = targetDimensions(2880, 1800, 1280)!;
    expect(t.w).toBe(1280);
    // 1800 * (1280/2880) = 800
    expect(t.h).toBe(800);
  });

  test("scales portrait images so the longest side equals the cap", () => {
    const t = targetDimensions(1800, 2880, 1280)!;
    expect(t.h).toBe(1280);
    expect(t.w).toBe(800);
  });

  test("preserves aspect ratio within a 1px floor rounding error", () => {
    const t = targetDimensions(3000, 2000, 1024)!;
    const srcRatio = 3000 / 2000;
    const dstRatio = t.w / t.h;
    expect(Math.abs(srcRatio - dstRatio)).toBeLessThan(0.01);
  });

  test("never returns a zero dimension on extreme aspect ratios", () => {
    const t = targetDimensions(10000, 10, 1280)!;
    expect(t.w).toBe(1280);
    expect(t.h).toBeGreaterThanOrEqual(1);
  });

  test("rejects nonsense input", () => {
    expect(targetDimensions(0, 100, 1280)).toBeNull();
    expect(targetDimensions(100, 0, 1280)).toBeNull();
    expect(targetDimensions(-1, 100, 1280)).toBeNull();
    expect(targetDimensions(Number.NaN, 100, 1280)).toBeNull();
    expect(targetDimensions(100, Number.POSITIVE_INFINITY, 1280)).toBeNull();
  });

  test("constants are wired to the values the code reasons about", () => {
    // If we ever change these caps, do it deliberately rather than
    // silently. 1280 is "still legible UI text"; 1024 is "we know
    // there's 2× redundancy in the source so we can be tighter".
    expect(DEFAULT_MAX_SIDE).toBe(1280);
    expect(HI_DPI_MAX_SIDE).toBe(1024);
    expect(HI_DPI_THRESHOLD_DPI).toBe(140);
  });
});

/**
 * Helpers for building synthetic PNG byte streams. We only need the
 * 8-byte signature + one chunk (pHYs or IDAT) for these tests; pixel
 * data is irrelevant since `pngPixelDensityDpi` only looks at chunk
 * headers.
 */
const PNG_SIG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function writeUint32BE(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function chunk(type: string, data: number[]): number[] {
  const out: number[] = [];
  writeUint32BE(out, data.length);
  out.push(
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  );
  out.push(...data);
  // Dummy CRC — parser doesn't verify.
  writeUint32BE(out, 0);
  return out;
}

function pHYsChunk(xPpu: number, yPpu: number, unit: 0 | 1): number[] {
  const data: number[] = [];
  writeUint32BE(data, xPpu);
  writeUint32BE(data, yPpu);
  data.push(unit);
  return chunk("pHYs", data);
}

function ihdrChunk(colorType: number): number[] {
  const data: number[] = [];
  writeUint32BE(data, 1);
  writeUint32BE(data, 1);
  data.push(8, colorType, 0, 0, 0);
  return chunk("IHDR", data);
}

function buildPng(chunks: number[][]): Uint8Array {
  const all: number[] = [];
  all.push(...PNG_SIG);
  for (const c of chunks) all.push(...c);
  return new Uint8Array(all);
}

describe("pngPixelDensityDpi", () => {
  test("returns null for non-PNG bytes", () => {
    expect(pngPixelDensityDpi(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(pngPixelDensityDpi(new Uint8Array(0))).toBeNull();
    // JPEG SOI marker — definitely not a PNG.
    expect(
      pngPixelDensityDpi(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])),
    ).toBeNull();
  });

  test("returns null for a PNG without a pHYs chunk", () => {
    const png = buildPng([chunk("IDAT", [0])]);
    expect(pngPixelDensityDpi(png)).toBeNull();
  });

  test("returns null when pHYs unit is 0 (aspect-only)", () => {
    // Many tools write unit=0 with arbitrary numerator/denominator just
    // to record the aspect ratio. We can't derive DPI from that.
    const png = buildPng([pHYsChunk(5669, 5669, 0)]);
    expect(pngPixelDensityDpi(png)).toBeNull();
  });

  test("reports ~72 dpi for a standard 2835 px/m PNG", () => {
    const png = buildPng([pHYsChunk(2835, 2835, 1)]);
    const dpi = pngPixelDensityDpi(png)!;
    expect(dpi).toBeGreaterThan(71.9);
    expect(dpi).toBeLessThan(72.1);
  });

  test("reports ~144 dpi for a Retina (5669 px/m) PNG", () => {
    const png = buildPng([pHYsChunk(5669, 5669, 1)]);
    const dpi = pngPixelDensityDpi(png)!;
    expect(dpi).toBeGreaterThan(143.9);
    expect(dpi).toBeLessThan(144.1);
    // And it's over the threshold the resizer cares about.
    expect(dpi).toBeGreaterThanOrEqual(HI_DPI_THRESHOLD_DPI);
  });

  test("stops scanning at IDAT (pHYs after IDAT is malformed and ignored)", () => {
    // Real-world PNGs may not put pHYs before IDAT in pathological
    // cases; we treat that as "no usable density info" rather than
    // walking the whole stream.
    const png = buildPng([chunk("IDAT", [0]), pHYsChunk(5669, 5669, 1)]);
    expect(pngPixelDensityDpi(png)).toBeNull();
  });

  test("returns null on truncated bytes", () => {
    // Build a full hi-DPI PNG, then chop the pHYs chunk midway.
    const full = buildPng([pHYsChunk(5669, 5669, 1)]);
    const truncated = full.slice(0, full.length - 4);
    expect(pngPixelDensityDpi(truncated)).toBeNull();
  });
});

describe("imageBytesHaveAlpha", () => {
  test("detects PNG color types and tRNS chunks that carry alpha", () => {
    expect(
      imageBytesHaveAlpha(
        buildPng([ihdrChunk(6), chunk("IDAT", [0])]),
        "image/png",
      ),
    ).toBe(true);
    expect(
      imageBytesHaveAlpha(
        buildPng([ihdrChunk(2), chunk("IDAT", [0])]),
        "image/png",
      ),
    ).toBe(false);
    expect(
      imageBytesHaveAlpha(
        buildPng([ihdrChunk(2), chunk("tRNS", [0, 0, 0, 0, 0, 0])]),
        "image/png",
      ),
    ).toBe(true);
  });

  test("detects extended WebP alpha flags", () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x12, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
      0x50, 0x56, 0x50, 0x38, 0x58, 0x0a, 0x00, 0x00, 0x00, 0x10, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(imageBytesHaveAlpha(webp, "image/webp")).toBe(true);
  });

  test("treats SVG images as transparent-capable", () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
    );
    expect(imageBytesHaveAlpha(svg, "image/svg+xml")).toBe(true);
  });
});
