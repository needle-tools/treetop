/**
 * Custom app icons usable as sticker glyphs and (later) session/repo icons.
 *
 * To add a new app icon:
 *   1. Drop the SVG file at `packages/ui/public/icons/apps/<name>.svg`
 *   2. Add an entry to `APP_ICONS` below with the same `name`
 *
 * Token format: app icons are referenced as the string `app:<name>` —
 * stickers store this as their `body` and render the matching SVG
 * instead of an emoji glyph.
 */

export interface AppIcon {
  /** Filename (without extension). Becomes the `app:<name>` token. */
  name: string;
  /** Display label shown in tooltips / search results. */
  label: string;
  /** File extension on disk. Defaults to "svg". */
  ext?: "svg" | "png" | "webp";
  /** Optional search keywords (in addition to `name` and `label`). */
  keywords?: string[];
}

export const APP_ICONS: AppIcon[] = [
  { name: "needle", label: "Needle", ext: "webp", keywords: ["needle", "engine", "tools", "3d", "web"] },
  { name: "blender", label: "Blender", ext: "png", keywords: ["3d", "modeling", "animation"] },
  { name: "unity", label: "Unity", keywords: ["3d", "game", "engine"] },
  { name: "vscode", label: "VS Code", ext: "png", keywords: ["editor", "code", "ide", "microsoft"] },
  { name: "threejs", label: "three.js", ext: "png", keywords: ["3d", "webgl", "javascript", "library"] },
  { name: "threejs-alt", label: "three.js (alt)", ext: "png", keywords: ["3d", "webgl", "javascript", "library"] },
  { name: "gltf", label: "glTF", ext: "png", keywords: ["3d", "format", "model", "khronos"] },
  { name: "usd", label: "USD", ext: "png", keywords: ["3d", "format", "scene", "pixar", "openusd"] },
  { name: "npm", label: "npm", ext: "png", keywords: ["package", "node", "registry", "javascript"] },
  { name: "hetzner", label: "Hetzner", ext: "png", keywords: ["cloud", "hosting", "server"] },
];

export const APP_ICON_TOKEN_PREFIX = "app:";

export function isAppIconToken(s: string): boolean {
  return s.startsWith(APP_ICON_TOKEN_PREFIX);
}

export function appIconNameFromToken(s: string): string | null {
  if (!isAppIconToken(s)) return null;
  return s.slice(APP_ICON_TOKEN_PREFIX.length);
}

export function appIconUrl(name: string): string {
  const icon = APP_ICONS.find((i) => i.name === name);
  const ext = icon?.ext ?? "svg";
  return `/icons/apps/${encodeURIComponent(name)}.${ext}`;
}
