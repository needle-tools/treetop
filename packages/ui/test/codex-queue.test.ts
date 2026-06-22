import { describe, expect, it } from "bun:test";
import {
  canSaveCodexQueueEdit,
  enqueueCodexQueue,
  parseCodexQueue,
  removeCodexQueuedAttachment,
  removeCodexQueuedMessage,
  mergeCodexQueuedMessageUp,
  reorderCodexQueuedMessage,
  updateCodexQueuedMessage,
} from "../src/codex-queue";

interface TestAttachment {
  path: string;
}

describe("parseCodexQueue", () => {
  it("ignores empty, malformed, and non-array storage", () => {
    expect(parseCodexQueue(null)).toEqual([]);
    expect(parseCodexQueue("not json")).toEqual([]);
    expect(parseCodexQueue('{"id":"one"}')).toEqual([]);
  });

  it("keeps valid queued messages and fills legacy timestamps", () => {
    const parsed = parseCodexQueue<TestAttachment>(
      JSON.stringify([
        {
          id: "one",
          text: "first",
          attachments: [{ path: "/tmp/one.png" }],
          createdAt: "2026-06-19T10:00:00.000Z",
        },
        {
          id: "two",
          text: "legacy",
        },
        {
          id: 3,
          text: "invalid",
        },
      ]),
      () => "2026-06-19T11:00:00.000Z",
    );

    expect(parsed).toEqual([
      {
        id: "one",
        text: "first",
        attachments: [{ path: "/tmp/one.png" }],
        createdAt: "2026-06-19T10:00:00.000Z",
      },
      {
        id: "two",
        text: "legacy",
        attachments: [],
        createdAt: "2026-06-19T11:00:00.000Z",
      },
    ]);
  });
});

describe("Codex queue updates", () => {
  it("enqueues payloads without sharing the attachment array", () => {
    const attachments = [{ path: "/tmp/one.png" }];
    const queue = enqueueCodexQueue<TestAttachment>(
      [],
      { text: "queued", attachments },
      "one",
      "2026-06-19T10:00:00.000Z",
    );

    attachments.push({ path: "/tmp/two.png" });

    expect(queue).toEqual([
      {
        id: "one",
        text: "queued",
        attachments: [{ path: "/tmp/one.png" }],
        createdAt: "2026-06-19T10:00:00.000Z",
      },
    ]);
  });

  it("updates queued text and attachments together", () => {
    const queue = [
      {
        id: "one",
        text: "old",
        attachments: [{ path: "/tmp/old.png" }],
        createdAt: "2026-06-19T10:00:00.000Z",
      },
    ];

    expect(
      updateCodexQueuedMessage<TestAttachment>(queue, "one", {
        text: "  new  ",
        attachments: [{ path: "/tmp/new.png" }],
      }),
    ).toEqual([
      {
        id: "one",
        text: "new",
        attachments: [{ path: "/tmp/new.png" }],
        createdAt: "2026-06-19T10:00:00.000Z",
      },
    ]);
  });

  it("allows attachments-only queued edits", () => {
    expect(canSaveCodexQueueEdit("", [{ path: "/tmp/one.png" }])).toBe(true);
    expect(canSaveCodexQueueEdit("   ", [])).toBe(false);
  });

  it("removes queued messages and individual queued attachments", () => {
    const queue = [
      {
        id: "one",
        text: "first",
        attachments: [],
        createdAt: "2026-06-19T10:00:00.000Z",
      },
      {
        id: "two",
        text: "second",
        attachments: [],
        createdAt: "2026-06-19T10:01:00.000Z",
      },
    ];

    expect(removeCodexQueuedMessage(queue, "one")).toEqual([queue[1]]);
    expect(
      removeCodexQueuedAttachment(
        [{ path: "/tmp/one.png" }, { path: "/tmp/two.png" }],
        0,
      ),
    ).toEqual([{ path: "/tmp/two.png" }]);
  });

  it("reorders a queued message by id", () => {
    const queue = [
      {
        id: "one",
        text: "first",
        attachments: [],
        createdAt: "2026-06-19T10:00:00.000Z",
      },
      {
        id: "two",
        text: "second",
        attachments: [],
        createdAt: "2026-06-19T10:01:00.000Z",
      },
      {
        id: "three",
        text: "third",
        attachments: [],
        createdAt: "2026-06-19T10:02:00.000Z",
      },
    ];

    expect(reorderCodexQueuedMessage(queue, "three", "one")).toEqual([
      queue[2],
      queue[0],
      queue[1],
    ]);
    expect(reorderCodexQueuedMessage(queue, "one", "three")).toEqual([
      queue[1],
      queue[0],
      queue[2],
    ]);
    expect(reorderCodexQueuedMessage(queue, "one", null)).toEqual([
      queue[1],
      queue[2],
      queue[0],
    ]);
    expect(reorderCodexQueuedMessage(queue, "two", "two")).toBe(queue);
    expect(reorderCodexQueuedMessage(queue, "missing", "one")).toBe(queue);
  });

  it("merges a queued message into the previous one", () => {
    const queue = [
      {
        id: "one",
        text: "first",
        attachments: [{ path: "/tmp/one.png" }],
        createdAt: "2026-06-19T10:00:00.000Z",
      },
      {
        id: "two",
        text: "second",
        attachments: [{ path: "/tmp/two.png" }],
        createdAt: "2026-06-19T10:01:00.000Z",
      },
      {
        id: "three",
        text: "third",
        attachments: [],
        createdAt: "2026-06-19T10:02:00.000Z",
      },
    ];

    expect(mergeCodexQueuedMessageUp(queue, "two")).toEqual([
      {
        ...queue[0],
        text: "first\n\nsecond",
        attachments: [{ path: "/tmp/one.png" }, { path: "/tmp/two.png" }],
      },
      queue[2],
    ]);
    expect(mergeCodexQueuedMessageUp(queue, "one")).toBe(queue);
    expect(mergeCodexQueuedMessageUp(queue, "missing")).toBe(queue);
  });
});
