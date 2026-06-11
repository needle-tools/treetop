import { describe, expect, test } from "bun:test";
import {
  STICKER_TOKEN_PREFIX,
  buildStickerPacksFromModules,
  isLikelyMissingStickerToken,
  parseStickerSheetFilename,
  stickerPreviewStyle,
  stickerTokenLabel,
} from "../src/sticker-packs-core";

describe("sticker packs", () => {
  test("parses _NxM suffixes and falls back to 1x1", () => {
    expect(parseStickerSheetFilename("animals_4x4.png")).toEqual({
      name: "animals",
      grid: { cols: 4, rows: 4 },
    });
    expect(parseStickerSheetFilename("loose-leaf.webp")).toEqual({
      name: "loose-leaf",
      grid: { cols: 1, rows: 1 },
    });
  });

  test("builds packs from folder names and expands sprite-sheet cells", () => {
    const packs = buildStickerPacksFromModules({
      "./assets/stickers/Jungle/animals_4x4.png": "/assets/animals.png",
      "./assets/stickers/Jungle/leaf.png": "/assets/leaf.png",
      "./assets/stickers/Stargaze/glow_4x4.avif": "/assets/glow.avif",
    });

    expect(packs).toHaveLength(2);
    expect(packs[0]?.id).toBe("Jungle");
    expect(packs[0]?.label).toBe("Jungle");
    expect(packs[0]?.stickers).toHaveLength(17);
    expect(packs[0]?.stickers[0]?.token.startsWith(STICKER_TOKEN_PREFIX)).toBe(
      true,
    );
    expect(packs[0]?.stickers[0]?.sheet.grid).toEqual({ cols: 4, rows: 4 });
    expect(packs[0]?.stickers[16]?.sheet.grid).toEqual({ cols: 1, rows: 1 });
    expect(packs[1]?.id).toBe("Stargaze");
    expect(packs[1]?.stickers).toHaveLength(16);
    expect(packs[1]?.stickers[0]?.sheet.url).toBe("/assets/glow.avif");
  });

  test("creates CSS background crop math for sprite cells", () => {
    const [pack] = buildStickerPacksFromModules({
      "./assets/stickers/Jungle/animals_4x4.png": "/assets/animals.png",
    });
    const sticker = pack?.stickers[5];
    expect(sticker).toBeTruthy();
    const style = stickerPreviewStyle(sticker!);

    expect(style).toContain('background-image: url("/assets/animals.png")');
    expect(style).toContain("background-size: 400% 400%");
    expect(style).toContain(
      "background-position: 33.33333333333333% 33.33333333333333%",
    );
  });

  test("labels and detects stale sticker references", () => {
    const token = `${STICKER_TOKEN_PREFIX}Jungle/plants_blooms_4x4/2`;

    expect(stickerTokenLabel(token)).toBe("Jungle / Plants Blooms #3");
    expect(isLikelyMissingStickerToken(token)).toBe(true);
    expect(isLikelyMissingStickerToken("/plants-decal/seedling")).toBe(true);
    expect(isLikelyMissingStickerToken("✨")).toBe(false);
  });
});
