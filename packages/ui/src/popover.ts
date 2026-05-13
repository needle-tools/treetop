/**
 * Svelte action that nudges an absolutely-positioned popover back inside
 * the viewport when the anchor sits close to a screen edge. The popover's
 * own `max-width` can't prevent off-screen overflow because the popover
 * positions to one edge of its anchor — once the anchor is near the right
 * edge of the page, no `max-width` saves it. This action measures on
 * mount, on resize, and on scroll, applying a `translateX` correction.
 *
 * Use directly on the popover root element:
 *
 *     <div class="agents-popover" use:clampToViewport>...</div>
 *
 * Or rely on `Popover.svelte`, which applies this unconditionally.
 */
export function clampToViewport(node: HTMLElement) {
  const MARGIN = 8;
  function clamp() {
    // Reset any prior offset before measuring, otherwise our own
    // correction gets compounded on resize.
    node.style.transform = "";
    const rect = node.getBoundingClientRect();
    const overRight = rect.right - window.innerWidth + MARGIN;
    const overLeft = MARGIN - rect.left;
    if (overRight > 0) {
      node.style.transform = `translateX(-${overRight}px)`;
    } else if (overLeft > 0) {
      node.style.transform = `translateX(${overLeft}px)`;
    }
  }
  clamp();
  window.addEventListener("resize", clamp);
  window.addEventListener("scroll", clamp, { passive: true });
  return {
    destroy() {
      window.removeEventListener("resize", clamp);
      window.removeEventListener("scroll", clamp);
    },
  };
}
