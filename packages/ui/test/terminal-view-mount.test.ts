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

describe("TerminalView clipboard paste", () => {
  /** xterm.js's default keydown for Ctrl+V (Win/Linux) sends a literal
   *  0x16 SYN byte AND calls preventDefault on the keydown, which kills
   *  the browser's native paste event before it can fire. Result on
   *  Windows: pressing Ctrl+V in the TUI silently does nothing — neither
   *  text nor image pastes round-trip. The fix routes Ctrl/Cmd+V through
   *  attachCustomKeyEventHandler + the async Clipboard API instead. If a
   *  future refactor drops either piece this test fails loudly so paste
   *  doesn't break on Windows again. */
  test("intercepts Ctrl/Cmd+V via attachCustomKeyEventHandler", () => {
    expect(SOURCE).toContain("attachCustomKeyEventHandler");
    // The handler must look at KeyV specifically, not the broader keydown
    // stream (otherwise we'd swallow unrelated shortcuts).
    expect(SOURCE).toMatch(/code\s*===\s*["']KeyV["']/);
    // And it must route to our own clipboard reader rather than letting
    // xterm send the 0x16 SYN byte.
    expect(SOURCE).toContain("doClipboardPaste");
  });

  test("doClipboardPaste reads images + text via async Clipboard API", () => {
    // Images route through the same /api/attach + path-insertion as
    // drag-drop (uploadAndInsert); text routes through xterm.paste()
    // so bracketed-paste mode keeps working.
    expect(SOURCE).toContain("navigator.clipboard.read");
    expect(SOURCE).toMatch(/uploadAndInsert\(blob\)/);
    expect(SOURCE).toMatch(/xterm\??\.paste\(text\)/);
  });

  test("paste event listener stays in capture phase", () => {
    // xterm.js's bubble-phase paste listener on its helper textarea
    // calls stopPropagation, so a bubble-phase on:paste here would
    // never fire. Capture phase runs first; without it the image-paste
    // fallback (right-click → Paste, touch paste menus) is dead.
    expect(SOURCE).toContain("on:paste|capture={onPaste}");
  });
});
