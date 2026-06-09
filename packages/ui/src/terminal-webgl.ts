/**
 * WebGL renderer slot pool for terminal columns.
 *
 * Why this exists (plans/performance.md "Layerize storm during typing"):
 * xterm's DOM renderer adds/removes the row <span>/#text nodes on every
 * keystroke. That structural churn dirties compositing and forces a
 * Layerize (full layer-tree rebuild) per keystroke — `contain: layout
 * paint` on .xterm-host made each rebuild ~5× cheaper, but only a
 * renderer that doesn't touch the DOM removes the trigger. The WebGL
 * renderer re-rasters inside one composited <canvas>: zero node churn,
 * no per-keystroke Layerize, and the decorative status animations stay
 * affordable because nothing rebuilds the tree underneath them.
 * (@xterm/addon-canvas would have been the lighter pick but is dead
 * upstream — its peer range stops at xterm ^5, we're on 6.)
 *
 * Why a POOL: browsers cap live WebGL contexts at ~16 per page and
 * evict the oldest beyond that, while supergit mounts dozens of
 * terminal columns. Contexts are therefore a managed resource:
 * TerminalView acquires a slot when its column is on-screen and
 * releases it when scrolled away / unmounted (the same
 * IntersectionObserver that gates xterm.write). Anything that can't
 * hold a context — cap reached, WebGL2 unavailable, context evicted by
 * the browser — silently keeps xterm's DOM renderer, which still has
 * the `contain` mitigation.
 */
import { WebglAddon } from "@xterm/addon-webgl";

/** Minimal surface of @xterm/addon-webgl the pool relies on; tests
 *  inject fakes (bun test has no DOM/WebGL). */
export interface WebglAddonLike {
  dispose(): void;
  onContextLoss(listener: () => void): void;
}

interface AddonHost<A> {
  loadAddon(addon: A): void;
}

export interface WebglHandle {
  /** False once the slot was released (manual dispose or browser
   *  context loss). Callers re-attach on the next reveal if needed. */
  readonly active: boolean;
  dispose(): void;
}

/** Leaves headroom under the ~16-context browser cap for anything else
 *  on the page that wants a GL/2D-accelerated canvas. */
export const MAX_WEBGL_TERMINALS = 12;

export function createWebglPool<A extends WebglAddonLike>(
  max: number,
  createAddon: () => A,
) {
  let used = 0;
  return {
    inUse: () => used,
    tryAttach(term: AddonHost<A>): WebglHandle | null {
      if (used >= max) return null;
      let addon: A;
      try {
        addon = createAddon();
      } catch {
        return null;
      }
      try {
        term.loadAddon(addon);
      } catch {
        // WebGL2 unsupported / context creation failed — clean up and
        // leave the terminal on the DOM renderer.
        try {
          addon.dispose();
        } catch {}
        return null;
      }
      used++;
      let active = true;
      const handle: WebglHandle = {
        get active() {
          return active;
        },
        dispose() {
          if (!active) return;
          active = false;
          used--;
          try {
            addon.dispose();
          } catch {}
        },
      };
      // The browser reclaimed the context (too many pages/contexts).
      // Disposing reverts this terminal to the DOM renderer; the slot
      // frees up for whoever becomes visible next.
      addon.onContextLoss(() => handle.dispose());
      return handle;
    },
  };
}

export const webglPool = createWebglPool(
  MAX_WEBGL_TERMINALS,
  () => new WebglAddon(),
);
