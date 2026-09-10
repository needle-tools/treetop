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
    closest: () => null,
    querySelectorAll: (selector: string) =>
      selector === "[data-visual-scroll-anchor]" ? [anchor] : [],
    querySelector: (selector: string) =>
      selector.includes("assistant:stable") ? anchor : null,
    contains: () => true,
  } as unknown as HTMLElement;
}

function fakeLiveWorkScroller(opts: { zen?: boolean } = {}): {
  scroller: HTMLElement;
  workBody: HTMLElement;
} {
  const workBody = {
    dataset: { workKey: "work:live" },
    scrollHeight: 1_800,
    scrollTop: 0,
    clientHeight: 256,
  } as unknown as HTMLElement;
  const user = {
    getBoundingClientRect: () => rect(260, 120),
    compareDocumentPosition: () => 4,
  } as unknown as HTMLElement;
  const workRow = {
    getBoundingClientRect: () => rect(410, 300),
  } as unknown as HTMLElement;
  const liveWork = {
    closest: (selector: string) => (selector === ".work-row" ? workRow : null),
  } as unknown as HTMLElement;
  const scroller = {
    isConnected: true,
    scrollHeight: 2_000,
    scrollTop: 1_490,
    clientHeight: 500,
    getBoundingClientRect: () => rect(100, 500),
    closest: (selector: string) =>
      opts.zen && selector === ".row.row-zen" ? {} : null,
    querySelectorAll: (selector: string) => {
      if (selector === ".work-foldout-live > .work-foldout-body") {
        return [workBody];
      }
      if (selector === ".msg.user-message") return [user];
      if (selector === "[data-visual-scroll-anchor]") return [];
      return [];
    },
    querySelector: (selector: string) =>
      selector === ".work-foldout-live" ? liveWork : null,
    contains: () => true,
  } as unknown as HTMLElement;
  return { scroller, workBody };
}

describe("session scroll controller", () => {
  test("keeps the first wheel gesture native while recording upward reader intent", () => {
    const controller = createSessionScrollController();
    let prevented = false;

    controller.onMouseEnter();
    controller.onWheel({
      deltaX: 0,
      deltaY: -120,
      preventDefault: () => {
        prevented = true;
      },
    } as WheelEvent);
    controller.dispose();

    expect(prevented).toBe(false);
    expect(controller.isPaused).toBe(true);
  });

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

  test("uses transcript rows, not work containers, as paused reader anchors", () => {
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

  for (const { label, zen } of [
    { label: "regular", zen: false },
    { label: "zen", zen: true },
  ]) {
    test(`keeps the bounded live work body at its tail in ${label} mode`, () => {
      const scheduler = new ManualScheduler();
      const { scroller, workBody } = fakeLiveWorkScroller({ zen });
      const controller = createSessionScrollController({ scheduler });

      controller.setElement(scroller);
      controller.updateTail("live-output:1");
      scheduler.flush();

      expect(workBody.scrollTop).toBe(1_000_000_000);
      expect(scroller.scrollTop).toBeGreaterThan(1_490);
    });
  }

  test("does not steal a reader's live-work position until tail follow is forced", () => {
    const scheduler = new ManualScheduler();
    const { scroller, workBody } = fakeLiveWorkScroller();
    const controller = createSessionScrollController({ scheduler });

    controller.setElement(scroller);
    controller.updateTail("live-output:1");
    scheduler.flush();
    workBody.scrollTop = 400;
    controller.onLiveWorkBodyScroll("work:live", workBody);

    controller.updateTail("live-output:2");
    scheduler.flush();
    expect(workBody.scrollTop).toBe(400);

    controller.forceTailFollow();
    scheduler.flush();
    expect(workBody.scrollTop).toBe(1_000_000_000);
  });

  test("keeps a paused reader in place when a new transcript step arrives", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });

    controller.setElement(scroller);
    controller.updateTail("initial-step");
    scheduler.flush();
    scroller.scrollTop = 400;
    controller.setPaused(true);
    controller.updateTail("next-step");
    scheduler.flush();

    expect(scroller.scrollTop).toBe(400);
    expect(controller.isPaused).toBe(true);
  });

  test("does not mistake a turn-boundary relayout for reader scroll intent", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });

    controller.setElement(scroller);
    controller.updateTail("initial-turn");
    scheduler.flush();

    // The old live-work row is still at the tail when the next replay step is
    // scheduled. Replacing it with the completed turn can clamp scrollTop and
    // emit a scroll event before Svelte's new tail has settled.
    scroller.scrollHeight = 1_200;
    scroller.scrollTop = 700;
    controller.updateTail("next-turn");
    scroller.scrollHeight = 1_800;
    scroller.scrollTop = 50;
    controller.onScroll();
    scheduler.flush();

    expect(controller.isPaused).toBe(false);
    expect(scroller.scrollTop).toBe(1_000_000_000);
  });
});
