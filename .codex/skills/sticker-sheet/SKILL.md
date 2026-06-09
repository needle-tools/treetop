---
name: "sticker-sheet"
description: "Generate Supergit-style NxN sticker, collage, or sprite sheets: isolated flat gouache/screenprint sticker objects on pure black. Use when the user asks for a 4x4, 8x8, or other grid of sticker-pack/collage cutouts, especially for Supergit sticker packs. Requires an explicit N and exactly N*N provided topics or cell subjects before generation."
metadata:
  short-description: Generate NxN black-background sticker sheets
---

# Sticker Sheet

Use this skill for Supergit sticker-pack sheets: an `N x N` square image of isolated sticker objects floating on pure black, suitable for later cropping into individual UI stickers.

This skill handles art direction only. For generation mechanics, use the built-in `image_gen` tool via the `imagegen` skill.

## Required Inputs

Before generating, make sure the request includes:

- Grid size `N x N` such as `4x4` or `8x8`.
- Exactly `N*N` cell topics. Do not invent missing topics unless the user explicitly asks you to fill them in.
- A theme or pack name.

If any required input is missing, ask for it. For `4x4`, require 16 topics. For `8x8`, require 64 topics.

## Core Prompt Rules

Every prompt must include these constraints:

- Exact strict `N columns by N rows`, equal square cells.
- One isolated subject per cell, centered, fully visible, with generous black padding.
- Perfectly uniform pure `#000000` background across the whole sheet.
- No text, labels, numbers, watermark, frames, borders, UI mockup, paper texture, postmarks, horizon, scene background, ground plane, cast shadows, vignettes, or background texture.
- Subjects should read as separate sticker/collage objects, not landscape vignettes or scenes.

## Style Target

Use this as the default style language:

```text
Flat vintage gouache plus screenprint poster art, rich but controlled color, bold readable silhouettes, clean shape edges defined by color contrast, simplified graphic forms, subtle hand-painted texture, even lighting, minimal gradients, low depth, not photorealistic, not glossy, not 3D, not generic clipart, not bland pastel, not literal paper cutouts.
```

For Supergit sticker packs, protect against the recurring drift:

- Avoid yellow/gold wash, beige dominance, brown/orange dominance, and warm paper-like aging.
- Do not use drawn outlines, black contour strokes, sticker-border strokes, or yellow ochre edge strokes.
- Define forms through silhouette, adjacent color blocks, and painted edge contrast instead of outlines.
- Prefer black-background "thingness": each item should feel like a designed object floating in black.
- Keep color vivid enough to feel collectible, but not neon or childish.
- For animals and birds, vary poses strongly: side view, three-quarter view, singing, eating, preening, wings open, landing, flying, crouched, perched, tail lifted, head turned. Avoid a sheet of repeated canonical side profiles.
- If the theme is desert, allow rust/coral/magenta/teal/violet/cool ivory; use ochre only as a small accent.
- If the theme is jungle/treetop, prefer fresh greens, teal shadows, cool ivory highlights, controlled reds/magentas/blues, and only restrained yellow accents.

## Prompt Template

```text
Use case: stylized-concept
Asset type: {N}x{N} sprite sheet / collage sticker sheet for a UI sticker library
Primary request: Create one square image containing exactly {N*N} {theme} sticker cutouts arranged in a strict {N} column by {N} row grid on a perfectly uniform pure black background (#000000).

Core visual rule: Each cell contains one isolated {theme} subject floating on black. No full scene, no horizon, no ground plane, no sunlight beams, no cast shadows, no background texture, no vignette.

Composition:
- Exact {N}x{N} grid of equal square cells.
- One isolated subject per cell, centered, fully visible, with generous black padding around it.
- Pure #000000 background fills the whole sheet.
- No cell borders, labels, numbers, letters, watermark, or decorative frame.
- Subjects should read as designed sticker objects, not landscape vignettes.

Cell subjects, all distinct and cohesive:
1. {topic 1}
2. {topic 2}
...
{N*N}. {topic N*N}

Style:
- Flat vintage gouache plus screenprint poster art with bold readable silhouettes, clean shape edges defined by color contrast, simplified graphic forms, subtle hand-painted texture, even lighting, minimal gradients, and low depth.
- No drawn outlines, no black contour strokes, no sticker-border strokes, no yellow ochre edge strokes. Use silhouette, color blocks, and painted edge contrast instead.
- Rich but controlled palette: {theme palette}. Avoid yellow/gold wash, beige dominance, brown/orange dominance, pastel-only color, glossy highlights, realistic rendering, dense fur/foliage detail, and literal paper-cut style.
- Calm, tasteful, collectible, readable at small UI sizes.

Technical target: square sprite sheet, exactly {N} rows and {N} columns, production-ready, pure #000000 background, no text, no decorative border.
```

## Corrections

When iterating on a sheet, preserve the grid and only correct the failure:

- Too yellow/brown: "Remove the warm yellow/golden cast. Use a cooler, flatter palette; no drawn outlines, no dark contour strokes, no sepia/gold edge glow."
- Too scene-like: "Each cell must be one isolated object on black; remove horizons, ground planes, sunlight, and vignette lighting."
- Too realistic/deep: "Flatten toward screenprint/gouache shapes; reduce shiny highlights, heavy volume, and painterly rendering."
- Too paper-cut/pastel: "Less literal cutout, richer color blocks, crisp interior marks, still low depth."
- Too repetitive: "Make silhouettes, proportions, colors, and poses clearly distinct cell by cell."

## References

For proven prompts and correction examples, read `references/prompt-examples.md`.
