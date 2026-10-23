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

  flushNext(): void {
    const task = this.renderTasks.shift() ?? this.frameTasks.shift();
    task?.();
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

function countScrollWrites(scroller: HTMLElement): () => number {
  let scrollTop = scroller.scrollTop;
  let writes = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
      writes += 1;
    },
  });
  return () => writes;
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
  test("does not treat a horizontal trackpad gesture as vertical reader intent", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    let olderRequests = 0;
    const controller = createSessionScrollController({
      scheduler,
      requestOlder: () => olderRequests++,
    });
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    controller.onWheel({ deltaX: 1600, deltaY: -1 } as WheelEvent);
    expect(controller.isPaused).toBe(false);
    expect(olderRequests).toBe(0);
  });

  test.each(["content", "viewport"])(
    "keeps nested work following after a native %s geometry scroll",
    (change) => {
      const scheduler = new ManualScheduler();
      const { scroller, workBody } = fakeLiveWorkScroller();
      let bodyTop = 0;
      Object.defineProperty(workBody, "scrollTop", {
        get: () => bodyTop,
        set: (value: number) => {
          bodyTop = Math.max(
            0,
            Math.min(value, workBody.scrollHeight - workBody.clientHeight),
          );
        },
      });
      const controller = createSessionScrollController({ scheduler });
      controller.setElement(scroller);
      controller.updateTail("initial");
      scheduler.flush();
      expect(workBody.scrollTop).toBe(1544);
      if (change === "content") workBody.scrollHeight += 100;
      else workBody.clientHeight -= 100;
      // Native anchoring moves the viewport when streamed layout changes, but
      // leaves a small gap to the new end. No wheel or scrollbar input occurred.
      workBody.scrollTop += 69;
      controller.onLiveWorkBodyScroll("work:live", workBody);
      controller.updateTail("output-after-return");
      scheduler.flush();
      expect(workBody.scrollTop).toBe(1644);
      expect(controller.isActive).toBe(true);
    },
  );

  test.each(["pointer", "wheel", "paused body"])(
    "preserves nested reader intent during layout changes: %s",
    (intent) => {
      const scheduler = new ManualScheduler();
      const { scroller, workBody } = fakeLiveWorkScroller();
      const controller = createSessionScrollController({ scheduler });
      controller.setElement(scroller);
      controller.updateTail("initial");
      scheduler.flush();
      if (intent === "pointer") controller.onPointerDown();
      else if (intent === "wheel")
        controller.onWheel({ deltaY: -10 } as WheelEvent);
      else {
        workBody.scrollTop = 400;
        controller.onLiveWorkBodyScroll("work:live", workBody);
      }
      workBody.scrollHeight += 100;
      workBody.scrollTop = 500;
      controller.onLiveWorkBodyScroll("work:live", workBody);
      controller.onPointerUp();
      controller.updateTail("output-during-reader-input");
      scheduler.flush();
      expect(workBody.scrollTop).toBe(500);
      expect(controller.isActive).toBe(false);
    },
  );

  test("restores a paused live-work body on remount without pausing its outer viewport", () => {
    const scheduler = new ManualScheduler();
    const first = fakeLiveWorkScroller();
    const controller = createSessionScrollController({ scheduler });
    controller.setMemoryKey("nested-body-reader-remount");
    controller.setElement(first.scroller);
    controller.updateTail("initial");
    scheduler.flush();
    first.workBody.scrollTop = 400;
    controller.onLiveWorkBodyScroll("work:live", first.workBody);
    expect(controller.isPaused).toBe(false);
    controller.setElement(null);
    const next = fakeLiveWorkScroller();
    controller.setElement(next.scroller);
    scheduler.flush();
    expect(next.workBody.scrollTop).toBe(400);
    expect(controller.isPaused).toBe(false);
    expect(controller.isActive).toBe(false);
    next.workBody.scrollTop =
      next.workBody.scrollHeight - next.workBody.clientHeight;
    controller.onLiveWorkBodyScroll("work:live", next.workBody);
    expect(controller.isActive).toBe(true);
  });

  test("remembers an intentional jump to the beginning after previously reading midway", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    // Exercise the metric fallback, without a stable row to conceal a stale
    // saved scrollTop after navigating to the actual start.
    scroller.querySelectorAll = (() =>
      []) as unknown as typeof scroller.querySelectorAll;
    const controller = createSessionScrollController({ scheduler });
    controller.setMemoryKey("intentional-top-memory");
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    controller.setPaused(true);
    scroller.scrollTop = 400;
    controller.saveMemory();
    controller.scrollToEdge("start");
    controller.setElement(null);
    const replacement = fakeScroller(() => 220);
    replacement.scrollTop = 0;
    controller.setElement(replacement);
    scheduler.flush();
    expect(replacement.scrollTop).toBe(0);
    expect(controller.isPaused).toBe(true);
  });

  test("keeps an upward reader gesture paused after restoring a prepended row", () => {
    const scheduler = new ManualScheduler();
    let anchorTop = 220;
    const scroller = fakeScroller(() => anchorTop);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.setPaused(true);
    const anchor = controller.capturePausedReaderAnchor()!;
    anchorTop += 300;
    controller.restorePausedReaderAnchor(anchor);
    scheduler.flush();
    expect(scroller.scrollTop).toBe(700);

    controller.onWheel({ deltaY: -2 } as WheelEvent);
    scroller.scrollTop = 698;
    controller.onScroll();
    expect(controller.isPaused).toBe(true);
  });

  test("lets native upward scroll interrupt a pending update when geometry is unchanged", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    let scrollTop = 700;
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(
          0,
          Math.min(value, scroller.scrollHeight - scroller.clientHeight),
        );
      },
    });
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    controller.updateTail("streamed-same-height-text");
    scroller.scrollTop = 500;
    controller.onScroll();
    scheduler.flush();
    expect(scroller.scrollTop).toBe(500);
    expect(controller.isPaused).toBe(true);
  });

  test("does not move a selection started after a tail update was scheduled", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    let selecting = false;
    const controller = createSessionScrollController({
      scheduler,
      getSelection: () =>
        selecting
          ? ({
              isCollapsed: false,
              rangeCount: 1,
              anchorNode: {},
              focusNode: {},
            } as Selection)
          : null,
    });
    controller.setElement(scroller);
    controller.updateTail("initial");
    selecting = true;
    scheduler.flush();
    expect(scroller.scrollTop).toBe(400);
  });

  test("does not write to the transcript after disposal with tail work queued", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const writes = countScrollWrites(scroller);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");
    controller.dispose();
    scheduler.flush();
    expect(writes()).toBe(0);
  });

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

  test("does not apply a stale paused anchor after another reader wheel gesture", () => {
    const scheduler = new ManualScheduler();
    let anchorTop = 220;
    const scroller = fakeScroller(() => anchorTop);
    const controller = createSessionScrollController({ scheduler });

    controller.setElement(scroller);
    controller.setPaused(true);
    const anchor = controller.capturePausedReaderAnchor();
    anchorTop += 64;
    controller.restorePausedReaderAnchor(anchor!);

    controller.onWheel({
      deltaX: 0,
      deltaY: -80,
      preventDefault: () => {},
    } as WheelEvent);
    scroller.scrollTop = 300;
    controller.onScroll();
    scheduler.flush();

    expect(scroller.scrollTop).toBe(300);
    expect(controller.isPaused).toBe(true);
  });

  test("still restores a paused reader anchor after a layout-only scroll", () => {
    const scheduler = new ManualScheduler();
    let anchorTop = 220;
    const scroller = fakeScroller(() => anchorTop);
    const controller = createSessionScrollController({ scheduler });

    controller.setElement(scroller);
    controller.setPaused(true);
    const anchor = controller.capturePausedReaderAnchor();
    anchorTop += 64;
    controller.restorePausedReaderAnchor(anchor!);

    // Streaming layout and native scroll anchoring can emit `scroll` without
    // a wheel or pointer gesture. That event must not cancel the semantic-row
    // correction which keeps the reader at the same transcript position.
    scroller.scrollTop = 420;
    controller.onScroll();
    scheduler.flush();

    expect(scroller.scrollTop).toBe(484);
    expect(controller.isPaused).toBe(true);
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
    test(`anchors live work near the top and keeps its bounded body at the tail in ${label} mode`, () => {
      const scheduler = new ManualScheduler();
      const { scroller, workBody } = fakeLiveWorkScroller({ zen });
      const controller = createSessionScrollController({ scheduler });

      controller.setElement(scroller);
      controller.updateTail("live-output:1");
      scheduler.flush();

      expect(workBody.scrollTop).toBe(1_000_000_000);
      expect(scroller.scrollTop).toBe(1_712);
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

  test("remembers live-work follow intent while the lane is offscreen", () => {
    const scheduler = new ManualScheduler();
    const first = fakeLiveWorkScroller();
    first.scroller.scrollHeight = 4_000;
    first.scroller.scrollTop = 1_000;
    const controller = createSessionScrollController({ scheduler });
    controller.setMemoryKey("live-work-remount");
    controller.setElement(first.scroller);
    controller.updateTail("live-output:1");
    scheduler.flush();

    expect(controller.isPaused).toBe(false);
    expect(controller.isActive).toBe(true);
    expect(first.scroller.scrollTop).toBeLessThan(3_000);

    controller.setElement(null);
    const next = fakeLiveWorkScroller();
    next.scroller.scrollHeight = 4_500;
    next.scroller.scrollTop = 0;
    controller.setElement(next.scroller);
    scheduler.flush();

    expect(controller.isPaused).toBe(false);
    expect(controller.isActive).toBe(true);
  });

  test("keeps live-work follow when remount's programmatic scroll event precedes alignment", () => {
    const scheduler = new ManualScheduler();
    const first = fakeLiveWorkScroller();
    const controller = createSessionScrollController({ scheduler });
    controller.setMemoryKey("live-work-remount-scroll-event");
    controller.setElement(first.scroller);
    controller.updateTail("live-output");
    scheduler.flush();
    controller.setElement(null);

    const next = fakeLiveWorkScroller();
    next.scroller.scrollTop = 0;
    controller.setElement(next.scroller);
    scheduler.flushNext();
    scheduler.flushNext();
    // The browser reports the restoreMemory scrollTop write before the
    // follow-up frame aligns the live-work header. This is not reader input.
    controller.onScroll();
    expect(controller.isPaused).toBe(false);
    scheduler.flush();
    expect(controller.isActive).toBe(true);
    expect(next.workBody.scrollTop).toBe(1_000_000_000);
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

  test("coalesces a burst of streamed tail updates into one correction per frame", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    scroller.scrollTop = 700;
    const scrollWrites = countScrollWrites(scroller);
    const controller = createSessionScrollController({
      scheduler,
      transcriptActive: () => true,
    });

    controller.setElement(scroller);
    controller.updateTail("delta:1");
    controller.updateTail("delta:2");
    controller.updateTail("delta:3");
    scheduler.flush();

    expect(scrollWrites()).toBe(2);
    expect(scroller.scrollTop).toBe(1_000_000_000);
  });

  test("keeps following when ordinary live updates grow between scheduled corrections", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    scroller.scrollTop = 700;
    const controller = createSessionScrollController({
      scheduler,
      transcriptActive: () => true,
    });

    controller.setElement(scroller);
    controller.updateTail("ordinary-live-item-1");

    // Svelte can render the first item before the scheduled correction, then
    // receive another app-server item in a second flush. The first update was
    // observed at the tail, so the second must not revoke that follow intent
    // merely because the newly grown DOM is now farther from the old position.
    scroller.scrollHeight = 2_000;
    controller.updateTail("ordinary-live-item-2");
    scheduler.flush();

    expect(controller.isPaused).toBe(false);
    expect(scroller.scrollTop).toBe(1_000_000_000);
  });

  test("keeps an explicit send-time follow when the optimistic tail update supersedes it", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    scroller.scrollTop = 700;
    const controller = createSessionScrollController({
      scheduler,
      transcriptActive: () => true,
    });

    controller.setElement(scroller);
    controller.updateTail("completed-turn");
    scheduler.flush();

    scroller.scrollTop = 700;
    controller.forceTailFollow();
    scroller.scrollHeight = 2_000;
    controller.updateTail("optimistic-user-and-live-work");
    scheduler.flush();

    expect(controller.isPaused).toBe(false);
    expect(scroller.scrollTop).toBe(1_000_000_000);
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

  test("does not mistake late content layout for reader scroll intent", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();

    scroller.scrollTop = 679;
    scroller.scrollHeight = 1_400;
    controller.onScroll();
    scheduler.flush();

    expect(controller.isPaused).toBe(false);
    expect(scroller.scrollTop).toBe(1_000_000_000);
  });

  test("a viewport-height change cannot detach a followed lane", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    scroller.scrollTop = 700;
    controller.recordProgrammaticScroll();

    // Header/composer or lane geometry changes clamp the native scroll position
    // without any reader gesture and without changing the content height.
    Object.assign(scroller, { clientHeight: 600, scrollTop: 600 });
    controller.onScroll();
    scheduler.flush();
    expect(controller.isPaused).toBe(false);
    expect(controller.isActive).toBe(true);
  });

  test("keeps following new output after the viewport shrinks without a native scroll event", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    scroller.scrollTop = 700;
    controller.recordProgrammaticScroll();
    Object.assign(scroller, { clientHeight: 300 });
    controller.updateTail("output-after-resize");
    scheduler.flush();
    expect(controller.isPaused).toBe(false);
    expect(scroller.scrollTop).toBe(1_000_000_000);

    controller.setPaused(true);
    Object.assign(scroller, { clientHeight: 200, scrollTop: 400 });
    controller.updateTail("output-while-reading");
    scheduler.flush();
    expect(controller.isPaused).toBe(true);
    expect(scroller.scrollTop).toBe(400);
  });

  test.each(["viewport", "pending-output"])("remembers follow when leaving during %s geometry changes", change => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setMemoryKey(`leaving-during-${change}`);
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    scroller.scrollTop = 700;
    controller.recordProgrammaticScroll();
    if (change === "viewport") Object.assign(scroller, { clientHeight: 300 });
    else { controller.updateTail("next"); scroller.scrollHeight = 1800; }
    controller.setElement(null);
    scheduler.flush();
    const replacement = fakeScroller(() => 220);
    replacement.scrollHeight = 2000;
    replacement.scrollTop = 0;
    controller.setElement(replacement);
    scheduler.flush();
    expect(controller.isPaused).toBe(false);
    expect(controller.isActive).toBe(true);
    expect(replacement.scrollTop).toBe(1_000_000_000);
  });

  test("settles content that grows after the final pending tail write", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");

    scheduler.flushNext();
    scheduler.flushNext();
    scheduler.flushNext();
    scroller.scrollTop = 679;
    scroller.scrollHeight = 1_400;
    controller.onScroll();
    scheduler.flush();

    expect(controller.isPaused).toBe(false);
    expect(scroller.scrollTop).toBe(1_000_000_000);
  });

  test("still detaches when a pointer gesture scrolls away from the tail", () => {
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController();
    controller.setElement(scroller);
    controller.onPointerDown();
    scroller.scrollTop = 100;

    controller.onScroll();

    expect(controller.isPaused).toBe(true);
  });

  test("cancels a queued late-layout correction when the reader scrolls up", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("idle");
    scheduler.flush();

    scroller.scrollTop = 700;
    scroller.scrollHeight = 1_400;
    controller.onScroll();
    controller.onWheel({ deltaY: -100 } as WheelEvent);
    scroller.scrollTop = 600;
    controller.onScroll();
    scheduler.flush();

    expect(scroller.scrollTop).toBe(600);
    expect(controller.isPaused).toBe(true);
  });

  test("does not let first-render follow overwrite intervening reader intent", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");
    controller.onWheel({ deltaY: -100 } as WheelEvent);
    scroller.scrollTop = 300;
    controller.onScroll();
    scheduler.flush();

    expect(scroller.scrollTop).toBe(300);
    expect(controller.isPaused).toBe(true);
  });

  test("does not let remount restoration overwrite intervening reader intent", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setMemoryKey("restore-race-reader-intent");
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    scroller.scrollTop = 700;
    controller.setElement(null);

    const replacement = fakeScroller(() => 220);
    controller.setElement(replacement);
    controller.onWheel({ deltaY: -100 } as WheelEvent);
    replacement.scrollTop = 300;
    controller.onScroll();
    scheduler.flush();

    expect(replacement.scrollTop).toBe(300);
    expect(controller.isPaused).toBe(true);
  });

  test("lets scrollbar input detach while a tail update is pending", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    scroller.scrollTop = 700;
    controller.updateTail("next");
    controller.onPointerDown();
    scroller.scrollTop = 300;
    controller.onScroll();
    controller.onPointerUp();
    scheduler.flush();

    expect(scroller.scrollTop).toBe(300);
    expect(controller.isPaused).toBe(true);
  });

  test("does not let element replacement overwrite intervening reader intent", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    scroller.scrollTop = 700;

    const replacement = fakeScroller(() => 220);
    controller.setElement(replacement);
    controller.onWheel({ deltaY: -100 } as WheelEvent);
    replacement.scrollTop = 300;
    controller.onScroll();
    scheduler.flush();

    expect(replacement.scrollTop).toBe(300);
    expect(controller.isPaused).toBe(true);
  });

  test("keeps explicit upward intent even for a two-pixel gesture near the tail", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial");
    scheduler.flush();
    scroller.scrollTop = 700;
    controller.onScroll();

    controller.onWheel({ deltaY: -2 } as WheelEvent);
    scroller.scrollTop = 698;
    controller.onScroll();
    controller.updateTail("later-update");
    scheduler.flush();

    expect(scroller.scrollTop).toBe(698);
    expect(controller.isPaused).toBe(true);

    controller.onWheel({ deltaY: 2 } as WheelEvent);
    scroller.scrollTop = 700;
    controller.onScroll();
    expect(controller.isPaused).toBe(false);
  });

  test("detaches an idle reader when a bare native scroll moves away from the tail", () => {
    const scheduler = new ManualScheduler();
    const scroller = fakeScroller(() => 220);
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("settled-idle-turn");
    scheduler.flush();

    // Scrollbar drags, keyboard scrolling, and some WebKit gestures can reach
    // us as a native scroll without a preceding wheel/pointer event. With no
    // content-size change, this is reader intent and must detach tail follow.
    scroller.scrollTop = 100;
    controller.onScroll();
    scheduler.flush();

    expect(scroller.scrollTop).toBe(100);
    expect(controller.isPaused).toBe(true);
  });

  test("reports the visible transcript turn and can scroll to another turn", () => {
    const turns = [
      {
        dataset: { visualTurnIndex: "3" },
        getBoundingClientRect: () => rect(-200, 350),
      },
      {
        dataset: { visualTurnIndex: "4" },
        getBoundingClientRect: () => rect(150, 350),
      },
      {
        dataset: { visualTurnIndex: "5" },
        getBoundingClientRect: () => rect(500, 300),
      },
    ] as unknown as HTMLElement[];
    const scroller = fakeScroller(() => 220);
    scroller.querySelectorAll = ((selector: string) =>
      selector === "[data-visual-turn-index]"
        ? turns
        : []) as typeof scroller.querySelectorAll;
    scroller.querySelector = ((selector: string) =>
      selector === '[data-visual-turn-index="5"]'
        ? turns[2]
        : null) as typeof scroller.querySelector;
    const controller = createSessionScrollController();

    controller.setElement(scroller);
    expect(controller.visibleTurnIndex()).toBe(4);

    controller.scrollToTurn(5);
    expect(scroller.scrollTop).toBe(700);
    expect(controller.isPaused).toBe(true);
  });

  test("scrolls to exact transcript edges instead of centering their turns", () => {
    const scroller = fakeScroller(() => 220);
    const scheduler = new ManualScheduler();
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);

    controller.scrollToEdge("start");
    expect(scroller.scrollTop).toBe(0);
    expect(controller.isPaused).toBe(true);

    controller.scrollToEdge("end");
    scheduler.flush();
    expect(scroller.scrollTop).toBe(1_000_000_000);
    expect(controller.isPaused).toBe(false);
  });

  test("keeps an explicit end jump at the bottom during live work and later tail growth", () => {
    const scheduler = new ManualScheduler();
    const { scroller, workBody } = fakeLiveWorkScroller();
    const controller = createSessionScrollController({ scheduler });
    controller.setElement(scroller);
    controller.updateTail("initial-live-work");
    scheduler.flush();
    controller.setPaused(true);

    controller.scrollToEdge("end");
    scheduler.flush();
    expect(scroller.scrollTop).toBe(1_000_000_000);
    expect(workBody.scrollTop).toBe(1_000_000_000);

    // A new response can grow by more than the near-end threshold in one
    // render, before a browser scroll event has a chance to correct it.
    scroller.querySelector = () => null;
    scroller.scrollTop = 1_500;
    scroller.scrollHeight += 300;
    controller.updateTail("later-live-output");
    scheduler.flush();
    expect(scroller.scrollTop).toBe(1_000_000_000);
    expect(controller.isActive).toBe(true);

    controller.onWheel({ deltaY: -100 } as WheelEvent);
    scroller.scrollTop = 1_600;
    controller.updateTail("output-after-reader-scroll");
    scheduler.flush();
    expect(scroller.scrollTop).toBe(1_600);
    expect(controller.isPaused).toBe(true);
  });
});
