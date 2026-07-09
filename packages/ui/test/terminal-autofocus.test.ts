import { test, expect, describe } from "bun:test";
import { shouldAutofocusOnWsOpen } from "../src/terminal-autofocus";

describe("shouldAutofocusOnWsOpen", () => {
  test("grabs focus when nothing (or <body>) is focused — the Resume/fresh-mount case", () => {
    expect(
      shouldAutofocusOnWsOpen({
        activeIsBodyOrNull: true,
        activeIsWithinThisTerminal: false,
        activeIsTextEntry: false,
      }),
    ).toBe(true);
  });

  test("grabs focus when the active element is already inside this terminal", () => {
    // A reconnect while the user is typing in THIS terminal — re-focusing is a
    // no-op and must not be treated as stealing.
    expect(
      shouldAutofocusOnWsOpen({
        activeIsBodyOrNull: false,
        activeIsWithinThisTerminal: true,
        activeIsTextEntry: true,
      }),
    ).toBe(true);
  });

  test("does NOT steal focus from a text-entry target elsewhere (another TUI, composer, search)", () => {
    expect(
      shouldAutofocusOnWsOpen({
        activeIsBodyOrNull: false,
        activeIsWithinThisTerminal: false,
        activeIsTextEntry: true,
      }),
    ).toBe(false);
  });

  test("still grabs focus when the elsewhere-focused element is not a text-entry target (a button, a div)", () => {
    // Brand-new / Resume via a click leaves focus on the button; the autofocus
    // contract still needs the terminal to take keystrokes.
    expect(
      shouldAutofocusOnWsOpen({
        activeIsBodyOrNull: false,
        activeIsWithinThisTerminal: false,
        activeIsTextEntry: false,
      }),
    ).toBe(true);
  });
});
