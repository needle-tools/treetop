/**
 * Vines overlay — public entry point.
 *
 * The whole feature lives in this folder and is opt-in: main.ts only
 * dynamically imports this module when `?vines=1` (persisted in
 * localStorage as `vines`). To remove the feature entirely, delete this
 * folder and the small guarded block in main.ts — nothing else references
 * it.
 */
import "./vines.css";
import { createVinesOverlay } from "./vines-overlay";

let handle: { destroy: () => void } | null = null;

/** Mount the vines overlay (idempotent). */
export function initVines(): void {
  if (handle) return;
  handle = createVinesOverlay();
}

/** Tear the overlay down and remove its DOM. */
export function destroyVines(): void {
  handle?.destroy();
  handle = null;
}
