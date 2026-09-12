import {
  buildVisibleVisualWorkDisplayEntries,
  visualWorkOverview,
  type VisualTranscriptItem,
  type VisualWorkArtifact,
} from "./last-user-message";
import { normalizeArtifactPath, visualWorkArtifactChanges } from "./sparse-artifact-tree";

export const ARTIFACT_MAP_SOURCE_PREFIX = "__artifacts__:";

export function artifactMapPanelSource(ownerSource: string): string {
  return `${ARTIFACT_MAP_SOURCE_PREFIX}${encodeURIComponent(ownerSource)}`;
}

export function artifactMapOwnerSource(panelSource: string): string | undefined {
  if (!panelSource.startsWith(ARTIFACT_MAP_SOURCE_PREFIX)) return undefined;
  try {
    return decodeURIComponent(panelSource.slice(ARTIFACT_MAP_SOURCE_PREFIX.length));
  } catch {
    return undefined;
  }
}

export function insertArtifactMapPanel<
  T extends { agent: string; source: string },
>(
  sessions: readonly T[],
  ownerSource: string,
): { sessions: readonly T[]; inserted: boolean } {
  const source = artifactMapPanelSource(ownerSource);
  if (sessions.some((session) => session.source === source)) {
    return { sessions, inserted: false };
  }
  const ownerIndex = sessions.findIndex(
    (session) => session.source === ownerSource,
  );
  const next = [...sessions];
  next.splice(Math.max(0, ownerIndex), 0, { agent: "artifacts", source } as T);
  return { sessions: next, inserted: true };
}

export interface SessionArtifactTurn {
  turnNumber: number;
  startedAt?: string;
  endedAt?: string;
  artifacts: readonly VisualWorkArtifact[];
}

export interface SessionArtifactTotals {
  reads: number;
  references: number;
  partialReads: number;
  writes: number;
  partialWrites: number;
  additions: number;
  deletions: number;
}

export interface SessionArtifactEvolution {
  artifacts: readonly VisualWorkArtifact[];
  turns: readonly SessionArtifactTurn[];
  totals: SessionArtifactTotals;
}

export interface SessionArtifactRepeatedRange {
  range: string;
  reads: number;
  repeatedReads: number;
  turns: number[];
}

export interface SessionArtifactOverbookedFile {
  path: string;
  reads: number;
  repeatedReads: number;
  ranges: SessionArtifactRepeatedRange[];
}

export interface SessionArtifactOverbooking {
  repeatedReads: number;
  files: SessionArtifactOverbookedFile[];
  repeatedArtifacts: ReadonlySet<VisualWorkArtifact>;
  repeatedChanges: ReadonlyMap<VisualWorkArtifact, ReadonlySet<ReturnType<typeof visualWorkArtifactChanges>[number]>>;
}

export type SessionArtifactFilter = "all" | "reads" | "references" | "writes" | "partial-writes" | "repeated";
export type SessionArtifactScope = "consolidated" | "current";
type SessionArtifactChangeFilter = Exclude<SessionArtifactFilter, "all" | "repeated">;

export function sessionArtifactJuiceTransition(
  previous: SessionArtifactTotals | undefined,
  next: SessionArtifactTotals,
  enabled: boolean,
): { readImpact: boolean; writeImpact: boolean } {
  if (!enabled || !previous) return { readImpact: false, writeImpact: false };
  return {
    readImpact: next.reads > previous.reads,
    writeImpact:
      next.writes > previous.writes ||
      next.additions > previous.additions ||
      next.deletions > previous.deletions,
  };
}

export function sessionArtifactTurnWindow(
  turns: readonly SessionArtifactTurn[],
  limit: number,
): { turns: readonly SessionArtifactTurn[]; hiddenTurnCount: number } {
  const count = Math.max(1, Math.trunc(limit));
  const hiddenTurnCount = Math.max(0, turns.length - count);
  return {
    turns: hiddenTurnCount > 0 ? turns.slice(hiddenTurnCount) : turns,
    hiddenTurnCount,
  };
}

export function sessionArtifactTurnCounts(turn: SessionArtifactTurn): {
  reads: number;
  references: number;
  writes: number;
} {
  let reads = 0;
  let references = 0;
  let writes = 0;
  for (const artifact of turn.artifacts) {
    for (const change of visualWorkArtifactChanges(artifact)) {
      if (change.action === "used") reads += 1;
      else if (change.action === "referenced") references += 1;
      else if (change.action === "changed") writes += 1;
    }
  }
  return { reads, references, writes };
}

interface CachedWorkArtifacts {
  startedAt?: string;
  endedAt?: string;
  artifacts: readonly VisualWorkArtifact[];
}

function hasLineRange(value: string | undefined): boolean {
  return !!value && /:\d+(?:-\d+)?\b/.test(value);
}

function artifactReadRange(
  change: ReturnType<typeof visualWorkArtifactChanges>[number],
): string {
  for (const value of [change.path, change.label, change.title, change.previewTitle]) {
    const match = value?.match(/:(\d+(?:-\d+)?)\b/);
    if (match) return match[1]!;
  }
  return "whole file";
}

export function analyzeSessionArtifactOverbooking(
  turns: readonly SessionArtifactTurn[],
): SessionArtifactOverbooking {
  const cached = sessionArtifactOverbookingCache.get(turns as object);
  if (cached) return cached;
  const files = new Map<string, {
    path: string;
    reads: number;
    repeatedReads: number;
    ranges: Map<string, { range: string; reads: number; repeatedReads: number; turns: number[]; lastTurn?: number }>;
  }>();
  const repeatedArtifacts = new Set<VisualWorkArtifact>();
  const repeatedChanges = new Map<VisualWorkArtifact, Set<ReturnType<typeof visualWorkArtifactChanges>[number]>>();
  let repeatedReads = 0;

  for (const turn of turns) {
    for (const artifact of turn.artifacts) {
      for (const change of visualWorkArtifactChanges(artifact)) {
        const path = normalizeArtifactPath(change.path ?? artifact.path);
        if (!path) continue;
        let file = files.get(path);
        if (!file) {
          file = { path, reads: 0, repeatedReads: 0, ranges: new Map() };
          files.set(path, file);
        }
        if (change.action !== "used") continue;
        const range = artifactReadRange(change);
        let rangeState = file.ranges.get(range);
        if (!rangeState) {
          rangeState = { range, reads: 0, repeatedReads: 0, turns: [] };
          file.ranges.set(range, rangeState);
        }
        file.reads += 1;
        rangeState.reads += 1;
        if (rangeState.turns.at(-1) !== turn.turnNumber) rangeState.turns.push(turn.turnNumber);
        if (rangeState.lastTurn !== undefined && rangeState.lastTurn !== turn.turnNumber) {
          repeatedReads += 1;
          file.repeatedReads += 1;
          rangeState.repeatedReads += 1;
          repeatedArtifacts.add(artifact);
          const artifactChanges = repeatedChanges.get(artifact) ?? new Set();
          artifactChanges.add(change);
          repeatedChanges.set(artifact, artifactChanges);
        }
        rangeState.lastTurn = turn.turnNumber;
      }
    }
  }

  const result: SessionArtifactOverbooking = {
    repeatedReads,
    repeatedArtifacts,
    repeatedChanges,
    files: [...files.values()]
      .filter((file) => file.repeatedReads > 0)
      .map((file) => ({
        path: file.path,
        reads: file.reads,
        repeatedReads: file.repeatedReads,
        ranges: [...file.ranges.values()].map(({ lastTurn: _turn, ...range }) => range),
      }))
      .sort((a, b) => b.repeatedReads - a.repeatedReads || a.path.localeCompare(b.path)),
  };
  sessionArtifactOverbookingCache.set(turns as object, result);
  return result;
}

const sessionArtifactOverbookingCache = new WeakMap<object, SessionArtifactOverbooking>();

function addArtifactTotals(
  totals: SessionArtifactTotals,
  artifact: VisualWorkArtifact,
): void {
  for (const change of visualWorkArtifactChanges(artifact)) {
    if (change.action === "referenced") {
      totals.references += 1;
      continue;
    }
    if (change.action === "used") {
      totals.reads += 1;
      if (
        hasLineRange(change.label) ||
        hasLineRange(change.title) ||
        hasLineRange(change.previewTitle)
      ) {
        totals.partialReads += 1;
      }
      continue;
    }
    if (change.action !== "changed") continue;
    totals.writes += 1;
    totals.additions += change.additions ?? 0;
    totals.deletions += change.deletions ?? 0;
    if (change.fileAction === "edited") totals.partialWrites += 1;
  }
}

export function scopeSessionArtifactEvolution(
  evolution: SessionArtifactEvolution,
  scope: SessionArtifactScope,
): SessionArtifactEvolution {
  if (scope === "consolidated") return evolution;
  const turn = evolution.turns.at(-1);
  const totals: SessionArtifactTotals = {
    reads: 0,
    references: 0,
    partialReads: 0,
    writes: 0,
    partialWrites: 0,
    additions: 0,
    deletions: 0,
  };
  if (!turn) return { artifacts: [], turns: [], totals };
  for (const artifact of turn.artifacts) addArtifactTotals(totals, artifact);
  return { artifacts: turn.artifacts, turns: [turn], totals };
}

const filteredSessionArtifactCache = new WeakMap<
  object,
  Partial<Record<SessionArtifactChangeFilter, VisualWorkArtifact | null>>
>();

function filterSessionArtifact(
  artifact: VisualWorkArtifact,
  filter: SessionArtifactChangeFilter,
): VisualWorkArtifact | null {
  let cached = filteredSessionArtifactCache.get(artifact as object);
  if (cached && filter in cached) return cached[filter] ?? null;
  if (!cached) {
    cached = {};
    filteredSessionArtifactCache.set(artifact as object, cached);
  }
  const changes = visualWorkArtifactChanges(artifact).filter(
    (change) =>
      filter === "reads"
        ? change.action === "used"
        : filter === "references"
          ? change.action === "referenced"
        : filter === "partial-writes"
          ? change.action === "changed" && change.fileAction === "edited"
          : change.action === "changed",
  );
  const result = changes.length > 0
    ? {
        ...artifact,
        action: changes[0]!.action,
        additions: undefined,
        deletions: undefined,
        diff: undefined,
        preview: undefined,
        previewTitle: undefined,
        diffKind: undefined,
        fileAction: undefined,
        contentTokenCount: undefined,
        contentTokenCountEstimated: undefined,
        contentLineCount: undefined,
        contentLineCountEstimated: undefined,
        changes,
      }
    : null;
  cached[filter] = result;
  return result;
}

function filterSessionArtifacts(
  artifacts: readonly VisualWorkArtifact[],
  filter: SessionArtifactChangeFilter,
): VisualWorkArtifact[] {
  return artifacts
    .map((artifact) => filterSessionArtifact(artifact, filter))
    .filter((artifact): artifact is VisualWorkArtifact => artifact !== null);
}

export function filterSessionArtifactEvolution(
  evolution: SessionArtifactEvolution,
  filter: SessionArtifactFilter,
): SessionArtifactEvolution {
  if (filter === "all") return evolution;
  const overbooking = filter === "repeated"
    ? analyzeSessionArtifactOverbooking(evolution.turns)
    : undefined;
  const turns = evolution.turns.flatMap((turn) => {
    const artifacts = filter === "repeated"
      ? turn.artifacts.flatMap((artifact) => {
          const changes = overbooking!.repeatedChanges.get(artifact);
          return changes?.size
            ? [{ ...artifact, action: "used" as const, changes: [...changes] }]
            : [];
        })
      : filterSessionArtifacts(turn.artifacts, filter);
    return artifacts.length > 0 ? [{ ...turn, artifacts }] : [];
  });
  const artifacts = turns.flatMap((turn) => turn.artifacts);
  const totals: SessionArtifactTotals = {
    reads: 0,
    references: 0,
    partialReads: 0,
    writes: 0,
    partialWrites: 0,
    additions: 0,
    deletions: 0,
  };
  for (const artifact of artifacts) addArtifactTotals(totals, artifact);
  return { artifacts, turns, totals };
}

export function createSessionArtifactEvolutionTracker(): {
  update(items: readonly VisualTranscriptItem[]): SessionArtifactEvolution;
} {
  const workCache = new WeakMap<object, CachedWorkArtifacts>();
  const processedItems: VisualTranscriptItem[] = [];
  let previousInput: readonly VisualTranscriptItem[] | undefined;
  const checkpoints: Array<{
    turnNumber: number;
    artifactCount: number;
    turnCount: number;
    lastTurnArtifactCount: number;
    lastTurnStartedAt?: string;
    lastTurnEndedAt?: string;
    totals: SessionArtifactTotals;
  }> = [];
  const artifacts: VisualWorkArtifact[] = [];
  const turns: Array<{
    turnNumber: number;
    startedAt?: string;
    endedAt?: string;
    artifacts: VisualWorkArtifact[];
    revision: number;
  }> = [];
  const totals: SessionArtifactTotals = {
    reads: 0,
    references: 0,
    partialReads: 0,
    writes: 0,
    partialWrites: 0,
    additions: 0,
    deletions: 0,
  };
  let turnNumber = 0;
  let turnRevision = 0;
  let evolution: SessionArtifactEvolution = {
    artifacts: [],
    turns: [],
    totals: { ...totals },
  };
  const publishedTurns = new Map<
    number,
    {
      revision: number;
      value: SessionArtifactTurn;
    }
  >();

  function commonItemPrefix(items: readonly VisualTranscriptItem[]): number {
    const previousLength = processedItems.length;
    const nextLength = items.length;
    if (previousLength === 0 || nextLength === 0) return 0;
    if (items === previousInput) return previousLength;
    if (
      nextLength > previousLength &&
      items[0] === processedItems[0] &&
      items[previousLength - 1] === processedItems[previousLength - 1]
    ) {
      return previousLength;
    }
    if (
      nextLength < previousLength &&
      items[0] === processedItems[0] &&
      items[nextLength - 1] === processedItems[nextLength - 1]
    ) {
      return nextLength;
    }
    const max = Math.min(previousLength, nextLength);
    if (
      max > 1 &&
      items[max - 1] !== processedItems[max - 1] &&
      items[0] === processedItems[0] &&
      items[max - 2] === processedItems[max - 2]
    ) {
      return max - 1;
    }
    let prefix = 0;
    while (prefix < max && items[prefix] === processedItems[prefix]) prefix += 1;
    return prefix;
  }

  function restoreCheckpoint(index: number): boolean {
    const previousArtifactCount = artifacts.length;
    const checkpoint = checkpoints[index];
    if (!checkpoint) {
      turnNumber = 0;
      artifacts.length = 0;
      turns.length = 0;
      Object.assign(totals, {
        reads: 0,
        references: 0,
        partialReads: 0,
        writes: 0,
        partialWrites: 0,
        additions: 0,
        deletions: 0,
      });
      return previousArtifactCount !== 0;
    }
    turnNumber = checkpoint.turnNumber;
    artifacts.length = checkpoint.artifactCount;
    turns.length = checkpoint.turnCount;
    const lastTurn = turns.at(-1);
    if (lastTurn) {
      const changed =
        lastTurn.artifacts.length !== checkpoint.lastTurnArtifactCount ||
        lastTurn.startedAt !== checkpoint.lastTurnStartedAt ||
        lastTurn.endedAt !== checkpoint.lastTurnEndedAt;
      lastTurn.artifacts.length = checkpoint.lastTurnArtifactCount;
      lastTurn.startedAt = checkpoint.lastTurnStartedAt;
      lastTurn.endedAt = checkpoint.lastTurnEndedAt;
      if (changed) lastTurn.revision = ++turnRevision;
    }
    Object.assign(totals, checkpoint.totals);
    return artifacts.length !== previousArtifactCount;
  }

  function checkpoint(): (typeof checkpoints)[number] {
    const lastTurn = turns.at(-1);
    return {
      turnNumber,
      artifactCount: artifacts.length,
      turnCount: turns.length,
      lastTurnArtifactCount: lastTurn?.artifacts.length ?? 0,
      lastTurnStartedAt: lastTurn?.startedAt,
      lastTurnEndedAt: lastTurn?.endedAt,
      totals: { ...totals },
    };
  }

  function publish(): SessionArtifactEvolution {
    const nextTurns = turns.map((turn) => {
      const cached = publishedTurns.get(turn.turnNumber);
      if (cached?.revision === turn.revision) {
        return cached.value;
      }
      const value: SessionArtifactTurn = {
        turnNumber: turn.turnNumber,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        artifacts: [...turn.artifacts],
      };
      publishedTurns.set(turn.turnNumber, {
        revision: turn.revision,
        value,
      });
      return value;
    });
    evolution = {
      artifacts: [...artifacts],
      turns: nextTurns,
      totals: { ...totals },
    };
    return evolution;
  }

  return {
    update(items) {
      const prefix = commonItemPrefix(items);
      let artifactsChanged = false;
      if (prefix < processedItems.length) {
        artifactsChanged = restoreCheckpoint(prefix);
      }
      checkpoints.length = prefix;
      processedItems.length = prefix;

      for (let index = prefix; index < items.length; index += 1) {
        const item = items[index]!;
        checkpoints.push(checkpoint());
        processedItems.push(item);
        if (item.kind === "message" && item.message.role === "user") {
          turnNumber += 1;
          continue;
        }
        if (item.kind !== "work") continue;
        const cached = workCache.get(item as object);
        const work =
          cached ??
          (() => {
            const entries = buildVisibleVisualWorkDisplayEntries(item);
            const overview = visualWorkOverview(item, entries, {
              timeScope: "entries",
            });
            const next = {
              startedAt: item.startedAt,
              endedAt: item.endedAt,
              artifacts: overview.artifacts,
            } satisfies CachedWorkArtifacts;
            workCache.set(item as object, next);
            return next;
          })();
        if (work.artifacts.length === 0) continue;
        artifactsChanged = true;

        const resolvedTurnNumber = Math.max(1, turnNumber);
        const existing = turns.at(-1)?.turnNumber === resolvedTurnNumber
          ? turns.at(-1)
          : undefined;
        if (existing) {
          existing.artifacts.push(...work.artifacts);
          existing.startedAt ??= work.startedAt;
          if (work.endedAt) existing.endedAt = work.endedAt;
          existing.revision = ++turnRevision;
        } else {
          turns.push({
            turnNumber: resolvedTurnNumber,
            startedAt: work.startedAt,
            endedAt: work.endedAt,
            artifacts: [...work.artifacts],
            revision: ++turnRevision,
          });
        }
        artifacts.push(...work.artifacts);
        for (const artifact of work.artifacts) addArtifactTotals(totals, artifact);
      }
      if (!artifactsChanged) {
        previousInput = items;
        return evolution;
      }
      previousInput = items;
      return publish();
    },
  };
}
