import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

test("returning to the app restores session input focus without stealing other focus", { timeout: 30000 }, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const server = await createServer({
    root,
    configFile: false,
    resolve: { alias: { "@treetop/nicifier": resolve(root, "../nicifier/src/index.ts") } },
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
    });
    const page = await browser.newPage();
    await page.route("**/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<html><body></body></html>",
      }),
    );
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.setContent(`
      <div class="session-col"><textarea id="chat">draft text</textarea></div>
      <div class="session-col"><textarea id="terminal" class="xterm-helper-textarea"></textarea></div>
      <input id="search"><dialog><input id="modal"></dialog>
    `);
    const result = await page.evaluate(async () => {
      // Load the actual helper through Vite, with real DOM focus and events.
      const modulePath = "/src/session-window-focus.ts";
      const { installSessionWindowFocus } = await import(
        /* @vite-ignore */ modulePath
      );
      const dispose = installSessionWindowFocus(document, window);
      const el = (id: string) =>
        document.getElementById(id) as HTMLTextAreaElement;
      const leave = () => {
        window.dispatchEvent(new Event("blur"));
        (document.activeElement as HTMLElement).blur();
      };
      const returnToApp = async () => {
        window.dispatchEvent(new Event("focus"));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return document.activeElement?.id;
      };
      el("chat").focus();
      el("chat").setSelectionRange(2, 5);
      leave();
      const chat = await returnToApp();
      const selection = [el("chat").selectionStart, el("chat").selectionEnd];
      el("terminal").focus();
      leave();
      const terminal = await returnToApp();
      // Packaged WebView2 can emit only native activation notifications,
      // then report document focus a frame later than the host window.
      el("chat").focus();
      window.dispatchEvent(new CustomEvent("treetop:native-window-focus", { detail: { focused: false } }));
      el("chat").blur();
      const originalHasFocus = document.hasFocus.bind(document);
      let focusReady = false;
      document.hasFocus = () => focusReady;
      window.dispatchEvent(new CustomEvent("treetop:native-window-focus", { detail: { focused: true } }));
      await new Promise<void>(resolve => requestAnimationFrame(() => { focusReady = true; resolve(); }));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const nativeReturn = document.activeElement?.id;
      document.hasFocus = originalHasFocus;
      el("chat").blur();
      // The WebView may have missed deactivation while Windows suspended it.
      window.dispatchEvent(new CustomEvent("treetop:native-window-focus", { detail: { focused: true } }));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const nativeWithoutBlur = document.activeElement?.id;
      leave();
      el("search").focus();
      const search = await returnToApp();
      el("chat").focus();
      leave();
      document.querySelector("dialog")!.showModal();
      const modal = await returnToApp();
      document.querySelector("dialog")!.close();
      el("terminal").focus();
      leave();
      el("terminal").remove();
      const removed = await returnToApp();
      el("search").focus();
      leave();
      const outside = await returnToApp();
      el("chat").focus();
      leave();
      dispose();
      const disposed = await returnToApp();
      return {
        chat,
        selection,
        terminal,
        nativeReturn,
        nativeWithoutBlur,
        search,
        modal,
        removed,
        outside,
        disposed,
      };
    });
    assert.deepEqual(result, {
      chat: "chat",
      selection: [2, 5],
      terminal: "terminal",
      nativeReturn: "chat",
      nativeWithoutBlur: "chat",
      search: "search",
      modal: "modal",
      removed: "",
      outside: "",
      disposed: "",
    });
  } finally {
    await browser?.close();
    await server.close();
  }
});
