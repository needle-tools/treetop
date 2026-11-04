import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

test("recap continues after close, notifies completion and renders safe Markdown", { timeout: 30000 }, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const fixture = await mkdtemp(join(root, "test/.activity-recap-"));
  let server, browser;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  try {
    await writeFile(join(fixture, "index.html"), '<div id="app"></div><script type="module" src="./main.ts"></script>');
    await writeFile(join(fixture, "main.ts"), "import { mount } from 'svelte'; import Harness from './Harness.svelte'; mount(Harness,{target:document.getElementById('app')});");
    await writeFile(join(fixture, "Harness.svelte"), `<script>
      import ActivityRecap from '/src/ActivityRecap.svelte';
      let recap, notice;
      function notify(value) { notice = value; return 1; }
      </script>
      <button on:click={() => recap.show()}>Open recap</button>
      <ActivityRecap bind:this={recap} {notify}/>
      {#if notice}<button on:click={() => notice.action.onClick()}>{notice.title}</button>{/if}`);
    server = await createServer({ root, configFile: false, cacheDir: join(fixture, ".vite"),
      resolve: { alias: { "@treetop/nicifier": resolve(root, "../nicifier/src/index.ts") } },
      plugins: [svelte()], server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true });
    const page = await browser.newPage();
    let calls = 0;
    await page.route("**/api/activity-recap?**", async route => {
      calls++;
      await ready;
      const latest = { key: "new", since: 1700000000000, until: 1700086400000, body: '- **Shipped** updates.\n- <img src=x onerror="window.unsafe=true">Follow-up.', model: "codex:small", inputTokens: 120, outputTokens: 30 };
      await route.fulfill({ json: { recap: latest, recaps: [latest, { ...latest, key: "old", since: 1699913600000, until: 1700000000000, body: "- Older highlights", inputTokens: 80 }] } });
    });
    await page.goto(`http://127.0.0.1:${address.port}/test/${fixture.split(/[\\/]/).pop()}/index.html`);
    await page.getByRole("button", { name: "Open recap", exact: true }).click();
    await page.locator("dialog .loading-spinner").waitFor();
    assert((await page.locator("dialog").innerText()).includes("Generating highlights"));
    await page.getByRole("button", { name: "Close recap" }).click();
    assert.equal(await page.locator("dialog").isVisible(), false);
    release();
    await page.getByRole("button", { name: "Activity recap ready" }).click();
    await page.locator("dialog ul li").first().waitFor();
    assert.equal(await page.locator("dialog ul li").count(), 2);
    assert.equal(await page.locator("dialog strong").innerText(), "Shipped");
    assert.equal(await page.evaluate(() => (window as any).unsafe), undefined);
    assert.equal(await page.locator("dialog [onerror]").count(), 0);
    assert.equal(calls, 1, "Opening the completed notification must reuse its result");
    assert((await page.locator("dialog footer").innerText()).includes("120 input tokens"));
    assert(!(await page.locator("dialog").innerText()).includes("?"));
    const latestFooter = await page.locator("dialog footer").innerText();
    assert(latestFooter.includes("From ") && latestFooter.includes(" to "));
    await page.getByRole("button", { name: "Older recap", exact: true }).click();
    assert.equal(await page.locator("dialog ul li").innerText(), "Older highlights");
    assert((await page.locator("dialog footer").innerText()).includes("80 input tokens"));
    assert.notEqual(await page.locator("dialog footer").innerText(), latestFooter);
    await page.getByRole("button", { name: "Newer recap", exact: true }).click();
    assert.equal(await page.locator("dialog footer").innerText(), latestFooter);
    assert.equal(calls, 1, "History navigation must not regenerate recaps");
  } finally {
    release();
    await browser?.close();
    await server?.close();
    assert.equal(dirname(fixture), join(root, "test"));
    await rm(fixture, { recursive: true, force: true });
  }
});
