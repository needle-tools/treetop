import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

test("recap continues after close, notifies completion and renders safe Markdown", { timeout: 60000 }, async () => {
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
    let summariesAvailable = false;
    await page.addInitScript(() => localStorage.setItem("supergit:recapLastActivity", String(Date.now() - 9 * 3600_000)));
    await page.route("**/api/activity-recap?**", async route => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { available: summariesAvailable, recap: null } });
        return;
      }
      calls++;
      await ready;
      const latest = { key: "new", title: "A quieter workspace takes root", since: 1700000000000, until: 1700086400000, body: '### \u{1F335} Done\n- **Shipped** _updates_ to terminal sharing and recap history. ~~Old approach~~ replaced; <u>ready</u> for review. &#x1f389;\n- <img src=x onerror="window.unsafe=true">Cloud thumbnail fixes are committed.\n\n### \u{1F331} In progress\nEditor reconnect reliability and preview isolation are being checked.\n\n### \u{1F3DC}\uFE0F Next\nReview the remaining browser checks and today\'s reminder to inspect disk usage.', model: "codex:small", inputTokens: 120, outputTokens: 30 };
      await route.fulfill({ json: { recap: latest, recaps: [latest, { ...latest, key: "old", since: 1699913600000, until: 1700000000000, body: "- Older highlights", inputTokens: 80 }] } });
    });
    await page.goto(`http://127.0.0.1:${address.port}/test/${fixture.split(/[\\/]/).pop()}/index.html`);
    await page.getByRole("button", { name: "Open recap", exact: true }).waitFor();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole("button", { name: "Welcome back", exact: true }).count(), 0,
      "Returning after a long break must not offer a recap with no summaries");
    summariesAvailable = true;
    await page.reload();
    await page.getByRole("button", { name: "Welcome back", exact: true }).waitFor();
    assert.equal(calls, 0, "Offering a recap must not start generation");
    await page.getByRole("button", { name: "Welcome back", exact: true }).click();
    await page.locator("dialog .loading-spinner").waitFor();
    assert((await page.locator("dialog").innerText()).includes("Generating highlights"));
    await page.getByRole("button", { name: "Close recap" }).click();
    assert.equal(await page.locator("dialog").isVisible(), false);
    release();
    await page.getByRole("button", { name: "Activity recap ready" }).click();
    await page.locator("dialog ul li").first().waitFor();
    assert.equal(await page.locator("#recap-title").innerText(), "A quieter workspace takes root");
    assert.deepEqual(await page.locator(".recap-text h3").allTextContents(), ["Done", "In progress", "Next"]);
    assert.equal(await page.locator("dialog ul").evaluate(el => getComputedStyle(el).listStyleType), "none");
    await page.evaluate(() => document.fonts.ready);
    assert(await page.evaluate(() => document.fonts.check('14px "Treetop Nunito Sans"')));
    assert(await page.evaluate(() => document.fonts.check('italic 24px "Treetop Plex Serif"')));
    assert.equal(await page.locator("dialog ul li").count(), 2);
    assert.equal(await page.locator("dialog strong").innerText(), "Shipped");
    assert.equal(await page.locator("dialog em").innerText(), "updates");
    assert.equal(await page.locator("dialog del").innerText(), "Old approach");
    assert.equal(await page.locator("dialog u").innerText(), "ready");
    assert((await page.locator("dialog .recap-text").innerText()).includes(String.fromCodePoint(0x1f389)));
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
    if (process.env.TREETOP_RECAP_SCREENSHOT) await page.locator("dialog").screenshot({ path: process.env.TREETOP_RECAP_SCREENSHOT });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.locator("dialog").boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, "Recap must fit the mobile viewport");
    assert.equal(await page.locator(".recap-text").evaluate(el => getComputedStyle(el).columnCount), "1");
    if (process.env.TREETOP_RECAP_SCREENSHOT) await page.locator("dialog").screenshot({ path: process.env.TREETOP_RECAP_SCREENSHOT.replace(/\.png$/, "-mobile.png") });
  } finally {
    release();
    await browser?.close();
    await server?.close();
    assert.equal(dirname(fixture), join(root, "test"));
    await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
