/**
 * Regression tests for the TerminalView "second-resume render bug" and
 * the "Resume doesn't autofocus" bug.
 *
 * What both bugs had in common: the WebSocket-open handler in
 * TerminalView.svelte didn't do anything beyond flipping `phase = "live"`.
 * That left two failure modes:
 *
 *  1. The spawn POST went out with whatever cols/rows xterm had at
 *     onMount time. On a fresh column that's correct, but on the
 *     SECOND Resume the column re-mounts mid-layout (neighbors
 *     re-flowing) — `fit.fit()` inside onMount returns stale
 *     dimensions, the daemon spawns zsh at one width while xterm's
 *     viewport ends up at another, and zle's prompt-width count is
 *     off → the user sees "cursor on an empty line below the $, only
 *     the last keypress visible." Fix: re-fit and re-send size from
 *     inside ws.onopen so by the time the user can type, both ends
 *     agree on dimensions.
 *
 *  2. Resume mounts the column without a user click, so xterm.focus()
 *     never gets called and keystrokes land on the page chrome. Fix:
 *     focusTerminal() from ws.onopen too.
 *
 * Driving a real Svelte mount + xterm + WS round-trip in a Bun
 * unit test is well beyond the test stack's scope (no DOM, no
 * @xterm/xterm) — so we pin the workaround as a source-level
 * regression guard. If a future cleanup pass strips the rAF /
 * sendResize / focusTerminal calls from ws.onopen, this test fails
 * loudly instead of the bugs returning silently.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dir, "../src/TerminalView.svelte"),
  "utf-8",
);

describe("TerminalView ws.onopen post-mount fixups", () => {
  /** Slice of SOURCE starting at the first `ws.onopen` line and ending
   *  at the next handler boundary (`ws.onmessage`). Lets us assert
   *  that the fixup calls live INSIDE the open handler, not somewhere
   *  unrelated in the file. */
  function onOpenBlock(): string {
    const openIdx = SOURCE.indexOf("ws.onopen");
    expect(openIdx, "ws.onopen not found in TerminalView").toBeGreaterThan(-1);
    const nextHandlerIdx = SOURCE.indexOf("ws.onmessage", openIdx);
    expect(
      nextHandlerIdx,
      "ws.onmessage not found after ws.onopen",
    ).toBeGreaterThan(openIdx);
    return SOURCE.slice(openIdx, nextHandlerIdx);
  }

  test("re-fits and re-sends size from ws.onopen (cursor-render fix)", () => {
    const block = onOpenBlock();
    // rAF defers the fit until layout has settled — without it we
    // re-measure during the same frame as the spawn POST, so we'd
    // re-confirm the same stale dimensions.
    expect(block).toContain("requestAnimationFrame");
    // The actual size correction: fit.fit() recomputes cols/rows and
    // sendResize() tells the daemon (which forwards SIGWINCH to zsh).
    expect(block).toContain("fit.fit()");
    expect(block).toContain("sendResize()");
  });

  test("autofocuses the xterm from ws.onopen (resume-focus fix)", () => {
    const block = onOpenBlock();
    expect(block).toContain("focusTerminal()");
  });

  test("phase flips to 'live' before the focus / resize fixups", () => {
    const block = onOpenBlock();
    // The fixups run on the same tick (or one rAF later), so the
    // user never sees a flash where xterm is focused but the
    // overlay says "starting…". Pin the order: phase first, then
    // the fixups inside rAF.
    const phaseIdx = block.indexOf('phase = "live"');
    const rafIdx = block.indexOf("requestAnimationFrame");
    expect(phaseIdx).toBeGreaterThan(-1);
    expect(rafIdx).toBeGreaterThan(phaseIdx);
  });
});
