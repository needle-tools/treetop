import { test, expect, describe } from "bun:test";
import * as $ from "svelte/internal/client";
import { createCounter, trackEffect } from "./reactivity-poc.svelte.ts";
import { patchWorktreeDetails } from "../src/ndjson-client";
import { nextCachedSessionSummaryRequest } from "../src/summary-queue";
import { shouldCancelBackgroundSummary } from "../src/tui-auto-summary";

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
});
