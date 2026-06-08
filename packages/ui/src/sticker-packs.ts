import {
  buildStickerPacksFromModules,
  buildStickersByToken,
  STICKER_TOKEN_PREFIX,
  isStickerToken,
  isLikelyMissingStickerToken,
  stickerPreviewStyle,
  stickerTokenLabel,
  type GlobImportValue,
  type Sticker,
  type StickerPack,
} from "./sticker-packs-core";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { eager: true; query: string; import: "default" },
    ) => Record<string, GlobImportValue>;
  }
}

/*
 * Keep this as a direct `import.meta.glob(...)` call. Vite rewrites this exact
 * syntax into concrete asset imports; aliasing import.meta leaves packs empty.
 */
const STICKER_MODULES = import.meta.glob(
  "./assets/stickers/**/*.{png,webp,svg}",
  {
    eager: true,
    query: "?url",
    import: "default",
  },
) as Record<string, GlobImportValue>;

export {
  STICKER_TOKEN_PREFIX,
  isLikelyMissingStickerToken,
  isStickerToken,
  stickerPreviewStyle,
  stickerTokenLabel,
};
export type { Sticker, StickerPack };

export const STICKER_PACKS: StickerPack[] =
  buildStickerPacksFromModules(STICKER_MODULES);

const STICKERS_BY_TOKEN = buildStickersByToken(STICKER_PACKS);

export function stickerFromToken(token: string): Sticker | null {
  return STICKERS_BY_TOKEN.get(token) ?? null;
}
