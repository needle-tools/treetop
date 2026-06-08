export const STICKER_TOKEN_PREFIX = "sticker:";

export interface StickerSheetGrid {
  cols: number;
  rows: number;
}

export interface StickerSheet {
  id: string;
  name: string;
  label: string;
  pack: string;
  packLabel: string;
  url: string;
  grid: StickerSheetGrid;
}

export interface Sticker {
  token: string;
  label: string;
  index: number;
  sheet: StickerSheet;
}

export interface StickerPack {
  id: string;
  label: string;
  stickers: Sticker[];
}

export type GlobImportValue = string | { default?: string };

export function parseStickerSheetFilename(filename: string): {
  name: string;
  grid: StickerSheetGrid;
} {
  const stem = filename.replace(/\.[^.]+$/, "");
  const match = /^(.*)_([1-9]\d*)x([1-9]\d*)$/i.exec(stem);
  if (!match) return { name: stem, grid: { cols: 1, rows: 1 } };
  return {
    name: match[1] || stem,
    grid: { cols: Number(match[2]), rows: Number(match[3]) },
  };
}

function titleFromId(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function assetUrl(value: GlobImportValue): string {
  return typeof value === "string" ? value : (value.default ?? "");
}

function stickerToken(pack: string, sheetId: string, index: number): string {
  return `${STICKER_TOKEN_PREFIX}${encodeURIComponent(pack)}/${encodeURIComponent(sheetId)}/${index}`;
}

export function buildStickerPacksFromModules(
  modules: Record<string, GlobImportValue>,
): StickerPack[] {
  const packs = new Map<string, StickerPack>();
  const sheetPathRe =
    /^\.\/assets\/stickers\/([^/]+)\/([^/]+\.(?:png|webp|svg))$/i;
  const entries = Object.entries(modules).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  for (const [path, value] of entries) {
    const match = sheetPathRe.exec(path);
    if (!match) continue;
    const pack = match[1]!;
    const filename = match[2]!;
    const url = assetUrl(value);
    if (!url) continue;
    const { name, grid } = parseStickerSheetFilename(filename);
    const sheetId = filename.replace(/\.[^.]+$/, "");
    const sheet: StickerSheet = {
      id: sheetId,
      name,
      label: titleFromId(name),
      pack,
      packLabel: titleFromId(pack),
      url,
      grid,
    };
    const packEntry = packs.get(pack) ?? {
      id: pack,
      label: titleFromId(pack),
      stickers: [],
    };
    const total = grid.cols * grid.rows;
    for (let index = 0; index < total; index++) {
      packEntry.stickers.push({
        token: stickerToken(pack, sheetId, index),
        label: total === 1 ? sheet.label : `${sheet.label} ${index + 1}`,
        index,
        sheet,
      });
    }
    packs.set(pack, packEntry);
  }

  return Array.from(packs.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

export function buildStickersByToken(
  packs: readonly StickerPack[],
): Map<string, Sticker> {
  const stickers = new Map<string, Sticker>();
  for (const pack of packs) {
    for (const sticker of pack.stickers) {
      stickers.set(sticker.token, sticker);
    }
  }
  return stickers;
}

export function isStickerToken(s: string): boolean {
  return s.startsWith(STICKER_TOKEN_PREFIX);
}

export function stickerTokenLabel(token: string): string | null {
  if (!isStickerToken(token)) return null;
  const rest = token.slice(STICKER_TOKEN_PREFIX.length);
  const [packRaw, sheetRaw, indexRaw] = rest.split("/");
  const pack = decodeURIComponent(packRaw ?? "").trim();
  const sheet = decodeURIComponent(sheetRaw ?? "").trim();
  const index = Number.parseInt(indexRaw ?? "", 10);
  const { name } = parseStickerSheetFilename(sheet);
  const parts = [pack, name].filter(Boolean).map(titleFromId);
  const label = parts.join(" / ") || "Sticker";
  return Number.isFinite(index) ? `${label} #${index + 1}` : label;
}

export function isLikelyMissingStickerToken(s: string): boolean {
  const token = s.trim();
  if (!token) return false;
  return isStickerToken(token) || token.startsWith("/");
}

export function stickerPreviewStyle(sticker: Sticker): string {
  const { cols, rows } = sticker.sheet.grid;
  const col = sticker.index % cols;
  const row = Math.floor(sticker.index / cols);
  const x = cols <= 1 ? 0 : (col / (cols - 1)) * 100;
  const y = rows <= 1 ? 0 : (row / (rows - 1)) * 100;
  return [
    `background-image: url("${sticker.sheet.url}")`,
    `background-size: ${cols * 100}% ${rows * 100}%`,
    `background-position: ${x}% ${y}%`,
    "background-repeat: no-repeat",
  ].join("; ");
}
