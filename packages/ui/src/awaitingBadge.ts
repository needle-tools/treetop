/**
 * Browser-tab awaiting-input indicator: a red dot drawn into the
 * favicon plus a `(N) ` prefix in the document title whenever any open
 * session is waiting for the user. Lets the user notice "an agent
 * needs me" from a different tab without having to click back.
 *
 * Idempotent: re-calling with the same count is cheap (it short-
 * circuits before touching the DOM). The first call lazily loads the
 * base favicon as an HTMLImageElement so subsequent updates just
 * redraw without another network fetch.
 */

const BASE_TITLE_FALLBACK = "supergit";
const BASE_FAVICON_HREF = "/needle-logo.svg";

let baseTitle: string | null = null;
let baseImage: HTMLImageElement | null = null;
let baseImageReady = false;
let lastCount = -1;

/** Pure helper: produce the title string for a given awaiting count. */
export function titleForCount(base: string, count: number): string {
  if (count <= 0) return base;
  return `(${count}) ${base}`;
}

function ensureBaseTitle(): string {
  if (baseTitle === null) {
    // Strip any prefix already on the title from a previous run (e.g.
    // a quick reload-while-awaiting) so we don't stack "(2) (2) ".
    const current = typeof document !== "undefined" ? document.title : "";
    baseTitle = current.replace(/^\(\d+\)\s+/, "") || BASE_TITLE_FALLBACK;
  }
  return baseTitle;
}

function ensureBaseImage(): void {
  if (baseImage !== null) return;
  if (typeof Image === "undefined") return;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    baseImageReady = true;
    // If the count was set while we were still loading, paint it now.
    if (lastCount > 0) drawBadge(lastCount);
    else if (lastCount === 0) clearBadge();
  };
  img.onerror = () => {
    // Couldn't load the base — fall back to "title only" badge mode.
    baseImage = null;
  };
  img.src = BASE_FAVICON_HREF;
  baseImage = img;
}

function getFaviconLink(): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;
  let link = document.querySelector<HTMLLinkElement>(
    'link[rel~="icon"]',
  );
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  return link;
}

function drawBadge(count: number): void {
  if (!baseImage || !baseImageReady) return;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // Base icon underneath.
  try {
    ctx.drawImage(baseImage, 0, 0, size, size);
  } catch {
    return;
  }
  // Red dot in the top-right with a tight contrast ring so it stays
  // visible against light backgrounds in the browser's tab strip.
  const r = 8;
  const cx = size - r - 0.5;
  const cy = r + 0.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#e34c3c";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.stroke();
  // Optional small count when it fits (<=9). The "what" matters
  // more than the precise number, so we don't try to render 2+ digits.
  if (count >= 1 && count <= 9) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 11px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(count), cx, cy + 0.5);
  }
  const link = getFaviconLink();
  if (!link) return;
  try {
    link.type = "image/png";
    link.href = canvas.toDataURL("image/png");
  } catch {
    // Tainted canvas (CORS) — leave the favicon alone, title still updates.
  }
}

function clearBadge(): void {
  const link = getFaviconLink();
  if (!link) return;
  link.type = "image/x-icon";
  link.href = "/favicon.ico";
}

/** Apply the awaiting badge for `count` waiting sessions. Updates the
 *  document title prefix and the favicon. Safe to call repeatedly. */
export function updateAwaitingBadge(count: number): void {
  if (count === lastCount) return;
  lastCount = count;
  if (typeof document !== "undefined") {
    const base = ensureBaseTitle();
    document.title = titleForCount(base, count);
  }
  ensureBaseImage();
  if (count <= 0) {
    clearBadge();
    return;
  }
  if (baseImageReady) drawBadge(count);
  // else: drawBadge will run from the image's onload handler.
}
