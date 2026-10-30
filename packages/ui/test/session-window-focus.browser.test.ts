import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

test("a visible new terminal starts despite stale ancestor animation hints", {timeout:60000}, async () => {
  const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
  const server=await createServer({root,configFile:false,
    plugins:[svelte({compilerOptions:{compatibility:{componentApi:4}}})],
    resolve:{alias:{"@treetop/nicifier":resolve(root,"../nicifier/src/index.ts")}},
    server:{host:"127.0.0.1",port:0,hmr:false},logLevel:"error",
  });
  let browser;
  try {
    await server.listen();const address=server.httpServer!.address();assert(address&&typeof address!=="string");
    browser=await chromium.launch({channel:process.platform==="win32"?"msedge":"chrome",headless:true,timeout:20000});
    const page=await browser.newPage();let spawns=0;
    const pageErrors:string[]=[];
    page.on("pageerror",error=>{if(pageErrors.length<2)pageErrors.push(error.stack ?? error.message);});
    await page.route("**/api/**",route=>{
      if(route.request().method()==="POST"&&new URL(route.request().url()).pathname==="/api/terminals") {
        spawns++;return route.fulfill({json:{id:"test-terminal",pid:1}});
      }
      return route.fulfill({json:{}});
    });
    await page.route("**/",route=>route.fulfill({contentType:"text/html",body:'<div class="row row-offscreen"><div class="session-col col-offscreen" style="width:600px;height:500px"><div id="target"></div></div></div>'}));
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.evaluate(async()=>{
      const path="/src/NewSessionCol.svelte";
      const {default:Col}=await import(/* @vite-ignore */path);
      (window as any).Col=Col;
    });
    const spawn=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/terminals",{timeout:5000});
    await page.evaluate(()=>{
      (window as any).col=new (window as any).Col({target:document.querySelector("#target"),props:{
        agent:"shell",source:"__new__:shell:visibility-probe",wtPath:"C:/probe",cwd:"C:/probe",cmd:["cmd.exe"],procName:"probe",spawnReady:true,
      }});
    });
    try {await spawn;} catch(error) {
      console.error(JSON.stringify({pageErrors,rect:await page.locator("#target").boundingBox()}));
      throw error;
    }
    assert.equal(spawns,1);
    assert.equal(await page.locator(".col-offscreen").count(),1);
    await page.evaluate(async()=>{
      (window as any).col.$destroy();
      const target=document.querySelector<HTMLElement>("#target")!;
      target.style.marginTop="5000px";
      (window as any).col=new (window as any).Col({target,props:{
        agent:"shell",source:"__new__:shell:offscreen-probe",wtPath:"C:/probe",cwd:"C:/probe",cmd:["cmd.exe"],procName:"probe",spawnReady:true,
      }});
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    });
    assert.equal(spawns,1);
    assert.equal(await page.locator(".session-body-deferred").count(),1);
    const revealed=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/terminals",{timeout:5000});
    await page.locator("#target").scrollIntoViewIfNeeded();
    await revealed;assert.equal(spawns,2);
    await page.evaluate(async()=>{
      (window as any).col.$destroy();
      const target=document.querySelector<HTMLElement>("#target")!;
      target.style.marginTop="0";target.parentElement!.style.display="none";
      (window as any).col=new (window as any).Col({target,props:{
        agent:"shell",source:"__new__:shell:hidden-probe",wtPath:"C:/probe",cwd:"C:/probe",cmd:["cmd.exe"],procName:"probe",spawnReady:true,
      }});
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    });
    assert.equal(spawns,2);
    assert.equal(await page.locator(".session-body-deferred").count(),1);
    await page.evaluate(()=>{(window as any).col.$destroy();});
  } finally {await browser?.close();await server.close();}
});

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
      <div class="session-col" data-session-source="chat-session"><textarea id="chat">draft text</textarea></div>
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
      let refocused = 0;
      el("chat").addEventListener("focus", () => refocused++);
      // A delayed native activation duplicates the ordinary focus event. It
      // must not blur/refocus the caret the user has already started using.
      window.dispatchEvent(new CustomEvent("treetop:native-window-focus", { detail: { focused: true } }));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const nativeSameInput = refocused === 0 && document.activeElement?.id === "chat";
      // A later activation with a missed blur must still repair routing.
      await new Promise(resolve => setTimeout(resolve, 1050));
      window.dispatchEvent(new CustomEvent("treetop:native-window-focus", {detail:{focused:true}}));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const nativeLaterRepair = refocused > 0 && document.activeElement?.id === "chat";
      leave();
      el("chat").closest(".session-col")!.setAttribute("data-session-source", "chat-session");
      el("chat").outerHTML = '<textarea id="chat">draft text</textarea>';
      const replacedInput = await returnToApp();
      leave();
      el("chat").closest(".session-col")!.outerHTML = '<div class="session-col" data-session-source="chat-session"><textarea id="chat">draft text</textarea></div>';
      const replacedColumn = await returnToApp();
      leave();
      let delayedFocusReady = false;
      document.hasFocus = () => delayedFocusReady;
      window.dispatchEvent(new CustomEvent("treetop:native-window-focus", { detail: { focused: true } }));
      await new Promise(resolve => setTimeout(resolve, 650));
      delayedFocusReady = true;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const slowNativeReturn = document.activeElement?.id;
      document.hasFocus = originalHasFocus;
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
        nativeSameInput,
        nativeLaterRepair,
        replacedInput,
        replacedColumn,
        slowNativeReturn,
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
      nativeSameInput: true,
      nativeLaterRepair: true,
      replacedInput: "chat",
      replacedColumn: "chat",
      slowNativeReturn: "chat",
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
