import { after, before, describe, test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, type Browser, type Page } from "playwright-core";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const test = (name: string, run: () => Promise<void>, timeout: number) =>
  nodeTest(name, { timeout }, run);
let server: ViteDevServer;
let browser: Browser;
let origin = "";
let latestTurnComplete = false;
let sessionModel = "gpt-6.1";
let usageHistoryItems: Record<string, unknown>[] = [];
let childUsageHistoryItems: Record<string, unknown>[] = [];
let historicalWorkGroupCount = 0;
let historicalTurnCount = 18;
let historicalSubagentOnly = false;
let olderHistoryAvailable = false;
let terminalStopStatus = 200;
let terminalStopCalls = 0;
let turnRequestDelayMs = 120;
let historyRequestDelayMs = 0;
let historyRequestCount = 0;
let turnRequestCount = 0;
let turnResponseIds: string[] = [];
let turnResponseStatus = 200;
let turnResponseGates: Promise<void>[] = [];
const turnRequestInputs: { threadId: string; text: string }[] = [];
const eventClients = new Set<ServerResponse>();
const threadId = "lifecycle-thread";
const latestTurnId = "turn-latest";

function threadPage(complete: boolean): unknown {
  const turns = Array.from({ length: historicalTurnCount }, (_, index) => {
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
    ...(complete ? { completedAt: 1_780_000_208 } : {}),
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
      ...Array.from({ length: historicalWorkGroupCount }, (_, index) => [
        {
          id: `historical-reasoning-${index}`,
          type: "reasoning",
          summary: [
            {
              type: "summary_text",
              text: `Planning historical command ${index}`,
            },
          ],
        },
        {
          id: `historical-command-${index}`,
          type: "commandExecution",
          command: `/bin/zsh -lc 'echo ${index}'`,
          cwd: "/tmp/treetop-session-lifecycle",
          status: "completed",
          aggregatedOutput: `${index}\n`,
        },
        {
          id: `historical-response-${index}`,
          type: "agentMessage",
          text: `Historical checkpoint ${index}`,
        },
      ]).flat(),
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
      ...usageHistoryItems,
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
  if (historicalSubagentOnly) {
    const latest = turns.at(-1)!;
    const subagentItems = latest.items.filter((item) => item.id.startsWith("latest-subagent"));
    latest.items = latest.items.filter((item) => !item.id.startsWith("latest-subagent"));
    turns[0]!.items.push(...subagentItems);
  }
  return {
    ok: true,
    thread: {
      id: threadId,
      cwd: "/tmp/treetop-session-lifecycle",
      createdAt: 1_780_000_000,
      turns: turns.reverse(),
    },
    model: sessionModel,
    nextCursor: olderHistoryAvailable ? "older-page" : null,
  };
}

function olderThreadPage(): unknown {
  const turns = Array.from({ length: 80 }, (_, index) => ({
    id: `turn-older-page-${index}`,
    startedAt: 1_779_999_000 + index * 10,
    completedAt: 1_779_999_005 + index * 10,
    items: [
      {
        id: `user-older-page-${index}`,
        type: "userMessage",
        content: [
          {
            type: "text",
            text:
              index === 0
                ? "Oldest loaded request must remain reachable without a cursor"
                : index === 30
                ? "Older paged request that must remain in scrollback"
                : `Older paged request ${index}`,
          },
        ],
      },
      {
        id: `answer-older-page-${index}`,
        type: "agentMessage",
        text: `Older paged response ${index} that must remain in scrollback`,
      },
    ],
  })).reverse();
  return {
    ok: true,
    thread: {
      id: threadId,
      cwd: "/tmp/treetop-session-lifecycle",
      createdAt: 1_779_999_900,
      turns,
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
          response.on("close", () => eventClients.delete(response));
          return;
        }
        if (url.pathname === "/api/codex-app/thread") {
          if (url.searchParams.get("threadId") === "child-layout-review") {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ thread: { id: "child-layout-review", createdAt: 1780000200, turns: [{ id: "child-turn", startedAt: 1780000201, items: childUsageHistoryItems }] }, model: "gpt-6.1", nextCursor: null }));
            return;
          }
          historyRequestCount += 1;
          if (historyRequestDelayMs) await new Promise(resolveDelay => setTimeout(resolveDelay, historyRequestDelayMs));
          response.setHeader("Content-Type", "application/json");
          if (url.searchParams.get("threadId") === "other-lifecycle-thread") {
            response.end(JSON.stringify({ ok: true, thread: { id: "other-lifecycle-thread", cwd: "/tmp/treetop-session-lifecycle", turns: [{ id: "other-turn", items: [{ id: "other-answer", type: "agentMessage", text: "OTHER_SESSION_ANSWER" }] }] }, nextCursor: null }));
            return;
          }
          response.end(
            JSON.stringify(
              url.searchParams.get("cursor") === "older-page"
                ? olderThreadPage()
                : threadPage(latestTurnComplete),
            ),
          );
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
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const input = JSON.parse(Buffer.concat(chunks).toString());
          turnRequestInputs.push({ threadId: input.threadId, text: input.text });
          const responseTurnId = input.steer ? input.expectedTurnId : (turnResponseIds.shift() ?? "turn-next");
          const responseStatus = turnResponseStatus;
          turnRequestCount += 1;
          const gate = turnResponseGates.shift();
          if (gate) await gate;
          else await new Promise((resolveDelay) => setTimeout(resolveDelay, turnRequestDelayMs));
          response.setHeader("Content-Type", "application/json");
          response.statusCode = responseStatus;
          response.end(
            JSON.stringify({
              ok: true,
              threadId,
              turnId: responseTurnId,
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
    optimizeDeps: { entries: ["test/browser/session-view-lifecycle.html"] },
    logLevel: "error",
    plugins: [svelte(), lifecycleApiPlugin()],
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {},
      warmup: { clientFiles: ["./test/browser/session-view-lifecycle-main.ts"] },
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Vite lifecycle-test server did not bind a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
  const engine = process.env.TREETOP_TEST_BROWSER ?? "chromium";
  if (engine !== "chromium" && engine !== "webkit") throw new Error(`Unsupported TREETOP_TEST_BROWSER: ${engine}`);
  browser = engine === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true });
}, { timeout: 30_000 });

after(async () => {
  for (const client of eventClients) client.end();
  eventClients.clear();
  await browser?.close();
  server?.httpServer?.closeAllConnections();
  await server?.close();
}, { timeout: 10_000 });

async function openHarness(options: { query?: string } = {}): Promise<Page> {
  latestTurnComplete = false;
  const currentPage = await browser.newPage({
    viewport: { width: 900, height: 680 },
  });
  const startupErrors: string[] = [];
  currentPage.on("pageerror", error => startupErrors.push(error.message));
  currentPage.on("requestfailed", request => startupErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
  // Observe this page's stream, rather than a connection left by another page.
  // Start the deadline before navigation so cold Vite transforms share it.
  const streamReady = currentPage.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/codex-app/events" && response.status() === 200,
    { timeout: 20_000 },
  );
  // Attach immediately: navigation failures must not leave an unhandled timer.
  void streamReady.catch(() => {});
  try {
    await currentPage.goto(
      `${origin}/test/browser/session-view-lifecycle.html${options.query ? `?${options.query}` : ""}`,
      { waitUntil: "networkidle" },
    );
    await currentPage.locator(".messages").waitFor();
    await waitForCondition(
      async () =>
        historicalWorkGroupCount > 0
          ? (await currentPage.locator(".work-row").count()) > 0
          : (await currentPage.locator(".msg").count()) > 20,
      "SessionView did not render its history",
    );
    await streamReady;
    return currentPage;
  } catch (error) {
    await currentPage.close();
    throw new Error(`${error instanceof Error ? error.message : error}\nBrowser startup errors: ${startupErrors.join("; ") || "none"}`, { cause: error });
  }
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
  test("keeps queued work owned by its session when the view switches sessions", async () => {
    const currentPage = await openHarness();
    const requestsBefore = turnRequestInputs.length;
    try {
      emitCodexEvents([{
        kind: "notification", method: "turn/started", threadId,
        turnId: latestTurnId, receivedAt: "2026-10-01T10:00:10.000Z",
        params: { turn: { id: latestTurnId } },
      }]);
      await currentPage.getByRole("button", { name: "Stop Codex", exact: true }).waitFor();
      const composer = currentPage.locator("textarea.composer-input");
      await composer.fill("QUEUED_FOR_ORIGINAL_SESSION");
      await composer.press("Enter");
      await currentPage.getByRole("button", { name: "Show queued messages", exact: true }).waitFor();
      assert.deepEqual(turnRequestInputs.slice(requestsBefore), []);

      await currentPage.getByRole("button", { name: "Switch session", exact: true }).click();
      await currentPage.locator(".messages").getByText("OTHER_SESSION_ANSWER", { exact: true }).waitFor();
      await currentPage.waitForTimeout(250);
      assert.deepEqual(turnRequestInputs.slice(requestsBefore), []);
      assert.equal(await currentPage.getByRole("button", { name: "Show queued messages", exact: true }).count(), 0);
      assert(!(await currentPage.locator(".messages").innerText()).includes("QUEUED_FOR_ORIGINAL_SESSION"));

      await currentPage.getByRole("button", { name: "Switch session", exact: true }).click();
      await waitForCondition(async () => turnRequestInputs.length > requestsBefore, "Original queue was not restored");
      assert.deepEqual(turnRequestInputs.slice(requestsBefore), [
        { threadId, text: "QUEUED_FOR_ORIGINAL_SESSION" },
      ]);
    } finally {
      await currentPage.close();
    }
  }, 30_000);

  test("isolates a pending send from a different session and its late HTTP response", async () => {
    const currentPage = await openHarness();
    turnRequestDelayMs = 750;
    try {
      const requestsBefore = turnRequestCount;
      await currentPage.locator("textarea.composer-input").fill("OLD_SESSION_PENDING");
      await currentPage.locator("textarea.composer-input").press("Enter");
      await waitForCondition(async () => turnRequestCount > requestsBefore, "Send did not reach server");
      await currentPage.getByRole("button", { name: "Switch session", exact: true }).click();
      await currentPage.locator(".messages").getByText("OTHER_SESSION_ANSWER", { exact: true }).waitFor();
      assert.equal(await currentPage.locator(".messages").getByText("OLD_SESSION_PENDING", { exact: true }).count(), 0);
      assert.equal(await currentPage.getByRole("button", { name: "Stop Codex", exact: true }).count(), 0);
      await currentPage.waitForTimeout(900);
      assert.equal(await currentPage.locator(".messages").getByText("OLD_SESSION_PENDING", { exact: true }).count(), 0);
      assert.equal(await currentPage.getByRole("button", { name: "Stop Codex", exact: true }).count(), 0);
    } finally {
      turnRequestDelayMs = 120;
      await currentPage.close();
    }
  }, 30_000);

  test("ignores an old send failure after switching away and back to the same source", async () => {
    const currentPage = await openHarness();
    turnRequestDelayMs = 1500;
    turnResponseStatus = 502;
    try {
      const requestsBefore = turnRequestCount;
      const composer = currentPage.locator("textarea.composer-input");
      await composer.fill("OLD_SOURCE_REQUEST");
      await composer.press("Enter");
      await waitForCondition(async () => turnRequestCount > requestsBefore, "Send did not reach server");
      await currentPage.getByRole("button", { name: "Switch session", exact: true }).click();
      await currentPage.locator(".messages").getByText("OTHER_SESSION_ANSWER", { exact: true }).waitFor();
      await currentPage.getByRole("button", { name: "Switch session", exact: true }).click();
      await currentPage.waitForTimeout(1600);
      assert.equal(await composer.inputValue(), "");
      assert.equal(await currentPage.getByText("HTTP 502", { exact: true }).count(), 0);
    } finally {
      turnRequestDelayMs = 120;
      turnResponseStatus = 200;
      await currentPage.close();
    }
  }, 30_000);

  test("keeps an SSE-confirmed completed send accepted after a late HTTP failure", async () => {
    const currentPage = await openHarness();
    turnRequestDelayMs = 750;
    turnResponseStatus = 502;
    const initialRequests = turnRequestCount;
    try {
      const composer = currentPage.locator("textarea.composer-input");
      await composer.fill("CONFIRMED_REQUEST");
      await composer.press("Enter");
      await waitForCondition(async () => turnRequestCount > initialRequests, "Send was not received");
      emitCodexEvents([
        { kind: "notification", method: "turn/started", threadId, turnId: "turn-next", receivedAt: "2026-10-01T10:00:10.000Z", params: { turn: { id: "turn-next" } } },
        { kind: "notification", method: "item/completed", threadId, turnId: "turn-next", receivedAt: "2026-10-01T10:00:11.000Z", params: { item: { id: "confirmed-user", type: "userMessage", content: [{ type: "text", text: "CONFIRMED_REQUEST" }] } } },
        { kind: "notification", method: "item/completed", threadId, turnId: "turn-next", receivedAt: "2026-10-01T10:00:12.000Z", params: { item: { id: "confirmed-answer", type: "agentMessage", text: "CONFIRMED_ANSWER" } } },
        { kind: "notification", method: "turn/completed", threadId, turnId: "turn-next", receivedAt: "2026-10-01T10:00:13.000Z", params: { turnId: "turn-next" } },
      ]);
      await currentPage.locator(".messages").getByText("CONFIRMED_ANSWER", { exact: true }).waitFor();
      await currentPage.waitForTimeout(900);
      assert.equal(await composer.inputValue(), "");
      assert((await currentPage.locator(".messages").innerText()).includes("CONFIRMED_REQUEST"));
      assert.equal(await currentPage.getByText("HTTP 502", { exact: true }).count(), 0);
    } finally {
      turnRequestDelayMs = 120;
      turnResponseStatus = 200;
      await currentPage.close();
    }
  }, 30_000);

  test("accepts only the acknowledged steer when identical sends receive late HTTP failures", async () => {
    const currentPage = await openHarness();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    turnResponseGates = [
      new Promise<void>(resolve => { releaseFirst = resolve; }),
      new Promise<void>(resolve => { releaseSecond = resolve; }),
    ];
    turnResponseStatus = 502;
    const requestsBefore = turnRequestCount;
    try {
      emitCodexEvents([{ kind: "notification", method: "turn/started", threadId, turnId: latestTurnId, receivedAt: "2026-10-01T10:00:10.000Z", params: { turn: { id: latestTurnId } } }]);
      const composer = currentPage.locator("textarea.composer-input");
      await composer.fill("REPEATED_STEER");
      await currentPage.locator(".composer-steer").click();
      await waitForCondition(async () => turnRequestCount === requestsBefore + 1, "First steer did not reach server");
      await composer.fill("REPEATED_STEER");
      await currentPage.locator(".composer-steer").click();
      await waitForCondition(async () => turnRequestCount === requestsBefore + 2, "Second steer did not reach server");
      const sequence = async () => (await currentPage.locator(".messages").innerText()).match(/REPEATED_STEER/g) ?? [];
      assert.deepEqual(await sequence(), ["REPEATED_STEER", "REPEATED_STEER"]);
      emitCodexEvents([{ kind: "notification", method: "item/completed", threadId, turnId: latestTurnId, receivedAt: "2026-10-01T10:00:11.000Z", params: { item: { id: "accepted-first-steer", type: "userMessage", content: [{ type: "text", text: "REPEATED_STEER" }] } } }]);
      await currentPage.locator('[data-visual-scroll-anchor*="accepted-first-steer"]').waitFor();
      releaseFirst();
      await currentPage.waitForTimeout(900);
      assert.equal(await composer.inputValue(), "");
      assert.deepEqual(await sequence(), ["REPEATED_STEER", "REPEATED_STEER"]);
      releaseSecond();
      await waitForCondition(async () => await composer.inputValue() === "REPEATED_STEER", "Rejected second steer did not restore its draft");
      assert.deepEqual(await sequence(), ["REPEATED_STEER"]);
    } finally {
      releaseFirst();
      releaseSecond();
      turnResponseGates = [];
      turnRequestDelayMs = 120;
      turnResponseStatus = 200;
      await currentPage.close();
    }
  }, 30_000);

  test("preserves each promoted queued request through fast completion, late user items, and remount", async () => {
    const currentPage = await openHarness();
    turnRequestDelayMs = 500;
    turnResponseIds = ["queued-turn-1", "queued-turn-2"];
    const initialRequests = turnRequestCount;
    const item = (turnId: string, id: string, type: string, text: string) => ({
      kind: "notification", method: "item/completed", threadId, turnId, receivedAt: "2026-10-01T10:00:11.000Z",
      params: { item: { id, type, ...(type === "userMessage" ? { content: [{ type: "text", text }] } : { text }) } },
    });
    const lifecycle = (turnId: string, method: string) => ({
      kind: "notification", method, threadId, turnId, receivedAt: "2026-10-01T10:00:12.000Z", params: { turnId, turn: { id: turnId } },
    });
    const sequence = async () => (await currentPage.locator(".messages").innerText()).match(/QUEUED_ONE|QUEUED_TWO|ANSWER_ONE|ANSWER_TWO/g) ?? [];
    try {
      emitCodexEvents([lifecycle(latestTurnId, "turn/started")]);
      await currentPage.getByRole("button", { name: "Stop Codex", exact: true }).waitFor();
      const composer = currentPage.locator("textarea.composer-input");
      await composer.fill("QUEUED_ONE");
      await composer.press("Enter");
      await composer.fill("QUEUED_TWO");
      await composer.press("Enter");
      assert.deepEqual(await sequence(), []);
      await completeLatestTurn(currentPage);
      await waitForCondition(async () => turnRequestCount === initialRequests + 1, "First queued request was not promoted");
      assert.deepEqual(await sequence(), ["QUEUED_ONE"]);
      emitCodexEvents([
        lifecycle("queued-turn-1", "turn/started"),
        item("queued-turn-1", "queued-user-1", "userMessage", "QUEUED_ONE"),
        item("queued-turn-1", "queued-answer-1", "agentMessage", "ANSWER_ONE"),
        lifecycle("queued-turn-1", "turn/completed"),
      ]);
      await waitForCondition(async () => turnRequestCount === initialRequests + 2, "Second queued request was blocked by a stale start response");
      assert.deepEqual(await sequence(), ["QUEUED_ONE", "ANSWER_ONE", "QUEUED_TWO"]);
      emitCodexEvents([
        lifecycle("queued-turn-2", "turn/started"),
        item("queued-turn-2", "queued-answer-2", "agentMessage", "ANSWER_TWO"),
      ]);
      await waitForCondition(async () => (await sequence()).includes("ANSWER_TWO"), "Second queued response was not shown");
      assert.deepEqual(await sequence(), ["QUEUED_ONE", "ANSWER_ONE", "QUEUED_TWO", "ANSWER_TWO"]);
      emitCodexEvents([
        item("queued-turn-2", "queued-user-2", "userMessage", "QUEUED_TWO"),
        lifecycle("queued-turn-2", "turn/completed"),
      ]);
      await currentPage.waitForTimeout(650);
      assert.deepEqual(await sequence(), ["QUEUED_ONE", "ANSWER_ONE", "QUEUED_TWO", "ANSWER_TWO"]);
      const stage = currentPage.locator(".session-lifecycle-stage");
      await stage.evaluate(element => { (element as HTMLElement).style.transform = "translateX(2000px)"; });
      await waitForCondition(async () => (await currentPage.locator(".messages").count()) === 0, "Lane did not unmount");
      await stage.evaluate(element => { (element as HTMLElement).style.transform = ""; });
      await currentPage.locator(".messages").waitFor();
      assert.deepEqual(await sequence(), ["QUEUED_ONE", "ANSWER_ONE", "QUEUED_TWO", "ANSWER_TWO"]);
    } finally {
      turnRequestDelayMs = 120;
      turnResponseIds = [];
      await currentPage.close();
    }
  }, 30_000);

  test("does not reopen a completed turn when its start response arrives late", async () => {
    const currentPage = await openHarness();
    turnRequestDelayMs = 750;
    const initialRequests = turnRequestCount;
    try {
      await currentPage.locator("textarea.composer-input").fill("FAST_REQUEST");
      await currentPage.locator("textarea.composer-input").press("Enter");
      await waitForCondition(async () => turnRequestCount > initialRequests, "Turn start did not reach server");
      emitCodexEvents([
        { kind: "notification", method: "turn/started", threadId, turnId: "turn-next", receivedAt: "2026-10-01T10:00:10.000Z", params: { turn: { id: "turn-next" } } },
        { kind: "notification", method: "item/completed", threadId, turnId: "turn-next", receivedAt: "2026-10-01T10:00:11.000Z", params: { item: { id: "fast-user", type: "userMessage", content: [{ type: "text", text: "FAST_REQUEST" }] } } },
        { kind: "notification", method: "item/completed", threadId, turnId: "turn-next", receivedAt: "2026-10-01T10:00:12.000Z", params: { item: { id: "fast-answer", type: "agentMessage", text: "FAST_ANSWER" } } },
        { kind: "notification", method: "turn/completed", threadId, turnId: "turn-next", receivedAt: "2026-10-01T10:00:13.000Z", params: { turnId: "turn-next" } },
      ]);
      await currentPage.locator(".messages").getByText("FAST_ANSWER", { exact: true }).waitFor();
      const sequence = async () => (await currentPage.locator(".messages").innerText()).match(/FAST_REQUEST|FAST_ANSWER/g) ?? [];
      assert.deepEqual(await sequence(), ["FAST_REQUEST", "FAST_ANSWER"]);
      await currentPage.waitForTimeout(900);
      assert.equal(await currentPage.getByRole("button", { name: "Stop Codex", exact: true }).count(), 0);
      assert.deepEqual(await sequence(), ["FAST_REQUEST", "FAST_ANSWER"]);
    } finally {
      turnRequestDelayMs = 120;
      await currentPage.close();
    }
  }, 30_000);

  test("keeps a canonical steer at its visible position when output arrives before acknowledgment", async () => {
    const currentPage = await openHarness();
    try {
      emitCodexEvents([{ kind: "notification", method: "turn/started", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-01T10:00:01.000Z", params: { threadId, turn: { id: latestTurnId } } }]);
      await currentPage.locator("textarea.composer-input").fill("STEER_KEEP_THIS_MESSAGE");
      await currentPage.locator(".composer-steer").waitFor();
      await currentPage.locator(".composer-steer").click();
      const textSequence = async () => (await currentPage.locator(".messages").innerText()).match(/STEER_KEEP_THIS_MESSAGE|OUTPUT_AFTER_STEER/g) ?? [];
      await waitForCondition(async () => (await textSequence()).length === 1, "Optimistic steer did not render");
      assert.deepEqual(await textSequence(), ["STEER_KEEP_THIS_MESSAGE"]);
      emitCodexEvents([{ kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-01T10:00:03.000Z", params: { item: { id: "after-steer", type: "agentMessage", text: "OUTPUT_AFTER_STEER" } } }]);
      await waitForCondition(async () => (await textSequence()).length === 2, "Output after steer did not render");
      assert.deepEqual(await textSequence(), ["STEER_KEEP_THIS_MESSAGE", "OUTPUT_AFTER_STEER"]);
      emitCodexEvents([{ kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-01T10:00:04.000Z", params: { item: { id: "confirmed-steer", type: "userMessage", content: [{ type: "text", text: "STEER_KEEP_THIS_MESSAGE" }] } } }]);
      await currentPage.waitForTimeout(250);
      assert.deepEqual(await textSequence(), ["STEER_KEEP_THIS_MESSAGE", "OUTPUT_AFTER_STEER"]);
      emitCodexEvents([{ kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-01T10:00:05.000Z", params: { item: { id: "continued-command", type: "commandExecution",
          command: "/bin/zsh -lc 'pwd'", cwd: "/tmp/treetop-session-lifecycle", status: "completed",
          aggregatedOutput: "/tmp/treetop-session-lifecycle\n" } } }]);
      await waitForCondition(async () => await currentPage.locator('.work-action-group[open]').count() > 0,
        "Next action group did not open");
      assert.deepEqual(await textSequence(), ["STEER_KEEP_THIS_MESSAGE", "OUTPUT_AFTER_STEER"]);
      assert.equal(await currentPage.locator(".work-steering-user-message").isVisible(), true);
      assert.equal(await currentPage.locator(".work-steering-user-message").evaluate(element =>
        element.closest(".work-action-group") === null), true);
    } finally {
      await currentPage.close();
    }
  }, 30_000);

  test(
    "promotes only the live top summary after a long lane remount",
    async () => {
      historicalWorkGroupCount = 15;
      let currentPage: Page | undefined;
      try {
        currentPage = await openHarness();
        emitCodexEvents([
          {
            kind: "notification",
            method: "turn/started",
            params: { threadId, turn: { id: latestTurnId } },
            threadId,
            turnId: latestTurnId,
            receivedAt: "2026-10-11T17:00:00.000Z",
          },
        ]);
        await currentPage.locator(".work-foldout-live").waitFor();
        const stage = currentPage.locator(".session-lifecycle-stage");
        await stage.evaluate((element) => {
          (element as HTMLElement).style.transform = "translateX(2000px)";
        });
        await waitForCondition(
          async () => (await currentPage!.locator(".messages").count()) === 0,
          "Offscreen long-work lane did not release its transcript body",
        );
        await stage.evaluate((element) => {
          (element as HTMLElement).style.transform = "";
        });
        await currentPage.locator(".messages").waitFor();
        await currentPage.waitForTimeout(250);
        const summaryPillCount = await currentPage
          .locator(".work-summary-pill-shell")
          .count();
        assert((summaryPillCount) > 10);
        const liveSummaryPill = currentPage.locator(
          ".work-foldout-live > summary .work-summary-pill-shell",
        ).first();
        const groupedSummaryPill = currentPage.locator(
          ".work-foldout-live .work-action-group .work-summary-pill-shell",
        ).first();
        await liveSummaryPill.waitFor();
        await groupedSummaryPill.waitFor();
        assert.equal(await liveSummaryPill.evaluate(
            (element) => getComputedStyle(element).willChange,
          ), "transform");
        assert.equal(await groupedSummaryPill.evaluate(
            (element) => getComputedStyle(element).willChange,
          ), "auto");
      } finally {
        historicalWorkGroupCount = 0;
        await currentPage?.close();
      }
    },
    30_000,
  );

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
    assert((await badge.textContent()).includes("Subagents: 1"));
    await badge.click();
    const pane = currentPage.getByLabel("Codex subagents");
    await pane.getByText("Kierkegaard").waitFor();
    await pane.getByText("gpt-6-astra · high").waitFor();
    await pane
      .getByText("Review the lifecycle layout without changing it.")
      .waitFor();
    emitCodexEvents([{ kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
      receivedAt: "2026-10-08T00:00:09Z", params: { item: {
        id: "latest-subagent-settings", type: "subAgentActivity", kind: "interacted", agentThreadId: "child-layout-review",
        agentPath: "/root/layout_review", model: "gpt-6.1-sol", reasoningEffort: "medium",
      } } }]);
    await pane.getByText("gpt-6.1-sol · medium").waitFor();
    await pane.locator(".composer-panel-item").click();
    assert.equal(await currentPage.locator("[data-opened-subagent]").textContent(), "child-layout-review");
    assert.partialDeepStrictEqual(JSON.parse((await currentPage.locator("[data-opened-subagent-context]").textContent())!), {
      sourceKind: "app-server",
      subagent: { id: "child-layout-review", task: "Review the lifecycle layout without changing it.", model: "gpt-6.1-sol", effort: "medium" },
    });
    assert.equal(await currentPage.locator(".messages").getByText("child-layout-review").count(), 0);
    emitCodexEvents([{
      kind: "notification",
      method: "item/completed",
      threadId,
      turnId: "latest-turn",
      receivedAt: "2026-10-08T00:00:10Z",
      params: {
        item: {
          id: "latest-subagent-completed",
          type: "subAgentActivity",
          kind: "completed",
          agentThreadId: "child-layout-review",
          agentPath: "/root/layout_review",
        },
      },
    }]);
    await waitForCondition(
      async () => await currentPage.getByRole("button", { name: /subagents/i }).count() === 0,
      "Completed subagent remained in the composer badge",
    );
    emitCodexEvents([{ kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
      receivedAt: "2026-10-08T00:00:11Z", params: { item: { id: "late-subagent-wait", type: "dynamicToolCall",
        tool: "wait_agent", arguments: { agent_id: "child-layout-review" }, result: { status: {}, timed_out: true },
      } } }, { kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
      receivedAt: "2026-10-08T00:00:12Z", params: { item: { id: "after-late-wait", type: "agentMessage", text: "Late wait observed." } } }]);
    await currentPage.locator(".messages").getByText("Late wait observed.", { exact: true }).waitFor();
    assert.equal(await currentPage.getByRole("button", { name: /subagents/i }).count(), 0);
    emitCodexEvents([{ kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
      receivedAt: "2026-10-08T00:00:13Z", params: { item: { id: "subagent-restarted", type: "subAgentActivity", kind: "started",
        agentThreadId: "child-layout-review", agentPath: "/root/layout_review",
      } } }]);
    await currentPage.getByRole("button", { name: "Show subagents" }).waitFor();
    assert((await currentPage.getByRole("button", { name: "Show subagents" }).textContent()).includes("Subagents: 1"));
    assert((await currentPage.locator(".messages .work-subagent-badge").count()) > 0);
    await currentPage.close();
  }, 30_000);

  test("keeps earlier subagents in the roster when their turn is outside the virtual window", async () => {
    historicalSubagentOnly = true;
    historicalTurnCount = 250;
    let currentPage: Page | undefined;
    try {
      currentPage = await openHarness();
      assert.equal(await currentPage.locator(".messages .work-subagent-badge").count(), 0);
      await currentPage.getByRole("button", { name: "Show subagents" }).click();
      const panel = currentPage.getByLabel("Codex subagents");
      await panel.getByText("Review the lifecycle layout without changing it.").waitFor();
      assert.equal(await panel.locator(".composer-panel-item").count(), 1);
    } finally {
      historicalSubagentOnly = false;
      historicalTurnCount = 18;
      await currentPage?.close();
    }
  }, 30_000);

  test("shows the same-source parent task in the child view without inserting a history message", async () => {
    const currentPage = await openHarness({ query: "parent-task" });
    try {
      const context = currentPage.locator(".context-update").filter({ hasText: "Task from parent" });
      await context.waitFor();
      assert.equal(await context.locator("strong").textContent(), "the entire renderer");
      assert((await context.textContent()).includes("Preserve scrolling and subscriptions."));
      await currentPage.getByRole("button", { name: "Switch session" }).click();
      await waitForCondition(async () => await context.count() === 0, "Parent context leaked to another session");
    } finally { await currentPage.close(); }
  }, 30_000);

  test("queue and subagents share the composer panel and item system", async () => {
    const currentPage = await openHarness();
    await currentPage
      .getByRole("button", { name: "Show subagents" })
      .click();
    const subagentPanel = currentPage.getByLabel("Codex subagents");
    await subagentPanel.waitFor();
    assert.equal(await subagentPanel.getAttribute("data-composer-panel"), "subagents");
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
    assert.equal(await queuePanel.getAttribute("data-composer-panel"), "queue");
    const queueItem = queuePanel.locator(".composer-panel-item");
    await queueItem.waitFor();
    await queueItem.getByText("Next", { exact: true }).waitFor();
    await queueItem
      .getByText("Run the focused queue regression next")
      .waitFor();

    assert.deepEqual(await sharedCardStyles(queueItem), subagentCardStyles);
    await currentPage.close();
  }, 30_000);

  test("clears a transient connection warning after app-server output resumes", async () => {
    const currentPage = await openHarness();
    const reconnecting = "Connection lost; reconnecting to Codex.";
    emitCodexEvents([
      {
        kind: "notification",
        method: "error",
        params: {
          threadId,
          turnId: latestTurnId,
          message: reconnecting,
          willRetry: true,
        },
        threadId,
        turnId: latestTurnId,
        receivedAt: "2026-10-07T10:00:00.000Z",
      },
    ]);

    const warningBadge = currentPage.getByRole("button", {
      name: "Show warnings",
    });
    await warningBadge.waitFor();
    await warningBadge.click();
    await currentPage.getByLabel("Codex warnings").getByText(reconnecting).waitFor();

    emitCodexEvents([
      {
        kind: "notification",
        method: "item/completed",
        params: {
          threadId,
          turnId: latestTurnId,
          item: {
            id: "answer-after-reconnect",
            type: "agentMessage",
            text: "The response continued after reconnecting.",
          },
        },
        threadId,
        turnId: latestTurnId,
        receivedAt: "2026-10-07T10:00:01.000Z",
      },
    ]);

    await currentPage
      .getByText("The response continued after reconnecting.")
      .waitFor();
    await waitForCondition(
      async () =>
        (await currentPage.getByRole("button", { name: "Show warnings" }).count()) === 0 &&
        (await currentPage.getByText(reconnecting).count()) === 0,
      "Recovered app-server warning remained visible",
    );
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
    assert((await liveBody.evaluate(
        (element) => element.scrollHeight - element.clientHeight,
      )) > 0);
    await messages.evaluate((element) => {
      element.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, deltaY: -100 }),
      );
      element.scrollTop = element.scrollHeight - element.clientHeight - 40;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    assert(!(await followHandle.getAttribute("class")).includes("active"));
    await followHandle.click();
    await currentPage.waitForTimeout(150);
    const tailDistance = () =>
      messages.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      );
    assert((await tailDistance()) <= 1);
    assert((await followHandle.getAttribute("class")).includes("active"));
    assert((await liveBody.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      )) <= 1);

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
    assert((await tailDistance()) <= 1);
    assert((await followHandle.getAttribute("class")).includes("active"));
    await currentPage.close();
  }, 30_000);

  test("keeps following ordinary live rows that arrive across consecutive frames", async () => {
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
    await completeLatestTurn(currentPage);

    const messages = currentPage.locator(".messages");
    const followHandle = currentPage.locator(".session-tail-follow");
    await followHandle.click();
    const tailDistance = () =>
      messages.evaluate(
        (element) =>
          element.scrollHeight - element.clientHeight - element.scrollTop,
      );
    await waitForCondition(
      async () => (await tailDistance()) <= 1,
      "Jump to end did not reach the completed session tail",
    ).catch(async error => {
      console.error("failed-follow-geometry", await messages.evaluate(el => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight, live: el.querySelectorAll(".work-foldout-live").length })), await followHandle.getAttribute("aria-label"));
      await currentPage.screenshot({ path: "/tmp/treetop-follow-failure.png" });
      throw error;
    });

    for (let index = 0; index < 12; index += 1) {
      emitCodexEvents([
        {
          kind: "notification",
          method: "item/completed",
          params: {
            threadId,
            turnId: "ordinary-live-turn",
            item: {
              id: `ordinary-live-answer-${index}`,
              type: "agentMessage",
              text: `Ordinary live answer ${index} arrived while following.`,
            },
          },
          threadId,
          turnId: "ordinary-live-turn",
          receivedAt: `2026-10-07T10:02:${String(index).padStart(2, "0")}.000Z`,
        },
      ]);
    }

    await messages
      .getByText("Ordinary live answer 11 arrived while following.", {
        exact: true,
      })
      .waitFor();
    await currentPage.waitForTimeout(150);
    assert((await tailDistance()) <= 1);
    await currentPage.close();
  }, 30_000);

  test("parent deliveries do not invent an outbound message direction", async () => {
    const currentPage = await openHarness();
    try {
      emitCodexEvents([{ kind: "notification", method: "turn/started", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T11:59:59Z", params: { threadId, turn: { id: latestTurnId } } },
        { kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:00Z", params: { item: { id: "parent-delivery", type: "userMessage", content: [{ type: "text", text:
          "Message Type: NEW_TASK\nTask name: /root/reviewer\nSender: /root\nPayload:\nPlease review the result." }] } } }]);
      await waitForCondition(async () => (await currentPage.locator(".messages").innerText()).includes("Please review the result."),
        "Parent delivery did not render");
      assert((await currentPage.locator(".messages").innerText()).includes("Parent root"));
      assert.equal(await currentPage.locator('.messages [title="Message to parent root"]').count(), 0);
      const entry = currentPage.locator(".work-entry").filter({ hasText: "Please review the result." }).last();
      await entry.locator(":scope > summary").click();
      const card = entry.locator(".subagent-detail-card");
      await card.waitFor();
      assert.deepEqual(await card.locator(".subagent-detail-label").allTextContents(), ["Input"]);
      assert((await card.innerText()).includes("Please review the result."));
    } finally {
      await currentPage.close();
    }
  }, 30_000);

  test("a refreshed usage item advances the baseline for subsequent live notifications", async () => {
    const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, totalTokens: inputTokens });
    const item = (input: number) => ({ id: "refresh-usage", type: "tokenUsage", tokenUsage: { last: usage(input), total: usage(input) } });
    usageHistoryItems = [item(100)];
    const currentPage = await openHarness();
    try {
      const summary = currentPage.locator(".work-foldout > summary").last();
      await waitForCondition(async () => (await summary.innerText()).includes("100 tok"), "Initial history usage did not load");
      emitCodexEvents([{ kind: "notification", method: "turn/started", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:00Z", params: { turn: { id: latestTurnId } } }]);
      usageHistoryItems = [item(200)];
      latestTurnComplete = true;
      const refreshed = currentPage.waitForResponse(response => new URL(response.url()).pathname === "/api/codex-app/thread");
      emitCodexEvents([{ kind: "notification", method: "turn/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:01Z", params: { turn: { id: latestTurnId } } }]);
      await (await refreshed).finished();
      await waitForCondition(async () => (await summary.innerText()).includes("200 tok"), "Refreshed history usage did not render");
      emitCodexEvents([{ kind: "notification", method: "thread/tokenUsage/updated", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:02Z", params: { tokenUsage: { last: usage(250), total: usage(250) } } }]);
      await waitForCondition(async () => (await summary.innerText()).includes("250 tok"), "Final usage for an observed turn did not render after completion");
      assert((await summary.innerText()).includes("250 tok"));
    } finally {
      usageHistoryItems = [];
      latestTurnComplete = false;
      await currentPage.close();
    }
  }, 30_000);

  test("completion reconciliation does not charge overlapping item and thread usage twice", async () => {
    const currentPage = await openHarness();
    try {
      const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, totalTokens: inputTokens });
      emitCodexEvents([{ kind: "notification", method: "turn/started", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:00Z", params: { turn: { id: latestTurnId } } },
        { kind: "notification", method: "item/started", threadId, turnId: latestTurnId, receivedAt: "2026-10-14T12:00:01Z",
          params: { item: { id: "usage-lifecycle", type: "tokenUsage", tokenUsage: { last: usage(100), total: usage(100) } } } },
        { kind: "notification", method: "thread/tokenUsage/updated", threadId, turnId: latestTurnId, receivedAt: "2026-10-14T12:00:02Z",
          params: { tokenUsage: { last: usage(150), total: usage(150) } } },
        { kind: "notification", method: "item/completed", threadId, turnId: latestTurnId, receivedAt: "2026-10-14T12:00:03Z",
          params: { item: { id: "usage-lifecycle", type: "tokenUsage", tokenUsage: { last: usage(150), total: usage(150) } } } }]);
      const summary = currentPage.locator(".work-foldout > summary").last();
      await waitForCondition(async () => (await summary.innerText()).includes("150 tok"), "Live usage did not reach 150 tokens");
      usageHistoryItems = [{ id: "usage-lifecycle", type: "tokenUsage", tokenUsage: { last: usage(150), total: usage(150) } }];
      latestTurnComplete = true;
      const reconciled = currentPage.waitForResponse(response => new URL(response.url()).pathname === "/api/codex-app/thread");
      emitCodexEvents([{ kind: "notification", method: "turn/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:04Z", params: { turn: { id: latestTurnId } } }]);
      await (await reconciled).finished();
      await currentPage.waitForTimeout(100);
      assert((await summary.innerText()).includes("150 tok"));
    } finally {
      usageHistoryItems = [];
      latestTurnComplete = false;
      await currentPage.close();
    }
  }, 30_000);

  test("an idle visible session loads child accounting without starting a turn", async () => {
    usageHistoryItems = [{ id: "parent-idle-usage", type: "tokenUsage", tokenUsage: { last: { inputTokens: 100, outputTokens: 0, totalTokens: 100 } } }];
    childUsageHistoryItems = [{ id: "child-idle-usage", type: "tokenUsage", tokenUsage: { last: { inputTokens: 600, outputTokens: 0, totalTokens: 600 } } }];
    const currentPage = await openHarness();
    try {
      await waitForCondition(async () => (await currentPage.locator(".work-foldout > summary").last().innerText()).includes("700 tok"), "Idle session did not load child usage");
    } finally {
      usageHistoryItems = [];
      childUsageHistoryItems = [];
      await currentPage.close();
    }
  }, 30_000);

  test("round usage includes child work with a parent/child breakdown and full-width activity chips", async () => {
    sessionModel = "gpt-5.6-terra";
    childUsageHistoryItems = [{ id: "child-usage", type: "tokenUsage", tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100, totalTokens: 1100 } } }];
    const currentPage = await openHarness();
    try {
      emitCodexEvents([{ kind: "notification", method: "turn/started", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:00Z", params: { threadId, turn: { id: latestTurnId } } },
        { kind: "notification", method: "thread/tokenUsage/updated", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:01Z", params: { threadId, turnId: latestTurnId, tokenUsage: {
          last: { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 20, outputTokens: 100, reasoningOutputTokens: 30, totalTokens: 1100 },
          total: { inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 20, outputTokens: 100, reasoningOutputTokens: 30, totalTokens: 1100 },
        } } }]);
      const round = currentPage.locator(".work-foldout").last();
      await waitForCondition(async () => (await round.locator(":scope > summary").innerText()).includes("900 tok"),
        "Round did not include child usage");
      assert(!(await round.locator(":scope > summary").innerText()).includes("this agent"));
      const token = round.locator(":scope > summary .work-tool-meta").filter({ hasText: "900 tok" });
      assert((await token.getAttribute("title")).includes("300 parent + 600 children"));
      assert((await token.getAttribute("title")).includes("20 cache write (included in fresh input)"));
      const price = round.locator(":scope > summary .work-tool-meta[title*='estimated token cost']");
      assert((await price.getAttribute("title")).includes("parent +"));
      const originalCost = await price.innerText();
      if (!await round.evaluate(element => (element as HTMLDetailsElement).open)) {
        await round.locator(":scope > summary").click();
      }
      assert((await round.locator(".work-overview-meta").first().innerText()).includes("fresh input 700"));
      const overviewText = await round.locator(".work-overview-meta").first().innerText();
      const cachedTotal = await currentPage.evaluate(() => (1_300).toLocaleString());
      assert(overviewText.includes(`cached ${cachedTotal}`), overviewText);
      assert((await round.locator(".work-overview-meta").first().innerText()).includes("output 200"));
      assert((await round.locator(".work-overview-meta").first().innerText()).includes("cache write 20 (included in fresh input)"));
      assert((await round.locator(".work-overview-meta").first().innerText()).includes("reasoning 30 (included in output)"));
      assert((await round.locator(".work-overview-meta").first().innerText()).includes("300 parent + 600 children"));
      const boxes = await round.locator(":scope > summary").evaluate(element => {
        const summary = element.getBoundingClientRect();
        const chips = element.querySelector(".work-summary-pills")!.getBoundingClientRect();
        const heading = element.querySelector(".work-summary-heading")!.getBoundingClientRect();
        return { width: summary.width, chips: chips.width, inside: chips.right <= summary.right, below: chips.top > heading.top, headingInset: heading.left - summary.left };
      });
      assert((boxes.chips) > boxes.width * 0.8);
      assert.equal(boxes.inside && boxes.below, true);
      assert((boxes.headingInset) < 30);
      await round.locator(":scope > summary").screenshot({ path: "/tmp/treetop-round-total-layout.png" });
      await currentPage.locator(".session-lifecycle-stage").evaluate(element => { (element as HTMLElement).style.width = "360px"; });
      const narrow = await round.locator(":scope > summary").evaluate(element => {
        const box = element.getBoundingClientRect();
        return { width: box.width, overflow: element.scrollWidth > element.clientWidth + 1, chips: element.querySelector(".work-summary-pills")!.getBoundingClientRect().width };
      });
      assert.equal(narrow.overflow, false);
      assert((narrow.chips) > narrow.width * 0.8);
      await currentPage.locator(".session-lifecycle-stage").evaluate(element => { (element as HTMLElement).style.width = ""; });
      // Parent subscription must not mistake child traffic for parent usage.
      emitCodexEvents([{ kind: "notification", method: "thread/tokenUsage/updated", threadId: "child-layout-review", turnId: "child-turn",
        receivedAt: "2026-10-14T12:00:02Z", params: { threadId: "child-layout-review", turnId: "child-turn", tokenUsage: {
          last: { inputTokens: 5000000, outputTokens: 5000, totalTokens: 5005000 },
        } } }]);
      await currentPage.waitForTimeout(100);
      assert((await token.innerText()).includes("900 tok"));
      assert.equal(await price.innerText(), originalCost);
      latestTurnComplete = true;
      emitCodexEvents([{ kind: "notification", method: "turn/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:03Z", params: { threadId, turn: { id: latestTurnId } } }]);
      await waitForCondition(async () => await round.locator(".work-complete-icon").count() > 0,
        "Round did not complete");
      assert((await round.locator(":scope > summary").innerText()).includes("900 tok"));
    } finally {
      sessionModel = "gpt-6.1";
      childUsageHistoryItems = [];
      latestTurnComplete = false;
      await currentPage.close();
    }
  }, 30_000);

  test("renders shared writing, review, and realtime directives in live messages", async () => {
    const currentPage = await openHarness();
    try {
      // WebKit permits clipboard writes from the real button gesture, but its
      // automation protocol only exposes the read permission.
      await currentPage.context().grantPermissions(browser.browserType().name() === "webkit"
        ? ["clipboard-read"] : ["clipboard-read", "clipboard-write"]);
      emitCodexEvents([{ kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T12:00:01Z", params: { item: { id: "directive-response", type: "agentMessage", text: [
          "::codex-realtime-inline{}",
          "The draft is ready.",
          "",
          ':::writing{variant="email" id="12345" subject="Review" recipient="team@example.com"}',
          "Hello **team**.",
          ":::" ,
          "",
          '::code-comment{title="[P2] Boundary" body="Use **the final row**." file="/tmp/app.ts" start=10 end=11 priority=2}',
        ].join("\n") } } }]);
      const draft = currentPage.locator(".md-writing-block");
      await draft.waitFor();
      await waitForCondition(async () => await draft.locator("strong").innerText() === "team", "Writing block did not finish rendering its inline markup");
      assert.equal(await draft.locator("strong").innerText(), "team");
      assert((await draft.innerText()).includes("team@example.com"));
      await draft.getByRole("button", { name: "Copy email" }).click();
      await waitForCondition(async () => await currentPage.evaluate(() => navigator.clipboard.readText()) === "Hello **team**.",
        "Writing copy did not preserve the artifact body");
      const review = currentPage.locator(".md-review-comment");
      assert.equal(await review.locator(".work-preview-path").innerText(), "app.ts:10–11");
      assert.equal(await review.locator(".work-preview-path").getAttribute("data-supergit-file-href"), "/tmp/app.ts");
      assert.equal(await review.locator("strong").innerText(), "the final row");
      const text = await currentPage.locator(".messages").innerText();
      assert((text).includes("The draft is ready."));
      assert(!(text).includes("::codex-realtime-inline"));
      assert(!(text).includes(":::writing"));
      assert(!(text).includes("::code-comment"));
    } finally { await currentPage.close(); }
  }, 30_000);

  test("renders live file citations with shared file-chip styling", async () => {
    const currentPage = await openHarness();
    try {
      emitCodexEvents([
        { kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
          receivedAt: "2026-10-14T11:00:00Z", params: { item: { id: "citation-read", type: "commandExecution",
            command: "cat /tmp/citation-source.pdf", status: "completed", aggregatedOutput: "Source content" } } },
        { kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
          receivedAt: "2026-10-14T11:00:01Z", params: { item: { id: "citation-response", type: "agentMessage",
            text: 'Verified :codex-file-citation{path="/tmp/citation-source.pdf" purpose="source"}.\n\n:codex-file-citation{path="/tmp/citation-output.pdf" purpose="output"}' } } },
      ]);
      const citation = currentPage.locator('a.work-preview-path[data-supergit-file-href="/tmp/citation-source.pdf"]');
      await citation.waitFor();
      assert.equal(await citation.innerText(), "citation-source.pdf");
      assert.equal(await citation.getAttribute("title"), "source · /tmp/citation-source.pdf");
      assert.equal(await currentPage.locator('a.work-preview-path[data-supergit-file-href="/tmp/citation-output.pdf"]').count(), 1);
      assert(!(await currentPage.locator(".messages").innerText()).includes(":codex-file-citation"));
      assert.equal(await citation.evaluate(el => getComputedStyle(el).borderRadius), "999px");
      assert.equal(await citation.evaluate(el => getComputedStyle(el).cursor), "pointer");
    } finally { await currentPage.close(); }
  }, 30_000);

  test("retains offscreen deltas received during a history refresh", async () => {
    const currentPage = await openHarness();
    try {
      historyRequestDelayMs = 1500;
      const readsBefore = historyRequestCount;
      emitCodexEvents([{ kind: "notification", method: "turn/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-14T10:00:01Z", params: { threadId, turn: { id: latestTurnId, status: "completed" } } }]);
      await waitForCondition(async () => historyRequestCount > readsBefore, "History refresh did not start");
      const stage = currentPage.locator(".session-lifecycle-stage");
      await stage.evaluate(element => { (element as HTMLElement).style.transform = "translateX(2000px)"; });
      await waitForCondition(async () => await currentPage.locator(".messages").count() === 0, "Lane did not leave viewport");
      emitCodexEvents([
        { kind: "notification", method: "turn/started", threadId, turnId: "buffered-turn", receivedAt: "2026-10-14T10:00:02Z",
          params: { threadId, turn: { id: "buffered-turn" } } },
        { kind: "notification", method: "item/started", threadId, turnId: "buffered-turn", receivedAt: "2026-10-14T10:00:03Z",
          params: { item: { id: "buffered-answer", type: "agentMessage", text: "BUFFERED_PREFIX " } } },
        { kind: "notification", method: "item/agentMessage/delta", threadId, turnId: "buffered-turn", receivedAt: "2026-10-14T10:00:04Z",
          params: { itemId: "buffered-answer", delta: "DELTA_SURVIVES_HISTORY" } },
      ]);
      await currentPage.waitForTimeout(1800);
      await stage.evaluate(element => { (element as HTMLElement).style.transform = ""; });
      await currentPage.locator(".messages").waitFor();
      await waitForCondition(async () => (await currentPage.locator(".messages").innerText()).includes("DELTA_SURVIVES_HISTORY"),
        "History refresh discarded the buffered live delta");
    } finally {
      historyRequestDelayMs = 0;
      await currentPage.close();
    }
  }, 30_000);

  test("horizontal trackpad lane navigation does not pause vertical transcript follow", async () => {
    const currentPage = await openHarness({ query: "lanes=horizontal" });
    try {
      const handle = currentPage.locator(".session-tail-follow");
      await handle.click();
      await waitForCondition(
        async () =>
          (await handle.getAttribute("aria-label")) ===
          "Following latest transcript messages",
        "Session did not start following",
      );
      const viewport = await currentPage.locator(".messages").boundingBox();
      if (!viewport) throw new Error("Missing transcript viewport");
      // A physical trackpad's horizontal gesture includes a small vertical
      // component. Start over the outer transcript, outside the work body.
      await currentPage.mouse.move(viewport.x + 4, viewport.y + 4);
      await currentPage.mouse.wheel(1600, -1);
      await waitForCondition(
        async () => (await currentPage.locator(".messages").count()) === 0,
        "Trackpad gesture did not navigate to the neighboring lane",
      );
      emitCodexEvents([
        {
          kind: "notification",
          method: "item/started",
          threadId,
          turnId: latestTurnId,
          receivedAt: new Date().toISOString(),
          params: {
            item: {
              id: "trackpad-away-answer",
              type: "agentMessage",
            },
          },
        },
        {
          kind: "notification",
          method: "item/agentMessage/delta",
          threadId,
          turnId: latestTurnId,
          receivedAt: new Date().toISOString(),
          params: {
            itemId: "trackpad-away-answer",
            delta: "TRACKPAD_AWAY_OUTPUT\n\n" + "New output.\n\n".repeat(80),
          },
        },
      ]);
      await currentPage.waitForTimeout(100);
      await currentPage
        .getByRole("button", { name: "Session lane", exact: true })
        .click();
      await currentPage.locator(".messages").waitFor();
      await waitForCondition(
        async () =>
          (await currentPage.locator(".messages").innerText()).includes(
            "TRACKPAD_AWAY_OUTPUT",
          ),
        "Offscreen output did not render",
      );
      await waitForCondition(
        async () =>
          await currentPage
            .locator(".messages")
            .evaluate(
              (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 3,
            ),
        "Horizontal navigation lost vertical tail follow",
      );
      assert.equal(await handle.getAttribute("aria-label"), "Following latest transcript messages");
      const endTop = await currentPage
        .locator(".messages")
        .evaluate((el) => el.scrollTop);
      await currentPage.mouse.move(viewport.x + 4, viewport.y + 4);
      await currentPage.mouse.wheel(0, -180);
      await waitForCondition(
        async () =>
          (await currentPage
            .locator(".messages")
            .evaluate((el) => el.scrollTop)) <
          endTop - 20,
        "Vertical reader gesture did not scroll history",
      );
      await waitForCondition(
        async () =>
          (await handle.getAttribute("aria-label")) ===
          "Jump to latest transcript message",
        "Vertical reader gesture did not pause follow",
      );
      await currentPage.waitForTimeout(150);
      const readerTop = await currentPage
        .locator(".messages")
        .evaluate((el) => el.scrollTop);
      emitCodexEvents([
        {
          kind: "notification",
          method: "item/agentMessage/delta",
          threadId,
          turnId: latestTurnId,
          receivedAt: new Date().toISOString(),
          params: {
            itemId: "trackpad-away-answer",
            delta: "\n\nOUTPUT_AFTER_VERTICAL_PAUSE",
          },
        },
      ]);
      await waitForCondition(
        async () =>
          (await currentPage.locator(".messages").innerText()).includes(
            "OUTPUT_AFTER_VERTICAL_PAUSE",
          ),
        "Output after reader pause did not render",
      );
      await currentPage.waitForTimeout(100);
      assert((Math.abs(
          (await currentPage
            .locator(".messages")
            .evaluate((el) => el.scrollTop)) - readerTop,
        )) < 3);
      assert.equal(await handle.getAttribute("aria-label"), "Jump to latest transcript message");
    } finally {
      await currentPage.close();
    }
  }, 30_000);

  for (const direction of ["horizontal", "vertical", "horizontal&smooth", "vertical&smooth"]) {
    test(`${direction} lane navigation retains live work follow through offscreen tool output and the next turn`, async () => {
      historicalWorkGroupCount = 25;
      const currentPage = await openHarness({ query: `lanes=${direction}` });
      const handle = currentPage.locator(".session-tail-follow");
      const body = currentPage.locator(
        ".work-foldout-live > .work-foldout-body",
      );
      const command = (id: string, turnId = latestTurnId) => ({
        kind: "notification",
        method: "item/completed",
        threadId,
        turnId,
        receivedAt: new Date().toISOString(),
        params: {
          threadId,
          turnId,
          item: {
            id,
            type: "commandExecution",
            command: `/bin/zsh -lc 'echo ${id}'`,
            status: "completed",
            aggregatedOutput: `${id}\n`,
          },
        },
      });
      // Consecutive commands coalesce into one display group. Interleave real
      // reasoning and checkpoints so offscreen output grows the bounded body.
      const workStep = (id: string, turnId = latestTurnId) => [
        {
          kind: "notification",
          method: "item/completed",
          threadId,
          turnId,
          receivedAt: new Date().toISOString(),
          params: {
            item: {
              id: `reason-${id}`,
              type: "reasoning",
              summary: [{ type: "summary_text", text: `Planning ${id}` }],
            },
          },
        },
        command(id, turnId),
        {
          kind: "notification",
          method: "item/completed",
          threadId,
          turnId,
          receivedAt: new Date().toISOString(),
          params: {
            item: {
              id: `checkpoint-${id}`,
              type: "agentMessage",
              text: `Checkpoint ${id}`,
            },
          },
        },
      ];
      let phase = "initial";
      const following = async () => {
        try {
          await waitForCondition(
            async () =>
              (await handle.getAttribute("aria-label")) ===
              "Following latest transcript messages",
            `Lane lost follow intent: ${phase}`,
          );
          await waitForCondition(
            async () =>
              await body.evaluate(
                (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 3,
              ),
            `Nested body stopped following: ${phase}`,
          );
        } catch (error) {
          console.error(
            "lane-follow-geometry",
            phase,
            await currentPage.locator(".messages").evaluate((el) => ({
              top: el.scrollTop,
              height: el.scrollHeight,
              client: el.clientHeight,
              bodies: [
                ...el.querySelectorAll(
                  ".work-foldout-live > .work-foldout-body",
                ),
              ].map((body) => ({
                key: (body as HTMLElement).dataset.workKey,
                top: body.scrollTop,
                height: body.scrollHeight,
                client: body.clientHeight,
              })),
            })),
          );
          throw error;
        }
      };
      const rendered = (text: string) =>
        waitForCondition(
          async () =>
            (await currentPage.locator(".messages").innerText()).includes(text),
          `Live output was not rendered: ${text}`,
        );
      try {
        emitCodexEvents([
          {
            kind: "notification",
            method: "turn/started",
            threadId,
            turnId: latestTurnId,
            receivedAt: new Date().toISOString(),
            params: { threadId, turn: { id: latestTurnId } },
          },
        ]);
        await body.waitFor();
        emitCodexEvents([command("initial-live-work")]);
        await following();
        for (let visit = 0; visit < 4; visit++) {
          phase = `visit ${visit}`;
          await currentPage
            .getByRole("button", { name: "Neighbor lane", exact: true })
            .click();
          await waitForCondition(
            async () => (await currentPage.locator(".messages").count()) === 0,
            "Scrolled lane did not suspend",
          );
          emitCodexEvents(
            Array.from({ length: 10 }, (_, index) =>
              workStep(`away-${visit}-${index}`),
            ).flat(),
          );
          await currentPage.waitForTimeout(100);
          await currentPage
            .getByRole("button", { name: "Session lane", exact: true })
            .click();
          await body.waitFor();
          await rendered(`Checkpoint away-${visit}-9`);
          await currentPage.waitForTimeout(100);
          await following();
          emitCodexEvents(workStep(`returned-${visit}`));
          await rendered(`Checkpoint returned-${visit}`);
          await currentPage.waitForTimeout(100);
          await following();
        }
        await currentPage
          .getByRole("button", { name: "Neighbor lane", exact: true })
          .click();
        await waitForCondition(
          async () => (await currentPage.locator(".messages").count()) === 0,
          "Lane did not suspend before turn transition",
        );
        const nextTurn = "lane-next-turn";
        phase = "next turn";
        emitCodexEvents([
          {
            kind: "notification",
            method: "turn/completed",
            threadId,
            turnId: latestTurnId,
            receivedAt: new Date().toISOString(),
            params: {
              threadId,
              turn: { id: latestTurnId, status: "completed" },
            },
          },
          {
            kind: "notification",
            method: "turn/started",
            threadId,
            turnId: nextTurn,
            receivedAt: new Date().toISOString(),
            params: { threadId, turn: { id: nextTurn } },
          },
          {
            kind: "notification",
            method: "item/completed",
            threadId,
            turnId: nextTurn,
            receivedAt: new Date().toISOString(),
            params: {
              item: {
                id: "lane-next-user",
                type: "userMessage",
                content: [{ type: "text", text: "Next request while away" }],
              },
            },
          },
          ...Array.from({ length: 12 }, (_, index) =>
            workStep(`next-turn-${index}`, nextTurn),
          ).flat(),
        ]);
        await currentPage.waitForTimeout(150);
        await currentPage
          .getByRole("button", { name: "Session lane", exact: true })
          .click();
        await body.waitFor();
        await rendered("Checkpoint next-turn-11");
        await following();
        emitCodexEvents([command("next-turn-returned", nextTurn)]);
        await rendered("next-turn-returned");
        await currentPage.waitForTimeout(100);
        await following();
        assert((await currentPage.locator(".messages").innerText()).includes("Next request while away"));
      } finally {
        historicalWorkGroupCount = 0;
        await currentPage.close();
      }
    }, 30_000);
  }

  test("lane viewport growth does not turn a native scroll clamp into a remembered reader pause", async () => {
    const currentPage = await openHarness();
    try {
      const stage = currentPage.locator(".session-lifecycle-stage");
      const handle = currentPage.locator(".session-tail-follow");
      await currentPage.locator(".session").evaluate(el => { (el as HTMLElement).style.maxHeight = "none"; });
      await handle.click();
      await waitForCondition(async () => await handle.getAttribute("aria-label") === "Following latest transcript messages", "Session did not attach to latest");
      const before = await currentPage.locator(".messages").evaluate(el => ({ height: el.scrollHeight, client: el.clientHeight, top: el.scrollTop }));
      await stage.evaluate(el => { (el as HTMLElement).style.height = "640px"; });
      await currentPage.waitForTimeout(150);
      const after = await currentPage.locator(".messages").evaluate(el => ({ height: el.scrollHeight, client: el.clientHeight, top: el.scrollTop }));
      assert.equal(after.height, before.height);
      assert((after.client) > before.client);
      assert((after.top) < before.top);
      assert.equal(await handle.getAttribute("aria-label"), "Following latest transcript messages");
      await stage.evaluate(el => { (el as HTMLElement).style.transform = "translateX(2000px)"; });
      await waitForCondition(async () => await currentPage.locator(".messages").count() === 0, "Lane did not suspend");
      emitCodexEvents([{ kind: "notification", method: "item/completed", threadId, turnId: latestTurnId, receivedAt: "2026-10-16T11:00:00Z",
        params: { item: { id: "resized-lane-reply", type: "agentMessage", text: "NEW_WHILE_AWAY\n\n" + "More output.\n\n".repeat(80) } } }]);
      await stage.evaluate(el => { (el as HTMLElement).style.transform = ""; });
      await waitForCondition(async () => await currentPage.locator(".messages").evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 3), "Resized returning lane lost follow");
      assert.equal(await handle.getAttribute("aria-label"), "Following latest transcript messages");
    } finally { await currentPage.close(); }
  }, 30_000);

  test("keeps following a live-work lane after it leaves and re-enters the viewport", async () => {
    const currentPage = await openHarness();
    const stage = currentPage.locator(".session-lifecycle-stage");
    const followHandle = currentPage.locator(".session-tail-follow");
    try {
    emitCodexEvents([
      {
        kind: "notification",
        method: "turn/started",
        params: { threadId, turn: { id: latestTurnId } },
        threadId,
        turnId: latestTurnId,
        receivedAt: "2026-10-07T10:01:00.000Z",
      },
      ...Array.from({ length: 16 }, (_, index) => ({
        kind: "notification" as const,
        method: "item/completed",
        params: {
          threadId,
          turnId: latestTurnId,
          item: {
            id: `offscreen-follow-command-${index}`,
            type: "commandExecution",
            command: `/bin/zsh -lc 'echo ${index}'`,
            status: "completed",
            aggregatedOutput: `${index}\n`,
          },
        },
        threadId,
        turnId: latestTurnId,
        receivedAt: "2026-10-07T10:01:01.000Z",
      })),
    ]);
    await currentPage.locator(".work-foldout-live").waitFor();
    await waitForCondition(
      async () => (await followHandle.getAttribute("class"))?.includes("active") === true,
      "Live lane did not begin in tail-follow mode",
    );

    await stage.evaluate((element) => {
      (element as HTMLElement).style.transform = "translateX(2000px)";
    });
    await waitForCondition(
      async () => (await currentPage.locator(".messages").count()) === 0,
      "Offscreen lane did not release its transcript body",
    );
    const awayText = "ANSWER_WHILE_AWAY\n\n" + "New output while another lane is visible.\n\n".repeat(100);
    usageHistoryItems = [{ id: "away-answer", type: "agentMessage", text: awayText }];
    emitCodexEvents([
      { kind: "notification", method: "item/completed", threadId, turnId: latestTurnId,
        receivedAt: "2026-10-07T10:02:00Z", params: { item: { id: "away-answer", type: "agentMessage", text: awayText } } },
    ]);
    await currentPage.waitForTimeout(150);
    await stage.evaluate((element) => { (element as HTMLElement).style.transform = ""; });
    await currentPage.locator(".messages").waitFor();
    await waitForCondition(
      async () => (await followHandle.getAttribute("class"))?.includes("active") === true,
      "Returning lane forgot follow after output while away",
    );
    assert((await currentPage.locator(".messages").innerText()).includes("ANSWER_WHILE_AWAY"));
    const following = await currentPage.locator(".messages").evaluate(el => {
      const body = el.querySelector(".work-foldout-live > .work-foldout-body");
      return body ? body.scrollHeight - body.scrollTop - body.clientHeight < 3 : el.scrollHeight - el.scrollTop - el.clientHeight < 3;
    });
    assert.equal(following, true);
    } finally {
      usageHistoryItems = [];
      latestTurnComplete = false;
      await currentPage.close();
    }
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
      assert.deepEqual(questionStyles, goalStyles);
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
    "lets an idle reader scroll away from the tail without a wheel prelude",
    async () => {
      const currentPage = await openHarness();
      const messages = currentPage.locator(".messages");
      await completeLatestTurn(currentPage);
      await messages.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const targetTop = await messages.evaluate((element) => {
        const next = Math.max(0, element.scrollTop - 700);
        element.scrollTop = next;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
        return next;
      });
      await currentPage.waitForTimeout(80);

      assert.equal(await messages.evaluate((element) => element.scrollTop), targetTop);
      assert(!(await currentPage
          .locator(".session-tail-follow")
          .getAttribute("class")).includes("active"));
      await currentPage.close();
    },
    30_000,
  );

  test(
    "keeps paged app-server history visible and reachable after the cursor ends",
    async () => {
      olderHistoryAvailable = true;
      historicalWorkGroupCount = 40;
      let currentPage: Page | undefined;
      try {
        currentPage = await openHarness();
        const messages = currentPage.locator(".messages");
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await messages.evaluate((element) => {
            element.dispatchEvent(
              new WheelEvent("wheel", { bubbles: true, deltaY: -700 }),
            );
            element.scrollTop = 0;
            element.dispatchEvent(new Event("scroll", { bubbles: true }));
          });
          await currentPage.waitForTimeout(150);
        }

        await currentPage
          .getByText("Older paged request that must remain in scrollback")
          .waitFor();
        assert.equal(await messages.getByText("Loading earlier messages").count(), 0);
        await messages.evaluate((element) => {
          element.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: -700 }),
          );
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await currentPage
          .getByText(
            "Oldest loaded request must remain reachable without a cursor",
          )
          .waitFor();
      } finally {
        olderHistoryAvailable = false;
        historicalWorkGroupCount = 0;
        await currentPage?.close();
      }
    },
    30_000,
  );

  test(
    "keeps a paused virtual window anchored while live app-server rows append",
    async () => {
      historicalTurnCount = 180;
      let currentPage: Page | undefined;
      try {
        currentPage = await openHarness();
        const messages = currentPage.locator(".messages");
        const anchor = messages.getByText("Historical request 160");
        await anchor.waitFor();
        await anchor.evaluate((element) => {
          element.scrollIntoView({ block: "center" });
        });
        await messages.evaluate((element) => {
          element.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: -40 }),
          );
          element.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        const offsetBefore = await anchor.evaluate((element) => {
          const scroller = element.closest(".messages") as HTMLElement;
          return (
            element.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top
          );
        });

        emitCodexEvents(
          Array.from({ length: 80 }, (_, index) => ({
            kind: "notification",
            method: "item/completed",
            params: {
              threadId,
              turnId: latestTurnId,
              item: {
                id: `paused-window-live-answer-${index}`,
                type: "agentMessage",
                text: `Live answer appended while reading ${index}`,
              },
            },
            threadId,
            turnId: latestTurnId,
            receivedAt: new Date(1_780_000_300_000 + index * 1_000).toISOString(),
          })),
        );
        await currentPage.waitForTimeout(120);

        await anchor.waitFor();
        const offsetAfter = await anchor.evaluate((element) => {
          const scroller = element.closest(".messages") as HTMLElement;
          return (
            element.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top
          );
        });
        assert((Math.abs(offsetAfter - offsetBefore)) < 20);
      } finally {
        historicalTurnCount = 18;
        await currentPage?.close();
      }
    },
    30_000,
  );

  test("previews captured section writes from the changed-file chip without fetching disk diffs", async () => {
    usageHistoryItems = [{
      id: "section-write", type: "commandExecution", cwd: "/tmp/treetop-session-lifecycle", status: "completed", aggregatedOutput: "",
      command: "python3 - <<'PY'\nfrom pathlib import Path\np=Path('AGENTS.md');s=p.read_text();start=s.index('Old section');end=s.index('Next section',start);s=s[:start]+'''Preview/export parity: complete pipeline only.\n'''+s[end:];p.write_text(s)\nPY",
    }];
    const currentPage = await openHarness();
    let diskDiffs = 0;
    await currentPage.route("**/api/file-diff**", async route => {
      diskDiffs += 1;
      await route.fulfill({ json: { diff: "WRONG_CURRENT_DISK_CONTENT" } });
    });
    try {
      await currentPage.getByText("Changed 1 file", { exact: true }).last().hover();
      const file = currentPage.locator(".work-changed-tooltip .sparse-artifact-name").filter({ hasText: "AGENTS.md" }).last();
      await file.hover();
      await currentPage.getByText("Captured replacement content (partial file)", { exact: true }).waitFor();
      assert((await currentPage.locator(".sparse-artifact-diff").last().innerText()).includes("Preview/export parity: complete pipeline only."));
      assert.equal(diskDiffs, 0);
    } finally {
      usageHistoryItems = [];
      await currentPage.close();
    }
  }, 30_000);

  test("shows reconstructed plus/minus section diffs across action groups", async () => {
    usageHistoryItems = [
      { id: "section-before", type: "commandExecution", cwd: "/tmp/treetop-session-lifecycle", status: "completed", command: "sed -n '10,14p' AGENTS.md", aggregatedOutput: "Old section\nold instructions\n\nNext section\n" },
      { id: "section-commentary", type: "agentMessage", text: "I will replace the old section with the concise rule." },
      { id: "section-after", type: "commandExecution", cwd: "/tmp/treetop-session-lifecycle", status: "completed", aggregatedOutput: "", command: "python3 - <<'PY'\nfrom pathlib import Path\np=Path('AGENTS.md');s=p.read_text();start=s.index('Old section');end=s.index('Next section',start);s=s[:start]+'''Preview/export parity: complete pipeline only.\n'''+s[end:];p.write_text(s)\nPY" },
    ];
    const currentPage = await openHarness();
    let diskDiffs = 0;
    await currentPage.route("**/api/file-diff**", async route => { diskDiffs += 1; await route.fulfill({ json: { diff: "WRONG_CURRENT_DISK_CONTENT" } }); });
    try {
      await currentPage.getByText("Changed 1 file", { exact: true }).last().hover();
      await currentPage.locator(".work-changed-tooltip .sparse-artifact-name").filter({ hasText: "AGENTS.md" }).last().hover();
      const diff = currentPage.locator(".sparse-artifact-diff").last();
      await diff.locator(".line.remove").filter({ hasText: "-old instructions" }).waitFor();
      assert((await diff.locator(".line.add").innerText()).includes("+Preview/export parity: complete pipeline only."));
      assert.equal(await diff.locator(".line.hunk").innerText(), "@@ -10,3 +10,1 @@");
      assert.equal(diskDiffs, 0);
      await currentPage.mouse.move(890, 10);
      await diff.waitFor({ state: "hidden" });
      const round = currentPage.locator(".work-foldout").last();
      if (await round.getAttribute("open") === null) await round.locator(":scope > summary").click();
      const steps = round.locator(".work-detail-toggle");
      if (!(await steps.innerText()).includes("Showing all")) await steps.click();
      await waitForCondition(async () => (await steps.innerText()).includes("Showing all"), "Work steps did not expand");
      const group = currentPage.locator(".work-action-group").last();
      if (await group.getAttribute("open") === null) await group.locator(":scope > summary").press("Enter");
      await currentPage.locator(".work-file-edit-preview .work-preview-path").last().hover({ timeout: 5000 });
      await currentPage.locator(".visual-preview-diff-tooltip .line.remove").filter({ hasText: "-old instructions" }).waitFor();
      assert((await currentPage.locator(".visual-preview-diff-tooltip .line.add").innerText()).includes("+Preview/export parity: complete pipeline only."));
      assert.equal(diskDiffs, 0);
    } finally {
      usageHistoryItems = [];
      await currentPage.close();
    }
  }, 30_000);

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
      assert.equal(await diagram.locator("svg").count(), 1);
      assert.equal(await currentPage.locator("code.language-mermaid").count(), 0);
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
