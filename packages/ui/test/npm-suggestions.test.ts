import { describe, expect, test } from "bun:test";
import {
  filterNpmSuggestions,
  npmScriptsPlaceholder,
} from "../src/npm-suggestions";

const SCRIPTS = [
  "start",
  "dev",
  "build",
  "build:launch",
  "test",
  "test:watch",
  "test:coverage",
  "stop-dev",
];

describe("filterNpmSuggestions", () => {
  test("returns empty for empty scripts list", () => {
    expect(filterNpmSuggestions("npm run ", [])).toEqual([]);
    expect(filterNpmSuggestions("npm", [])).toEqual([]);
    expect(filterNpmSuggestions("dev", [])).toEqual([]);
  });

  test("returns empty for unrelated commands", () => {
    expect(filterNpmSuggestions("git status", SCRIPTS)).toEqual([]);
    expect(filterNpmSuggestions("ls -la", SCRIPTS)).toEqual([]);
  });

  test("empty string returns empty", () => {
    expect(filterNpmSuggestions("", SCRIPTS)).toEqual([]);
    expect(filterNpmSuggestions("  ", SCRIPTS)).toEqual([]);
  });

  // ── npm ───────────────────────────────────────────────────────

  test("shows all scripts when typing 'npm'", () => {
    expect(filterNpmSuggestions("npm", SCRIPTS)).toEqual(
      SCRIPTS.map((s) => `npm run ${s}`),
    );
  });

  test("shows all scripts for partial 'n', 'np', 'npm'", () => {
    for (const partial of ["n", "np", "npm"]) {
      expect(filterNpmSuggestions(partial, SCRIPTS)).toEqual(
        SCRIPTS.map((s) => `npm run ${s}`),
      );
    }
  });

  test("shows all scripts for 'npm r', 'npm ru', 'npm run'", () => {
    for (const partial of ["npm r", "npm ru", "npm run"]) {
      expect(filterNpmSuggestions(partial, SCRIPTS)).toEqual(
        SCRIPTS.map((s) => `npm run ${s}`),
      );
    }
  });

  test("shows all scripts for 'npm run ' (with trailing space)", () => {
    expect(filterNpmSuggestions("npm run ", SCRIPTS)).toEqual(
      SCRIPTS.map((s) => `npm run ${s}`),
    );
  });

  test("filters by prefix after 'npm run'", () => {
    expect(filterNpmSuggestions("npm run d", SCRIPTS)).toEqual(["npm run dev"]);
    expect(filterNpmSuggestions("npm run t", SCRIPTS)).toEqual([
      "npm run test",
      "npm run test:watch",
      "npm run test:coverage",
    ]);
    expect(filterNpmSuggestions("npm run test:", SCRIPTS)).toEqual([
      "npm run test:watch",
      "npm run test:coverage",
    ]);
  });

  test("exact match still shows the suggestion", () => {
    expect(filterNpmSuggestions("npm run dev", SCRIPTS)).toEqual([
      "npm run dev",
    ]);
    expect(filterNpmSuggestions("npm run start", SCRIPTS)).toEqual([
      "npm run start",
    ]);
    expect(filterNpmSuggestions("npm run test", SCRIPTS)).toEqual([
      "npm run test",
      "npm run test:watch",
      "npm run test:coverage",
    ]);
  });

  test("no match returns empty", () => {
    expect(filterNpmSuggestions("npm run xyz", SCRIPTS)).toEqual([]);
    expect(filterNpmSuggestions("npm run foo", SCRIPTS)).toEqual([]);
  });

  test("case insensitive", () => {
    expect(filterNpmSuggestions("NPM RUN D", SCRIPTS)).toEqual(["npm run dev"]);
    expect(filterNpmSuggestions("Npm Run S", SCRIPTS)).toEqual([
      "npm run start",
      "npm run stop-dev",
    ]);
  });

  test("leading whitespace is ignored", () => {
    expect(filterNpmSuggestions("  npm run d", SCRIPTS)).toEqual([
      "npm run dev",
    ]);
  });

  test("extra spaces between npm and run are tolerated", () => {
    expect(filterNpmSuggestions("npm  run  d", SCRIPTS)).toEqual([
      "npm run dev",
    ]);
  });

  test("'npm s' matches start and stop-dev with shorthands", () => {
    expect(filterNpmSuggestions("npm s", SCRIPTS)).toEqual([
      "npm start",
      "npm run start",
      "npm run stop-dev",
    ]);
  });

  test("'npm t' matches test scripts with shorthand", () => {
    expect(filterNpmSuggestions("npm t", SCRIPTS)).toEqual([
      "npm test",
      "npm run test",
      "npm run test:watch",
      "npm run test:coverage",
    ]);
  });

  test("'npm start' exact shorthand match", () => {
    expect(filterNpmSuggestions("npm start", SCRIPTS)).toEqual([
      "npm start",
      "npm run start",
    ]);
  });

  test("'npm d' matches dev (no shorthand)", () => {
    expect(filterNpmSuggestions("npm d", SCRIPTS)).toEqual(["npm run dev"]);
  });

  // ── yarn ──────────────────────────────────────────────────────

  test("shows all scripts for partial 'y', 'ya', 'yar', 'yarn'", () => {
    for (const partial of ["y", "ya", "yar", "yarn"]) {
      expect(filterNpmSuggestions(partial, SCRIPTS)).toEqual(
        SCRIPTS.map((s) => `yarn run ${s}`),
      );
    }
  });

  test("'yarn run ' lists all scripts", () => {
    expect(filterNpmSuggestions("yarn run ", SCRIPTS)).toEqual(
      SCRIPTS.map((s) => `yarn run ${s}`),
    );
  });

  test("'yarn d' matches dev", () => {
    expect(filterNpmSuggestions("yarn d", SCRIPTS)).toEqual([
      "yarn dev",
      "yarn run dev",
    ]);
  });

  test("'yarn run d' matches dev", () => {
    expect(filterNpmSuggestions("yarn run d", SCRIPTS)).toEqual([
      "yarn run dev",
    ]);
  });

  test("'yarn dev' exact match", () => {
    expect(filterNpmSuggestions("yarn dev", SCRIPTS)).toEqual([
      "yarn dev",
      "yarn run dev",
    ]);
  });

  test("'yarn t' matches test scripts", () => {
    expect(filterNpmSuggestions("yarn t", SCRIPTS)).toEqual([
      "yarn test",
      "yarn run test",
      "yarn test:watch",
      "yarn run test:watch",
      "yarn test:coverage",
      "yarn run test:coverage",
    ]);
  });

  // ── bun ───────────────────────────────────────────────────────

  test("shows all scripts for partial 'b', 'bu', 'bun'", () => {
    for (const partial of ["b", "bu", "bun"]) {
      expect(filterNpmSuggestions(partial, SCRIPTS)).toEqual(
        SCRIPTS.map((s) => `bun run ${s}`),
      );
    }
  });

  test("'bun run ' lists all scripts", () => {
    expect(filterNpmSuggestions("bun run ", SCRIPTS)).toEqual(
      SCRIPTS.map((s) => `bun run ${s}`),
    );
  });

  test("'bun d' matches dev", () => {
    expect(filterNpmSuggestions("bun d", SCRIPTS)).toEqual([
      "bun dev",
      "bun run dev",
    ]);
  });

  test("'bun run d' matches dev", () => {
    expect(filterNpmSuggestions("bun run d", SCRIPTS)).toEqual(["bun run dev"]);
  });

  test("'bun dev' exact match", () => {
    expect(filterNpmSuggestions("bun dev", SCRIPTS)).toEqual([
      "bun dev",
      "bun run dev",
    ]);
  });

  test("'bun run dev' exact match stays visible", () => {
    expect(filterNpmSuggestions("bun run dev", SCRIPTS)).toEqual([
      "bun run dev",
    ]);
  });

  // ── bare script name ──────────────────────────────────────────

  test("bare script name suggests all runners", () => {
    expect(filterNpmSuggestions("dev", SCRIPTS)).toEqual([
      "npm run dev",
      "yarn dev",
      "bun dev",
    ]);
    expect(filterNpmSuggestions("build", SCRIPTS)).toEqual([
      "npm run build",
      "yarn build",
      "bun build",
      "npm run build:launch",
      "yarn build:launch",
      "bun build:launch",
    ]);
  });

  test("bare shorthand-eligible name includes npm shorthand", () => {
    expect(filterNpmSuggestions("start", SCRIPTS)).toEqual([
      "npm start",
      "npm run start",
      "yarn start",
      "bun start",
    ]);
    expect(filterNpmSuggestions("test", SCRIPTS)).toEqual([
      "npm test",
      "npm run test",
      "yarn test",
      "bun test",
      "npm run test:watch",
      "yarn test:watch",
      "bun test:watch",
      "npm run test:coverage",
      "yarn test:coverage",
      "bun test:coverage",
    ]);
  });

  test("bare partial matches all runners", () => {
    expect(filterNpmSuggestions("d", SCRIPTS)).toEqual([
      "npm run dev",
      "yarn dev",
      "bun dev",
    ]);
    expect(filterNpmSuggestions("st", SCRIPTS)).toEqual([
      "npm start",
      "npm run start",
      "yarn start",
      "bun start",
      "npm run stop-dev",
      "yarn stop-dev",
      "bun stop-dev",
    ]);
  });

  test("bare name no match returns empty", () => {
    expect(filterNpmSuggestions("xyz", SCRIPTS)).toEqual([]);
    expect(filterNpmSuggestions("foo", SCRIPTS)).toEqual([]);
  });

  test("bare name is case insensitive", () => {
    expect(filterNpmSuggestions("DEV", SCRIPTS)).toEqual([
      "npm run dev",
      "yarn dev",
      "bun dev",
    ]);
  });

  test("limits suggestions to package managers detected for the repo", () => {
    expect(
      filterNpmSuggestions("build", SCRIPTS, { packageManagers: ["bun"] }),
    ).toEqual(["bun build", "bun build:launch"]);
    expect(
      filterNpmSuggestions("npm run build", SCRIPTS, {
        packageManagers: ["bun"],
      }),
    ).toEqual([]);
    expect(
      filterNpmSuggestions("bun run build", SCRIPTS, {
        packageManagers: ["bun"],
      }),
    ).toEqual(["bun run build", "bun run build:launch"]);
  });
});

describe("npmScriptsPlaceholder", () => {
  test("returns default when no scripts", () => {
    expect(npmScriptsPlaceholder([])).toBe("npm run dev");
  });

  test("joins short script lists with commas", () => {
    expect(npmScriptsPlaceholder(["start", "dev"])).toBe("start, dev");
  });

  test("truncates long lists with ellipsis", () => {
    const many = [
      "start",
      "dev",
      "build",
      "test",
      "test:watch",
      "test:coverage",
      "lint",
      "format",
      "deploy",
    ];
    const result = npmScriptsPlaceholder(many);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result).toEndWith("...");
  });

  test("shows all if under 50 chars", () => {
    const scripts = ["dev", "build", "test"];
    const result = npmScriptsPlaceholder(scripts);
    expect(result).toBe("dev, build, test");
    expect(result).not.toContain("...");
  });
});
