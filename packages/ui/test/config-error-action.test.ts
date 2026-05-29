/**
 * The config-error pill (TerminalView) used to vanish the moment you
 * clicked Open/Repair/Dismiss, giving no sign the click registered.
 * These tests pin the small state machine that now keeps the pill
 * visible: chosen action marked, spinner while in flight, confirmation
 * (or error) when it settles.
 */

import { test, expect, describe } from "bun:test";
import {
  startConfigAction,
  settleConfigAction,
  configButtonView,
} from "../src/config-error-action";

describe("config action lifecycle", () => {
  test("start puts the chosen kind into a pending state with a label", () => {
    const s = startConfigAction("open");
    expect(s.kind).toBe("open");
    expect(s.phase).toBe("pending");
    expect(s.message).toBe("Opening…");
  });

  test("settle ok → done with the default confirmation label", () => {
    const done = settleConfigAction(startConfigAction("repair"), true);
    expect(done.phase).toBe("done");
    expect(done.message).toBe("Repaired");
  });

  test("settle not-ok → error with the default error label", () => {
    const failed = settleConfigAction(startConfigAction("repair"), false);
    expect(failed.phase).toBe("error");
    expect(failed.message).toBe("Repair failed");
  });

  test("an explicit message overrides the default label", () => {
    const done = settleConfigAction(
      startConfigAction("open"),
      true,
      "Opened (notepad)",
    );
    expect(done.message).toBe("Opened (notepad)");
  });

  test("settle preserves the kind so the right button stays marked", () => {
    const done = settleConfigAction(startConfigAction("dismiss"), true);
    expect(done.kind).toBe("dismiss");
  });
});

describe("configButtonView", () => {
  test("with no active action every button is idle and enabled", () => {
    for (const k of ["open", "repair", "dismiss"] as const) {
      expect(configButtonView(k, null)).toEqual({
        active: false,
        spinner: false,
        disabled: false,
        phase: "idle",
      });
    }
  });

  test("while pending the chosen button spins and all are disabled", () => {
    const action = startConfigAction("repair");
    expect(configButtonView("repair", action)).toEqual({
      active: true,
      spinner: true,
      disabled: true,
      phase: "pending",
    });
    // Siblings: locked, no spinner, no active mark.
    expect(configButtonView("open", action)).toEqual({
      active: false,
      spinner: false,
      disabled: true,
      phase: "idle",
    });
  });

  test("a settled Open re-enables every button (non-committing action)", () => {
    const done = settleConfigAction(startConfigAction("open"), true);
    expect(configButtonView("open", done)).toEqual({
      active: true,
      spinner: false,
      disabled: false,
      phase: "done",
    });
    expect(configButtonView("dismiss", done).disabled).toBe(false);
  });

  test("a settled Repair keeps the whole pill locked (committing action)", () => {
    const done = settleConfigAction(startConfigAction("repair"), true);
    expect(configButtonView("repair", done)).toEqual({
      active: true,
      spinner: false,
      disabled: true,
      phase: "done",
    });
    expect(configButtonView("open", done).disabled).toBe(true);
  });

  test("a failed Repair surfaces the error phase on its button", () => {
    const failed = settleConfigAction(startConfigAction("repair"), false);
    expect(configButtonView("repair", failed).phase).toBe("error");
  });
});
