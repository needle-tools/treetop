import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const uiRoot = resolve(import.meta.dir, "..");
let server: ViteDevServer;
let browser: Browser;
let origin = "";
let latestTurnComplete = false;
let terminalStopStatus = 200;
let terminalStopCalls = 0;
const eventClients = new Set<ServerResponse>();
const threadId = "lifecycle-thread";
const latestTurnId = "turn-latest";

function threadPage(complete: boolean): unknown {
  const turns = Array.from({ length: 18 }, (_, index) => {
    const turnNumber = index + 1;
    return {
      id: `turn-${turnNumber}`,
      startedAt: 1_780_000_000 + index * 10,
      completedAt: 1_780_000_005 + index * 10,
      items: [
        {
          id: `user-${turnNumber}`,
          type: "userMessage",
          content: [
            {
              type: "text",
              text: `Historical request ${turnNumber} with enough text to occupy a visible transcript row.`,
            },
          ],
        },
        {
          id: `answer-${turnNumber}`,
          type: "agentMessage",
          text: `Historical answer ${turnNumber} with enough text to exercise real browser layout and scrolling.`,
        },
      ],
    };
  });
  turns.push({
    id: latestTurnId,
    startedAt: 1_780_000_200,
    completedAt: 1_780_000_208,
    items: [
      {
        id: "latest-user",
        type: "userMessage",
        content: [{ type: "text", text: "Finish the previous request" }],
      },
      {
        id: "latest-reasoning",
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "Completing the previous request" },
        ],
      },
      {
        id: "latest-command",
        type: "commandExecution",
        command: "/bin/zsh -lc 'pwd'",
        cwd: "/tmp/treetop-session-lifecycle",
        status: "completed",
        aggregatedOutput: "/tmp/treetop-session-lifecycle\n",
      },
      {
        id: "latest-question",
        type: "agentMessage",
        delivery: "async",
        text: "Which scope should this use?\n\n1. Current file\n2. Whole project",
        questions: [
          {
            title: "Which scope should this use?",
            options: ["Current file", "Whole project"],
          },
        ],
      },
      ...(complete
        ? [
            {
              id: "latest-answer",
              type: "agentMessage",
              text: "The previous answer arrived during completion reconciliation.",
            },
          ]
        : []),
    ],
  });
  return {
    ok: true,
    thread: {
      id: threadId,
      cwd: "/tmp/treetop-session-lifecycle",
      createdAt: 1_780_000_000,
      turns: turns.reverse(),
    },
    model: "gpt-6.1",
    nextCursor: null,
  };
}

function lifecycleApiPlugin(): Plugin {
  return {
    name: "session-lifecycle-api",
    configureServer(viteServer) {
      viteServer.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/api/codex-app/events") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          response.write(": connected\n\n");
          eventClients.add(response);
          request.on("close", () => eventClients.delete(response));
          return;
        }
        if (url.pathname === "/api/codex-app/thread") {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(threadPage(latestTurnComplete)));
          return;
        }
        if (url.pathname === "/api/terminals/test-terminal" && request.method === "DELETE") {
          terminalStopCalls++;
          response.statusCode = terminalStopStatus;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify(terminalStopStatus === 200 ? { ok: true } : { error: "Terminal stop rejected" }));
          return;
        }
        if (
          url.pathname === "/api/codex-app/turns" &&
          request.method === "POST"
        ) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              ok: true,
              threadId,
              turnId: "turn-next",
            }),
          );
          return;
        }
        if (url.pathname.startsWith("/api/")) {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({}));
          return;
        }
        next();
      });
    },
  };
}

beforeAll(async () => {
  server = await createServer({
    root: uiRoot,
    configFile: false,
    resolve: { alias: { "@treetop/nicifier": resolve(uiRoot, "../nicifier/src/index.ts") } },
    logLevel: "error",
    plugins: [svelte(), lifecycleApiPlugin()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {},
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Vite lifecycle-test server did not bind a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
  });
}, 30_000);

afterAll(async () => {
  for (const client of eventClients) client.end();
  eventClients.clear();
  await browser?.close();
  server?.httpServer?.closeAllConnections();
  await server?.close();
}, 10_000);

async function openHarness(): Promise<Page> {
  latestTurnComplete = false;
  const currentPage = await browser.newPage({
    viewport: { width: 900, height: 680 },
  });
  await currentPage.goto(
    `${origin}/test/browser/session-view-lifecycle.html`,
    { waitUntil: "networkidle" },
  );
  await currentPage.locator(".messages").waitFor();
  await waitForCondition(
    async () => (await currentPage.locator(".msg").count()) > 20,
    "SessionView did not render its history",
  );
  await waitForCondition(
    async () => eventClients.size > 0,
    "SessionView did not establish its app-server event stream",
  );
  return currentPage;
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(message);
}

async function completeLatestTurn(currentPage: Page): Promise<void> {
  latestTurnComplete = true;
  const event = {
    kind: "notification",
    method: "turn/completed",
    params: { threadId, turnId: latestTurnId },
    threadId,
    turnId: latestTurnId,
    receivedAt: "2026-10-01T10:00:08.000Z",
  };
  for (const client of eventClients) {
    client.write(`event: codex\ndata: ${JSON.stringify([event])}\n\n`);
  }
  await currentPage
    .getByText("The previous answer arrived during completion reconciliation.")
    .waitFor();
}

function emitCodexEvents(events: readonly unknown[]): void {
  for (const client of eventClients) {
    client.write(`event: codex\ndata: ${JSON.stringify(events)}\n\n`);
  }
}

describe.serial("SessionView browser lifecycle", () => {
  test("a terminal shown visually stays attached; failed Stop preserves it and successful Stop clears it", async () => {
    terminalStopCalls = 0;
    terminalStopStatus = 502;
    const currentPage = await browser.newPage();
    try {
      await currentPage.goto(`${origin}/test/browser/session-view-lifecycle.html?terminal=1`, { waitUntil: "networkidle" });
      await currentPage.getByRole("button", { name: "Session menu", exact: true }).click();
      await currentPage.getByText("View as", { exact: true }).hover();
      await currentPage.getByText("Visual", { exact: true }).click();
      expect(await currentPage.locator(".composer").count()).toBe(0);
      const stop = currentPage.getByRole("button", { name: "Stop Session", exact: true });
      await stop.click();
      await waitForCondition(async () => terminalStopCalls === 1, "Stop did not address the attached terminal");
      await stop.waitFor();
      expect(await currentPage.locator("main").getAttribute("data-stopped")).toBe("false");
      terminalStopStatus = 200;
      await stop.click();
      await waitForCondition(async () => await currentPage.locator("main").getAttribute("data-stopped") === "true", "Successful stop retained the terminal attachment");
      expect(terminalStopCalls).toBe(2);
      await currentPage.getByRole("button", { name: "Resume", exact: true }).waitFor();
    } finally { terminalStopStatus = 200; await currentPage.close(); }
  }, 30000);

  test("switching to terminal transcript clears visual activity and switching back reconnects", async () => {
    const currentPage = await openHarness();
    try {
      emitCodexEvents([{ kind: "notification", method: "turn/started", params: { threadId, turn: { id: "turn-switch" } }, threadId, turnId: "turn-switch", receivedAt: "2026-10-08T00:00:00Z" }]);
      await waitForCondition(async () => await currentPage.locator("main").getAttribute("data-working") === "true", "Visual turn did not become active");
      await currentPage.getByRole("button", { name: "Session menu", exact: true }).click();
      await currentPage.getByText("View as", { exact: true }).hover();
      await currentPage.getByText("Terminal", { exact: true }).click();
      await waitForCondition(async () => await currentPage.locator("main").getAttribute("data-working") === "false", "Terminal transcript retained visual activity");
      expect(await currentPage.locator(".composer").count()).toBe(0);
      await currentPage.getByRole("button", { name: "Session menu", exact: true }).click();
      await currentPage.getByText("View as", { exact: true }).hover();
      await currentPage.getByText("Visual", { exact: true }).click();
      await waitForCondition(async () => eventClients.size > 0, "Visual event subscription did not resume");
    } finally { await currentPage.close(); }
  }, 30000);

  test("Stop interrupts a running visual session and leaves it stopped until Resume", async () => {
    const currentPage = await openHarness();
    try {
      emitCodexEvents([{ kind: "notification", method: "turn/started", params: { threadId, turn: { id: "turn-stop" } }, threadId, turnId: "turn-stop", receivedAt: "2026-10-08T00:00:00Z" }]);
      await waitForCondition(async () => await currentPage.locator("main").getAttribute("data-working") === "true", "Visual turn did not start");
      await currentPage.getByRole("button", { name: "Stop", exact: true }).click();
      await waitForCondition(async () => await currentPage.locator("main").getAttribute("data-stopped") === "true", "Stop only interrupted the turn without stopping the session");
      expect(await currentPage.locator("main").getAttribute("data-working")).toBe("false");
      await currentPage.getByRole("button", { name: "Resume", exact: true }).click();
      await waitForCondition(async () => await currentPage.locator("main").getAttribute("data-stopped") === "false", "Resume did not restore the visual session");
    } finally { await currentPage.close(); }
  }, 30000);

  test(
    "surfaces async transcript questions in the composer and work flow",
    async () => {
      const currentPage = await openHarness();
      const questionBadge = currentPage.getByRole("button", {
        name: "Show pending questions",
      });
      await questionBadge.waitFor();
      const questionChip = currentPage.locator(".work-question-chip");
      await questionChip.waitFor();
      const [questionColor, thinkingColor, questionBackground] =
        await currentPage.evaluate(() => {
          const question = document.querySelector<HTMLElement>(
            ".work-question-chip",
          );
          const thinking = document.querySelector<HTMLElement>(
            ".work-thinking-chip",
          );
          if (!question || !thinking) throw new Error("missing work chips");
          return [
            getComputedStyle(question).color,
            getComputedStyle(thinking).color,
            getComputedStyle(question).backgroundColor,
          ];
        });
      expect(questionColor).not.toBe(thinkingColor);
      expect(questionBackground).not.toBe("rgba(0, 0, 0, 0)");

      await questionBadge.click();
      const questionPane = currentPage.getByLabel("Codex questions");
      await questionPane.getByText("Which scope should this use?").waitFor();
      await questionPane.getByRole("button", { name: "Current file" }).waitFor();
      await currentPage.close();
    },
    30_000,
  );

  test(
    "aligns title-only thinking rows with neighboring work entries",
    async () => {
      const currentPage = await openHarness();
      const thinkingChip = currentPage.locator(
        ".work-entry-static .work-thinking-chip",
      );
      const commandChip = currentPage.locator(
        ".work-entry:not(.work-entry-static) .work-tool-chip",
      );

      await thinkingChip.waitFor();
      await commandChip.first().waitFor();
      const [thinkingBox, commandBox] = await Promise.all([
        thinkingChip.boundingBox(),
        commandChip.first().boundingBox(),
      ]);

      expect(thinkingBox).not.toBeNull();
      expect(commandBox).not.toBeNull();
      expect(Math.abs(thinkingBox!.x - commandBox!.x)).toBeLessThan(1);
      await currentPage.close();
    },
    30_000,
  );

  test(
    "unmounts collapsed work action rows and remounts them on demand",
    async () => {
      const currentPage = await openHarness();
      emitCodexEvents([
        {
          kind: "notification",
          method: "turn/started",
          params: { threadId, turn: { id: latestTurnId } },
          threadId,
          turnId: latestTurnId,
          receivedAt: "2026-10-01T10:00:07.000Z",
        },
      ]);
      const openGroup = currentPage.locator(".work-action-group[open]").first();
      await openGroup.waitFor();
      expect(
        await openGroup.locator(".work-action-group-entries").count(),
      ).toBeGreaterThan(0);

      const groupId = await openGroup.getAttribute("data-work-action-group");
      expect(groupId).not.toBeNull();
      await openGroup.locator(":scope > summary").click();
      const stableGroup = currentPage.locator(
        `[data-work-action-group="${groupId}"]`,
      );
      await waitForCondition(
        async () =>
          (await stableGroup.locator(".work-action-group-entries").count()) ===
          0,
        "Collapsed action rows remained mounted",
      );

      await stableGroup.locator(":scope > summary").click();
      await stableGroup
        .locator(".work-action-group-entries")
        .waitFor({ state: "attached" });
      await currentPage.close();
    },
    30_000,
  );

  test(
    "preserves a paused reader through completion layout",
    async () => {
      const currentPage = await openHarness();
      const messages = currentPage.locator(".messages");
      await messages.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await messages.evaluate((element) => {
        element.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: -700 }),
        );
        element.scrollTop -= 700;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      });

      const before = await messages.evaluate((element) => ({
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
      }));
      expect(before.top).toBeLessThan(before.max - 100);

      await completeLatestTurn(currentPage);
      await currentPage.waitForTimeout(80);

      const after = await messages.evaluate((element) => ({
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
      }));
      expect(after.top).toBeLessThan(after.max - 100);
      expect(Math.abs(after.top - before.top)).toBeLessThan(80);
    },
    30_000,
  );

  test(
    "keeps a late prior reply before an optimistic next request",
    async () => {
      const currentPage = await openHarness();
      const composer = currentPage.locator("textarea.composer-input");
      await composer.fill("Start the next request");
      await composer.press("Enter");
      await currentPage
        .locator(".messages")
        .getByText("Start the next request")
        .waitFor();

      await completeLatestTurn(currentPage);
      const transcriptText = await currentPage.locator(".messages").innerText();
      expect(
        transcriptText.indexOf(
          "The previous answer arrived during completion reconciliation.",
        ),
      ).toBeLessThan(transcriptText.indexOf("Start the next request"));

      await waitForCondition(
        async () =>
          (await currentPage.locator(".messages").evaluate((element) =>
            Math.abs(
              element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )) < 4,
        "SessionView did not keep following the new turn tail",
      );
    },
    30_000,
  );

  test(
    "keeps the sent request before its response when app-server confirms the user item late",
    async () => {
      const currentPage = await openHarness();
      const composer = currentPage.locator("textarea.composer-input");
      await composer.fill("Start the next request");
      await composer.press("Enter");
      await currentPage
        .locator(".messages")
        .getByText("Start the next request")
        .waitFor();
      await currentPage.waitForTimeout(150);

      emitCodexEvents([
        {
          kind: "notification",
          method: "item/completed",
          params: {
            threadId,
            turnId: "turn-next",
            item: {
              id: "next-answer",
              type: "agentMessage",
              text: "This is the new turn response.",
            },
          },
          threadId,
          turnId: "turn-next",
          receivedAt: "2026-10-01T10:00:10.000Z",
        },
      ]);
      await currentPage.getByText("This is the new turn response.").waitFor();

      emitCodexEvents([
        {
          kind: "notification",
          method: "item/completed",
          params: {
            threadId,
            turnId: "turn-next",
            item: {
              id: "next-user",
              type: "userMessage",
              content: [{ type: "text", text: "Start the next request" }],
            },
          },
          threadId,
          turnId: "turn-next",
          receivedAt: "2026-10-01T10:00:11.000Z",
        },
      ]);

      await waitForCondition(async () => {
        const transcriptText = await currentPage.locator(".messages").innerText();
        return (
          transcriptText.indexOf("Start the next request") >= 0 &&
          transcriptText.indexOf("Start the next request") <
            transcriptText.indexOf("This is the new turn response.")
        );
      }, "The canonical user row moved behind its app-server response");
      await currentPage.close();
    },
    30_000,
  );
});
