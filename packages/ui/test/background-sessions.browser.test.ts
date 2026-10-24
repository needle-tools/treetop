import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

test(
  "restore stays opt-in, submits only selected rows and fits a compact window",
  { timeout: 30_000 },
  async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const fixture = await mkdtemp(join(root, "test/.background-sessions-"));
    let server;
    let browser;
    try {
      await writeFile(
        join(fixture, "index.html"),
        '<div id="app"></div><script type="module" src="./main.ts"></script>',
      );
      await writeFile(
        join(fixture, "main.ts"),
        "import { mount } from 'svelte'; import Harness from './Harness.svelte'; mount(Harness,{target:document.getElementById('app')});",
      );
      await writeFile(
        join(fixture, "Harness.svelte"),
        `
      <script>
        import BackgroundSessions from '/src/BackgroundSessions.svelte';
        import SessionHeader from '/src/SessionHeader.svelte';
        import { codexAgentSettings } from '/src/claude-session-menu';
        let reviewer = '';
        $: settings = codexAgentSettings({models:[],currentModel:'',modelsLoading:false,modelsError:'',currentEffort:'',currentServiceTier:'',currentSummary:'auto',currentSandbox:'workspaceWrite',currentApproval:'on-request',currentReviewer:reviewer,onPickReviewer:value=>{reviewer=value;window.__reviewer=value;},onPickModel:()=>{},onPickEffort:()=>{},onPickServiceTier:()=>{},onPickSummary:()=>{},onPickSandbox:()=>{},onPickApproval:()=>{}});
        import { backgroundStatus, backgroundRestorePending } from '/src/background-state';
        import '/src/styles/tokens.css';
        import '/src/styles/base.css';
        backgroundStatus.set({enabled:true,connected:true,sessions:0,commands:0,restore:{id:'snapshot',candidates:[
          {id:'terminal:codex',title:'Codex: editor fixes',cwd:'C:/git/needle-web-editor',kind:'terminal',selected:true},
          {id:'command:cloud:dev',title:'Cloud dev',cwd:'C:/git/needle-cloud',kind:'command',selected:false}
        ]}});
        backgroundRestorePending.set(true);
      </script>
      <BackgroundSessions on:restored={event => event.detail.done()} />
      <SessionHeader agent="codex" source="test" agentSettings={settings} mode="read" canEnd={false} />
    `,
      );
      server = await createServer({
        root,
        configFile: false,
        cacheDir: join(fixture, ".vite"),
        resolve: {
          alias: {
            "@treetop/nicifier": resolve(root, "../nicifier/src/index.ts"),
          },
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
      const page = await browser.newPage({
        viewport: { width: 390, height: 700 },
      });
      const requests: any[] = [];
      await page.route("**/api/background/**", async (route) => {
        if (route.request().url().endsWith("restore-ack")) {
          await route.fulfill({ json: { ok: true } });
          return;
        }
        if (route.request().method() === "POST") {
          requests.push(route.request().postDataJSON());
          await route.fulfill({
            json: { results: [{ id: "command:cloud:dev", ok: true }] },
          });
        } else
          await route.fulfill({
            json: {
              enabled: true,
              connected: true,
              sessions: 0,
              commands: 1,
              restore: null,
            },
          });
      });
      const url = `http://127.0.0.1:${address.port}/test/${fixture.split(/[\\/]/).pop()}/index.html`;
      await page.goto(url);
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.equal(await page.getByRole("button", { name: /sessions.*terminals.*commands/ }).count(), 0, "background process counts do not belong in the application toolbar");
      assert.equal(
        requests.length,
        0,
        "opening the prompt must never launch commands",
      );
      const checkboxes = dialog.getByRole("checkbox");
      assert.equal(await checkboxes.nth(0).isChecked(), true);
      assert.equal(await checkboxes.nth(1).isChecked(), false);
      const bounds = await dialog.boundingBox();
      assert(
        bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390,
        "restore list should fit a narrow window",
      );
      await mkdir(resolve(root, "../../output"), { recursive: true });
      await page.screenshot({
        path: resolve(root, "../../output/background-restore.png"),
      });
      await checkboxes.nth(0).uncheck();
      await checkboxes.nth(1).check();
      await dialog.getByRole("button", { name: "Resume selected (1)" }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.deepEqual(requests, [
        { id: "snapshot", selected: ["command:cloud:dev"] },
      ]);

      requests.length = 0;
      await page.goto(url);
      await page.getByRole("button", { name: "Skip all" }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.deepEqual(requests, [{ id: "snapshot", selected: [] }]);
      await page.setViewportSize({ width: 900, height: 900 });
      await page.locator("button.agent-pill").click();
      await page
        .getByRole("button", { name: "Approve for me", exact: true })
        .click();
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      assert.equal(
        await page.evaluate(() => (window as any).__reviewer),
        "auto_review",
      );
      await page.locator("button.agent-pill").click();
      assert.equal(
        await page
          .getByRole("button", { name: "Approve for me", exact: true })
          .evaluate((element) => element.classList.contains("selected")),
        true,
      );
      await page.screenshot({
        path: resolve(root, "../../output/approval-reviewer.png"),
      });
    } finally {
      await browser?.close();
      await server?.close();
      // mkdtemp resolves inside the UI test directory; only this fixture is removed.
      assert(
        fixture.startsWith(
          join(root, "test") + (process.platform === "win32" ? "\\" : "/"),
        ),
      );
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
