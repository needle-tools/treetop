import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as httpServer } from "node:http";
import { createServer } from "vite";
import { chromium } from "playwright-core";
import { devDaemonRecoveryPlugin } from "../vite.config.ts";

test(
  "dev warning appears once after repeated backend failure and closes on recovery",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "treetop-dev-recovery-"));
    let healthy = false,
      probes = 0;
    const backend = httpServer((_req, res) => {
      probes++;
      res.writeHead(healthy ? 200 : 503);
      res.end("{}");
    });
    let vite, browser;
    try {
      await new Promise<void>((resolve) =>
        backend.listen(0, "127.0.0.1", resolve),
      );
      const addr = backend.address();
      assert(addr && typeof addr !== "string");
      await writeFile(join(root, "index.html"), "<h1>Dev fixture</h1>");
      vite = await createServer({
        root,
        configFile: false,
        plugins: [
          devDaemonRecoveryPlugin(addr.port, { pollMs: 50, failureLimit: 3 }),
        ],
        server: { host: "127.0.0.1", port: 0 },
        logLevel: "silent",
      });
      await vite.listen();
      const address = vite.httpServer!.address();
      assert(address && typeof address !== "string");
      browser = await chromium.launch({
        channel: process.platform === "win32" ? "msedge" : "chrome",
        headless: true,
      });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${address.port}`);
      const dialog = page.getByRole("dialog", {
        name: "Dev backend is unavailable",
      });
      await dialog.waitFor();
      assert(probes >= 3);
      await dialog.getByRole("button", { name: "Dismiss" }).click();
      await page.waitForTimeout(300);
      assert.equal(await dialog.isVisible(), false);
      healthy = true;
      await page.waitForTimeout(200);
      healthy = false;
      await dialog.waitFor();
      healthy = true;
      await dialog.waitFor({ state: "hidden" });
    } finally {
      await browser?.close();
      await vite?.close();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      assert(root.startsWith(join(tmpdir(), "treetop-dev-recovery-")));
      await rm(root, { recursive: true, force: true });
    }
  },
);
