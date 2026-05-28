import { describe, expect, test } from "bun:test";
import { iconFor, ICONS } from "../src/icons";

describe("iconFor", () => {
  test("returns null for unknown / empty keys", () => {
    expect(iconFor(null)).toBeNull();
    expect(iconFor(undefined)).toBeNull();
    expect(iconFor("")).toBeNull();
    expect(iconFor("does-not-exist")).toBeNull();
  });

  test("returns the registered icon for known provider keys", () => {
    for (const key of [
      "github",
      "gitlab",
      "bitbucket",
      "azure",
      "codeberg",
      "sourcehut",
      "gitea",
      "git",
    ]) {
      const def = iconFor(key);
      expect(def).not.toBeNull();
      // Each icon contributes at least one drawable primitive — otherwise
      // the SVG would render empty and the button would look broken.
      const primitives =
        (def!.paths?.length ?? 0) + (def!.circles?.length ?? 0);
      expect(primitives).toBeGreaterThan(0);
    }
  });

  test("returns the registered icon for known editor / app keys", () => {
    for (const key of [
      "code",
      "cursor",
      "rider",
      "idea",
      "idea-ce",
      "webstorm",
      "subl",
      "nvim",
      "fork",
      "terminal",
      "files",
      "finder",
      "explorer",
    ]) {
      const def = iconFor(key);
      expect(def).not.toBeNull();
      const primitives =
        (def!.paths?.length ?? 0) + (def!.circles?.length ?? 0);
      expect(primitives).toBeGreaterThan(0);
    }
  });

  test("brand colours, when present, are valid hex strings", () => {
    for (const [key, def] of Object.entries(ICONS)) {
      if (def.brand === undefined) continue;
      expect(def.brand, `${key} brand`).toMatch(
        /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
      );
    }
  });

  test("at least one popular provider carries a brand colour", () => {
    // Sanity check — if the brand map gets wiped accidentally, the
    // buttons silently lose all colour. This guards against that.
    expect(iconFor("gitlab")?.brand).toBeDefined();
    expect(iconFor("bitbucket")?.brand).toBeDefined();
    expect(iconFor("code")?.brand).toBeDefined();
  });

  test("multi-colour brand marks include a monochrome paths fallback", () => {
    // Icons that ship an inline `svg` body must also define `paths` (or
    // `circles`) so the `color={false}` rendering still has something
    // to show.
    for (const [key, def] of Object.entries(ICONS)) {
      if (!def.svg) continue;
      const primitives = (def.paths?.length ?? 0) + (def.circles?.length ?? 0);
      expect(primitives, `${key} fallback`).toBeGreaterThan(0);
    }
  });

  test("rider, fork, finder, explorer all carry a brand SVG", () => {
    // The whole point of this batch — guard against accidental removal.
    expect(iconFor("rider")?.svg).toBeTruthy();
    expect(iconFor("fork")?.svg).toBeTruthy();
    expect(iconFor("finder")?.svg).toBeTruthy();
    expect(iconFor("explorer")?.svg).toBeTruthy();
  });

  test("registry keys match the editor cmd / provider naming used by the daemon", () => {
    // The daemon's KNOWN_EDITORS uses these `cmd` values; if either side
    // diverges, the icons silently stop rendering. Keep this list in sync
    // with packages/daemon/src/open.ts.
    expect(Object.keys(ICONS)).toEqual(
      expect.arrayContaining([
        "cursor",
        "code",
        "rider",
        "idea",
        "idea-ce",
        "webstorm",
        "subl",
        "nvim",
      ]),
    );
  });
});
