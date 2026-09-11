import {
  buildVisibleVisualWorkDisplayEntries,
  visualWorkOverview,
  type VisualTranscriptItem,
  type VisualWorkArtifact,
} from "./last-user-message";
import { visualWorkArtifactChanges } from "./sparse-artifact-tree";

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

export type SessionArtifactFilter = "all" | "reads" | "writes";

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
  writes: number;
} {
  let reads = 0;
  let writes = 0;
  for (const artifact of turn.artifacts) {
    for (const change of visualWorkArtifactChanges(artifact)) {
      if (change.action === "used") reads += 1;
      else writes += 1;
    }
  }
  return { reads, writes };
}

interface CachedWorkArtifacts {
  startedAt?: string;
  endedAt?: string;
  artifacts: readonly VisualWorkArtifact[];
}

function hasLineRange(value: string | undefined): boolean {
  return !!value && /:\d+(?:-\d+)?\b/.test(value);
}

function addArtifactTotals(
  totals: SessionArtifactTotals,
  artifact: VisualWorkArtifact,
): void {
  for (const change of visualWorkArtifactChanges(artifact)) {
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
    totals.writes += 1;
    totals.additions += change.additions ?? 0;
    totals.deletions += change.deletions ?? 0;
    if (change.fileAction === "edited") totals.partialWrites += 1;
  }
}

const filteredSessionArtifactCache = new WeakMap<
  object,
  Partial<Record<"reads" | "writes", VisualWorkArtifact | null>>
>();

function filterSessionArtifact(
  artifact: VisualWorkArtifact,
  filter: Exclude<SessionArtifactFilter, "all">,
): VisualWorkArtifact | null {
  let cached = filteredSessionArtifactCache.get(artifact as object);
  if (cached && filter in cached) return cached[filter] ?? null;
  if (!cached) {
    cached = {};
    filteredSessionArtifactCache.set(artifact as object, cached);
  }
  const wantRead = filter === "reads";
  const changes = visualWorkArtifactChanges(artifact).filter(
    (change) => (change.action === "used") === wantRead,
  );
  const result = changes.length > 0
    ? { ...artifact, action: changes[0]!.action, changes }
    : null;
  cached[filter] = result;
  return result;
}

function filterSessionArtifacts(
  artifacts: readonly VisualWorkArtifact[],
  filter: Exclude<SessionArtifactFilter, "all">,
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
  const turns = evolution.turns.flatMap((turn) => {
    const artifacts = filterSessionArtifacts(turn.artifacts, filter);
    return artifacts.length > 0 ? [{ ...turn, artifacts }] : [];
  });
  const artifacts = turns.flatMap((turn) => turn.artifacts);
  const totals: SessionArtifactTotals = {
    reads: 0,
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
