#!/usr/bin/env node
/**
 * Generate all icon assets from icon.svg.
 *
 *   node scripts/generate-icons.mjs            # or: bun scripts/generate-icons.mjs
 *
 * Outputs:
 *   icon.ico                  — multi-size Windows ICO (16–256)
 *   icon.iconset/*.png        — macOS iconset (16–512 + @2x retina)
 *
 * Requires: sharp (dev dependency).
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SVG_PATH = join(ROOT, "icon.svg");
const ICO_PATH = join(ROOT, "icon.ico");
const ICONSET_DIR = join(ROOT, "icon.iconset");

// --- macOS iconset sizes (base + @2x retina) -------------------------
const ICONSET_SIZES = [16, 32, 64, 128, 256, 512];

// --- Windows ICO sizes ------------------------------------------------
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const MAC_ICON_BG = "#2d2d28";

async function renderPng(svgBuf, size, { background } = {}) {
  let pipeline = sharp(svgBuf, { density: Math.max(300, size * 2) })
    .resize(size, size);
  if (background) pipeline = pipeline.flatten({ background });
  return pipeline.png().toBuffer();
}

// ---- ICO encoder (BMP-in-ICO for ≤48px, embedded PNG for larger) -----

function buildIco(entries) {
  // ICO header: 3 × uint16 (reserved=0, type=1, count)
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * entries.length;
  let dataOffset = headerSize + dirSize;

  const dirBufs = [];
  const dataBufs = [];

  for (const { size, png } of entries) {
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;

    const dir = Buffer.alloc(dirEntrySize);
    dir.writeUInt8(w, 0);
    dir.writeUInt8(h, 1);
    dir.writeUInt8(0, 2);   // color palette
    dir.writeUInt8(0, 3);   // reserved
    dir.writeUInt16LE(1, 4); // color planes
    dir.writeUInt16LE(32, 6); // bits per pixel
    dir.writeUInt32LE(png.length, 8); // data size
    dir.writeUInt32LE(dataOffset, 12); // data offset
    dirBufs.push(dir);
    dataBufs.push(png);
    dataOffset += png.length;
  }

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(entries.length, 4);

  return Buffer.concat([header, ...dirBufs, ...dataBufs]);
}

// ----------------------------------------------------------------------

async function main() {
  const svgBuf = await readFile(SVG_PATH);
  console.log(`Source: ${SVG_PATH}`);

  // macOS iconset
  await mkdir(ICONSET_DIR, { recursive: true });
  const iconsetJobs = [];
  for (const s of ICONSET_SIZES) {
    iconsetJobs.push(
      renderPng(svgBuf, s, { background: MAC_ICON_BG }).then((buf) =>
        writeFile(join(ICONSET_DIR, `icon_${s}x${s}.png`), buf),
      ),
    );
    iconsetJobs.push(
      renderPng(svgBuf, s * 2, { background: MAC_ICON_BG }).then((buf) =>
        writeFile(join(ICONSET_DIR, `icon_${s}x${s}@2x.png`), buf),
      ),
    );
  }
  await Promise.all(iconsetJobs);
  console.log(`  icon.iconset/  ${ICONSET_SIZES.length} sizes + retina`);

  // Windows ICO
  const icoEntries = await Promise.all(
    ICO_SIZES.map(async (size) => ({
      size,
      png: await renderPng(svgBuf, size),
    })),
  );
  const ico = buildIco(icoEntries);
  await writeFile(ICO_PATH, ico);
  console.log(`  icon.ico       ${ICO_SIZES.join(", ")}px`);

  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
