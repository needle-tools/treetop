export const VISUAL_TAIL_FOLLOW_NEAR_PX = 64;

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

export function isNearVisualScrollEnd(
  metrics: VisualScrollMetrics,
  nearPx = VISUAL_TAIL_FOLLOW_NEAR_PX,
): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= nearPx
  );
}

export function shouldFollowVisualTail(opts: {
  force?: boolean;
  firstRender?: boolean;
  paused: boolean;
  nearEnd: boolean;
  selecting?: boolean;
}): boolean {
  if (opts.selecting) return false;
  return (
    opts.force === true ||
    opts.firstRender === true ||
    (!opts.paused && opts.nearEnd)
  );
}

export function shouldFollowNewLiveWorkBody(opts: {
  previousShouldStick: boolean | undefined;
  parentShouldStick: boolean;
}): boolean {
  return opts.previousShouldStick ?? opts.parentShouldStick;
}

export function shouldAnchorLiveWorkTail(opts: {
  hasLiveWork: boolean;
  shouldStickMessages: boolean;
}): boolean {
  return opts.hasLiveWork && opts.shouldStickMessages;
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
