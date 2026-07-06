import { describe, expect, it } from "bun:test";
import {
  isNearVisualScrollEnd,
  replacementVisualScrollTop,
  shouldAnchorLiveWorkTail,
  shouldFollowNewLiveWorkBody,
  shouldFollowVisualTail,
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

  it("allows explicit user actions and first render to jump to the newest message", () => {
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

  it("uses the parent transcript tail state for newly created live work bodies", () => {
    expect(
      shouldFollowNewLiveWorkBody({
        previousShouldStick: undefined,
        parentShouldStick: true,
      }),
    ).toBe(true);
    expect(
      shouldFollowNewLiveWorkBody({
        previousShouldStick: undefined,
        parentShouldStick: false,
      }),
    ).toBe(false);
    expect(
      shouldFollowNewLiveWorkBody({
        previousShouldStick: false,
        parentShouldStick: true,
      }),
    ).toBe(false);
  });

  it("anchors the outer transcript on live work only while tail-following", () => {
    expect(
      shouldAnchorLiveWorkTail({
        hasLiveWork: true,
        shouldStickMessages: true,
      }),
    ).toBe(true);
    expect(
      shouldAnchorLiveWorkTail({
        hasLiveWork: false,
        shouldStickMessages: true,
      }),
    ).toBe(false);
    expect(
      shouldAnchorLiveWorkTail({
        hasLiveWork: true,
        shouldStickMessages: false,
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
});
