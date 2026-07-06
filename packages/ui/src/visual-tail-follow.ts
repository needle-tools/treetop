export const VISUAL_TAIL_FOLLOW_NEAR_PX = 64;

export interface VisualScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
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
