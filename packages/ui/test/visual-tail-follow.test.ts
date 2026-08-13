import { describe, expect, it } from "bun:test";
import {
  isNearVisualScrollEnd,
  shouldPauseVisualTailAfterUserScroll,
  isVisualTailFollowActive,
  replacementVisualScrollTop,
  shouldFollowLiveWorkBody,
  shouldFollowVisualTail,
  shouldRememberVisualScrollMemory,
  visualScrollMemoryFromMetrics,
  visualScrollTopFromMemory,
} from "../src/visual-tail-follow";

describe("visual transcript tail following", () => {
  it("follows passive updates only when the scroller is already near the end", () => {
    expect(
      shouldFollowVisualTail({
        paused: false,
        nearEnd: isNearVisualScrollEnd({
          scrollHeight: 2_000,
          scrollTop: 1_360,
          clientHeight: 600,
        }),
      }),
    ).toBe(true);

    expect(
      shouldFollowVisualTail({
        paused: false,
        nearEnd: isNearVisualScrollEnd({
          scrollHeight: 2_000,
          scrollTop: 800,
          clientHeight: 600,
        }),
      }),
    ).toBe(false);
  });

  it("does not resume passive following while the user has paused tail follow", () => {
    expect(
      shouldFollowVisualTail({
        paused: true,
        nearEnd: true,
      }),
    ).toBe(false);
  });

  it("does not show the tail-follow indicator until the scroller is really at the tail", () => {
    expect(
      isVisualTailFollowActive({
        paused: false,
        metrics: {
          scrollHeight: 6_000,
          scrollTop: 0,
          clientHeight: 600,
        },
      }),
    ).toBe(false);

    expect(
      isVisualTailFollowActive({
        paused: false,
        metrics: {
          scrollHeight: 6_000,
          scrollTop: 5_390,
          clientHeight: 600,
        },
      }),
    ).toBe(true);
  });

  it("does not re-arm tail follow merely because the user scrolls downward near the end", () => {
    const nearButStillReading = {
      scrollHeight: 6_000,
      scrollTop: 5_350,
      clientHeight: 600,
    };

    expect(isNearVisualScrollEnd(nearButStillReading)).toBe(true);
    expect(
      shouldPauseVisualTailAfterUserScroll({
        metrics: nearButStillReading,
      }),
    ).toBe(true);

    expect(
      shouldPauseVisualTailAfterUserScroll({
        metrics: {
          scrollHeight: 6_000,
          scrollTop: 5_397,
          clientHeight: 600,
        },
      }),
    ).toBe(false);
  });

  it("allows explicit user actions and a fresh first render to jump to the newest message", () => {
    expect(
      shouldFollowVisualTail({
        force: true,
        paused: true,
        nearEnd: false,
      }),
    ).toBe(true);
    expect(
      shouldFollowVisualTail({
        firstRender: true,
        paused: true,
        nearEnd: false,
      }),
    ).toBe(true);
  });

  it("does not let first render override a saved paused reader position", () => {
    const restoredMemory = visualScrollMemoryFromMetrics({
      metrics: {
        scrollHeight: 6_000,
        scrollTop: 2_400,
        clientHeight: 700,
      },
      paused: true,
    });

    expect(
      shouldFollowVisualTail({
        firstRender: true,
        paused: true,
        nearEnd: false,
        restoredMemory,
      }),
    ).toBe(false);

    expect(
      shouldFollowVisualTail({
        firstRender: true,
        force: true,
        paused: true,
        nearEnd: false,
        restoredMemory,
      }),
    ).toBe(true);
  });

  it("never follows while the user is selecting transcript text", () => {
    expect(
      shouldFollowVisualTail({
        force: true,
        paused: false,
        nearEnd: true,
        selecting: true,
      }),
    ).toBe(false);
    expect(
      shouldFollowVisualTail({
        firstRender: true,
        paused: false,
        nearEnd: true,
        selecting: true,
      }),
    ).toBe(false);
  });

  it("uses the parent transcript and body tail state for live work bodies", () => {
    expect(
      shouldFollowLiveWorkBody({
        parentShouldStick: true,
        bodyPaused: false,
      }),
    ).toBe(true);
    expect(
      shouldFollowLiveWorkBody({
        parentShouldStick: false,
        bodyPaused: false,
      }),
    ).toBe(false);
    expect(
      shouldFollowLiveWorkBody({
        parentShouldStick: true,
        bodyPaused: true,
      }),
    ).toBe(false);
  });

  it("preserves a reader's scroll position when the transcript scroller is replaced", () => {
    expect(
      replacementVisualScrollTop({
        previous: {
          scrollHeight: 3_000,
          scrollTop: 900,
          clientHeight: 600,
        },
        next: {
          scrollHeight: 3_400,
          scrollTop: 0,
          clientHeight: 600,
        },
        followTail: false,
      }),
    ).toBe(900);
  });

  it("keeps tail-following readers at the end when the transcript scroller is replaced", () => {
    expect(
      replacementVisualScrollTop({
        previous: {
          scrollHeight: 3_000,
          scrollTop: 2_400,
          clientHeight: 600,
        },
        next: {
          scrollHeight: 3_400,
          scrollTop: 0,
          clientHeight: 600,
        },
        followTail: true,
      }),
    ).toBe(2_800);
  });

  it("remembers a reader's paused position without promoting it to first-render tail follow", () => {
    const memory = visualScrollMemoryFromMetrics({
      metrics: {
        scrollHeight: 4_000,
        scrollTop: 1_125,
        clientHeight: 600,
      },
      paused: true,
      anchorKey: "message:mid",
      anchorOffsetTop: 42,
    });

    expect(memory).toMatchObject({
      followTail: false,
      scrollTop: 1_125,
      anchorKey: "message:mid",
      anchorOffsetTop: 42,
    });
    expect(
      visualScrollTopFromMemory({
        memory,
        next: {
          scrollHeight: 4_800,
          scrollTop: 0,
          clientHeight: 600,
        },
      }),
    ).toBe(1_125);
  });

  it("remembers tail-following state across transcript remounts", () => {
    const memory = visualScrollMemoryFromMetrics({
      metrics: {
        scrollHeight: 4_000,
        scrollTop: 3_380,
        clientHeight: 600,
      },
      paused: false,
    });

    expect(memory.followTail).toBe(true);
    expect(
      visualScrollTopFromMemory({
        memory,
        next: {
          scrollHeight: 4_800,
          scrollTop: 0,
          clientHeight: 600,
        },
      }),
    ).toBe(4_200);
  });

  it("does not let detached transcript bodies overwrite saved scroll memory", () => {
    expect(
      shouldRememberVisualScrollMemory({
        layoutUsable: true,
        metrics: {
          scrollHeight: 4_000,
          scrollTop: 3_380,
          clientHeight: 600,
        },
      }),
    ).toBe(true);

    expect(
      shouldRememberVisualScrollMemory({
        layoutUsable: false,
        metrics: {
          scrollHeight: 0,
          scrollTop: 0,
          clientHeight: 0,
        },
      }),
    ).toBe(false);
  });

  it("does not let a remount at top overwrite a paused reader position", () => {
    const previous = visualScrollMemoryFromMetrics({
      metrics: {
        scrollHeight: 6_000,
        scrollTop: 2_400,
        clientHeight: 700,
      },
      paused: true,
      anchorKey: "message:mid",
      anchorOffsetTop: 80,
    });

    expect(
      shouldRememberVisualScrollMemory({
        layoutUsable: true,
        previous,
        metrics: {
          scrollHeight: 6_200,
          scrollTop: 0,
          clientHeight: 700,
        },
      }),
    ).toBe(false);
  });
});
