import { describe, it, expect } from "bun:test";
import { findApiCalls } from "../src/api-call-audit";

/**
 * The parser behind the daemon-routing guard. If it miscounts daemonId
 * args or misreads a path, the guard's verdicts are worthless — so its
 * edge cases (templates, nested parens, comments, multiline calls) are
 * pinned here first.
 */

describe("findApiCalls — basic", () => {
  it("finds a bare local apiUrl call (no daemonId)", () => {
    const calls = findApiCalls(`fetch(apiUrl("/api/repos"))`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fn: "apiUrl",
      path: "/api/repos",
      hasDaemonId: false,
    });
  });

  it("detects a daemonId argument", () => {
    const calls = findApiCalls(`fetch(apiUrl("/api/repos", daemonId))`);
    expect(calls[0]!.hasDaemonId).toBe(true);
  });

  it("treats explicit undefined / null as no daemonId", () => {
    expect(findApiCalls(`apiUrl("/api/x", undefined)`)[0]!.hasDaemonId).toBe(false);
    expect(findApiCalls(`apiUrl("/api/x", null)`)[0]!.hasDaemonId).toBe(false);
  });

  it("strips a query string from the path prefix", () => {
    const calls = findApiCalls(`apiUrl("/api/diff?path=/x&all=1", d)`);
    expect(calls[0]!.path).toBe("/api/diff");
    expect(calls[0]!.hasDaemonId).toBe(true);
  });
});

describe("findApiCalls — apiWsUrl (daemonId is the 4th arg)", () => {
  it("reads daemonId from the 4th position", () => {
    const calls = findApiCalls(
      `apiWsUrl("/api/terminals/t/io", host, "ws:", daemonId)`,
    );
    expect(calls[0]).toMatchObject({
      fn: "apiWsUrl",
      path: "/api/terminals/t/io",
      hasDaemonId: true,
    });
  });

  it("flags a ws call missing the 4th arg as no daemonId", () => {
    const calls = findApiCalls(`apiWsUrl("/api/terminals/t/io", host, "ws:")`);
    expect(calls[0]!.hasDaemonId).toBe(false);
  });
});

describe("findApiCalls — template literals", () => {
  it("extracts the static prefix before an interpolation", () => {
    const calls = findApiCalls("apiUrl(`/api/session/${id}`, daemonId)");
    expect(calls[0]!.path).toBe("/api/session/");
    expect(calls[0]!.hasDaemonId).toBe(true);
  });

  it("does not let a comma inside ${} split the args", () => {
    // The fn call inside the interpolation has its own comma — must not be
    // read as the daemonId arg separator.
    const calls = findApiCalls("apiUrl(`/api/x/${fn(a, b)}`)");
    expect(calls[0]!.hasDaemonId).toBe(false);
    expect(calls[0]!.path).toBe("/api/x/");
  });

  it("handles a daemonId after a template path with interpolation", () => {
    const calls = findApiCalls(
      "apiUrl(`/api/repos/${repoId}/color`, daemonIdForRepoId(repos, repoId))",
    );
    expect(calls[0]!.path).toBe("/api/repos/");
    expect(calls[0]!.hasDaemonId).toBe(true);
  });
});

describe("findApiCalls — robustness", () => {
  it("ignores apiUrl mentioned in a // line comment", () => {
    expect(findApiCalls(`// see apiUrl("/api/x") above\nconst y = 1;`)).toHaveLength(
      0,
    );
  });

  it("ignores apiUrl mentioned in a /* block */ comment", () => {
    expect(
      findApiCalls(`/* apiUrl("/api/x") is the helper */ const y = 1;`),
    ).toHaveLength(0);
  });

  it("ignores an apiUrl substring inside a string literal", () => {
    expect(findApiCalls(`const s = "call apiUrl(/api/x) here";`)).toHaveLength(0);
  });

  it("handles a call split across multiple lines", () => {
    const src = `fetch(
      apiUrl(
        "/api/diff?path=" + encodeURIComponent(p),
        daemonId,
      ),
    )`;
    const calls = findApiCalls(src);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.hasDaemonId).toBe(true);
  });

  it("finds multiple calls in one source and reports line numbers", () => {
    const src = `a(apiUrl("/api/a"));\nb(apiUrl("/api/b", d));`;
    const calls = findApiCalls(src);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ path: "/api/a", hasDaemonId: false, line: 1 });
    expect(calls[1]).toMatchObject({ path: "/api/b", hasDaemonId: true, line: 2 });
  });

  it("returns null path for a computed first argument", () => {
    const calls = findApiCalls(`apiUrl(buildPath(x), daemonId)`);
    expect(calls[0]!.path).toBeNull();
    expect(calls[0]!.hasDaemonId).toBe(true);
  });

  it("does not match apiUrlSomething (word boundary)", () => {
    expect(findApiCalls(`apiUrlBuilder("/api/x")`)).toHaveLength(0);
  });
});
