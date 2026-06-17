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

describe("TerminalView onDestroy socket teardown", () => {
  /** Slice of SOURCE covering the onDestroy callback body, ending at the
   *  next top-level function declaration. */
  function onDestroyBlock(): string {
    const idx = SOURCE.indexOf("onDestroy(");
    expect(idx, "onDestroy not found in TerminalView").toBeGreaterThan(-1);
    const endIdx = SOURCE.indexOf("function focusTerminal", idx);
    expect(endIdx, "focusTerminal not found after onDestroy").toBeGreaterThan(
      idx,
    );
    return SOURCE.slice(idx, endIdx);
  }

  /** Regression guard for the "TUI opens and closes immediately" bug.
   *
   *  onDestroy closes the terminal WS so the daemon can grace-reap the
   *  orphaned PTY. But ws.onclose treats ANY clean code-1000 close as a
   *  PTY exit and calls onExit() — which makes the parent (SessionView)
   *  flip the column from terminal mode back to read mode. On a plain
   *  unmount that's wrong: the PTY is still alive on the daemon. The
   *  damage shows when the column merely REMOUNTS (Svelte {#key} bump on
   *  a model/effort switch, a settings-store tick, or a poll re-render):
   *  the dying instance's delayed onclose fires onExit and tears down the
   *  freshly-mounted replacement → the TUI appears to open and close
   *  immediately, leaving a live orphaned PTY behind each time.
   *
   *  The fix mirrors the retry / attach-fallback paths: detachSocket(ws)
   *  (which nulls onopen/onmessage/onerror/onclose) BEFORE ws.close, so a
   *  deliberate unmount never reports a phantom exit. */
  test("detaches socket handlers before closing on unmount", () => {
    const block = onDestroyBlock();
    const detachIdx = block.indexOf("detachSocket(ws)");
    const closeIdx = block.indexOf('ws.close(1000, "unmount")');
    expect(
      detachIdx,
      "onDestroy must call detachSocket(ws) before closing the socket",
    ).toBeGreaterThan(-1);
    expect(
      closeIdx,
      "onDestroy must close the socket on unmount",
    ).toBeGreaterThan(-1);
    // detach must precede close, else onclose's code-1000 branch fires
    // onExit() and the unmount is misreported as a PTY exit.
    expect(detachIdx).toBeLessThan(closeIdx);
  });

  test("reports idle before unmounting so dock state cannot stick working", () => {
    const block = onDestroyBlock();
    const clearIdx = block.indexOf("setCurrentWorking(false)");
    const closeIdx = block.indexOf('ws.close(1000, "unmount")');
    expect(
      clearIdx,
      "onDestroy must publish working=false before teardown",
    ).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(closeIdx);
  });
});

describe("TerminalView working idle state", () => {
  function workingTickerBlock(): string {
    const idx = SOURCE.indexOf("workingTicker = setInterval");
    expect(idx, "workingTicker not found in TerminalView").toBeGreaterThan(-1);
    const endIdx = SOURCE.indexOf("}, 500);", idx);
    expect(endIdx, "workingTicker interval end not found").toBeGreaterThan(idx);
    return SOURCE.slice(idx, endIdx);
  }

  test("byte-silence can lower working even while the column is offscreen", () => {
    const block = workingTickerBlock();
    expect(block).toContain("currentWorking");
    expect(block).toContain("Date.now() - lastActivityTs > WORKING_IDLE_MS");
    expect(block).not.toContain("isTerminalVisible &&");
  });
});

describe("TerminalView clipboard copy + paste", () => {
  /** xterm.js's default keydown for Ctrl+V (Win/Linux) sends a literal
   *  0x16 SYN byte AND calls preventDefault on the keydown, which kills
   *  the browser's native paste event before it can fire. Ctrl+C has the
   *  symmetric bug — maps to 0x03 ETX + preventDefault, so the browser's
   *  copy event never runs and selected TUI text can't reach the system
   *  clipboard. Both shortcuts now route through attachCustomKeyEventHandler
   *  + the async Clipboard API; if a future refactor drops either piece
   *  this test fails loudly so copy/paste don't silently break on Windows
   *  again. */
  test("intercepts Ctrl/Cmd+V via attachCustomKeyEventHandler", () => {
    expect(SOURCE).toContain("attachCustomKeyEventHandler");
    // The handler must look at KeyV specifically, not the broader keydown
    // stream (otherwise we'd swallow unrelated shortcuts).
    expect(SOURCE).toMatch(/code\s*===\s*["']KeyV["']/);
    // And it must route text paste to our own clipboard reader; image
    // paste may intentionally forward a native paste key to the PTY.
    expect(SOURCE).toContain("doClipboardPaste");
  });

  test("doClipboardPaste reads images + text via async Clipboard API", () => {
    // Images can still route through the same /api/attach + path-insertion
    // as drag-drop (uploadAndInsert); text routes through xterm.paste()
    // so bracketed-paste mode keeps working.
    expect(SOURCE).toContain("navigator.clipboard.read");
    expect(SOURCE).toMatch(/uploadAndInsert\(blob\)/);
    expect(SOURCE).toMatch(/xterm\??\.paste\(text\)/);
  });

  test("intercepts Ctrl/Cmd+C and copies the TUI selection", () => {
    // Selection-gated copy: must check hasSelection() before swallowing
    // the keystroke so plain Ctrl+C with no selection still sends ETX
    // (interrupt) — otherwise we'd silently break SIGINT in the TUI.
    expect(SOURCE).toMatch(/code\s*===\s*["']KeyC["']/);
    expect(SOURCE).toMatch(/xterm\??\.hasSelection\(\)/);
    expect(SOURCE).toMatch(/getCleanedSelection\(xterm\)/);
    expect(SOURCE).toContain("copyToClipboard(sel)");
  });

  /** copyToClipboard wraps the async Clipboard API with an
   *  execCommand("copy") fallback. WebView2 and other strict-Permissions
   *  contexts silently reject `navigator.clipboard.writeText` even when
   *  the keydown is a trusted user gesture — observed on Windows where
   *  Ctrl+C-with-selection felt like it "did nothing" because the
   *  promise rejected and a `.catch(() => {})` swallowed it. The
   *  legacy execCommand path uses a transient offscreen textarea that
   *  honors the same trusted-gesture rule but takes the
   *  selection-based clipboard route the WebView allows. If a future
   *  refactor drops either path or quietly removes the warning,
   *  Windows users lose Ctrl+C silently again — this test fails loud. */
  test("copyToClipboard tries async Clipboard API then execCommand fallback", () => {
    // Helper exists and is the single point of clipboard-write.
    expect(SOURCE).toMatch(/function copyToClipboard\(text: string\)/);
    const fnIdx = SOURCE.indexOf("function copyToClipboard");
    // 600-char window is comfortably larger than the helper body
    // (~50 lines) but small enough not to bleed into the next handler.
    const body = SOURCE.slice(fnIdx, fnIdx + 1600);
    // Async API attempted first.
    expect(body).toContain("navigator.clipboard?.writeText");
    // Legacy fallback wired with the offscreen-textarea + execCommand
    // dance — required for WebView2 / clipboard-permission lockdowns.
    expect(body).toContain('document.execCommand("copy")');
    expect(body).toMatch(/createElement\(["']textarea["']\)/);
    // Surface failures so a silent dropped Ctrl+C is debuggable
    // instead of a mystery.
    expect(body).toContain("console.warn");
  });

  test("paste event listener stays in capture phase", () => {
    // xterm.js's bubble-phase paste listener on its helper textarea
    // calls stopPropagation, so a bubble-phase on:paste here would
    // never fire. Capture phase runs first; without it the image-paste
    // fallback (right-click → Paste, touch paste menus) is dead.
    expect(SOURCE).toContain("on:paste|capture={onPaste}");
  });

  /** Windows console copy/paste keystrokes — Shift+Insert pastes,
   *  Ctrl+Insert copies. cmd.exe and the Win32 console treat these as
   *  the canonical clipboard shortcuts (Ctrl+C is interrupt there by
   *  default), so a Windows user running `cmd` or `powershell` in a
   *  terminal column needs them wired. Both route through the same
   *  doClipboardPaste / selection-writeText path as Ctrl+V / Ctrl+C,
   *  and the handlers must sit BEFORE the modOnly Ctrl/Cmd gate or
   *  Shift+Insert (no Ctrl) would get filtered out. */
  test("intercepts Shift+Insert as paste (Windows console convention)", () => {
    expect(SOURCE).toMatch(/code\s*===\s*["']Insert["']/);
    // The Shift+Insert branch must call our async-Clipboard paste path
    // and live INSIDE the Insert block (between the code === "Insert"
    // check and its closing brace), not somewhere unrelated in the file.
    const insertIdx = SOURCE.indexOf('ev.code === "Insert"');
    expect(insertIdx).toBeGreaterThan(-1);
    // Grab a generous slice and assert the branch + behavior live together.
    const block = SOURCE.slice(insertIdx, insertIdx + 800);
    expect(block).toMatch(/ev\.shiftKey[\s\S]*doClipboardPaste\(\)/);
  });

  test("intercepts Ctrl+Insert as copy when there is a selection", () => {
    const insertIdx = SOURCE.indexOf('ev.code === "Insert"');
    expect(insertIdx).toBeGreaterThan(-1);
    const block = SOURCE.slice(insertIdx, insertIdx + 800);
    // Selection-gated copy mirrors the Ctrl+C handler: hasSelection()
    // first, then getCleanedSelection + copyToClipboard. Same gating
    // so a bare Ctrl+Insert with no selection becomes a no-op rather
    // than silently overwriting the clipboard with an empty string.
    expect(block).toMatch(/ev\.ctrlKey[\s\S]*hasSelection\(\)/);
    expect(block).toMatch(/getCleanedSelection\(xterm\)/);
    expect(block).toContain("copyToClipboard(sel)");
  });

  /** Capture-phase Ctrl+C copy on Windows/Linux. Mirrors the macOS
   *  Cmd+C branch and exists because xterm.js's own keydown handler
   *  can clear / mutate selection state between the raw keydown and
   *  attachCustomKeyEventHandler firing — observed under cmd.exe and
   *  PowerShell PTYs where the selection visibly highlights but plain
   *  Ctrl+C feels like it "did nothing." Reading + writing in capture
   *  phase pins the selection read and clipboard write to the earliest
   *  possible moment. */
  test("Ctrl+C copies selection in capture phase on Windows/Linux", () => {
    // The handler must live inside the capture-phase container listener
    // (third arg `true` to addEventListener), not in attachCustomKeyEventHandler
    // — that's the whole point of the redundancy.
    // Match against a whitespace-collapsed copy so Prettier's wrapping
    // (splitting `addEventListener("keydown", handler, true)` across lines
    // and adding trailing commas) doesn't break this structural check —
    // the contract is the handler's placement, not its line layout.
    const flat = SOURCE.replace(/\s+/g, " ");
    const captureIdx = flat.search(
      /containerEl\.addEventListener\(\s*"keydown"/,
    );
    expect(captureIdx).toBeGreaterThan(-1);
    // The capture-phase registration closes with `, true)` (capture=true),
    // possibly with a trailing comma before the paren.
    const closeRel = flat.slice(captureIdx).search(/}\s*,\s*true\s*,?\s*\)/);
    expect(closeRel).toBeGreaterThan(-1);
    const captureBlock = flat.slice(captureIdx, captureIdx + closeRel);
    // The non-Mac branch must gate on ctrlKey (not metaKey), require
    // an existing selection, and route through copyToClipboard (which
    // owns the async-API + execCommand fallback). If any of these are
    // missing the handler is either Mac-only or silently overwrites
    // the clipboard with an empty string.
    expect(captureBlock).toMatch(/!isMac[\s\S]*ev\.ctrlKey/);
    expect(captureBlock).toMatch(
      /code\s*===\s*["']KeyC["'][\s\S]*hasSelection\(\)/,
    );
    expect(captureBlock).toMatch(/getCleanedSelection\(xterm\)/);
    expect(captureBlock).toContain("copyToClipboard(sel)");
  });

  test("Insert handler runs before the modOnly Ctrl/Cmd gate", () => {
    // Shift+Insert has no Ctrl on Windows, and modOnly is
    // `ctrlKey && !metaKey`, so if the Insert block were placed after
    // the `if (!modOnly) return true;` guard it would never fire and
    // Shift+Insert would fall through to xterm's default (which emits
    // the bare Insert escape sequence — not what the user wants).
    const insertIdx = SOURCE.indexOf('ev.code === "Insert"');
    const modOnlyIdx = SOURCE.indexOf("const modOnly");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(modOnlyIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeLessThan(modOnlyIdx);
  });
});

describe("TerminalView hidden terminal output", () => {
  test("preserves hidden output when the buffer cap is hit", () => {
    const binaryIdx = SOURCE.indexOf("// Binary frame = raw PTY output.");
    expect(binaryIdx).toBeGreaterThan(-1);
    const noteIdx = SOURCE.indexOf("noteActivity();", binaryIdx);
    expect(noteIdx).toBeGreaterThan(binaryIdx);
    const block = SOURCE.slice(binaryIdx, noteIdx);
    expect(block).toContain("writeBuffer.push(bytes)");
    expect(block).toContain("flushBufferedTerminalOutput()");
    expect(block).toContain("xterm?.write(batch)");
    expect(block).not.toContain("console.warn");
    expect(block).not.toContain("skipped hidden terminal output");
    const helperIdx = SOURCE.indexOf("function flushBufferedTerminalOutput()");
    expect(helperIdx).toBeGreaterThan(-1);
    const helperEnd = SOURCE.indexOf("function clearStartupGuard", helperIdx);
    const helper = SOURCE.slice(helperIdx, helperEnd);
    expect(helper).toContain("writeBuffer.flush()");
    expect(helper).toContain("hiddenFlushes += 1");
  });

  test("flushes the retained hidden-output tail only on a (deferred) reveal", () => {
    // The flush moved from the observer into the scroll-gated reveal reconcile
    // (so a scroll doesn't fire it per column-crossing), but it still only runs
    // when this terminal is the reconcile's *visible* target.
    const idx = SOURCE.indexOf("function scheduleRevealReconcile");
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf("\n  const writeBuffer", idx);
    const block = SOURCE.slice(idx, end > idx ? end : idx + 1800);
    // Hidden branch returns early; flush is in the visible branch.
    expect(block).toContain("if (!revealReconcileTarget)");
    expect(block).toContain("flushBufferedTerminalOutput()");
    expect(block).toContain("xterm.write(batch)");
    expect(block).toContain("resizeCoalescer?.trigger()");
  });

  test("reports visibility to the daemon so hidden PTY output can be muted", () => {
    expect(SOURCE).toContain("function sendVisibilityState()");
    // Visibility reported to the daemon gates on BOTH the IntersectionObserver
    // (in-viewport geometry) AND document visibility: a backgrounded / occluded
    // window's socket stops draining, so it must report hidden or the daemon
    // buffers its output without bound. See the OOM regression note in
    // terminal-backlog.ts.
    expect(SOURCE).toContain("isTerminalVisible && !document.hidden");
    expect(SOURCE).toContain(
      'JSON.stringify({ type: "visibility", visible, drain })',
    );
    expect(SOURCE).toContain(
      'document.addEventListener("visibilitychange"',
    );
    const openIdx = SOURCE.indexOf("ws.onopen = () =>");
    expect(openIdx).toBeGreaterThan(-1);
    const messageIdx = SOURCE.indexOf("ws.onmessage", openIdx);
    expect(SOURCE.slice(openIdx, messageIdx)).toContain(
      "sendVisibilityState()",
    );
    const observerIdx = SOURCE.indexOf("new IntersectionObserver");
    const resizeIdx = SOURCE.indexOf("resizeCoalescer?.trigger()", observerIdx);
    const block = SOURCE.slice(observerIdx, resizeIdx);
    expect(block).toContain("isTerminalVisible = visible");
    expect(block).toContain("sendVisibilityState()");
    expect(SOURCE).toContain("OUTPUT_VISIBILITY_ROOT_MARGIN");
    expect(SOURCE).toContain(
      "{ rootMargin: OUTPUT_VISIBILITY_ROOT_MARGIN, threshold: 0 }",
    );
  });

  test("reports whether a hidden terminal socket can still drain output", () => {
    const idx = SOURCE.indexOf("function sendVisibilityState()");
    expect(idx).toBeGreaterThan(-1);
    const end = SOURCE.indexOf("function publishTerminalIoStats", idx);
    const block = SOURCE.slice(idx, end);
    expect(block).toContain("const drain = !document.hidden");
    expect(block).toContain('JSON.stringify({ type: "visibility", visible, drain })');
  });

  test("has an opt-in terminal I/O debug readout", () => {
    expect(SOURCE).toContain('settingValue("terminal.showIoDebug")');
    expect(SOURCE).toContain("rxBytesPerSec");
    expect(SOURCE).toContain("txBytesPerSec");
    expect(SOURCE).toContain("term-io-debug");
    expect(SOURCE).toContain(' <span aria-hidden="true">·</span> ');
    expect(SOURCE).toContain("sendTerminalInput(data)");
  });

  test("repaint debug uses xterm decorations, not a standalone text overlay", () => {
    expect(SOURCE).toContain("registerDecoration");
    expect(SOURCE).not.toContain("term-repaint-overlay");
    expect(SOURCE).not.toContain("syncRepaintOverlayGeometry");
  });

  test("repaint flash and scale controls stay independent", () => {
    expect(SOURCE).toContain("...(repaintFlashEnabled");
    expect(SOURCE).toContain(
      'glyph.className = "term-repaint-glyph"',
    );
    expect(SOURCE).toContain("element.replaceChildren(glyph)");
    expect(SOURCE).toContain(
      "foregroundColor: repaintFlashEnabled\n                ? REPAINT_DEBUG_FOREGROUND\n                : TERMINAL_THEME_BACKGROUND",
    );
    expect(SOURCE).toContain(
      ":global(.terminal-wrap .xterm-decoration.term-repaint-decoration) {\n    display: block;",
    );
    expect(SOURCE).toContain("line-height: 1.15;");
    expect(SOURCE).toContain("82% {\n      transform: scale(1);");
    expect(SOURCE).toContain(
      ":global(.terminal-wrap .xterm-decoration.term-repaint-decoration.scale) {\n    overflow: visible;",
    );
    expect(SOURCE).toContain(".term-repaint-glyph");
    expect(SOURCE).not.toContain(
      ".terminal-wrap.repaint-debug-scale\n        .xterm-rows",
    );
  });
});

describe("TerminalView web links", () => {
  test("routes WebLinksAddon activation through the shared openUrl helper", () => {
    expect(SOURCE).toContain('import { openUrl } from "./open-url"');
    const addonIdx = SOURCE.indexOf("new WebLinksAddon");
    expect(addonIdx).toBeGreaterThan(-1);
    const block = SOURCE.slice(addonIdx, addonIdx + 500);
    expect(block).toContain("event.preventDefault()");
    expect(block).toContain("event.stopPropagation()");
    expect(block).toContain("openUrl(uri)");
    expect(block).not.toContain('fetch(apiUrl("/api/open-default")');
  });
});
