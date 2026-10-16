import { estimateModelTokenCost, type SessionTokenUsageSegment, type ModelsDevPricingSnapshot } from "./model-pricing.js";
import type { VisualWorkOverview } from "./work-overview.js";

/** Compact, source-owned usage. Child IDs describe descendants, not additional usage. */
export interface SessionAgentUsage {
  startedAt?: string;
  complete?: boolean;
  segments: readonly SessionTokenUsageSegment[];
  childIds: readonly string[];
}

export function sessionAgentUsageFromMessages(messages: readonly {
  timestamp?: string; model?: string; tokenUsage?: SessionTokenUsageSegment["usage"];
  blocks: readonly { subagentId?: string; subagentIsParent?: boolean }[];
}[]): SessionAgentUsage {
  const childIds = new Set<string>();
  const segments: SessionTokenUsageSegment[] = [];
  for (const message of messages) {
    if (message.tokenUsage) segments.push({ usage: message.tokenUsage, at: message.timestamp, model: message.model });
    for (const block of message.blocks) if (block.subagentId && !block.subagentIsParent) childIds.add(block.subagentId);
  }
  return { segments, childIds: [...childIds] };
}

export interface VisualUsageScope {
  ownTokens: number;
  childTokens: number;
  ownCost: number;
  childCost: number;
  childCount: number;
  missingIds: string[];
}

// Child snapshots are immutable. Price each checkpoint once, and locate a replay
// window by binary search rather than repricing/scanning a child's whole lifetime
// on every streaming message or clock tick.
const preparedUsage = new WeakMap<SessionAgentUsage, Map<ModelsDevPricingSnapshot | undefined, {
  rows: { at: number; segment: SessionTokenUsageSegment; price: ReturnType<typeof estimateModelTokenCost> }[];
  invalidTimestamp: boolean;
}>>();
function childUsageWindow(data: SessionAgentUsage, start: number, end: number, through: number, modelsDev?: ModelsDevPricingSnapshot) {
  let snapshots = preparedUsage.get(data);
  if (!snapshots) preparedUsage.set(data, snapshots = new Map());
  let prepared = snapshots.get(modelsDev);
  if (!prepared) {
    const rows = data.segments.map(segment => ({ at: Date.parse(segment.at ?? ""), segment, price: estimateModelTokenCost(segment.usage, segment.model, segment.at, { modelsDev, standardOnly: segment.standardOnly }) }));
    prepared = { rows: rows.filter(row => Number.isFinite(row.at)).sort((a, b) => a.at - b.at), invalidTimestamp: rows.some(row => !Number.isFinite(row.at)) };
    if (snapshots.size >= 2) snapshots.clear();
    snapshots.set(modelsDev, prepared);
  }
  const bound = (time: number, inclusive: boolean) => {
    let lo = 0, hi = prepared.rows.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (prepared.rows[mid]!.at < time || (inclusive && prepared.rows[mid]!.at === time)) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const lo = bound(Math.max(start, data.startedAt ? Date.parse(data.startedAt) : -Infinity), false);
  const hi = Math.min(bound(end, false), bound(through, true));
  return { rows: prepared.rows, lo, hi, invalidTimestamp: prepared.invalidTimestamp };
}

/** Half-open parent-round window; each descendant is counted once, even through cycles. */
export function visualWorkWithSubagentUsage(
  own: VisualWorkOverview,
  options: {
    childIds: readonly string[];
    usage: ReadonlyMap<string, SessionAgentUsage>;
    start: string | undefined;
    end?: string;
    through?: string;
    parentId?: string;
    modelsDev?: ModelsDevPricingSnapshot;
  },
): VisualWorkOverview {
  if (!options.childIds.length) return own;
  const start = Date.parse(options.start ?? "");
  const end = options.end ? Date.parse(options.end) : Infinity;
  const through = options.through ? Date.parse(options.through) : Infinity;
  const tokens = { ...own.tokens };
  const cost = { ...own.cost, models: [...own.cost.models], sources: [...own.cost.sources] };
  const seen = new Set(options.parentId ? [options.parentId] : []);
  const missing = new Set<string>();
  let childCount = 0;
  for (const queue = [...options.childIds]; queue.length;) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const data = options.usage.get(id);
    if (!data) { missing.add(id); continue; }
    if (data.startedAt && Date.parse(data.startedAt) >= end) continue;
    childCount += 1;
    if (data.complete === false) missing.add(id);
    queue.push(...data.childIds);
    const window = childUsageWindow(data, start, end, through, options.modelsDev);
    if (!Number.isFinite(start) || window.invalidTimestamp) missing.add(id);
    if (!Number.isFinite(start)) continue;
    for (let i = window.lo; i < window.hi; i++) {
      const { segment, price: priced } = window.rows[i]!;
      const usage = segment.usage;
      const fresh = Math.max(0, usage.input - usage.cachedInput);
      tokens.input += usage.input;
      tokens.cachedInput += usage.cachedInput;
      tokens.cacheWriteInput += usage.cacheWriteInput;
      tokens.freshInput += fresh;
      tokens.output += usage.output;
      tokens.reasoningOutput += usage.reasoningOutput;
      tokens.generatedOutput += usage.output;
      tokens.reportedTotal += usage.total;
      tokens.total += fresh + usage.output;
      tokens.agent += fresh + usage.output;
      if (!priced) { cost.unpricedCheckpoints += 1; continue; }
      cost.totalUsd += priced.totalUsd;
      cost.pricedCheckpoints += 1;
      if (priced.longContext) cost.longContextCheckpoints += 1;
      if (!cost.models.includes(priced.model)) cost.models.push(priced.model);
      if (!cost.sources.includes(priced.source)) cost.sources.push(priced.source);
    }
  }
  tokens.perSecond = own.time.elapsedMs > 0 ? tokens.output / (own.time.elapsedMs / 1000) : 0;
  tokens.agentPerSecond = own.time.elapsedMs > 0 ? tokens.agent / (own.time.elapsedMs / 1000) : 0;
  return { ...own, tokens, cost, usageScope: {
    ownTokens: own.tokens.total, childTokens: tokens.total - own.tokens.total,
    ownCost: own.cost.totalUsd, childCost: cost.totalUsd - own.cost.totalUsd,
    childCount, missingIds: [...missing],
  } };
}
