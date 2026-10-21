import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

test("command URL hover preserves horizontal scrolling and remains clickable", { timeout: 30000 }, async () => {
  const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const fixture = await mkdtemp(join(uiRoot, "test/.command-row-"));
  const component =
    process.env.TREETOP_COMMAND_ROW_TEST_COMPONENT ||
    "/src/OpenInActions.svelte";
  let server;
  let browser;
  try {
    await writeFile(
      join(fixture, "index.html"),
      '<div id="app"></div><script type="module" src="./main.ts"></script>',
    );
    await writeFile(
      join(fixture, "main.ts"),
      `import { mount } from 'svelte'; import Harness from './Harness.svelte'; mount(Harness, {target: document.getElementById('app')});`,
    );
    await writeFile(
      join(fixture, "Harness.svelte"),
      `
      <script>
        import Actions from '${component}';
        import '/src/styles/tokens.css';
        import '/src/styles/worktree-row.css';
        const links = [
          ...Array.from({length: 18}, (_, i) => ({id: String(i), kind: 'command', name: 'Server command ' + i, cmd: 'npm run dev'})),
          ...Array.from({length: 12}, (_, i) => ({id: 'app-' + i, kind: 'url', name: 'App ' + i, url: 'https://example.com/app/' + i})),
        ];
      </script>
      <div style="width:500px; margin:40px">
        <Actions path="/test/project" customLinks={links}
          commandUrls={{'12':['http://localhost:3000', 'http://localhost:3001'], '13':['http://localhost:4000']}}
          openIn={() => {}} openRemote={() => {}} />
      </div>
      <style>:global(.custom-link-wrap) {flex-shrink:0} :global(.custom-link-btn) {white-space:nowrap}</style>
    `,
    );
    server = await createServer({
      root: uiRoot,
      configFile: false,
      resolve: {
        alias: { "@treetop/nicifier": resolve(uiRoot, "../nicifier/src/index.ts") },
      },
      plugins: [svelte()],
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error",
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert(address && typeof address !== "string");
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
    });
    const page = await browser.newPage();
    await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
    await page.goto(
      `http://127.0.0.1:${address.port}/test/${fixture.split(/[\\/]/).pop()}/index.html`,
    );
    const row = page.locator(".command-actions");
    const apps = page.locator(".app-actions");
    await row.waitFor();
    assert.equal(await apps.locator(".custom-link-wrap").count(), 12);
    assert.equal(await row.locator(".custom-link-wrap").count(), 18);
    const appOverflow = await apps.evaluate((el) => el.scrollWidth > el.clientWidth);
    assert(appOverflow, "app group should overflow independently");
    await apps.evaluate((el) => (el.scrollLeft = 100));
    assert.equal(await row.evaluate((el) => el.scrollLeft), 0);
    const appsBefore = await apps.evaluate((el) => el.scrollLeft);
    for (const number of [12, 13]) {
      const icon = page
        .locator(".custom-link-wrap")
        .nth(number)
        .locator(".cmd-url-inner");
      await icon.evaluate((el) =>
        el.scrollIntoView({ inline: "center", block: "nearest" }),
      );
      const before = await row.evaluate((el) => ({
        scroll: el.scrollLeft,
        width: el.scrollWidth,
      }));
      assert(before.scroll > 0, "fixture must be horizontally scrolled");
      const bounds = await icon.boundingBox();
      assert(bounds);
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.waitForTimeout(400);
      const after = await row.evaluate((el) => ({
        scroll: el.scrollLeft,
        width: el.scrollWidth,
      }));
      assert.deepEqual(
        after,
        before,
        "hover must preserve scroll offset and extent",
      );
      assert.equal(await apps.evaluate((el) => el.scrollLeft), appsBefore);
      const hovered = await icon.boundingBox();
      assert(hovered);
      assert.equal(
        hovered.x,
        bounds.x,
        "URL button must stay under the cursor",
      );
      const opened = page.waitForRequest("**/api/open-default");
      await page.mouse.click(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      const request = await opened;
      assert.equal(
        request.postDataJSON().path,
        number === 12 ? "http://localhost:3000" : "http://localhost:4000",
      );
      if (number === 12) {
        const choice = page.getByRole("button", {
          name: "localhost:3001",
          exact: true,
        });
        await choice.waitFor({ state: "visible" });
        const selected = page.waitForRequest("**/api/open-default");
        await choice.click();
        const next = await selected;
        assert.equal(next.postDataJSON().path, "http://localhost:3001");
      }
      await page.mouse.move(0, 0);
      await page.waitForTimeout(350);
    }
    await page.locator(".row-actions").evaluate((el) => {
      el.parentElement!.style.width = "6000px";
    });
    for (const strip of [row, apps]) {
      const size = await strip.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      assert(size.scrollWidth <= size.clientWidth, "fitting actions should have no scrollbar");
    }
  } finally {
    await browser?.close();
    await server?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
