import { describe, expect, test } from "bun:test";
import {
  createSessionScrollController,
  type SessionScrollScheduler,
} from "../src/session-scroll-controller";

class ManualScheduler implements SessionScrollScheduler {
  private renderTasks: Array<() => void> = [];
  private frameTasks: Array<() => void> = [];

  afterRender(task: () => void): void {
    this.renderTasks.push(task);
  }

  nextFrame(task: () => void): void {
    this.frameTasks.push(task);
  }

  flush(): void {
    while (this.renderTasks.length || this.frameTasks.length) {
      this.renderTasks.splice(0).forEach((task) => task());
      this.frameTasks.splice(0).forEach((task) => task());
    }
  }
}

type FakeAnchor = {
  dataset: { visualScrollAnchor: string };
  parentElement: null;
  getBoundingClientRect: () => DOMRect;
};

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 600,
    width: 600,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function fakeScroller(anchorTop: () => number): HTMLElement {
  const anchor: FakeAnchor = {
    dataset: { visualScrollAnchor: "assistant:stable" },
    parentElement: null,
    getBoundingClientRect: () => rect(anchorTop(), 80),
  };
  return {
    isConnected: true,
    scrollHeight: 1_200,
    scrollTop: 400,
    clientHeight: 500,
    getBoundingClientRect: () => rect(100, 500),
    querySelectorAll: (selector: string) =>
      selector === "[data-visual-scroll-anchor]" ? [anchor] : [],
    querySelector: (selector: string) =>
      selector.includes("assistant:stable") ? anchor : null,
    contains: () => true,
  } as unknown as HTMLElement;
}

describe("session scroll controller", () => {
  test("restores the same visible row after a paused live update", () => {
    const scheduler = new ManualScheduler();
    let anchorTop = 220;
    const scroller = fakeScroller(() => anchorTop);
    const controller = createSessionScrollController({ scheduler });

    controller.setElement(scroller);
    controller.setPaused(true);
    const anchor = controller.capturePausedReaderAnchor();
    expect(anchor?.key).toBe("assistant:stable");

    anchorTop += 64;
    controller.restorePausedReaderAnchor(anchor!);
    scheduler.flush();

    expect(scroller.scrollTop).toBe(464);
  });

  test("uses the transcript as its sole scrolling authority", () => {
    const scheduler = new ManualScheduler();
    const selectors: string[] = [];
    const scroller = fakeScroller(() => 220);
    const originalQuery = scroller.querySelectorAll.bind(scroller);
    scroller.querySelectorAll = ((selector: string) => {
      selectors.push(selector);
      return originalQuery(selector);
    }) as typeof scroller.querySelectorAll;
    const controller = createSessionScrollController({ scheduler });

    controller.setElement(scroller);
    controller.setPaused(true);
    controller.capturePausedReaderAnchor();

    expect(selectors).toEqual(["[data-visual-scroll-anchor]"]);
    expect(
      selectors.some((selector) => selector.includes("work-foldout")),
    ).toBe(false);
  });
});
