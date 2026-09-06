import {
  isNearVisualScrollEnd,
  isVisualTailFollowActive,
  replacementVisualScrollTop,
  selectVisualScrollAnchor,
  shouldFollowVisualTail,
  shouldPauseVisualTailAfterUserScroll,
  shouldRememberVisualScrollMemory,
  VISUAL_TAIL_FOLLOW_NEAR_PX,
  VISUAL_TAIL_FOLLOW_RESUME_PX,
  visualScrollMemoryFromMetrics,
  visualScrollTopFromMemory,
  zenLiveWorkScrollDelta,
  type VisualScrollMemory,
} from "./visual-tail-follow";

const scrollMemoryByKey = new Map<string, VisualScrollMemory>();
const SCROLL_MEMORY_LIMIT = 200;
const CURSOR_SETTLE_MS = 300;

function rememberScrollMemory(key: string, memory: VisualScrollMemory): void {
  if (!key) return;
  if (scrollMemoryByKey.has(key)) scrollMemoryByKey.delete(key);
  scrollMemoryByKey.set(key, memory);
  while (scrollMemoryByKey.size > SCROLL_MEMORY_LIMIT) {
    const oldest = scrollMemoryByKey.keys().next().value;
    if (!oldest) break;
    scrollMemoryByKey.delete(oldest);
  }
}

export interface SessionScrollScheduler {
  afterRender(task: () => void): void;
  nextFrame(task: () => void): void;
}

export interface SessionScrollControllerOptions {
  scheduler?: SessionScrollScheduler;
  requestOlder?: () => void;
  historyAnchorActive?: () => boolean;
  transcriptActive?: () => boolean;
  onActiveChange?: (active: boolean) => void;
  scrollWindowBy?: (deltaY: number) => void;
  getSelection?: () => Selection | null;
}

export interface PausedSessionReaderAnchor {
  el: HTMLElement;
  key: string;
  offsetTop: number;
  pauseSeq: number;
}

function defaultScheduler(): SessionScrollScheduler {
  return {
    afterRender(task) {
      queueMicrotask(task);
    },
    nextFrame(task) {
      requestAnimationFrame(task);
    },
  };
}

function metrics(el: HTMLElement) {
  return {
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
  };
}

function usableLayout(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function scrollToEnd(el: HTMLElement): void {
  // Let the browser clamp to the real end. Reading scrollHeight here forces
  // layout across large transcripts during startup.
  el.scrollTop = 1_000_000_000;
}

function escapedAttribute(value: string): string {
  const escape = globalThis.CSS?.escape;
  return escape ? escape(value) : value.replace(/["\\]/g, "\\$&");
}

export class SessionScrollController {
  private readonly scheduler: SessionScrollScheduler;
  private readonly options: SessionScrollControllerOptions;
  private el: HTMLElement | null = null;
  private memoryKey = "";
  private tailKey = "";
  private renderedOnce = false;
  private paused = false;
  private active = false;
  private pauseSeq = 0;
  private readerRestoreSeq = 0;
  private layoutObserver: ResizeObserver | null = null;
  private cursorSettled = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SessionScrollControllerOptions = {}) {
    this.options = options;
    this.scheduler = options.scheduler ?? defaultScheduler();
  }

  get element(): HTMLElement | null {
    return this.el;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setMemoryKey(key: string): void {
    this.memoryKey = key;
  }

  setElement(next: HTMLElement | null): void {
    if (next === this.el) return;
    const previous = this.el;
    if (previous && this.renderedOnce) this.saveMemory(previous);
    this.el = next;
    if (!next) {
      this.setActive(false);
      return;
    }
    if (this.restoreMemory(next)) return;
    if (previous && this.renderedOnce) {
      this.preserveReplacement(previous, next);
    }
  }

  updateTail(nextTailKey: string): void {
    if (!this.el || nextTailKey === this.tailKey) return;
    this.tailKey = nextTailKey;
    this.scheduleTailFollow();
  }

  reset(): void {
    this.renderedOnce = false;
    this.tailKey = "";
    this.paused = false;
    this.pauseSeq += 1;
    this.setActive(false);
  }

  dispose(): void {
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  setPaused(paused: boolean): void {
    if (this.paused !== paused) {
      this.paused = paused;
      this.pauseSeq += 1;
    }
    this.syncActive();
  }

  updateIntent(): void {
    if (!this.el) return;
    const zenLiveDelta = this.zenLiveWorkDelta(this.el);
    this.setPaused(
      zenLiveDelta !== undefined
        ? Math.abs(zenLiveDelta) > VISUAL_TAIL_FOLLOW_RESUME_PX
        : shouldPauseVisualTailAfterUserScroll({ metrics: metrics(this.el) }),
    );
  }

  onMouseEnter(): void {
    this.cursorSettled = false;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.cursorSettled = true;
      this.settleTimer = null;
    }, CURSOR_SETTLE_MS);
  }

  onMouseLeave(): void {
    this.cursorSettled = false;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  onWheel(event: WheelEvent): void {
    if (this.cursorSettled) {
      if (event.deltaY < 0) this.setPaused(true);
      else if (event.deltaY > 0) this.updateIntent();
      if (event.deltaY < 0) this.options.requestOlder?.();
      return;
    }
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    if (this.options.scrollWindowBy) {
      this.options.scrollWindowBy(event.deltaY);
    } else {
      window.scrollBy({ top: event.deltaY, behavior: "auto" });
    }
  }

  onScroll(): void {
    this.updateIntent();
    this.saveMemory();
    this.options.requestOlder?.();
  }

  capturePausedReaderAnchor(): PausedSessionReaderAnchor | undefined {
    if (
      !this.el ||
      !this.paused ||
      this.options.historyAnchorActive?.() === true
    ) {
      return undefined;
    }
    const anchor = this.scrollAnchor(this.el);
    return anchor
      ? { el: this.el, ...anchor, pauseSeq: this.pauseSeq }
      : undefined;
  }

  restorePausedReaderAnchor(anchor: PausedSessionReaderAnchor): void {
    const restoreSeq = ++this.readerRestoreSeq;
    this.afterPaint(() => {
      if (
        restoreSeq !== this.readerRestoreSeq ||
        this.el !== anchor.el ||
        !this.paused ||
        this.pauseSeq !== anchor.pauseSeq
      ) {
        return;
      }
      const target = anchor.el.querySelector<HTMLElement>(
        `[data-visual-scroll-anchor="${escapedAttribute(anchor.key)}"]`,
      );
      if (!target) return;
      const scrollerTop = anchor.el.getBoundingClientRect().top;
      const nextOffsetTop = target.getBoundingClientRect().top - scrollerTop;
      const delta = nextOffsetTop - anchor.offsetTop;
      if (Math.abs(delta) >= 0.5) anchor.el.scrollTop += delta;
    });
  }

  saveMemory(el: HTMLElement | null = this.el): void {
    if (!el || !this.memoryKey) return;
    const current = metrics(el);
    if (
      !shouldRememberVisualScrollMemory({
        layoutUsable: usableLayout(el),
        metrics: current,
        previous: scrollMemoryByKey.get(this.memoryKey),
      })
    ) {
      return;
    }
    const anchor = this.scrollAnchor(el);
    rememberScrollMemory(
      this.memoryKey,
      visualScrollMemoryFromMetrics({
        metrics: current,
        paused: this.paused,
        nearPx: VISUAL_TAIL_FOLLOW_NEAR_PX,
        anchorKey: anchor?.key,
        anchorOffsetTop: anchor?.offsetTop,
      }),
    );
  }

  scheduleTailFollow(options: { force?: boolean } = {}): void {
    const el = this.el;
    if (!el) return;
    const force = options.force === true;
    const firstRender = !this.renderedOnce;
    if (firstRender && !usableLayout(el)) {
      this.waitForLayout(options);
      return;
    }
    const pauseSeq = this.pauseSeq;
    const selecting = this.hasActiveSelection();
    const shouldStick =
      (!this.paused &&
        !selecting &&
        this.zenLiveWorkDelta(el) !== undefined) ||
      shouldFollowVisualTail({
        force,
        firstRender,
        paused: this.paused,
        nearEnd: isNearVisualScrollEnd(el, VISUAL_TAIL_FOLLOW_NEAR_PX),
        restoredMemory: scrollMemoryByKey.get(this.memoryKey),
        selecting,
      });
    this.syncActive(el);
    this.renderedOnce = true;

    this.afterPaint(() => {
      const current = this.el;
      if (!current) return;
      const mayFollow = firstRender || this.canApplyFollow(pauseSeq);
      if (!mayFollow) this.setActive(false);
      if (shouldStick && mayFollow) this.applyTailFollow(current);
      if (!this.options.transcriptActive?.()) return;
      this.scheduler.nextFrame(() => {
        const settled = this.el;
        const mayFollowSettled = firstRender || this.canApplyFollow(pauseSeq);
        if (!mayFollowSettled) this.setActive(false);
        if (settled && shouldStick && mayFollowSettled) {
          this.applyTailFollow(settled);
        }
      });
    });
  }

  forceTailFollow(): void {
    this.setPaused(false);
    this.scheduleTailFollow({ force: true });
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.options.onActiveChange?.(active);
  }

  private syncActive(el: HTMLElement | null = this.el): void {
    this.setActive(
      !!el &&
        !this.paused &&
        (this.zenLiveWorkDelta(el) !== undefined ||
          isVisualTailFollowActive({
            metrics: metrics(el),
            paused: false,
            nearPx: VISUAL_TAIL_FOLLOW_NEAR_PX,
          })),
    );
  }

  private afterPaint(task: () => void): void {
    this.scheduler.afterRender(() => this.scheduler.nextFrame(task));
  }

  private canApplyFollow(seq: number): boolean {
    return this.pauseSeq === seq && !this.paused;
  }

  private applyTailFollow(el: HTMLElement): void {
    const zenLiveDelta = this.zenLiveWorkDelta(el);
    if (zenLiveDelta !== undefined) el.scrollTop += zenLiveDelta;
    else scrollToEnd(el);
    this.syncActive(el);
  }

  private zenLiveWorkDelta(el: HTMLElement): number | undefined {
    if (!el.closest(".row.row-zen")) return undefined;
    const liveWork = el
      .querySelector<HTMLElement>(".work-foldout-live")
      ?.closest<HTMLElement>(".work-row");
    if (!liveWork) return undefined;
    const userMessages = Array.from(
      el.querySelectorAll<HTMLElement>(".msg.user-message"),
    );
    const precedingUser = userMessages.findLast(
      (user) =>
        (user.compareDocumentPosition(liveWork) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    );
    if (!precedingUser) return undefined;
    const viewport = el.getBoundingClientRect();
    const user = precedingUser.getBoundingClientRect();
    const work = liveWork.getBoundingClientRect();
    return zenLiveWorkScrollDelta({
      viewportTop: viewport.top,
      viewportHeight: viewport.height,
      userHeight: user.height,
      workTop: work.top,
    });
  }

  private waitForLayout(options: { force?: boolean }): void {
    const el = this.el;
    if (!el) return;
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    if (typeof ResizeObserver === "undefined") {
      this.scheduler.nextFrame(() => this.scheduleTailFollow(options));
      return;
    }
    this.layoutObserver = new ResizeObserver(() => {
      if (!this.el || !usableLayout(this.el)) return;
      this.layoutObserver?.disconnect();
      this.layoutObserver = null;
      this.scheduleTailFollow(options);
    });
    this.layoutObserver.observe(el);
  }

  private restoreMemory(el: HTMLElement): boolean {
    const memory = scrollMemoryByKey.get(this.memoryKey);
    if (!memory) return false;
    this.renderedOnce = true;
    this.setPaused(!memory.followTail);
    this.afterPaint(() => {
      if (this.el !== el) return;
      if (
        !memory.followTail &&
        memory.anchorKey &&
        memory.anchorOffsetTop !== undefined
      ) {
        const target = el.querySelector<HTMLElement>(
          `[data-visual-scroll-anchor="${escapedAttribute(memory.anchorKey)}"]`,
        );
        if (target) {
          const scrollerRect = el.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          el.scrollTop +=
            targetRect.top - scrollerRect.top - memory.anchorOffsetTop;
          this.syncActive(el);
          return;
        }
      }
      el.scrollTop = visualScrollTopFromMemory({ memory, next: metrics(el) });
      this.syncActive(el);
      if (memory.followTail) this.settleTailFollow(el);
    });
    return true;
  }

  private preserveReplacement(previous: HTMLElement, next: HTMLElement): void {
    const previousMetrics = metrics(previous);
    const followedTail = !this.paused && isNearVisualScrollEnd(previousMetrics);
    if (!followedTail) this.setPaused(true);
    const pauseSeq = this.pauseSeq;
    this.afterPaint(() => {
      if (this.el !== next) return;
      const followTail = followedTail && this.canApplyFollow(pauseSeq);
      next.scrollTop = replacementVisualScrollTop({
        previous: previousMetrics,
        next: metrics(next),
        followTail,
      });
      this.syncActive(next);
      if (followTail) this.settleTailFollow(next);
    });
  }

  private settleTailFollow(el: HTMLElement): void {
    this.scheduler.nextFrame(() => {
      if (this.el !== el) return;
      this.applyTailFollow(el);
    });
  }

  private hasActiveSelection(): boolean {
    if (!this.el) return false;
    const selection = this.options.getSelection
      ? this.options.getSelection()
      : typeof window !== "undefined"
        ? window.getSelection?.()
        : null;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return false;
    }
    return (
      (!!selection.anchorNode && this.el.contains(selection.anchorNode)) ||
      (!!selection.focusNode && this.el.contains(selection.focusNode))
    );
  }

  private scrollAnchor(
    el: HTMLElement,
  ): { key: string; offsetTop: number } | undefined {
    const scrollerRect = el.getBoundingClientRect();
    const anchors = Array.from(
      el.querySelectorAll<HTMLElement>("[data-visual-scroll-anchor]"),
    );
    return selectVisualScrollAnchor({
      viewportTop: scrollerRect.top,
      viewportBottom: scrollerRect.bottom,
      candidates: anchors.flatMap((anchor) => {
        const key = anchor.dataset.visualScrollAnchor;
        if (!key) return [];
        const box = anchor.getBoundingClientRect();
        let depth = 0;
        let parent = anchor.parentElement?.closest<HTMLElement>(
          "[data-visual-scroll-anchor]",
        );
        while (parent && el.contains(parent)) {
          depth += 1;
          parent = parent.parentElement?.closest<HTMLElement>(
            "[data-visual-scroll-anchor]",
          );
        }
        return [{ key, top: box.top, bottom: box.bottom, depth }];
      }),
    });
  }
}

export function createSessionScrollController(
  options: SessionScrollControllerOptions = {},
): SessionScrollController {
  return new SessionScrollController(options);
}
