import { describe, expect, test } from "bun:test";
import { uiStaticRequestPath } from "../src/ui-static";

describe("uiStaticRequestPath", () => {
  test("routes the dashboard and replay lab to separate html entrypoints", () => {
    expect(uiStaticRequestPath("/")).toBe("/index.html");
    expect(uiStaticRequestPath("/replay-lab")).toBe("/replay-lab.html");
    expect(uiStaticRequestPath("/replay-lab/")).toBe("/replay-lab.html");
    expect(uiStaticRequestPath("/codex-replay")).toBe("/replay-lab.html");
    expect(uiStaticRequestPath("/codex-replay/")).toBe("/replay-lab.html");
  });

  test("leaves static asset and app subresource paths untouched", () => {
    expect(uiStaticRequestPath("/assets/index.js")).toBe("/assets/index.js");
    expect(uiStaticRequestPath("/favicon.svg")).toBe("/favicon.svg");
  });
});
