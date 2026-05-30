/**
 * Repo accent-colour helpers, shared by the repo chips in the worktree
 * board (App.svelte) and the per-repo headers in the process list
 * (ProcessList.svelte) so both pick the same readable foreground.
 */

/**
 * Pick a readable foreground for a `#rrggbb` chip background. Uses OKLCH
 * lightness (perceptually uniform) instead of sRGB YIQ luma, so the
 * flip-point between dark/light text matches what the eye actually sees
 * — saturated yellows + cyans correctly read as "light" and get dark
 * text, while mid blues correctly read as "dark" and get white text.
 * Pipeline: sRGB → linear-sRGB → LMS (Björn Ottosson's matrix) → cbrt →
 * OKLab L. Threshold 0.6 is the standard accessibility hinge. Malformed
 * input falls back to white.
 */
export function repoChipFg(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#ffffff";
  const v = parseInt(m[1]!, 16);
  const r8 = ((v >> 16) & 0xff) / 255;
  const g8 = ((v >> 8) & 0xff) / 255;
  const b8 = (v & 0xff) / 255;
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);
  const lL = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const mL = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const sL = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const L =
    0.2104542553 * Math.cbrt(lL) +
    0.793617785 * Math.cbrt(mL) -
    0.0040720468 * Math.cbrt(sL);
  return L >= 0.6 ? "#1a1a1a" : "#ffffff";
}
