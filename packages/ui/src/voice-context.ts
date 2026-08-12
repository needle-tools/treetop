export interface VoiceProjectInput {
  id: string;
  name: string;
  path: string;
  daemonId?: string;
  worktrees: Array<{
    path: string;
    branch: string;
    fileStatus?: {
      staged?: number;
      unstaged?: number;
      untracked?: number;
    };
  }>;
}

export interface VoiceSessionInput {
  source: string;
  agent: string;
  worktreePath: string;
  repoId: string;
  sessionId?: string;
  title?: string;
  lastActive?: string;
  working?: boolean;
  awaiting?: boolean;
  exited?: boolean;
}

export interface VoiceNoteInput {
  id: string;
  body: string;
  anchors: string[];
  tags?: string[];
  kind?: string;
  updatedAt?: string;
}

export interface TreetopVoiceContext {
  product: "Treetop";
  cwd: string;
  zenMode: { active: false } | { active: true; rowKey: string };
  activeProject?: {
    id: string;
    name: string;
    path: string;
    daemonId?: string;
    worktreePath: string;
    branch: string;
  };
  activeSession?: VoiceSessionInput;
  latestSession?: VoiceSessionInput;
  projects: Array<{
    id: string;
    name: string;
    path: string;
    daemonId?: string;
    worktrees: Array<{
      path: string;
      branch: string;
      staged: number;
      unstaged: number;
      untracked: number;
    }>;
  }>;
  sessions: VoiceSessionInput[];
  notes: Array<{
    id: string;
    excerpt: string;
    anchors: string[];
    tags: string[];
    kind: string;
    updatedAt?: string;
  }>;
}

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function excerpt(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 240);
}

export function deriveVoiceContext(input: {
  projects: VoiceProjectInput[];
  rows: Array<{ key: string; repoId: string; worktreePath?: string }>;
  zenRowKey: string | null;
  activeWorktreePath: string | null;
  lastActiveSessionSource: string | null;
  sessions: VoiceSessionInput[];
  notes?: VoiceNoteInput[];
}): TreetopVoiceContext {
  const zenRow = input.zenRowKey
    ? input.rows.find((row) => row.key === input.zenRowKey)
    : undefined;
  const activePath =
    zenRow?.worktreePath ?? input.activeWorktreePath ?? undefined;
  const activeProjectInput =
    (zenRow
      ? input.projects.find((project) => project.id === zenRow.repoId)
      : undefined) ??
    (activePath
      ? input.projects.find((project) =>
          project.worktrees.some((worktree) => worktree.path === activePath),
        )
      : undefined) ??
    input.projects[0];
  const activeWorktree =
    activeProjectInput?.worktrees.find(
      (worktree) => worktree.path === activePath,
    ) ?? activeProjectInput?.worktrees[0];
  const latestSession = [...input.sessions].sort(
    (a, b) => timestamp(b.lastActive) - timestamp(a.lastActive),
  )[0];
  const activeSession =
    input.sessions.find(
      (session) => session.source === input.lastActiveSessionSource,
    ) ??
    input.sessions
      .filter((session) => session.worktreePath === activeWorktree?.path)
      .sort((a, b) => timestamp(b.lastActive) - timestamp(a.lastActive))[0] ??
    latestSession;
  const localFallback = input.projects.find((project) => !project.daemonId);
  const cwdProject = activeProjectInput?.daemonId
    ? localFallback
    : activeProjectInput;
  const cwd =
    cwdProject?.worktrees.find((worktree) => worktree.path === activePath)
      ?.path ??
    cwdProject?.worktrees[0]?.path ??
    cwdProject?.path ??
    activeWorktree?.path ??
    activeProjectInput?.path ??
    "/";
  const activeAnchors = new Set(
    [
      activeProjectInput?.path ? `repo:${activeProjectInput.path}` : undefined,
      activeWorktree?.path ? `worktree:${activeWorktree.path}` : undefined,
    ].filter((anchor): anchor is string => !!anchor),
  );
  const notes = [...(input.notes ?? [])]
    .filter((note) => note.body.trim() || (note.tags?.length ?? 0) > 0)
    .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
    .sort((a, b) => {
      const aActive = a.anchors.some((anchor) => activeAnchors.has(anchor));
      const bActive = b.anchors.some((anchor) => activeAnchors.has(anchor));
      return Number(bActive) - Number(aActive);
    })
    .slice(0, 24)
    .map((note) => ({
      id: note.id,
      excerpt: excerpt(note.body),
      anchors: note.anchors,
      tags: note.tags ?? [],
      kind: note.kind ?? "note",
      ...(note.updatedAt ? { updatedAt: note.updatedAt } : {}),
    }));

  return {
    product: "Treetop",
    cwd,
    zenMode:
      input.zenRowKey === null
        ? { active: false }
        : { active: true, rowKey: input.zenRowKey },
    ...(activeProjectInput && activeWorktree
      ? {
          activeProject: {
            id: activeProjectInput.id,
            name: activeProjectInput.name,
            path: activeProjectInput.path,
            ...(activeProjectInput.daemonId
              ? { daemonId: activeProjectInput.daemonId }
              : {}),
            worktreePath: activeWorktree.path,
            branch: activeWorktree.branch,
          },
        }
      : {}),
    ...(activeSession ? { activeSession } : {}),
    ...(latestSession ? { latestSession } : {}),
    projects: input.projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      ...(project.daemonId ? { daemonId: project.daemonId } : {}),
      worktrees: project.worktrees.map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
        staged: worktree.fileStatus?.staged ?? 0,
        unstaged: worktree.fileStatus?.unstaged ?? 0,
        untracked: worktree.fileStatus?.untracked ?? 0,
      })),
    })),
    sessions: [...input.sessions]
      .sort((a, b) => timestamp(b.lastActive) - timestamp(a.lastActive))
      .slice(0, 30),
    notes,
  };
}
