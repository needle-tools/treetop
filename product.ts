/**
 * Single source of truth for the product's display name.
 *
 * Imported by every place that shows the app's name in window/tab chrome:
 *   - packages/ui/src/main.ts      → document.title (runtime)
 *   - packages/ui/vite.config.ts   → <title> in index.html (build + dev)
 *   - src/electrobun/index.ts      → native BrowserWindow title
 *
 * NOTE: the Electrobun *bundle* name + identifier in electrobun.config.ts
 * are deliberately NOT sourced from here. They key the built `.app`
 * filename and the macOS data dirs (`~/.config/...`), so renaming them is
 * a migration, not a label change — kept separate on purpose.
 */
export const PRODUCT_NAME = "Jungle";

/**
 * Tab / window title. Dev builds get a suffix so two bookmarks
 * ("Jungle" / "Jungle · dev") stay visually distinct.
 */
export const windowTitle = (dev: boolean): string =>
  dev ? `${PRODUCT_NAME} · dev` : PRODUCT_NAME;
