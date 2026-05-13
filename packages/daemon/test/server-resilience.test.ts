/**
 * Regression test for the Bun.serve wedge we hit in 1.3.x where a
 * request that exceeded the default 10s idleTimeout would cause the
 * listener to silently stop accepting new connections (process alive,
 * port still bound, but no responses). Symptom in the prod log:
 *
 *   [Bun.serve]: request timed out after 10 seconds. Pass `idleTimeout`
 *   to configure.
 *
 * …followed by silence and a daemon that responded with TCP "connection
 * refused"-equivalents from curl.
 *
 * The mitigation in `server.ts` is:
 *  - explicit `idleTimeout: 30` so legitimate long ops (large /api/diff,
 *    first /api/session parse of a 100 MB JSONL, /api/fetch over a slow
 *    network) complete instead of getting nuked at 10s.
 *  - an `error()` callback so any handler escape gets recorded in the
 *    ErrorLog + broadcast over SSE instead of dying silently.
 *
 * Spinning up Bun.serve in a unit test to reproduce the wedge is more
 * trouble than it's worth (the bug is Bun-side; we'd be testing Bun).
 * Instead, this test guards the *workaround*: it reads server.ts and
 * asserts the canonical mitigation lines are present, so a future
 * "cleanup" pass doesn't quietly strip them and reintroduce the wedge.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_TS = readFileSync(
  join(import.meta.dir, "../src/server.ts"),
  "utf-8",
);

describe("shellCwds / shellTermIds are hoisted above Bun.serve (TDZ guard)", () => {
  // Regression: prod /api/errors snapshot included 7× "Cannot access
  // 'shellCwds' before initialization" on /api/shells → 500. Route
  // handlers inside `Bun.serve(...)` close over these maps, and
  // `Bun.serve(...)` returns synchronously and starts accepting
  // connections immediately — so any request that lands between
  // `Bun.serve` returning and the late `const` evaluating throws a TDZ
  // ReferenceError. The fix is to declare them above `Bun.serve(...)`;
  // this test makes sure they don't drift back down.
  function lineOf(needle: RegExp): number {
    const lines = SERVER_TS.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (needle.test(lines[i]!)) return i + 1;
    }
    return -1;
  }

  test("shellCwds is declared before Bun.serve(...)", () => {
    const decl = lineOf(/^const shellCwds\b/);
    const serve = lineOf(/^const server = Bun\.serve\b/);
    expect(decl, "shellCwds declaration not found").toBeGreaterThan(0);
    expect(serve, "Bun.serve declaration not found").toBeGreaterThan(0);
    expect(decl, "shellCwds must be hoisted above Bun.serve").toBeLessThan(
      serve,
    );
  });

  test("shellTermIds is declared before Bun.serve(...)", () => {
    const decl = lineOf(/^const shellTermIds\b/);
    const serve = lineOf(/^const server = Bun\.serve\b/);
    expect(decl, "shellTermIds declaration not found").toBeGreaterThan(0);
    expect(serve, "Bun.serve declaration not found").toBeGreaterThan(0);
    expect(decl, "shellTermIds must be hoisted above Bun.serve").toBeLessThan(
      serve,
    );
  });
});

describe("Bun.serve wedge workaround stays in place", () => {
  test("idleTimeout is set explicitly", () => {
    // The exact value can change, but it must be set and non-zero.
    const m = SERVER_TS.match(/idleTimeout\s*:\s*(\d+)/);
    expect(m, "expected `idleTimeout: N` in Bun.serve config").not.toBeNull();
    const seconds = Number(m![1]);
    expect(seconds, "idleTimeout must be > 10 (Bun's default)").toBeGreaterThan(10);
  });

  test("Bun.serve has an error() escape-hatch callback", () => {
    // Either `error(...)` short-method or `error: (...) =>` long-form.
    const hasErrorCb =
      /\berror\s*\(\s*\w+\s*:\s*Error\s*\)/.test(SERVER_TS) ||
      /\berror\s*:\s*(?:async\s+)?\(/.test(SERVER_TS);
    expect(hasErrorCb, "Bun.serve must have an error() callback to log + persist escapes")
      .toBe(true);
  });

  test("error() callback records into the errors log", () => {
    // The error callback funnels through `errors.append({ kind: 'server',
    // source: 'daemon', … })`. The exact whitespace varies (multi-line
    // chained call), so match a regex that tolerates newlines.
    const cbBlockMatch = SERVER_TS.match(/error\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/);
    expect(cbBlockMatch, "couldn't isolate the error() callback body").not.toBeNull();
    const body = cbBlockMatch![1]!;
    expect(/errors\s*[\.\n]\s*\.?\s*append\s*\(/.test(body)).toBe(true);
    expect(body).toContain('kind: "server"');
    expect(body).toContain('source: "daemon"');
  });
});
