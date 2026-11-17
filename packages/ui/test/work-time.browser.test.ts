import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { chromium } from "playwright-core";
import {
  WorkTimeStore,
  handleWorkTimeRequest,
} from "../../daemon/src/work-time.ts";

test(
  "work clock records projects, trims idle tails, pauses and adjusts daily totals",
  { timeout: 90_000 },
  async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "treetop-work-clock-browser-"));
    const store = await WorkTimeStore.open(dir);
    const requests: Array<{ status: number; body: string }> = [];
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const fixture: Plugin = {
      name: "work-clock-test",
      resolveId(id) {
        if (id === "/time-entry.ts") return "\0time-entry";
      },
      load(id) {
        if (id === "\0time-entry")
          return `import {mount} from 'svelte';import TimeTracker from '/src/TimeTracker.svelte';mount(TimeTracker,{target:document.querySelector('#tracker'),props:{projects:[{id:'a',name:'Project A'},{id:'b',name:'Project B'}]}});`;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === "/time-test.html") {
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<!doctype html><html><head><style>body{background:#1a1a1b;color:#ddd;font-family:system-ui}header{display:flex;justify-content:end}section{margin:20px}input{padding:8px}</style></head><body><header><div id="tracker"></div><button>Settings</button></header><section data-repo-id="a"><label>Project A input<input aria-label="Project A input"></label></section><section data-repo-id="b"><label>Project B input<input aria-label="Project B input"></label></section><script type="module" src="/time-entry.ts"></script></body></html>`,
            );
            return;
          }
          if (req.url === "/api/work-time") {
            const parts: Buffer[] = [];
            for await (const chunk of req) parts.push(Buffer.from(chunk));
            const response = await handleWorkTimeRequest(
              new Request("http://test/api/work-time", {
                method: req.method,
                ...(req.method === "POST"
                  ? { body: Buffer.concat(parts).toString() }
                  : {}),
              }),
              store,
              Date.now() + 600_000,
            );
            const body = await response.text();
            requests.push({ status: response.status, body });
            res.statusCode = response.status;
            res.setHeader("Content-Type", "application/json");
            res.end(body);
            return;
          }
          if (req.url?.startsWith("/api/")) {
            res.setHeader("Content-Type", "application/json");
            res.end("{}");
            return;
          }
          next();
        });
      },
    };
    const server = await createServer({
      root,
      configFile: false,
      cacheDir: resolve(dir, "vite"),
      logLevel: "error",
      plugins: [svelte(), fixture],
      optimizeDeps: { noDiscovery: true, include: ["svelte"] },
      server: { host: "127.0.0.1", port: 0, proxy: {} },
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await server.listen();
      browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const page = await browser.newPage();
      await page.clock.install();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const address = server.httpServer!.address();
      assert.ok(address && typeof address !== "string");
      await page.goto(`http://127.0.0.1:${address.port}/time-test.html`, {
        waitUntil: "networkidle",
      });
      const clock = page.getByRole("button", {
        name: "Work time",
        exact: true,
      });
      await clock.waitFor();
      async function until(condition: () => Promise<boolean>, message: string) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await condition()) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(message + " " + errors.join(";"));
      }
      await until(() => clock.isEnabled(), "Tracker did not load");
      await page.getByLabel("Project A input", { exact: true }).click();
      await page.keyboard.type("a");
      await page.clock.runFor(30_000);
      await page.keyboard.type("b");
      await page.clock.runFor(30_000);
      await page.getByLabel("Project B input", { exact: true }).click();
      await page.clock.runFor(10_000);
      await page.keyboard.type("c");
      await page.clock.runFor(121_000);
      await until(
        async () => store.summary().length === 2,
        `Project totals were not saved ${JSON.stringify(requests)} ${await clock.getAttribute("title")} ${await page.evaluate(() => ({ focus: document.hasFocus(), hidden: document.hidden })).then(JSON.stringify)}`,
      );
      assert.equal(
        Math.round(store.summary().find((r) => r.repoId === "a")!.ms / 1000),
        60,
      );
      assert.equal(
        Math.round(store.summary().find((r) => r.repoId === "b")!.ms / 1000),
        10,
      );
      assert.match(await clock.innerText(), /00:01:10/);
      // A short sleep is below the idle cutoff, but must still break the span.
      await page.getByLabel("Project A input", { exact: true }).click();
      await page.keyboard.type("before sleep");
      await page.clock.fastForward(60_000);
      await page.keyboard.type("after sleep");
      await page.clock.runFor(60_000);
      assert.equal(
        Math.round(store.summary().reduce((n, r) => n + r.ms, 0) / 1000),
        70,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.clock.fastForward(60_000);
      await page.keyboard.type("back from another app");
      assert.equal(
        Math.round(store.summary().reduce((n, r) => n + r.ms, 0) / 1000),
        70,
      );
      await clock.click();
      await page
        .getByRole("button", { name: "Pause tracking", exact: true })
        .click();
      await until(async () => store.paused(), "Pause was not persisted");
      await page
        .getByLabel("Adjustment project", { exact: true })
        .selectOption("a");
      await page.getByLabel("Minutes", { exact: true }).fill("15");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await until(
        async () =>
          store.summary().find((r) => r.repoId === "a")!.ms >= 960_000,
        "Manual adjustment failed",
      );
      assert.match(await clock.innerText(), /00:16:10/);
      await page
        .getByRole("button", { name: "Close work time", exact: true })
        .click();
      await page.getByLabel("Project A input", { exact: true }).click();
      await page.keyboard.type("paused");
      await page.clock.runFor(60_000);
      assert.equal(
        Math.round(store.summary().reduce((n, r) => n + r.ms, 0) / 1000),
        970,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      server.httpServer?.closeAllConnections();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
