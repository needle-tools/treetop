/**
 * Design-token contract guard.
 *
 * PURPOSE
 * -------
 * This test locks the CURRENT set of CSS custom-property names defined in
 * tokens.css so that a future consolidation cannot silently DROP a token.
 * It does NOT freeze token VALUES (re-theming remains free), and it does NOT
 * assert on the hex/color values themselves.
 *
 * TWO TIERS
 * ---------
 * 1. Name snapshot  — all 77 tokens currently defined in :root must stay
 *    defined after any consolidation.  This test MUST STAY GREEN.
 *
 * 2. Dangling-ref check — every var(--x) reference in styles/*.css should
 *    resolve to a defined token.  Several vars are intentionally component-
 *    local (set per-element by JS/template: --tilt, --grab-x, --grab-y,
 *    --stack-index, --swatch-bg, --repo-bg, --repo-fg, --command-accent) or
 *    have explicit fallback values making them non-breaking.  These are listed
 *    in KNOWN_LOCAL_OR_FALLBACK_ONLY and excluded from the check.  The
 *    remaining un-defined tokens are captured in
 *    KNOWN_DANGLING_WITHOUT_DEFINITION for the roadmap — the test records them
 *    but does NOT fail on them (they are pre-existing gaps, not regressions).
 *
 * WHAT "CONSOLIDATION ACCIDENTALLY DELETED" LOOKS LIKE
 * -----------------------------------------------------
 * If a developer removes --chip-cyan-bg from tokens.css the first `describe`
 * block fails immediately with a diff showing exactly which names disappeared.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UI_SRC = join(import.meta.dir, "../src");
const STYLES_DIR = join(UI_SRC, "styles");
const TOKENS_FILE = join(STYLES_DIR, "tokens.css");

function readTokensCss(): string {
  return readFileSync(TOKENS_FILE, "utf-8");
}

function readAllStylesCss(): string {
  const files = readdirSync(STYLES_DIR).filter((f) => f.endsWith(".css"));
  return files
    .map((f) => readFileSync(join(STYLES_DIR, f), "utf-8"))
    .join("\n");
}

/** Extract all `--name` tokens defined in a CSS :root block. */
function extractDefinedTokens(css: string): Set<string> {
  const defined = new Set<string>();
  // Match `  --token-name:` lines (custom property declarations)
  const re = /^\s+(--[a-zA-Z0-9_-]+)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    defined.add(m[1]!);
  }
  return defined;
}

/** Extract all `var(--name` references from CSS text. */
function extractVarReferences(css: string): Set<string> {
  const refs = new Set<string>();
  const re = /var\((--[a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    refs.add(m[1]!);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Snapshot — the exact 77 token names that exist today.
// Update this list deliberately when adding/renaming tokens; a silent drop
// will cause a test failure that surfaces the regression.
// ---------------------------------------------------------------------------

const EXPECTED_TOKEN_NAMES: ReadonlyArray<string> = [
  // base palette
  "--background",
  "--surface",
  "--error",
  "--note-paper",
  "--note-ink",
  // surfaces
  "--surface-0",
  "--surface-1",
  "--surface-2",
  "--surface-3",
  "--surface-input-hover",
  // text levels
  "--text-1",
  "--text-2",
  "--text-3",
  "--text-4",
  "--text-5",
  "--text-muted",
  "--text-faint",
  // borders
  "--border-muted",
  "--border-muted-strong",
  // brand
  "--brand",
  "--brand-hover",
  // Needle brand palette (official) + brand typeface
  "--needle-green",
  "--needle-green-dark",
  "--needle-green-light",
  "--needle-purple",
  "--font-brand",
  // status / error
  "--status-clean",
  "--status-dirty",
  "--error-bg",
  "--error-text",
  "--ctx-warn",
  "--ctx-hot",
  // chips
  "--chip-default-bg",
  "--chip-default-text",
  "--selected-bg",
  "--selected-text",
  "--chip-orange-bg",
  "--chip-orange-text",
  "--chip-cyan-bg",
  "--chip-cyan-text",
  "--chip-yellow-bg",
  "--chip-yellow-text",
  "--chip-purple-bg",
  "--chip-purple-text",
  "--chip-green-bg",
  "--chip-green-text",
  "--chip-codex-bg",
  "--chip-codex-text",
  "--chip-ollama-bg",
  "--chip-ollama-text",
  "--chip-indigo-bg",
  "--chip-indigo-text",
  "--chip-grey-text",
  // diff
  "--diff-add-bg",
  "--diff-add-text",
  "--diff-remove-bg",
  "--diff-remove-text",
  "--diff-hunk-bg",
  "--diff-hunk-text",
  "--diff-file-bg",
  "--diff-file-text",
  "--diff-commit-bg",
  "--diff-commit-text",
  // metrics / spacing
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--row-strip-pad",
  // font sizes
  "--fs-xs",
  "--fs-sm",
  "--fs-md",
  "--fs-lg",
  // scrollbar
  "--scrollbar-thumb",
  "--scrollbar-thumb-hover",
  // note-paper variants
  "--note-paper-top",
  "--note-paper-dark",
  // shadow tokens
  "--shadow-overlay",
  "--shadow-popover",
  "--shadow-md",
  // diagnostics chip pairs
  "--chip-warn-bg",
  "--chip-warn-text",
  "--chip-info-bg",
  "--chip-info-text",
] as const;

// ---------------------------------------------------------------------------
// Known vars that are NOT global tokens but are used in styles/*.css.
// Grouped by reason so the roadmap comment is self-documenting.
// ---------------------------------------------------------------------------

/**
 * Component-local CSS custom properties set per-element by JS or inline
 * style bindings.  They intentionally have no :root definition — they are
 * scoped to the element that sets them.
 */
const COMPONENT_LOCAL_VARS: ReadonlySet<string> = new Set([
  "--tilt", // notes.css: rotation set per-sticky by JS (StickyNote.svelte)
  "--grab-x", // notes.css: transform-origin for grab animation
  "--grab-y", // notes.css: transform-origin for grab animation
  "--stack-index", // notes.css: z-index ladder per-sticky
  "--message-stamp-rotation", // notes.css: per-message stamp tilt set inline
  "--swatch-bg", // worktree-row.css: per-repo color swatch set inline
  "--repo-bg", // worktree-row.css: per-repo accent color set inline
  "--repo-fg", // worktree-row.css: per-repo foreground color set inline
  "--project-color", // header.css: per-project accent color set inline
  "--command-accent", // notes.css: idle/running accent for command-power-card
  "--warm-glow-soft", // header.css: glow colour pre-resolved on .actions-btn.warm (composited warm-glow)
  "--warm-glow-core", // header.css: glow colour pre-resolved on .actions-btn.warm (composited warm-glow)
]);

/**
 * Vars used without a :root definition AND without a hardcoded fallback.
 * These are pre-existing gaps recorded here for the consolidation roadmap.
 * Adding a token for them is tracked work; this test does NOT fail on them.
 *
 * Roadmap:
 *   --status-ahead   → alias for --status-dirty  (file-browser.css, worktree-row.css)
 *   --font-mono      → needs a definition in tokens.css  (base.css)
 *   --text-primary   → alias for --text-1  (worktree-row.css)
 *   --danger         → alias for --ctx-hot or --error-bg  (file-browser.css)
 *   --red            → alias for --error-text  (notes.css)
 *   --accent         → blue focus-ring; needs definition  (popover.css)
 *   --border-1       → var with fallback, but not in tokens  (worktree-row.css)
 *   --border         → var with fallback, but not in tokens  (notes.css)
 *   --bg-0           → var with fallback to --surface-1  (zen-row.css)
 *   --bg-hover       → var with fallback  (notes.css)
 *   --bg-surface     → var with fallback  (notes.css)
 *   --error          → var with fallback; should alias --ctx-hot  (worktree-row.css)
 */
const KNOWN_DANGLING_WITHOUT_DEFINITION: ReadonlySet<string> = new Set([
  "--status-ahead",
  "--font-mono",
  "--text-primary",
  "--danger",
  "--red",
  "--error",
  "--accent",
  "--border-1",
  "--border",
  "--bg-0",
  "--bg-hover",
  "--bg-surface",
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("design tokens — name snapshot (MUST STAY GREEN)", () => {
  test("tokens.css defines exactly the expected set of 82 token names", () => {
    const css = readTokensCss();
    const defined = extractDefinedTokens(css);

    // Every expected token must be present.
    const missing = EXPECTED_TOKEN_NAMES.filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  test("no expected token has been silently renamed or removed", () => {
    const css = readTokensCss();
    const defined = extractDefinedTokens(css);

    for (const name of EXPECTED_TOKEN_NAMES) {
      expect(defined.has(name)).toBe(true);
    }
  });

  test("the count of defined tokens equals the snapshot count", () => {
    const css = readTokensCss();
    const defined = extractDefinedTokens(css);
    // diff-file-bg and diff-file-text reference other tokens rather than
    // hex values, so they still count as declarations in the token file.
    expect(defined.size).toBe(EXPECTED_TOKEN_NAMES.length);
  });
});

describe("design tokens — var() references in styles/*.css (roadmap info)", () => {
  test("every var(--x) in styles/*.css either resolves or is a known gap/local", () => {
    const tokensCss = readTokensCss();
    const allStylesCss = readAllStylesCss();

    const defined = extractDefinedTokens(tokensCss);
    const used = extractVarReferences(allStylesCss);

    // Collect genuinely unknown vars: not defined in tokens.css AND not a
    // component-local AND not already tracked in the roadmap list.
    const truelyUnknown: string[] = [];
    for (const ref of used) {
      if (
        !defined.has(ref) &&
        !COMPONENT_LOCAL_VARS.has(ref) &&
        !KNOWN_DANGLING_WITHOUT_DEFINITION.has(ref)
      ) {
        truelyUnknown.push(ref);
      }
    }

    // Fail only on NEW dangling refs that aren't captured in either list
    // above — this prevents silent regressions from future CSS edits that
    // introduce a new undefined var without updating the roadmap list.
    expect(truelyUnknown).toEqual([]);
  });

  test("component-local vars do not accidentally appear in tokens.css (they must stay local)", () => {
    const css = readTokensCss();
    const defined = extractDefinedTokens(css);
    const leaked = [...COMPONENT_LOCAL_VARS].filter((v) => defined.has(v));
    // These vars are intentionally scoped; promoting them to :root would
    // change their semantics (they'd become global defaults, not per-element
    // values set by JS). Fail if that happens accidentally.
    expect(leaked).toEqual([]);
  });
});
