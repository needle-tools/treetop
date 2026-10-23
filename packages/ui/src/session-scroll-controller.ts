import {
  isNearVisualScrollEnd,
  isVisualTailFollowActive,
  replacementVisualScrollTop,
  selectVisualScrollAnchor,
  selectVisualScrollIndex,
  shouldFollowVisualTail,
  shouldPauseVisualTailAfterUserScroll,
  shouldRememberVisualScrollMemory,
  VISUAL_TAIL_FOLLOW_NEAR_PX,
  VISUAL_TAIL_FOLLOW_RESUME_PX,
  visualScrollMemoryFromMetrics,
  visualScrollTopFromMemory,
  liveWorkScrollDelta,
  type VisualScrollMemory,
} from "./visual-tail-follow";

interface SessionScrollMemory extends VisualScrollMemory {
  outerPaused: boolean;
  liveWorkBodies: Array<{ key: string; scrollTop: number; paused: boolean }>;
}

const scrollMemoryByKey = new Map<string, SessionScrollMemory>();
const SCROLL_MEMORY_LIMIT = 200;
const CURSOR_SETTLE_MS = 300;
const DOCUMENT_POSITION_FOLLOWING = 4;

function rememberScrollMemory(key: string, memory: SessionScrollMemory): void {
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
  onPausedChange?: (paused: boolean) => void;
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
  private followExactEnd = false;
  private active = false;
  private pauseSeq = 0;
  private readerRestoreSeq = 0;
  private tailFollowSeq = 0;
  private pendingTailFollowSeq = 0;
  private pendingTailFollowForced = false;
  private pendingTailFollowShouldStick = false;
  private layoutObserver: ResizeObserver | null = null;
  private cursorSettled = false;
  private pointerScrollIntent = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private pausedLiveWorkBodyKeys = new Set<string>();
  private readonly observedLiveWorkBodies = new WeakMap<
    HTMLElement,
    ReturnType<typeof metrics>
  >();
  private observedScrollHeight = 0;
  private observedClientHeight = 0;
  private observedScrollTop = 0;
  private pendingMemoryRestore: {
    el: HTMLElement;
    pauseSeq: number;
  } | null = null;

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

  visibleTurnIndex(): number | undefined {
    if (!this.el) return undefined;
    const viewport = this.el.getBoundingClientRect();
    return selectVisualScrollIndex({
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      candidates: Array.from(
        this.el.querySelectorAll<HTMLElement>("[data-visual-turn-index]"),
      ).flatMap((row) => {
        const index = Number(row.dataset.visualTurnIndex);
        if (!Number.isInteger(index) || index < 0) return [];
        const box = row.getBoundingClientRect();
        return [{ index, top: box.top, bottom: box.bottom }];
      }),
    });
  }

  scrollToTurn(turnIndex: number): void {
    if (!this.el || !Number.isInteger(turnIndex) || turnIndex < 0) return;
    const target = this.el.querySelector<HTMLElement>(
      `[data-visual-turn-index="${turnIndex}"]`,
    );
    if (!target) return;
    this.setPaused(true);
    const viewport = this.el.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    this.el.scrollTop +=
      (box.top + box.bottom) / 2 - (viewport.top + viewport.bottom) / 2;
    this.recordProgrammaticScroll();
    this.saveMemory();
  }

  scrollToEdge(edge: "start" | "end"): void {
    if (!this.el) return;
    if (edge === "end") {
      this.followExactEnd = true;
      this.forceTailFollow();
      scrollToEnd(this.el);
    } else {
      this.setPaused(true);
      this.el.scrollTop = 0;
    }
    this.recordProgrammaticScroll();
    this.saveMemory();
  }

  recordProgrammaticScroll(): void {
    if (!this.el) return;
    this.observedScrollHeight = this.el.scrollHeight;
    this.observedClientHeight = this.el.clientHeight;
    this.observedScrollTop = this.el.scrollTop;
  }

  setMemoryKey(key: string): void {
    this.memoryKey = key;
  }

  setElement(next: HTMLElement | null): void {
    if (next === this.el) return;
    this.pointerScrollIntent = false;
    const previous = this.el;
    if (previous && this.renderedOnce) this.saveMemory(previous);
    // Persist pending follow intent first, then retire work owned by the old
    // scroll element. A later lane mount must restore its memory, not receive
    // an alignment callback scheduled against a detached viewport.
    this.tailFollowSeq += 1;
    this.pendingTailFollowSeq = 0;
    this.pendingTailFollowForced = false;
    this.pendingTailFollowShouldStick = false;
    this.el = next;
    this.pendingMemoryRestore = null;
    if (!next) {
      this.observedScrollHeight = 0;
      this.observedClientHeight = 0;
      this.setActive(false);
      return;
    }
    this.observedScrollHeight = next.scrollHeight;
    this.observedClientHeight = next.clientHeight;
    this.observedScrollTop = next.scrollTop;
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
    this.pendingMemoryRestore = null;
    this.tailFollowSeq += 1;
    this.pendingTailFollowSeq = 0;
    this.pendingTailFollowForced = false;
    this.pendingTailFollowShouldStick = false;
    this.renderedOnce = false;
    this.tailKey = "";
    const wasPaused = this.paused;
    this.paused = false;
    if (wasPaused) this.options.onPausedChange?.(false);
    this.followExactEnd = false;
    this.pointerScrollIntent = false;
    this.observedScrollHeight = this.el?.scrollHeight ?? 0;
    this.observedClientHeight = this.el?.clientHeight ?? 0;
    this.observedScrollTop = this.el?.scrollTop ?? 0;
    this.pausedLiveWorkBodyKeys.clear();
    this.pauseSeq += 1;
    this.setActive(false);
  }

  dispose(): void {
    this.pendingMemoryRestore = null;
    this.tailFollowSeq += 1;
    this.pendingTailFollowSeq = 0;
    this.pendingTailFollowForced = false;
    this.pendingTailFollowShouldStick = false;
    this.readerRestoreSeq += 1;
    this.pauseSeq += 1;
    this.el = null;
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  setPaused(paused: boolean): void {
    if (paused) this.followExactEnd = false;
    if (this.paused !== paused) {
      this.paused = paused;
      this.pauseSeq += 1;
      this.options.onPausedChange?.(paused);
    }
    this.syncActive();
  }

  updateIntent(): void {
    if (!this.el) return;
    const liveWorkDelta = this.followExactEnd
      ? undefined
      : this.liveWorkDelta(this.el);
    this.setPaused(
      liveWorkDelta !== undefined
        ? Math.abs(liveWorkDelta) > VISUAL_TAIL_FOLLOW_RESUME_PX
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
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (event.deltaY !== 0) {
      // `scroll` itself is ambiguous: streamed layout can clamp or anchor the
      // element without reader input. Wheel is explicit reader intent, so it
      // invalidates any paused-row correction captured before this gesture.
      this.pauseSeq += 1;
    }
    if (event.deltaY < 0) {
      this.setPaused(true);
      this.options.requestOlder?.();
      return;
    }
    if (this.cursorSettled && event.deltaY > 0) this.updateIntent();
    // Let the transcript's native scroller own the first gesture too. Its
    // scroll event updates pause state and requests older history. Redirecting
    // this gesture to an outer window made the same SessionView behave
    // differently depending on which shell mounted it.
  }

  onPointerDown(): void {
    this.pointerScrollIntent = true;
  }

  onPointerUp(): void {
    this.pointerScrollIntent = false;
  }

  onScroll(): void {
    // A tail update can replace a tall live-work row with a short completed
    // summary before adding the next turn. The browser clamps scrollTop and
    // emits a normal scroll event for that layout change. It is not reader
    // intent, and treating it as such cancels follow between replay/live
    // turns. Explicit wheel intent still updates pause state in onWheel.
    const stableUpwardScroll =
      !!this.el &&
      this.el.scrollHeight === this.observedScrollHeight &&
      this.el.clientHeight === this.observedClientHeight &&
      this.el.scrollTop < this.observedScrollTop;
    if (
      this.pendingTailFollowSeq !== 0 &&
      !this.paused &&
      !this.pointerScrollIntent &&
      !stableUpwardScroll
    ) {
      if (
        this.el &&
        !isNearVisualScrollEnd(this.el, VISUAL_TAIL_FOLLOW_RESUME_PX)
      ) {
        this.settleTailFollow(this.el);
      }
      return;
    }
    if (!this.paused && !this.pointerScrollIntent) {
      const el = this.el;
      const layoutChanged =
        !!el && (el.scrollHeight !== this.observedScrollHeight || el.clientHeight !== this.observedClientHeight);
      if (el) {
        this.observedScrollHeight = el.scrollHeight;
        this.observedClientHeight = el.clientHeight;
      }
      if (layoutChanged) {
        // Late image/font/disclosure layout or viewport resizing can move a followed viewport
        // without a new transcript tail key. Preserve follow only when the
        // content geometry actually changed; a quiet bare scroll is reader
        // intent (scrollbar, keyboard, and some WebKit gestures).
        if (!isNearVisualScrollEnd(el, VISUAL_TAIL_FOLLOW_RESUME_PX)) {
          this.settleTailFollow(el);
        } else {
          this.observedScrollTop = el.scrollTop;
          this.syncActive();
          this.saveMemory();
        }
        return;
      }
    }
    // A pointer drag is explicit reader intent. A bare `scroll` is reader
    // intent when geometry stayed stable; the branch above already retained
    // follow for native scroll anchoring caused by a content-height change.
    if (this.pointerScrollIntent) this.pauseSeq += 1;
    if (this.el) {
      // A small upward gesture is still reader intent, even while it remains
      // inside the end tolerance. Only movement back toward the tail may
      // reattach a paused reader. A programmatic restore records its position
      // before the browser dispatches scroll; that no-movement event must not
      // cancel the next alignment frame while the live header is unaligned.
      if (this.el.scrollTop < this.observedScrollTop) this.setPaused(true);
      else if (this.el.scrollTop > this.observedScrollTop) {
        this.updateIntent();
      }
      this.observedScrollHeight = this.el.scrollHeight;
      this.observedClientHeight = this.el.clientHeight;
      this.observedScrollTop = this.el.scrollTop;
    }
    this.saveMemory();
    this.options.requestOlder?.();
  }

  onLiveWorkBodyScroll(workKey: string, body: HTMLElement): void {
    const current = metrics(body);
    const previous = this.observedLiveWorkBodies.get(body);
    this.observedLiveWorkBodies.set(body, current);
    if (
      this.el &&
      previous &&
      !this.paused &&
      !this.pausedLiveWorkBodyKeys.has(workKey) &&
      !this.pointerScrollIntent &&
      (current.scrollHeight !== previous.scrollHeight ||
        current.clientHeight !== previous.clientHeight)
    ) {
      // Native anchoring can move a bounded live body when streamed work
      // changes its layout. As with the outer viewport, that scroll is not
      // reader intent. Keep its follow armed for the next correction.
      this.settleTailFollow(this.el);
      return;
    }
    const paused = shouldPauseVisualTailAfterUserScroll({
      metrics: current,
    });
    if (paused) this.pausedLiveWorkBodyKeys.add(workKey);
    else this.pausedLiveWorkBodyKeys.delete(workKey);
    this.syncActive();
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
      this.recordProgrammaticScroll();
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
        restoring:
          this.pendingMemoryRestore?.el === el &&
          this.pendingMemoryRestore.pauseSeq === this.pauseSeq,
      })
    ) {
      return;
    }
    const anchor = this.scrollAnchor(el);
    // Remember intent, not a transient gap while a resize or queued tail
    // correction is unsettled. Explicit outer/nested reader pauses still win.
    rememberScrollMemory(this.memoryKey, {
      ...visualScrollMemoryFromMetrics({
        metrics: current,
        paused: this.paused,
        followTail:
          !this.paused &&
          (this.pendingTailFollowShouldStick ||
            el.clientHeight !== this.observedClientHeight ||
            this.followExactEnd ||
            this.liveWorkDelta(el) !== undefined ||
            isNearVisualScrollEnd(current, VISUAL_TAIL_FOLLOW_NEAR_PX)) &&
          this.liveWorkBodiesAreFollowing(el, true),
        nearPx: VISUAL_TAIL_FOLLOW_NEAR_PX,
        anchorKey: anchor?.key,
        anchorOffsetTop: anchor?.offsetTop,
      }),
      outerPaused: this.paused,
      liveWorkBodies: this.liveWorkBodies(el).map(({ body, key }) => ({
        key,
        scrollTop: body.scrollTop,
        paused: this.pausedLiveWorkBodyKeys.has(key),
      })),
    });
  }

  scheduleTailFollow(options: { force?: boolean } = {}): void {
    const el = this.el;
    if (!el) return;
    const followSeq = ++this.tailFollowSeq;
    this.pendingTailFollowSeq = followSeq;
    this.pendingTailFollowForced ||= options.force === true;
    const force = this.pendingTailFollowForced;
    const firstRender = !this.renderedOnce;
    if (firstRender && !usableLayout(el)) {
      this.waitForLayout(options);
      return;
    }
    const pauseSeq = this.pauseSeq;
    const selecting = this.hasActiveSelection();
    const shouldStickNow =
      (!this.paused &&
        !selecting &&
        (this.followExactEnd ||
          this.liveWorkDelta(el) !== undefined ||
          el.clientHeight !== this.observedClientHeight)) ||
      shouldFollowVisualTail({
        force,
        firstRender,
        paused: this.paused,
        nearEnd: isNearVisualScrollEnd(el, VISUAL_TAIL_FOLLOW_NEAR_PX),
        restoredMemory: scrollMemoryByKey.get(this.memoryKey),
        selecting,
      });
    this.pendingTailFollowShouldStick ||= shouldStickNow;
    const shouldStick = this.pendingTailFollowShouldStick;
    this.syncActive(el);
    this.renderedOnce = true;

    this.afterPaint(() => {
      if (this.pendingTailFollowSeq !== followSeq) return;
      const current = this.el;
      if (!current) return;
      const mayFollow = this.canApplyFollow(pauseSeq);
      if (!mayFollow) this.setActive(false);
      if (shouldStick && mayFollow) this.applyTailFollow(current);
      this.scheduler.nextFrame(() => {
        if (this.pendingTailFollowSeq !== followSeq) return;
        const settled = this.el;
        const mayFollowSettled = this.canApplyFollow(pauseSeq);
        if (!mayFollowSettled) this.setActive(false);
        if (
          settled &&
          shouldStick &&
          mayFollowSettled &&
          this.options.transcriptActive?.()
        ) {
          this.applyTailFollow(settled);
        }
        this.scheduler.nextFrame(() => {
          if (this.pendingTailFollowSeq !== followSeq) return;
          this.pendingTailFollowSeq = 0;
          this.pendingTailFollowForced = false;
          this.pendingTailFollowShouldStick = false;
          this.syncActive();
        });
      });
    });
  }

  forceTailFollow(): void {
    this.pausedLiveWorkBodyKeys.clear();
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
        ((!this.followExactEnd && this.liveWorkDelta(el) !== undefined) ||
          isVisualTailFollowActive({
            metrics: metrics(el),
            paused: false,
            nearPx: VISUAL_TAIL_FOLLOW_NEAR_PX,
          })) &&
        this.liveWorkBodiesAreFollowing(el),
    );
  }

  private afterPaint(task: () => void): void {
    this.scheduler.afterRender(() => this.scheduler.nextFrame(task));
  }

  private canApplyFollow(seq: number): boolean {
    return this.pauseSeq === seq && !this.paused && !this.hasActiveSelection();
  }

  private applyTailFollow(el: HTMLElement): void {
    // A reader's jump to the end must stay at the real bottom. The default
    // live-work alignment can otherwise pull it back above the latest output.
    const liveWorkDelta = this.followExactEnd
      ? undefined
      : this.liveWorkDelta(el);
    if (liveWorkDelta !== undefined) el.scrollTop += liveWorkDelta;
    else scrollToEnd(el);
    this.scrollLiveWorkBodiesToEnd(el);
    this.observedScrollHeight = el.scrollHeight;
    this.observedClientHeight = el.clientHeight;
    this.observedScrollTop = el.scrollTop;
    this.syncActive(el);
  }

  private liveWorkBodies(el: HTMLElement): Array<{
    body: HTMLElement;
    key: string;
  }> {
    return Array.from(
      el.querySelectorAll<HTMLElement>(
        ".work-foldout-live > .work-foldout-body",
      ),
    ).map((body, index) => ({
      body,
      key: body.dataset.workKey ?? `live:${index}`,
    }));
  }

  private liveWorkBodiesAreFollowing(el: HTMLElement, rememberIntent = false): boolean {
    return this.liveWorkBodies(el).every(({ body, key }) => {
      if (body.scrollHeight <= body.clientHeight + 1) return true;
      return (
        !this.pausedLiveWorkBodyKeys.has(key) &&
        (rememberIntent || isNearVisualScrollEnd(body, VISUAL_TAIL_FOLLOW_NEAR_PX))
      );
    });
  }

  private scrollLiveWorkBodiesToEnd(el: HTMLElement): void {
    for (const { body, key } of this.liveWorkBodies(el)) {
      if (this.pausedLiveWorkBodyKeys.has(key)) continue;
      scrollToEnd(body);
      this.observedLiveWorkBodies.set(body, metrics(body));
    }
  }

  private liveWorkDelta(el: HTMLElement): number | undefined {
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
          DOCUMENT_POSITION_FOLLOWING) !==
        0,
    );
    if (!precedingUser) return undefined;
    const viewport = el.getBoundingClientRect();
    const user = precedingUser.getBoundingClientRect();
    const work = liveWork.getBoundingClientRect();
    return liveWorkScrollDelta({
      viewportTop: viewport.top,
      viewportHeight: viewport.height,
      userHeight: user.height,
      userBottom: user.bottom,
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
    this.setPaused(memory.outerPaused);
    const pauseSeq = this.pauseSeq;
    const pendingRestore = { el, pauseSeq };
    this.pendingMemoryRestore = pendingRestore;
    this.afterPaint(() => {
      if (this.pendingMemoryRestore === pendingRestore) {
        this.pendingMemoryRestore = null;
      }
      if (this.el !== el || this.pauseSeq !== pauseSeq) return;
      const liveBodies = new Map(
        this.liveWorkBodies(el).map(({ key, body }) => [key, body]),
      );
      for (const saved of memory.liveWorkBodies) {
        const body = liveBodies.get(saved.key);
        if (!body) continue;
        if (saved.paused) {
          this.pausedLiveWorkBodyKeys.add(saved.key);
          body.scrollTop = saved.scrollTop;
        } else {
          this.pausedLiveWorkBodyKeys.delete(saved.key);
          scrollToEnd(body);
        }
        this.observedLiveWorkBodies.set(body, metrics(body));
      }
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
          this.recordProgrammaticScroll();
          this.syncActive(el);
          return;
        }
      }
      el.scrollTop = visualScrollTopFromMemory({ memory, next: metrics(el) });
      this.recordProgrammaticScroll();
      if (memory.followTail) this.scrollLiveWorkBodiesToEnd(el);
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
      if (this.el !== next || this.pauseSeq !== pauseSeq) return;
      const followTail = followedTail && this.canApplyFollow(pauseSeq);
      next.scrollTop = replacementVisualScrollTop({
        previous: previousMetrics,
        next: metrics(next),
        followTail,
      });
      this.recordProgrammaticScroll();
      this.syncActive(next);
      if (followTail) this.settleTailFollow(next);
    });
  }

  private settleTailFollow(el: HTMLElement): void {
    const pauseSeq = this.pauseSeq;
    this.scheduler.nextFrame(() => {
      if (this.el !== el || !this.canApplyFollow(pauseSeq)) return;
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
