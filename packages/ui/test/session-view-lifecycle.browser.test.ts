import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const test = (name: string, run: () => Promise<void>, timeout: number) =>
  nodeTest(name, { timeout }, run);
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
        id: "latest-subagent-spawn",
        type: "dynamicToolCall",
        tool: "spawn_agent",
        arguments: {
          task_name: "layout_review",
          model: "gpt-6-astra",
          reasoning_effort: "high",
          message: "Review the lifecycle layout without changing it.",
        },
        result: {
          agent_id: "child-layout-review",
          nickname: "Kierkegaard",
        },
      },
      {
        id: "latest-subagent-activity",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "child-layout-review",
        agentPath: "/root/layout_review",
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
              text: [
                "The previous answer arrived during completion reconciliation.",
                "",
                "```mermaid",
                "graph LR",
                "request --> response",
                "```",
              ].join("\n"),
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

before(async () => {
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
}, { timeout: 30_000 });

after(async () => {
  for (const client of eventClients) client.end();
  eventClients.clear();
  await browser?.close();
  server?.httpServer?.closeAllConnections();
  await server?.close();
}, { timeout: 10_000 });

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

describe("SessionView browser lifecycle", { concurrency: false }, () => {
  test("a terminal shown visually stays attached; failed Stop preserves it and successful Stop clears it", async () => {
    terminalStopCalls = 0;
    terminalStopStatus = 502;
    const currentPage = await browser.newPage();
    try {
      await currentPage.goto(`${origin}/test/browser/session-view-lifecycle.html?terminal=1`, { waitUntil: "networkidle" });
      await currentPage.getByRole("button", { name: "Session menu", exact: true }).click();
      await currentPage.getByText("View as", { exact: true }).hover();
      await currentPage.getByText("Visual", { exact: true }).click();
      assert.equal(await currentPage.locator(".composer").count(), 0);
      const stop = currentPage.getByRole("button", { name: "Stop Session", exact: true });
      await stop.click();
      await waitForCondition(async () => terminalStopCalls === 1, "Stop did not address the attached terminal");
      await stop.waitFor();
      assert.equal(await currentPage.locator("main").getAttribute("data-stopped"), "false");
      terminalStopStatus = 200;
      await stop.click();
      await waitForCondition(async () => await currentPage.locator("main").getAttribute("data-stopped") === "true", "Successful stop retained the terminal attachment");
      assert.equal(terminalStopCalls, 2);
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
      assert.equal(await currentPage.locator(".composer").count(), 0);
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
      assert.equal(await currentPage.locator("main").getAttribute("data-working"), "false");
      await currentPage.getByRole("button", { name: "Resume", exact: true }).click();
      await waitForCondition(async () => await currentPage.locator("main").getAttribute("data-stopped") === "false", "Resume did not restore the visual session");
    } finally { await currentPage.close(); }
  }, 30000);

  test("surfaces a canonical subagent roster and opens the selected child", async () => {
    const currentPage = await openHarness();
    const badge = currentPage.getByRole("button", {
      name: "Show subagents",
    });
    await badge.waitFor();
    expect(await badge.textContent()).toContain("Subagents: 1");
    await badge.click();
    const pane = currentPage.getByLabel("Codex subagents");
    await pane.getByText("Kierkegaard").waitFor();
    await pane.getByText("gpt-6-astra · high").waitFor();
    await pane
      .getByText("Review the lifecycle layout without changing it.")
      .waitFor();
    await pane.locator(".composer-panel-item").click();
    expect(
      await currentPage.locator("[data-opened-subagent]").textContent(),
    ).toBe("child-layout-review");
    expect(
      await currentPage.locator(".messages").getByText("child-layout-review").count(),
    ).toBe(0);
    await currentPage.close();
  }, 30_000);

  test("queue and subagents share the composer panel and item system", async () => {
    const currentPage = await openHarness();
    await currentPage
      .getByRole("button", { name: "Show subagents" })
      .click();
    const subagentPanel = currentPage.getByLabel("Codex subagents");
    await subagentPanel.waitFor();
    expect(await subagentPanel.getAttribute("data-composer-panel")).toBe(
      "subagents",
    );
    const subagentItem = subagentPanel.locator(".composer-panel-item");
    await subagentItem.waitFor();
    const sharedCardStyles = async (locator: typeof subagentItem) =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          borderRadius: style.borderRadius,
          background: style.backgroundColor,
          padding: style.padding,
        };
      });
    const subagentCardStyles = await sharedCardStyles(subagentItem);
    await currentPage
      .getByRole("button", { name: "Collapse subagents" })
      .click();

    emitCodexEvents([
      {
        kind: "notification",
        method: "turn/started",
        params: { threadId, turn: { id: "turn-queue" } },
        threadId,
        turnId: "turn-queue",
        receivedAt: "2026-10-07T10:00:00.000Z",
      },
    ]);
    const composer = currentPage.locator(".composer-input");
    await composer.fill("Run the focused queue regression next");
    await currentPage
      .getByRole("button", { name: "Queue Codex message" })
      .click();
    const queueBadge = currentPage.getByRole("button", {
      name: "Show queued messages",
    });
    await queueBadge.waitFor();
    await queueBadge.click();

    const queuePanel = currentPage.getByLabel("Queued Codex messages");
    expect(await queuePanel.getAttribute("data-composer-panel")).toBe("queue");
    const queueItem = queuePanel.locator(".composer-panel-item");
    await queueItem.waitFor();
    await queueItem.getByText("Next", { exact: true }).waitFor();
    await queueItem
      .getByText("Run the focused queue regression next")
      .waitFor();

    expect(await sharedCardStyles(queueItem)).toEqual(subagentCardStyles);
    await currentPage.close();
  }, 30_000);

  test("the follow handle reaches the exact bottom and keeps following streamed output", async () => {
    const currentPage = await openHarness();
    await currentPage
      .locator(".session-lifecycle-stage")
      .evaluate((element) => {
        (element as HTMLElement).style.height = "320px";
        (element as HTMLElement).style.setProperty(
          "--session-body-min-height",
          "12rem",
        );
      });
    const messages = currentPage.locator(".messages");
    const followHandle = currentPage.locator(".session-tail-follow");
    emitCodexEvents([
      {
        kind: "notification",
        method: "turn/started",
        params: { threadId, turn: { id: latestTurnId } },
        threadId,
        turnId: latestTurnId,
        receivedAt: "2026-10-07T09:59:59.000Z",
      },
    ]);
    await currentPage.locator(".work-foldout-live").waitFor();
    emitCodexEvents(
      Array.from({ length: 12 }, (_, index) => ({
        kind: "notification",
        method: "item/completed",
        params: {
          threadId,
          turnId: latestTurnId,
          item: {
            id: `follow-command-${index}`,
            type: "commandExecution",
            command: `/bin/zsh -lc 'echo ${index}'`,
            status: "completed",
            aggregatedOutput: `${index}\n`,
          },
        },
        threadId,
        turnId: latestTurnId,
        receivedAt: "2026-10-07T09:59:59.000Z",
      })),
    );
    await currentPage.waitForTimeout(150);
    const actionGroup = currentPage
      .locator(".work-foldout-live .work-action-group")
      .last();
    if ((await actionGroup.getAttribute("open")) === null) {
      await actionGroup.locator(":scope > summary").click();
    }
    await currentPage.waitForTimeout(150);
    const liveBody = currentPage.locator(
      ".work-foldout-live > .work-foldout-body",
    );
    expect(
      await liveBody.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      ),
    ).toBeGreaterThan(0);
    await messages.evaluate((element) => {
      element.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
      );
      element.scrollTop = element.scrollHeight - element.clientHeight - 40;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(await followHandle.getAttribute("class")).not.toContain("active");
    await followHandle.click();
    await currentPage.waitForTimeout(150);
    const tailDistance = () =>
      messages.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      );
    expect(await tailDistance()).toBeLessThanOrEqual(1);
    expect(await followHandle.getAttribute("class")).toContain("active");
    expect(
      await liveBody.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    ).toBeLessThanOrEqual(1);

    emitCodexEvents([
      {
        kind: "notification",
        method: "turn/started",
        params: { threadId, turn: { id: "turn-follow" } },
        threadId,
        turnId: "turn-follow",
        receivedAt: "2026-10-07T10:00:00.000Z",
      },
      {
        kind: "notification",
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn-follow",
          item: {
            id: "follow-user",
            type: "userMessage",
            content: [
              { type: "text", text: "Continue following this request" },
            ],
          },
        },
        threadId,
        turnId: "turn-follow",
        receivedAt: "2026-10-07T10:00:01.000Z",
      },
      {
        kind: "notification",
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn-follow",
          item: {
            id: "follow-answer",
            type: "agentMessage",
            text: "The next output is visible at the bottom.",
          },
        },
        threadId,
        turnId: "turn-follow",
        receivedAt: "2026-10-07T10:00:02.000Z",
      },
    ]);
    await messages
      .getByText("The next output is visible at the bottom.")
      .waitFor();
    await currentPage.waitForTimeout(150);
    expect(await tailDistance()).toBeLessThanOrEqual(1);
    expect(await followHandle.getAttribute("class")).toContain("active");
    await currentPage.close();
  }, 30_000);

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
      assert.notEqual(questionColor, thinkingColor);
      assert.notEqual(questionBackground, "rgba(0, 0, 0, 0)");

      await questionBadge.click();
      const questionPane = currentPage.getByLabel("Codex questions");
      await questionPane.getByText("Which scope should this use?").waitFor();
      await questionPane.getByRole("button", { name: "Current file" }).waitFor();
      const questionStyles = await questionPane.evaluate((pane) => {
        const style = getComputedStyle(pane);
        const prompt = getComputedStyle(
          pane.querySelector(".async-question-prompt")!,
        );
        const option = getComputedStyle(
          pane.querySelector(".async-question-options button")!,
        );
        const card = getComputedStyle(pane.querySelector(".async-question")!);
        return {
          width: style.width,
          padding: style.padding,
          radius: style.borderRadius,
          font: prompt.fontSize,
          weight: prompt.fontWeight,
          lineHeight: prompt.lineHeight,
          optionFont: option.fontSize,
          optionRadius: option.borderRadius,
          cardRadius: card.borderRadius,
        };
      });
      emitCodexEvents([
        {
          kind: "notification",
          method: "thread/goal/updated",
          params: {
            threadId,
            turnId: latestTurnId,
            goal: {
              threadId,
              objective: "Use the existing composer styles.",
              status: "active",
            },
          },
          threadId,
          turnId: latestTurnId,
          receivedAt: "2026-10-07T11:00:00.000Z",
        },
      ]);
      await currentPage
        .getByRole("button", { name: "Show goal", exact: true })
        .click();
      const goalPane = currentPage.getByLabel("Codex goal", { exact: true });
      await goalPane.waitFor();
      const goalStyles = await goalPane.evaluate((pane) => {
        const style = getComputedStyle(pane);
        const text = getComputedStyle(pane.querySelector(".codex-goal-objective")!);
        const action = getComputedStyle(pane.querySelector(".codex-goal-action")!);
        return {
          width: style.width,
          padding: style.padding,
          radius: style.borderRadius,
          font: text.fontSize,
          weight: text.fontWeight,
          lineHeight: text.lineHeight,
          optionFont: action.fontSize,
          optionRadius: action.borderRadius,
          cardRadius: action.borderRadius,
        };
      });
      expect(questionStyles).toEqual(goalStyles);
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

      assert.notEqual(thinkingBox, null);
      assert.notEqual(commandBox, null);
      assert(Math.abs(thinkingBox!.x - commandBox!.x) < 1);
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
      assert(await openGroup.locator(".work-action-group-entries").count() > 0);

      const groupId = await openGroup.getAttribute("data-work-action-group");
      assert.notEqual(groupId, null);
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
      assert(before.top < before.max - 100);

      await completeLatestTurn(currentPage);
      await currentPage.waitForTimeout(80);

      const after = await messages.evaluate((element) => ({
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
      }));
      assert(after.top < after.max - 100);
      assert(Math.abs(after.top - before.top) < 80);
    },
    30_000,
  );

  test(
    "renders Mermaid fences as diagrams in app-server messages",
    async () => {
      const currentPage = await openHarness();
      const pageErrors: string[] = [];
      currentPage.on("pageerror", (error) => pageErrors.push(error.message));
      await completeLatestTurn(currentPage);
      const diagram = currentPage.locator(".mermaid-diagram");
      await diagram.waitFor({ state: "attached" });
      try {
        await waitForCondition(
          async () =>
            (await diagram.getAttribute("data-mermaid-status")) === "rendered",
          "Mermaid diagram did not render",
        );
      } catch {
        const diagramState = await diagram.evaluateAll((elements) =>
          elements.map((element) => ({
            status: (element as HTMLElement).dataset.mermaidStatus,
            parent: element.parentElement?.className,
            connected: element.isConnected,
            html: element.outerHTML,
          })),
        );
        throw new Error(
          `Mermaid diagram did not render (${JSON.stringify(diagramState)}; errors: ${pageErrors.join(" | ") || "none"})`,
        );
      }
      expect(await diagram.locator("svg").count()).toBe(1);
      expect(await currentPage.locator("code.language-mermaid").count()).toBe(
        0,
      );
      await currentPage.close();
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
      assert(
        transcriptText.indexOf("The previous answer arrived during completion reconciliation.") <
          transcriptText.indexOf("Start the next request"),
      );

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
