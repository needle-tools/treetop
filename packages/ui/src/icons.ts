/**
 * Inline SVG path registry for the "open in <tool>" buttons.
 *
 * All icons render at 24x24, monochrome with `currentColor`. Default
 * style is stroked (1.8) so they sit visually next to the small button
 * text. Set `filled: true` for a glyph that needs a fill (rare here).
 *
 * Keys match the values the rest of the app already passes around:
 *   - editor `ed.cmd` from /api/editors (`cursor`, `code`, `rider`, ...).
 *   - special apps: `fork`, `terminal`, `files`.
 *   - remote `provider` from listRemotes (`github`, `gitlab`, ...).
 *   - `git` is the fallback for remotes with an unknown provider.
 *
 * If you want to swap any of these for the real brand glyph from
 * `simple-icons`, drop its single-path `d` string in here — same
 * 24x24 viewBox, same `currentColor` tint.
 */

export interface IconDef {
  paths?: string[];
  circles?: { cx: number; cy: number; r: number }[];
  /** Render filled with currentColor instead of stroked. Most icons here
   *  are stroked (feather-style) so the button stays light visually. */
  filled?: boolean;
  /** Brand colour applied when the button's `color` prop is true. Omit
   *  for monochrome icons (system apps, near-black brand colours that
   *  would disappear on a dark UI), and they fall back to currentColor. */
  brand?: string;
  /** Pre-rendered multi-colour SVG body — used for brand marks that need
   *  more than one fill (Rider's confetti backdrop + black square). The
   *  body sits inside a 24x24 viewBox. Only used when the button's
   *  `color` prop is true; with `color={false}` we fall back to
   *  paths/circles for a monochrome rendering. */
  svg?: string;
}

const branch: IconDef = {
  paths: ["M6 3v12", "M18 9a9 9 0 0 1-9 9"],
  circles: [
    { cx: 6, cy: 3, r: 2 },
    { cx: 18, cy: 6, r: 2 },
    { cx: 6, cy: 21, r: 2 },
  ],
};

export const ICONS: Record<string, IconDef> = {
  // ---- Remote providers ---------------------------------------------
  // github's brand colour (#181717) is essentially black; leave it as
  // currentColor so it stays legible on the dashboard's dark surface.
  github: {
    paths: [
      "M9 19c-5 1.5-5-2.5-7-3 m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22",
    ],
  },
  gitlab: {
    brand: "#FC6D26",
    paths: [
      "M22 13.29l-3.33-10a.42.42 0 0 0-.14-.18.38.38 0 0 0-.22-.11.39.39 0 0 0-.23.07.42.42 0 0 0-.14.18l-2.26 6.67H8.32L6.1 3.26a.42.42 0 0 0-.14-.18.39.39 0 0 0-.23-.07.38.38 0 0 0-.22.11.42.42 0 0 0-.14.18L2 13.29a.74.74 0 0 0 .27.83L12 21l9.69-6.88a.71.71 0 0 0 .31-.83Z",
    ],
  },
  bitbucket: {
    brand: "#2684FF",
    paths: ["M3 4h18l-2 16H5z", "M9 9h6v6H9z"],
  },
  azure: {
    brand: "#0078D4",
    paths: ["M3 20l9-16 9 16Z"],
  },
  codeberg: {
    brand: "#2185D0",
    paths: ["M3 21l6-14 4 8 3-5 5 11Z"],
  },
  // sourcehut brand is black; keep currentColor.
  sourcehut: {
    circles: [{ cx: 12, cy: 12, r: 9 }],
    paths: ["M5 12h14"],
  },
  gitea: {
    brand: "#609926",
    paths: ["M5 5h10v8a5 5 0 0 1-10 0z", "M15 7h3a2 2 0 0 1 0 4h-3"],
  },
  // Fallback when the host doesn't map to a known provider. Generic git
  // branch glyph. Git-the-tool brand red works on the dark UI.
  git: { ...branch, brand: "#F05033" },

  // ---- Editors ------------------------------------------------------
  // VSCode brand mark — the classic ribbon/wrap silhouette. Filled, so
  // the brand blue reads correctly at small sizes (the stroked angle
  // brackets we used before were ambiguous with `</>` code icons).
  code: {
    brand: "#007ACC",
    filled: true,
    paths: [
      "M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z",
    ],
  },
  // Cursor brand is monochrome black/white; let it inherit text colour.
  cursor: {
    paths: ["M3 3l7 17 2.5-7 7-2.5z"],
  },
  // Rider brand mark — JetBrains "confetti" backdrop in pink/orange/blue
  // with a black square holding "RD" and the underscore prompt. The
  // monochrome `paths` fallback (used with color={false}) keeps the
  // stylised R-glyph from before.
  rider: {
    brand: "#C40B6E",
    paths: ["M4 4h16v16H4z", "M8 8h6a2 2 0 1 1 0 4H8z", "M10 12l4 4"],
    svg: `
      <polygon points="1,5 11,1 13,18 3,22" fill="#DD1265"/>
      <polygon points="9,1 18,3 14,12 7,10" fill="#F97A12"/>
      <polygon points="14,2 22,6 20,21 11,18" fill="#087CFA"/>
      <rect x="4" y="4" width="16" height="16" fill="#000"/>
      <text x="12" y="14.5" text-anchor="middle"
            font-family="Arial Black, Arial, sans-serif"
            font-weight="900" font-size="8" fill="#fff"
            style="letter-spacing:-0.5px">RD</text>
      <rect x="7" y="17.2" width="3" height="1.4" fill="#fff"/>
    `,
  },
  // IntelliJ brand uses the same near-black wordmark as GitHub on dark
  // backgrounds; the splash gradient (#FE315D) is the most recognisable
  // accent so we use it for both editions.
  idea: {
    brand: "#FE315D",
    paths: ["M5 5h14v14H5z", "M9 9h2v6a1.5 1.5 0 0 1-3 0"],
  },
  "idea-ce": {
    brand: "#FE315D",
    paths: ["M5 5h14v14H5z", "M9 9h2v6a1.5 1.5 0 0 1-3 0"],
  },
  webstorm: {
    brand: "#00CDD7",
    paths: ["M5 5h14v14H5z", "M9 9v3l3 1.5L9 15"],
  },
  subl: {
    brand: "#FF9800",
    paths: ["M19 4 5 8l14 4-14 4 14 4"],
  },
  nvim: {
    brand: "#57A143",
    paths: ["M5 5l4 14L19 5", "M9 5l6 14"],
  },

  // ---- Special apps -------------------------------------------------
  // Fork.app — blue disc with a white four-tined fork. Monochrome
  // fallback is the existing git-branch trident.
  fork: {
    paths: ["M6 7v10", "M18 13a3 3 0 0 0-3-3h-3a3 3 0 0 1-3-3V6"],
    circles: [
      { cx: 6, cy: 5, r: 2 },
      { cx: 6, cy: 19, r: 2 },
      { cx: 18, cy: 13, r: 2 },
    ],
    svg: `
      <circle cx="12" cy="12" r="11" fill="#1FA8E0"/>
      <rect x="7.6" y="5" width="1.2" height="5.2" rx="0.5" fill="#fff"/>
      <rect x="9.6" y="5" width="1.2" height="5.2" rx="0.5" fill="#fff"/>
      <rect x="11.6" y="5" width="1.2" height="5.2" rx="0.5" fill="#fff"/>
      <rect x="13.6" y="5" width="1.2" height="5.2" rx="0.5" fill="#fff"/>
      <rect x="7" y="9.6" width="8.4" height="1.9" rx="0.5" fill="#fff"/>
      <rect x="10.7" y="11" width="2.6" height="9" rx="1" fill="#fff"/>
    `,
  },
  terminal: {
    paths: ["M4 17l5-5-5-5", "M11 19h8"],
  },
  // Alt terminal glyph for process-list rows (terminal sessions AND
  // discovered subprocesses), distinct from the plain stroked `terminal`
  // chevron above used on the open-in buttons: a little terminal WINDOW
  // — a light, rounded "screen" with a title-bar divider so it stays
  // visible against the dark popover surface. No prompt mark inside.
  // Monochrome `paths` fallback is a stroked window for any context that
  // renders without the multi-colour `svg` body.
  "terminal-screen": {
    paths: ["M3 5h18v14H3z", "M3 9h18"],
    svg: `
      <rect x="3" y="4.5" width="18" height="15" rx="2"
            fill="none" stroke="currentColor" stroke-width="2"/>
      <line x1="3" y1="8.5" x2="21" y2="8.5"
            stroke="currentColor" stroke-width="2"/>
    `,
  },
  // Generic file-manager glyph. macOS / Windows get their own dedicated
  // brand marks below; this is the Linux / fallback default.
  files: {
    paths: [
      "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
    ],
  },
  folder: {
    paths: [
      "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
    ],
  },
  document: {
    paths: [
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z",
      "M14 2v6h6",
    ],
  },
  // macOS Finder — the two-tone smiling face. Used when the dashboard
  // is opened from a Mac browser. Monochrome fallback reuses the
  // generic folder glyph.
  finder: {
    paths: [
      "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
    ],
    svg: `
      <rect x="2" y="2" width="20" height="20" rx="4" fill="#fff"/>
      <path d="M2 6a4 4 0 0 1 4-4h6v20H6a4 4 0 0 1-4-4z" fill="#1E90FF"/>
      <rect x="7.1" y="8" width="1.4" height="3.2" rx="0.7" fill="#222"/>
      <rect x="15.5" y="8" width="1.4" height="3.2" rx="0.7" fill="#222"/>
      <path d="M7 15c1.5 2 8.5 2 10 0" stroke="#222"
            stroke-width="1.4" fill="none" stroke-linecap="round"/>
    `,
  },
  info: {
    paths: ["M12 16v-4", "M12 8h.01"],
    circles: [{ cx: 12, cy: 12, r: 10 }],
  },
  ai: {
    filled: true,
    paths: [
      "M12 1l2.35 8.65L23 12l-8.65 2.35L12 23l-2.35-8.65L1 12l8.65-2.35z",
    ],
  },
  user: {
    paths: ["M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"],
    circles: [{ cx: 12, cy: 7, r: 4 }],
  },
  speech: {
    filled: true,
    paths: [
      "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z",
    ],
  },
  // Generic web-link glyph — feather-style chain. Used as the fallback
  // icon for user-defined "open in" links when the favicon proxy can't
  // resolve a brand mark for the target URL.
  link: {
    paths: [
      "M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07l-1.5 1.5",
      "M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07l1.5-1.5",
    ],
  },
  // Windows File Explorer — yellow folder with the cyan house tab.
  explorer: {
    paths: [
      "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
    ],
    svg: `
      <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" fill="#FFD93D"/>
      <rect x="3.5" y="5" width="2.2" height="1.2" fill="#7BC74D"/>
      <path d="M8 13a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6h-2.2v-3h-3.6v3H8z" fill="#29C0E5"/>
    `,
  },

  // ---- UI chrome -------------------------------------------------------
  pin: {
    paths: ["M9 4v6l-2 4v2h10v-2l-2-4V4", "M12 16v5", "M8 4h8"],
  },
  emoji: {
    paths: ["M8 14s1.5 2 4 2 4-2 4-2"],
    circles: [
      { cx: 12, cy: 12, r: 10 },
      { cx: 9, cy: 9, r: 1 },
      { cx: 15, cy: 9, r: 1 },
    ],
  },
  tag: {
    paths: [
      "M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z",
    ],
    circles: [{ cx: 7, cy: 7, r: 1 }],
  },
  // Lucide "monitor" — used as the SSH active indicator in the shell pill.
  monitor: {
    paths: ["M2 3h20v14H2z", "M8 21h8", "M12 17v4"],
  },
};

export function iconFor(key: string | null | undefined): IconDef | null {
  if (!key) return null;
  return ICONS[key] ?? null;
}

/**
 * Git status glyph `d` strings, drawn in a 12x12 viewBox and stroked with
 * currentColor (`stroke-linecap: round`). Shared by StatusBadge (the
 * worktree pills) and SessionDock (the repo-arrow inner glyph) so the
 * ↑ ahead / ↓ behind / ~ dirty marks stay pixel-identical across every
 * surface. These are raw paths rather than `IconDef` entries because they
 * render inline at 12x12, not through the 24x24 OpenInButton machinery.
 */
export const GIT_AHEAD = "M6 10V2M6 2L2.5 5.5M6 2l3.5 3.5";
export const GIT_BEHIND = "M6 2v8M6 10l-3.5-3.5M6 10l3.5-3.5";
/** A proper tilde — rise then dip — not a single hump. */
export const GIT_DIRTY = "M2 6c1-2 3-2 4 0s3 2 4 0";
/**
 * Multi-period version of GIT_DIRTY for the SessionDock, where the dirty
 * glyph scrolls horizontally to read as a flowing wave. Same wavelength
 * (8 user units / one up+down) and amplitude as GIT_DIRTY, but it spans
 * x -4..20 so that translating it left by one full period (8px) keeps the
 * 0..12 viewBox window fully covered at every frame — a seamless loop.
 * The overflowing ends are clipped by the SVG's default overflow:hidden.
 */
export const GIT_DIRTY_WAVE =
  "M-4 6 q2 -2 4 0 t4 0 t4 0 t4 0 t4 0 t4 0 t4 0";
