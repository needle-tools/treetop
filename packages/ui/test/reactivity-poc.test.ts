import { test, expect, describe } from "bun:test";
import * as $ from "svelte/internal/client";
import { createCounter, trackEffect } from "./reactivity-poc.svelte.ts";
import { patchWorktreeDetails } from "../src/ndjson-client";
import { nextCachedSessionSummaryRequest } from "../src/summary-queue";
import { shouldCancelBackgroundSummary } from "../src/tui-auto-summary";
import {
  CODEX_LIVE_OUTPUT_LIMIT,
  codexEventVisualDelivery,
  codexOutputDeltaNeedsToolUse,
  shouldUseCodexAppHistorySource,
} from "../src/codex-event-stream";
import { applyVisualTranscriptDeltaPatches } from "../src/last-user-message";
import { resolveSessionMessageSource } from "../src/storage";

const { flush } = $;

describe("svelte 5 runes — DOM-free reactivity", () => {
  test("$state: reads initial value", () => {
    const c = createCounter(5);
    expect(c.count).toBe(5);
  });

  test("$state: mutation updates value", () => {
    const c = createCounter();
    c.increment();
    expect(c.count).toBe(1);
  });

  test("$derived: recomputes on state change", () => {
    const c = createCounter(3);
    expect(c.doubled).toBe(6);
    c.increment();
    expect(c.doubled).toBe(8);
  });

  test("$derived: boolean derived tracks correctly", () => {
    const c = createCounter(0);
    expect(c.isPositive).toBe(false);
    c.increment();
    expect(c.isPositive).toBe(true);
    c.decrement();
    expect(c.isPositive).toBe(false);
  });

  test("reset returns to initial value", () => {
    const c = createCounter(10);
    c.increment();
    c.increment();
    expect(c.count).toBe(12);
    c.reset();
    expect(c.count).toBe(10);
    expect(c.doubled).toBe(20);
  });

  test("$effect.root: tracks side effects without DOM", () => {
    const c = createCounter();
    const { values, cleanup } = trackEffect(() => c.count);

    flush();
    expect(values).toEqual([0]);

    c.increment();
    flush();
    expect(values).toEqual([0, 1]);

    c.increment();
    c.increment();
    flush();
    expect(values).toEqual([0, 1, 3]);

    cleanup();
  });

  test("duplicate worktree details do not wake whole-dashboard repo work", () => {
    const initial = [
      {
        id: "repo",
        worktrees: [
          { path: "/repo", fileStatus: { unstaged: 0 }, branchStatus: null },
        ],
      },
    ];
    const repos = $.state(initial);
    let wholeDashboardRuns = 0;
    const wholeDashboard = $.derived(() => {
      wholeDashboardRuns++;
      return $.get(repos).length;
    });
    const destroy = $.effect_root(() => {
      $.effect(() => void $.get(wholeDashboard));
    });

    try {
      $.flush();
      expect(wholeDashboardRuns).toBe(1);

      const duplicate = patchWorktreeDetails($.get(repos), "/repo", {
        fileStatus: { unstaged: 0 },
        branchStatus: null,
      });
      if (duplicate.changed) $.set(repos, duplicate.repos);
      $.flush();
      expect(wholeDashboardRuns).toBe(1);

      const realChange = patchWorktreeDetails($.get(repos), "/repo", {
        fileStatus: { unstaged: 1 },
        branchStatus: null,
      });
      if (realChange.changed) $.set(repos, realChange.repos);
      $.flush();
      expect(wholeDashboardRuns).toBe(2);
      expect($.get(repos)[0]!.worktrees[0]!.fileStatus.unstaged).toBe(1);
    } finally {
      destroy();
    }
  });

  test("turning background summaries off stops reactive session lookups", () => {
    const enabled = $.state(true);
    const source = $.state("source-a");
    const requested: string[] = [];
    let lastRequested: string | undefined;
    const destroy = $.effect_root(() => {
      $.effect(() => {
        const next = nextCachedSessionSummaryRequest({
          enabled: $.get(enabled),
          target: $.get(source),
          sessionLoaded: true,
          nearViewport: true,
          lastRequested,
        });
        if (next !== null) {
          lastRequested = next;
          requested.push(next);
        }
      });
    });

    try {
      $.flush();
      expect(requested).toEqual(["source-a"]);

      $.set(enabled, false);
      $.set(source, "source-b");
      $.flush();
      expect(requested).toEqual(["source-a"]);
    } finally {
      destroy();
    }
  });

  test("turning background summaries off aborts an active background stream", () => {
    const enabled = $.state(true);
    const controller = new AbortController();
    const destroy = $.effect_root(() => {
      $.effect(() => {
        if (
          shouldCancelBackgroundSummary({
            enabled: $.get(enabled),
            backgroundRequestActive: !controller.signal.aborted,
          })
        ) {
          controller.abort();
        }
      });
    });

    try {
      $.flush();
      expect(controller.signal.aborted).toBe(false);
      $.set(enabled, false);
      $.flush();
      expect(controller.signal.aborted).toBe(true);
    } finally {
      destroy();
    }
  });

  test("a late transcript path never changes a live Codex pane's message owner", () => {
    const liveSurface = $.state(true);
    const transcriptSource = $.state<string | undefined>(undefined);
    const owners: string[] = [];
    const owner = $.derived(() =>
      resolveSessionMessageSource({
        agent: "codex",
        source: "__codex_app__:thread-1",
        transcriptSource: $.get(transcriptSource),
        liveAppSurface: shouldUseCodexAppHistorySource({
          liveSurfaceActive: $.get(liveSurface),
          transcriptSource: $.get(transcriptSource),
        }),
      }),
    );
    const destroy = $.effect_root(() => {
      $.effect(() => owners.push($.get(owner).kind));
    });

    try {
      $.flush();
      expect($.get(owner).kind).toBe("app-server");

      $.set(transcriptSource, "/Users/me/.codex/sessions/thread-1.jsonl");
      $.flush();
      expect($.get(owner).kind).toBe("app-server");
      expect(owners).not.toContain("transcript");

      $.set(liveSurface, false);
      $.flush();
      expect($.get(owner)).toEqual({
        kind: "transcript",
        source: "/Users/me/.codex/sessions/thread-1.jsonl",
      });
      expect(owners.at(-1)).toBe("transcript");
    } finally {
      destroy();
    }
  });

  test("a burst of Codex deltas commits activity to Svelte only once per visual batch", () => {
    const liveActivityIso = $.state("");
    let pendingActivityIso = "";
    let reactiveRuns = 0;
    const observed: string[] = [];
    const destroy = $.effect_root(() => {
      $.effect(() => {
        reactiveRuns += 1;
        observed.push($.get(liveActivityIso));
      });
    });

    try {
      $.flush();
      expect(reactiveRuns).toBe(1);

      for (let index = 0; index < 70; index += 1) {
        const delivery = codexEventVisualDelivery({
          kind: "notification",
          method: "item/agentMessage/delta",
        });
        expect(delivery).toBe("batched-delta");
        pendingActivityIso = `2026-09-01T10:41:10.${String(index).padStart(3, "0")}Z`;
      }
      $.flush();
      expect(reactiveRuns).toBe(1);

      $.set(liveActivityIso, pendingActivityIso);
      pendingActivityIso = "";
      $.flush();
      expect(reactiveRuns).toBe(2);
      expect(observed.at(-1)).toBe("2026-09-01T10:41:10.069Z");

      const immediate = codexEventVisualDelivery({
        kind: "notification",
        method: "item/completed",
      });
      expect(immediate).toBe("immediate");
      $.set(liveActivityIso, "2026-09-01T10:41:11.000Z");
      $.flush();
      expect(reactiveRuns).toBe(3);
    } finally {
      destroy();
    }
  });

  test("thousands of live command-output deltas stay outside Svelte until one bounded visual commit", () => {
    const initialMessages = [
      {
        id: "codex-tool-exec-1",
        role: "assistant",
        blocks: [
          {
            type: "tool_use",
            toolName: "exec_command",
            toolUseId: "exec-1",
          },
        ],
      },
    ];
    const liveMessages = $.state(initialMessages);
    let renderRuns = 0;
    let renderedOutputLength = 0;
    const destroy = $.effect_root(() => {
      $.effect(() => {
        renderRuns += 1;
        renderedOutputLength =
          $.get(liveMessages).find(
            (message) => message.id === "codex-output-exec-1",
          )?.blocks[0]?.text?.length ?? 0;
      });
    });

    try {
      $.flush();
      expect(renderRuns).toBe(1);

      let pendingOutput = "";
      let everyDeltaStayedBatched = true;
      let everyDeltaReusedToolUse = true;
      for (let index = 0; index < 4_623; index += 1) {
        everyDeltaStayedBatched &&=
          codexEventVisualDelivery({
            kind: "notification",
            method: "item/commandExecution/outputDelta",
          }) === "batched-delta";
        everyDeltaReusedToolUse &&= !codexOutputDeltaNeedsToolUse(
          $.get(liveMessages),
          {
            id: "codex-tool-exec-1",
          },
        );
        pendingOutput += `${String(index).padStart(4, "0")}:${"x".repeat(250)}\n`;
      }
      $.flush();
      expect(renderRuns).toBe(1);
      expect(everyDeltaStayedBatched).toBe(true);
      expect(everyDeltaReusedToolUse).toBe(true);

      $.set(
        liveMessages,
        applyVisualTranscriptDeltaPatches($.get(liveMessages), [
          {
            id: "codex-output-exec-1",
            role: "tool",
            type: "tool_result",
            delta: pendingOutput,
            blockFields: {
              toolName: "exec_command",
              toolUseId: "exec-1",
              streaming: true,
            },
            maxTextChars: CODEX_LIVE_OUTPUT_LIMIT,
          },
        ]),
      );
      $.flush();
      expect(renderRuns).toBe(2);
      expect(renderedOutputLength).toBe(CODEX_LIVE_OUTPUT_LIMIT);
      expect(
        $.get(liveMessages)
          .at(-1)
          ?.blocks[0]?.text?.endsWith("4622:" + "x".repeat(250) + "\n"),
      ).toBe(true);
    } finally {
      destroy();
    }
  });
});
