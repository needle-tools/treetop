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

export function createSessionArtifactEvolutionTracker(): {
  update(items: readonly VisualTranscriptItem[]): SessionArtifactEvolution;
} {
  const workCache = new WeakMap<object, CachedWorkArtifacts>();

  return {
    update(items) {
      const turns = new Map<number, SessionArtifactTurn>();
      const artifacts: VisualWorkArtifact[] = [];
      const totals: SessionArtifactTotals = {
        reads: 0,
        partialReads: 0,
        writes: 0,
        partialWrites: 0,
        additions: 0,
        deletions: 0,
      };
      let turnNumber = 0;

      for (const item of items) {
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

        const resolvedTurnNumber = Math.max(1, turnNumber);
        const existing = turns.get(resolvedTurnNumber);
        if (existing) {
          existing.artifacts = [...existing.artifacts, ...work.artifacts];
          existing.startedAt ??= work.startedAt;
          if (work.endedAt) existing.endedAt = work.endedAt;
        } else {
          turns.set(resolvedTurnNumber, {
            turnNumber: resolvedTurnNumber,
            startedAt: work.startedAt,
            endedAt: work.endedAt,
            artifacts: work.artifacts,
          });
        }
        artifacts.push(...work.artifacts);
        for (const artifact of work.artifacts) addArtifactTotals(totals, artifact);
      }

      return { artifacts, turns: [...turns.values()], totals };
    },
  };
}
