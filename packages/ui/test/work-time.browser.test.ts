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
  "work clock records projects, retains time through the idle cutoff, pauses and adjusts daily totals",
  { timeout: 90_000 },
  async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "treetop-work-clock-browser-"));
    const store = await WorkTimeStore.open(dir);
    const requests: Array<{ status: number; body: string }> = [];
    let captures = 0,
      folderOpens = 0,
      installs = 0,
      encoderAvailable = true;
    let finishInstall: (() => void) | undefined,
      downloading = false,
      cancellations = 0;
    const generationModes: boolean[] = [];
    const recordingDay = {
      day: "2026-11-17",
      frames: 3,
      generatedAt: undefined as number | undefined,
    };
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const fixture: Plugin = {
      name: "work-clock-test",
      resolveId(id) {
        if (id === "/time-entry.ts") return "\0time-entry";
        if (id === "/settings-entry.ts") return "\0settings-entry";
      },
      load(id) {
        if (id === "\0settings-entry")
          return "        await import('/src/styles/tokens.css');\n        await import('/src/styles/base.css');\n        await import('/src/styles/overlays.css');\n        const { mount } = await import('svelte');\n        const { default: SettingsDialog } = await import('/src/SettingsDialog.svelte');\n        const { registerSettings } = await import('/src/settings-registry.ts');\n        registerSettings({id:'scroll-test',title:'Scroll test',order:999,settings:Array.from({length:40},(_,i)=>({key:`scroll.option${i}`,label:`Option ${i}`,type:'boolean',default:false}))});\n        mount(SettingsDialog,{target:document.body,props:{open:true}});";
        if (id === "\0time-entry")
          return `import {mount} from 'svelte';import TimeTracker from '/src/TimeTracker.svelte';mount(TimeTracker,{target:document.querySelector('#tracker'),props:{projects:[{id:'a',name:'Project A'},{id:'b',name:'Project B'}]}});`;
      },
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.startsWith("/api/timelapse")) {
            res.setHeader("Content-Type", "application/json");
            if (req.url === "/api/timelapse/capture") {
              captures++;
              res.end(JSON.stringify({ captured: true }));
            } else if (req.url === "/api/timelapse/install") {
              installs++;
              downloading = true;
              finishInstall = () => {
                encoderAvailable = true;
                downloading = false;
              };
              res.statusCode = 202;
              res.end(JSON.stringify({ ok: true }));
            } else if (req.url === "/api/timelapse/install/cancel") {
              cancellations++;
              downloading = false;
              res.end(JSON.stringify({ ok: true }));
            } else if (req.url === "/api/timelapse/generate") {
              const parts: Buffer[] = [];
              for await (const chunk of req) parts.push(Buffer.from(chunk));
              const body = JSON.parse(Buffer.concat(parts).toString());
              assert.equal(body.day, recordingDay.day);
              generationModes.push(body.deleteFrames);
              recordingDay.generatedAt = Date.now();
              if (body.deleteFrames) recordingDay.frames = 0;
              res.end(JSON.stringify({ ok: true }));
            } else if (req.url === "/api/timelapse/open-folder") {
              folderOpens++;
              res.end(JSON.stringify({ ok: true }));
            } else
              res.end(
                JSON.stringify({
                  days: [recordingDay],
                  folder: "test-timelapses",
                  encoder: encoderAvailable,
                  installation: {
                    state: downloading
                      ? "downloading"
                      : encoderAvailable
                        ? "ready"
                        : "idle",
                    supported: true,
                    total: 29581307,
                    received: 0,
                  },
                  supported: true,
                }),
              );
            return;
          }
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
      console.log("work clock: test server ready");
      browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(8000);
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
      console.log("work clock: component mounted");
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
      await page.clock.runFor(299_000);
      // The one-second display timer may be just before its next tick.
      assert.match(await clock.innerText(), /00:06:0[89]/);
      await page.clock.runFor(62_000);
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
        310,
      );
      assert.match(await clock.innerText(), /00:06:10/);
      // A short sleep is below the idle cutoff, but must still break the span.
      await page.getByLabel("Project A input", { exact: true }).click();
      await page.keyboard.type("before sleep");
      await page.clock.fastForward(60_000);
      await page.keyboard.type("after sleep");
      await page.clock.runFor(60_000);
      assert.equal(
        Math.round(store.summary().reduce((n, r) => n + r.ms, 0) / 1000),
        430,
      );
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.clock.fastForward(60_000);
      await page.keyboard.type("back from another app");
      assert.equal(
        Math.round(store.summary().reduce((n, r) => n + r.ms, 0) / 1000),
        430,
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
      assert.match(await clock.innerText(), /00:22:10/);
      await page
        .getByRole("button", { name: "Close work time", exact: true })
        .click();
      await page.getByLabel("Project A input", { exact: true }).click();
      await page.keyboard.type("paused");
      await page.clock.runFor(60_000);
      assert.equal(
        Math.round(store.summary().reduce((n, r) => n + r.ms, 0) / 1000),
        1330,
      );
      assert.deepEqual(errors, []);
      assert.equal(captures, 0, "timelapse must be off by default");
      console.log("work clock: tracking and default-off recording verified");
      assert.equal(
        await page.evaluate(async () => {
          const { getSetting } = await import("/src/settings-registry.ts");
          return getSetting("timelapse.enabled");
        }),
        false,
      );
      await clock.click();
      await page
        .getByRole("button", { name: "Resume tracking", exact: true })
        .click();
      await until(async () => !store.paused(), "Resume was not persisted");
      await page
        .getByRole("button", { name: "Close work time", exact: true })
        .click();
      await page.getByLabel("Project A input", { exact: true }).click();
      await page.keyboard.type("active work");
      await page.evaluate(async () => {
        const { setSetting } = await import("/src/settings-registry.ts");
        setSetting("timelapse.enabled", true);
      });
      await page.clock.runFor(6_000);
      await until(
        async () => captures > 0,
        "Enabled timelapse did not capture active work",
      );
      console.log("work clock: opt-in capture verified");
      const beforeOff = captures;
      await page.evaluate(async () => {
        const { setSetting } = await import("/src/settings-registry.ts");
        setSetting("timelapse.enabled", false);
      });
      await page.clock.runFor(30_000);
      assert.equal(
        captures,
        beforeOff,
        "disabled timelapse must stop captures",
      );
      await page.evaluate(async () => {
        const { settingsSections } = await import("/src/settings-registry.ts");
        let sections: any[] = [];
        const stop = settingsSections.subscribe((value) => (sections = value));
        stop();
        await sections
          .find((s) => s.id === "timelapse")
          .settings.find((s: any) => s.key === "timelapse.history")
          .onInvoke();
      });
      await page
        .getByRole("button", { name: "Open timelapse folder", exact: true })
        .click();
      await until(async () => folderOpens === 1, "Folder action did not run");
      assert.deepEqual(errors, []);
      // Settings writes must retain the controls and the user's scroll position.
      await page.evaluate(async () => {
        document
          .querySelectorAll("dialog[open]")
          .forEach((d: any) => d.close());
        await import("/settings-entry.ts");
      });
      encoderAvailable = false;
      await page.evaluate(async () => {
        const { setSetting } = await import("/src/settings-registry.ts");
        setSetting("timelapse.enabled", true);
      });
      const installDialog = page.getByRole("dialog", {
        name: "Install timelapse encoder",
      });
      await installDialog.waitFor();
      assert.equal(
        await installDialog.evaluate((el) => el.matches(":modal")),
        true,
        "installer must use the top layer above Settings",
      );
      assert.equal(
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .isVisible(),
        true,
      );
      assert.equal(
        installs,
        0,
        "enabling recording must not download without a click",
      );
      await installDialog
        .getByRole("button", { name: "Install encoder", exact: true })
        .click();
      await until(
        async () => installs === 1,
        "one-click encoder install did not run",
      );
      await installDialog
        .getByRole("button", { name: "Close encoder installer", exact: true })
        .click();
      await installDialog.waitFor({ state: "hidden" });
      assert.equal(
        downloading,
        true,
        "closing the dialog must keep the daemon download running",
      );
      assert.equal(cancellations, 0, "closing must not call Cancel");
      assert.equal(
        await page
          .getByRole("dialog", { name: "Settings", exact: true })
          .isVisible(),
        true,
      );
      await page.evaluate(async () => {
        const { settingsSections } = await import("/src/settings-registry.ts");
        let sections: any[] = [];
        const stop = settingsSections.subscribe((value) => (sections = value));
        stop();
        await sections
          .find((s) => s.id === "timelapse")
          .settings.find((s: any) => s.key === "timelapse.history")
          .onInvoke();
      });
      await page
        .getByRole("button", { name: "View download", exact: true })
        .click();
      await installDialog
        .getByRole("button", { name: "Cancel download", exact: true })
        .click();
      await until(
        async () => cancellations === 1 && !downloading,
        "Cancel did not stop the daemon download",
      );
      await installDialog
        .getByRole("button", { name: "Install encoder", exact: true })
        .click();
      await until(
        async () => installs === 2,
        "Cancelled download could not be restarted",
      );
      await installDialog
        .getByRole("button", { name: "Run in background", exact: true })
        .click();
      assert.equal(downloading, true);
      finishInstall!();
      await page.clock.runFor(1100);
      await page
        .getByRole("button", { name: "Generate preview", exact: true })
        .click();
      await until(
        async () => generationModes.length === 1,
        "Preview generation did not run",
      );
      assert.deepEqual(generationModes, [false]);
      assert.equal(recordingDay.frames, 3);
      await page
        .getByRole("link", { name: "Crisp MP4", exact: true })
        .waitFor();
      await page
        .getByRole("link", { name: "Motion blur MP4", exact: true })
        .waitFor();
      for(const [label,variant] of [["Crisp MP4","crisp"],["Motion blur MP4","motion-blur"]]) {
        const href = await page.getByRole("link",{name:label,exact:true}).getAttribute("href");
        const url = new URL(href!, "http://test");
        assert.equal(url.searchParams.get("day"),recordingDay.day);
        assert.equal(url.searchParams.get("variant"),variant);
      }
      await page
        .getByRole("button", { name: "Generate and delete", exact: true })
        .click();
      await until(
        async () => generationModes.length === 2,
        "Generate and delete did not run",
      );
      assert.deepEqual(generationModes, [false, true]);
      assert.equal(recordingDay.frames, 0);
      await page
        .getByRole("button", { name: "Close timelapses", exact: true })
        .click();

      await page.clock.runFor(100);
      const lastToggle = page
        .locator(".settings-body input[type=checkbox]")
        .last();
      await lastToggle.scrollIntoViewIfNeeded();
      await lastToggle.focus();
      await page.locator(".settings-body").evaluate((body) => {
        body.scrollTop = body.scrollHeight;
      });
      const scrollBefore = await page
        .locator(".settings-body")
        .evaluate((body) => body.scrollTop);
      assert.ok(scrollBefore > 100);
      await lastToggle.evaluate(
        (input) => ((window as any).originalSettingsInput = input),
      );
      await lastToggle.click();
      await page.clock.runFor(50);
      assert.equal(await lastToggle.isChecked(), true);
      assert.equal(
        await lastToggle.evaluate(
          (input) => input === (window as any).originalSettingsInput,
        ),
        true,
        "setting changes must preserve the input node",
      );
      assert.ok(
        Math.abs(
          (await page
            .locator(".settings-body")
            .evaluate((body) => body.scrollTop)) - scrollBefore,
        ) < 2,
        `setting changes must preserve scroll: ${scrollBefore} -> ${await page.locator(".settings-body").evaluate((body) => body.scrollTop)}`,
      );
    } finally {
      await browser?.close();
      server.httpServer?.closeAllConnections();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
