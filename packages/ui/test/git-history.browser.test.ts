import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

test(
  "tag hover lazily opens the same commit rows and allows inspecting a commit",
  { timeout: 60_000 },
  async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const cacheRoot = resolve(root, "../../.cache");
    await mkdir(cacheRoot, { recursive: true });
    const fixture = await mkdtemp(join(cacheRoot, "git-history-browser-"));
    let server, browser;
    try {
      await writeFile(
        join(fixture, "index.html"),
        '<div id="app"></div><script type="module" src="./main.ts"></script>',
      );
      await writeFile(
        join(fixture, "main.ts"),
        "import {mount} from 'svelte'; import Harness from './Harness.svelte'; mount(Harness,{target:document.getElementById('app')});",
      );
      await writeFile(
        join(fixture, "Harness.svelte"),
        `<script>
      import GitHistory from '/src/GitHistory.svelte';
      import Tooltip from '/src/Tooltip.svelte';
      let switching=false, revision=0;
      import '/src/styles/tokens.css'; import '/src/styles/base.css';
    </script><div style="width:700px">
      <div style="display:flex;justify-content:flex-end"><Tooltip escapeClip variant="wide" disabled={switching}>
        <button slot="trigger" on:click={()=>switching=!switching}>main branch</button>
        <div slot="content" aria-label="Branch commit history"><GitHistory wtPath="/repo" branch="main" source="branch-preview" daemonId="remote" fsChangeKey={revision} preview /></div>
      </Tooltip></div>
      {#if switching}<p>Switch branch</p>{/if}
      <button on:click={()=>revision++}>Advance repo revision</button>
      <GitHistory wtPath="/repo" source="history" daemonId="remote" />
    </div>`,
      );
      server = await createServer({
        root: fixture,
        configFile: false,
        cacheDir: join(fixture, ".vite"),
        resolve: {
          alias: {
            "/src": resolve(root, "src"),
            "@treetop/nicifier": resolve(root, "../nicifier/src/index.ts"),
          },
        },
        plugins: [svelte()],
        server: {
          host: "127.0.0.1",
          port: 0,
          fs: { allow: [resolve(root, "../..")] },
        },
        logLevel: "error",
      });
      await server.listen();
      const address = server.httpServer!.address();
      assert(address && typeof address !== "string");
      browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const page = await browser.newPage({
        viewport: { width: 900, height: 700 },
      });
      const tagRequests: string[] = [];
      let branchReads = 0,
        holdRefresh = false,
        releaseRefresh: (() => void) | undefined;
      const release = {
        sha: "aaa",
        shortSha: "aaa",
        subject: "Release commit",
        author: "Author",
        time: new Date().toISOString(),
        refs: ["tag: v1.0", "tag: broken"],
      };
      await page.route("**/api/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/commits")) {
          if (url.searchParams.get("tag") === "broken") {
            await route.fulfill({
              status: 503,
              json: { error: "History temporarily unavailable" },
            });
            return;
          }
          if (url.searchParams.has("tag")) {
            tagRequests.push(url.pathname + url.search);
            await route.fulfill({
              json: [
                release,
                {
                  ...release,
                  sha: "bbb",
                  shortSha: "bbb",
                  subject: "Earlier commit",
                  refs: [],
                },
              ],
            });
          } else {
            if (url.searchParams.get("limit") === "10")
              assert.equal(url.searchParams.get("branch"), "main");
            branchReads++;
            if (holdRefresh)
              await new Promise<void>((resolve) => {
                releaseRefresh = resolve;
              });
            await route.fulfill({ json: [release] });
          }
        } else if (url.pathname.endsWith("/commit"))
          await route.fulfill({
            body: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n",
          });
        else await route.fulfill({ json: [] });
      });
      await page.goto(`http://127.0.0.1:${address.port}/index.html`);
      const tag = page.locator(".gh-ref-tag").first();
      await tag.waitFor();
      assert.equal(tagRequests.length, 0);
      const branch = page.getByRole("button", {
        name: "main branch",
        exact: true,
      });
      await branch.hover();
      await page.getByRole("tooltip").locator(".gh-commit").waitFor();
      assert.equal(
        await page
          .getByRole("tooltip")
          .getByText("Release commit", { exact: true })
          .count(),
        1,
      );
      const tooltipBounds = await page.getByRole("tooltip").boundingBox();
      assert(
        tooltipBounds &&
          tooltipBounds.x >= 0 &&
          tooltipBounds.x + tooltipBounds.width <= 900,
      );
      const shaBounds = await page
        .getByRole("tooltip")
        .locator(".gh-sha")
        .boundingBox();
      const rowBounds = await page
        .getByRole("tooltip")
        .locator(".gh-commit-row")
        .boundingBox();
      assert(
        shaBounds &&
          rowBounds &&
          shaBounds.x + shaBounds.width <= rowBounds.x + rowBounds.width + 1,
      );
      await branch.click();
      await page.getByRole("tooltip").waitFor({ state: "detached" });
      await page.getByText("Switch branch", { exact: true }).waitFor();
      const readsBefore = branchReads;
      await branch.click();
      await page.mouse.move(850, 650);
      await branch.hover();
      await page
        .getByRole("tooltip")
        .getByText("Release commit", { exact: true })
        .waitFor();
      assert.equal(branchReads, readsBefore);
      await page.mouse.move(850, 650);
      await page.getByRole("tooltip").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Advance repo revision" }).click();
      holdRefresh = true;
      await branch.hover();
      await page
        .getByRole("tooltip")
        .getByText("Release commit", { exact: true })
        .waitFor();
      await page.waitForTimeout(150);
      assert.equal(branchReads, readsBefore + 1);
      releaseRefresh?.();
      holdRefresh = false;
      await page.mouse.move(850, 650);
      await page.getByRole("tooltip").waitFor({ state: "detached" });
      await tag.hover();
      const popup = page.getByRole("dialog", { name: "History at v1.0" });
      await popup.getByText("Earlier commit", { exact: true }).waitFor();
      assert.equal(tagRequests.length, 1);
      assert.match(tagRequests[0], /^\/api\/daemons\/remote\/commits\?/);
      assert.equal(
        new URL("http://local" + tagRequests[0]).searchParams.get("tag"),
        "v1.0",
      );
      assert.equal(await popup.locator(".gh-commit-row .gh-commit").count(), 2);
      await popup.getByText("Earlier commit", { exact: true }).click();
      await popup.locator(".gh-diff").waitFor();
      await page.waitForTimeout(350);
      assert.equal(await popup.isVisible(), true);
      const bounds = await popup.boundingBox();
      assert(bounds);
      assert(bounds.x >= 0 && bounds.x + bounds.width <= 900);
      await page.keyboard.press("Escape");
      await popup.waitFor({ state: "detached" });
      await tag.focus();
      await page.getByRole("dialog", { name: "History at v1.0" }).waitFor();
      assert.equal(tagRequests.length, 1);
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "View history at broken", exact: true })
        .hover();
      await page
        .getByRole("dialog", { name: "History at broken" })
        .getByRole("alert")
        .getByText("History temporarily unavailable", { exact: true })
        .waitFor();
    } finally {
      await browser?.close();
      await server?.close();
      assert(
        fixture.startsWith(
          cacheRoot + (process.platform === "win32" ? "\\" : "/"),
        ),
      );
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
