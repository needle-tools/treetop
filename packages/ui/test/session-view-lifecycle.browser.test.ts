import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type Plugin, type ViteDevServer } from "vite";

const uiRoot = resolve(import.meta.dir, "..");
let server: ViteDevServer;
let browser: Browser;
let origin = "";
let latestTurnComplete = false;
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
    configFile: resolve(uiRoot, "vite.config.ts"),
    logLevel: "error",
    plugins: [lifecycleApiPlugin()],
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

describe.serial("SessionView browser lifecycle", () => {
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
});
