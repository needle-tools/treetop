export const VISUAL_TAIL_FOLLOW_NEAR_PX = 64;
export const VISUAL_TAIL_FOLLOW_RESUME_PX = 4;

/** Keep live zen work high enough to remain a status surface while reserving
 *  room above it for the end of the user turn that started the work. */
export function zenLiveWorkScrollDelta(input: {
  viewportTop: number;
  viewportHeight: number;
  userHeight: number;
  workTop: number;
}): number {
  const userContextHeight = Math.min(
    Math.max(input.userHeight, 64),
    input.viewportHeight * 0.35,
  );
  return input.workTop - (input.viewportTop + userContextHeight);
}

export interface VisualScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export interface VisualScrollMemory extends VisualScrollMetrics {
  followTail: boolean;
  anchorKey?: string;
  anchorOffsetTop?: number;
}

export interface VisualScrollAnchorCandidate {
  key: string;
  top: number;
  bottom: number;
  depth?: number;
}

export interface VisualScrollIndexCandidate {
  index: number;
  top: number;
  bottom: number;
}

/** Selects the semantic row occupying the middle of a scroll viewport. */
export function selectVisualScrollIndex(opts: {
  viewportTop: number;
  viewportBottom: number;
  candidates: readonly VisualScrollIndexCandidate[];
}): number | undefined {
  const focus = (opts.viewportTop + opts.viewportBottom) / 2;
  let selected: VisualScrollIndexCandidate | undefined;
  let selectedDistance = Number.POSITIVE_INFINITY;
  for (const candidate of opts.candidates) {
    const distance =
      focus < candidate.top
        ? candidate.top - focus
        : focus > candidate.bottom
          ? focus - candidate.bottom
          : 0;
    if (distance >= selectedDistance) continue;
    selected = candidate;
    selectedDistance = distance;
    if (distance === 0) break;
  }
  return selected?.index;
}

export function selectVisualScrollAnchor(opts: {
  viewportTop: number;
  viewportBottom: number;
  candidates: readonly VisualScrollAnchorCandidate[];
}): { key: string; offsetTop: number } | undefined {
  const visible = opts.candidates.filter(
    (candidate) =>
      candidate.bottom >= opts.viewportTop &&
      candidate.top <= opts.viewportBottom,
  );
  visible.sort((a, b) => {
    const depthDelta = (b.depth ?? 0) - (a.depth ?? 0);
    if (depthDelta !== 0) return depthDelta;
    return (
      Math.abs(a.top - opts.viewportTop) - Math.abs(b.top - opts.viewportTop)
    );
  });
  const selected = visible[0];
  return selected
    ? { key: selected.key, offsetTop: selected.top - opts.viewportTop }
    : undefined;
}

export function isNearVisualScrollEnd(
  metrics: VisualScrollMetrics,
  nearPx = VISUAL_TAIL_FOLLOW_NEAR_PX,
): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= nearPx
  );
}

export function isAtVisualScrollEnd(
  metrics: VisualScrollMetrics,
  endPx = VISUAL_TAIL_FOLLOW_RESUME_PX,
): boolean {
  return isNearVisualScrollEnd(metrics, endPx);
}

export function shouldPauseVisualTailAfterUserScroll(opts: {
  metrics: VisualScrollMetrics;
  endPx?: number;
}): boolean {
  return !isAtVisualScrollEnd(opts.metrics, opts.endPx);
}

export function isVisualTailFollowActive(opts: {
  metrics: VisualScrollMetrics;
  paused: boolean;
  nearPx?: number;
}): boolean {
  return !opts.paused && isNearVisualScrollEnd(opts.metrics, opts.nearPx);
}

export function shouldFollowVisualTail(opts: {
  force?: boolean;
  firstRender?: boolean;
  paused: boolean;
  nearEnd: boolean;
  restoredMemory?: VisualScrollMemory;
  selecting?: boolean;
}): boolean {
  if (opts.selecting) return false;
  if (
    opts.firstRender === true &&
    opts.restoredMemory &&
    !opts.restoredMemory.followTail
  ) {
    return opts.force === true;
  }
  return (
    opts.force === true ||
    opts.firstRender === true ||
    (!opts.paused && opts.nearEnd)
  );
}

export function shouldFollowLiveWorkBody(opts: {
  parentShouldStick: boolean;
  bodyPaused?: boolean;
}): boolean {
  return opts.parentShouldStick && opts.bodyPaused !== true;
}

export function canRequestOlderTranscriptMessages(opts: {
  minMessages: number;
  maxMessages: number;
  loadedMessages: number;
  totalMessageCount?: number;
}): boolean {
  if (opts.minMessages >= opts.maxMessages) return false;
  if (
    opts.totalMessageCount !== undefined &&
    opts.totalMessageCount > 0 &&
    opts.loadedMessages >= opts.totalMessageCount
  ) {
    return false;
  }
  return true;
}

export function shouldPrefetchOlderVisualHistory(opts: {
  scrollTop: number;
  clientHeight: number;
  hasMore: boolean;
  requestInFlight: boolean;
}): boolean {
  if (!opts.hasMore || opts.requestInFlight) return false;
  const threshold = Math.max(600, opts.clientHeight * 2.5);
  return opts.scrollTop <= threshold;
}

export function replacementVisualScrollTop(opts: {
  previous: VisualScrollMetrics;
  next: VisualScrollMetrics;
  followTail: boolean;
}): number {
  const max = Math.max(0, opts.next.scrollHeight - opts.next.clientHeight);
  if (opts.followTail) return max;
  return Math.min(max, Math.max(0, opts.previous.scrollTop));
}

export function visualScrollMemoryFromMetrics(opts: {
  metrics: VisualScrollMetrics;
  paused: boolean;
  nearPx?: number;
  anchorKey?: string;
  anchorOffsetTop?: number;
}): VisualScrollMemory {
  return {
    ...opts.metrics,
    followTail:
      !opts.paused && isNearVisualScrollEnd(opts.metrics, opts.nearPx),
    anchorKey: opts.anchorKey,
    anchorOffsetTop: opts.anchorOffsetTop,
  };
}

export function shouldRememberVisualScrollMemory(opts: {
  layoutUsable: boolean;
  metrics: VisualScrollMetrics;
  previous?: VisualScrollMemory;
}): boolean {
  if (
    opts.previous &&
    !opts.previous.followTail &&
    opts.previous.scrollTop > 0 &&
    opts.metrics.scrollTop === 0
  ) {
    return false;
  }
  return (
    opts.layoutUsable &&
    opts.metrics.clientHeight > 0 &&
    opts.metrics.scrollHeight > 0
  );
}

export function visualScrollTopFromMemory(opts: {
  memory: VisualScrollMemory;
  next: VisualScrollMetrics;
}): number {
  return replacementVisualScrollTop({
    previous: opts.memory,
    next: opts.next,
    followTail: opts.memory.followTail,
  });
}
