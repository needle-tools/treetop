import { test, expect, describe } from "bun:test";
import { resolveImagePasteBehavior } from "../src/terminal-image-paste";

describe("resolveImagePasteBehavior", () => {
  test("auto: codex reads clipboard bytes → direct", () => {
    expect(resolveImagePasteBehavior("auto", "codex")).toBe("direct");
  });

  test("auto: claude does not → attachment (the regression we are fixing)", () => {
    expect(resolveImagePasteBehavior("auto", "claude")).toBe("attachment");
  });

  test("auto: copilot / ollama / shell / unknown all fall back to attachment", () => {
    for (const agent of ["copilot", "ollama", "shell", "what", undefined]) {
      expect(resolveImagePasteBehavior("auto", agent)).toBe("attachment");
    }
  });

  test("explicit overrides win regardless of agent", () => {
    // A user who set 'direct' globally gets direct even on claude...
    expect(resolveImagePasteBehavior("direct", "claude")).toBe("direct");
    // ...and 'attachment' forces the path flow even on codex.
    expect(resolveImagePasteBehavior("attachment", "codex")).toBe("attachment");
  });

  test("missing / unknown setting is treated as auto", () => {
    expect(resolveImagePasteBehavior(undefined, "codex")).toBe("direct");
    expect(resolveImagePasteBehavior("", "claude")).toBe("attachment");
  });
});
