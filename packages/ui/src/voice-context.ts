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
  transcriptSource?: string;
  title?: string;
  lastUserMessage?: string;
  lastUserMessages?: string[];
  messageCount?: number;
  recentMessageCount?: number;
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
  recentCompletions: Array<{
    source: string;
    sessionId?: string;
    transcriptSource?: string;
    title?: string;
    agent: string;
    repoId: string;
    worktreePath: string;
    finishedAt: string;
  }>;
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
  finishedAt?: Record<string, number | undefined>;
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
  const sessionBySource = new Map(
    input.sessions.map((session) => [session.source, session]),
  );
  const recentCompletions = Object.entries(input.finishedAt ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([source, finishedAt]) => {
      const session = sessionBySource.get(source);
      return session
        ? {
            source,
            ...(session.sessionId ? { sessionId: session.sessionId } : {}),
            ...(session.transcriptSource
              ? { transcriptSource: session.transcriptSource }
              : {}),
            ...(session.title ? { title: session.title } : {}),
            agent: session.agent,
            repoId: session.repoId,
            worktreePath: session.worktreePath,
            finishedAt: new Date(finishedAt).toISOString(),
          }
        : undefined;
    })
    .filter(
      (
        completion,
      ): completion is {
        source: string;
        sessionId?: string;
        transcriptSource?: string;
        title?: string;
        agent: string;
        repoId: string;
        worktreePath: string;
        finishedAt: string;
      } => !!completion,
    )
    .sort((a, b) => timestamp(b.finishedAt) - timestamp(a.finishedAt))
    .slice(0, 12);

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
    recentCompletions,
    notes,
  };
}

export type VoiceStickerMove =
  | { kind: "move"; stickerId: string; anchors: string[] }
  | { kind: "attach"; stickerId: string; targetNoteId: string };

export type VoiceNoteMove =
  | { kind: "move"; noteId: string; anchors: string[] }
  | { kind: "attach"; noteId: string; targetNoteId: string };

function cleanVoiceString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function voiceAreaAnchor(value: string): string | null {
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");
  if (
    normalized === "top" ||
    normalized === "toparea" ||
    normalized === "global" ||
    normalized === "workspace" ||
    normalized === "voice" ||
    normalized === "home"
  ) {
    return "workspace:voice";
  }
  return null;
}

function voiceMoveAnchors(
  args: Record<string, unknown>,
  defaultAnchor: string,
): string[] {
  const anchors = Array.isArray(args.anchors)
    ? args.anchors
        .map((anchor) => cleanVoiceString(anchor))
        .map((anchor) => voiceAreaAnchor(anchor) ?? anchor)
        .filter((anchor) => anchor.length > 0)
    : [];
  if (anchors.length > 0) return anchors;

  const area = cleanVoiceString(args.area);
  const areaAnchor = area ? voiceAreaAnchor(area) : null;
  if (areaAnchor) return [areaAnchor];

  const destination = cleanVoiceString(args.destination);
  const destinationAnchor = destination ? voiceAreaAnchor(destination) : null;
  if (destinationAnchor) return [destinationAnchor];

  const singleAnchor = cleanVoiceString(args.anchor);
  if (singleAnchor) return [voiceAreaAnchor(singleAnchor) ?? singleAnchor];

  return [defaultAnchor];
}

export function resolveVoiceNoteMove(
  args: Record<string, unknown>,
  notes: readonly Pick<VoiceNoteInput, "id" | "kind">[],
  defaultAnchor: string,
): VoiceNoteMove {
  const noteId = cleanVoiceString(args.id);
  if (!noteId) throw new Error("id must be a non-empty string");
  const note = notes.find((candidate) => candidate.id === noteId);
  if (!note) throw new Error("Note not found");

  const targetNoteId = cleanVoiceString(args.attachToNoteId);
  if (targetNoteId) {
    if (targetNoteId === noteId) {
      throw new Error("note cannot attach to itself");
    }
    if (note.kind !== "emoji") {
      throw new Error("Only stickers can attach to a note");
    }
    if (!notes.some((candidate) => candidate.id === targetNoteId)) {
      throw new Error("Target note not found");
    }
    return { kind: "attach", noteId, targetNoteId };
  }

  return {
    kind: "move",
    noteId,
    anchors: voiceMoveAnchors(args, defaultAnchor),
  };
}

export function resolveVoiceStickerMove(
  args: Record<string, unknown>,
  notes: readonly Pick<VoiceNoteInput, "id" | "kind">[],
  defaultAnchor: string,
): VoiceStickerMove {
  const move = resolveVoiceNoteMove(args, notes, defaultAnchor);
  const sticker = notes.find((note) => note.id === move.noteId);
  if (!sticker || sticker.kind !== "emoji") throw new Error("Sticker not found");
  return move.kind === "attach"
    ? {
        kind: "attach",
        stickerId: move.noteId,
        targetNoteId: move.targetNoteId,
      }
    : { kind: "move", stickerId: move.noteId, anchors: move.anchors };
}

export function resolveVoiceSessionTarget(
  context: TreetopVoiceContext,
  requested?: string,
): VoiceSessionInput {
  const value = requested?.trim();
  if (value) {
    const lower = value.toLowerCase();
    const target = context.sessions.find(
      (session) =>
        session.source === value ||
        session.sessionId === value ||
        session.title?.toLowerCase() === lower,
    );
    if (!target) throw new Error("Session not found");
    return target;
  }
  const target = context.activeSession ?? context.latestSession;
  if (!target) throw new Error("No session is available");
  return target;
}

export function resolveVoiceSessionMessageTarget(
  context: TreetopVoiceContext,
  requestedSource?: string,
): VoiceSessionInput {
  const target = resolveVoiceSessionTarget(context, requestedSource);
  if (!target.sessionId) throw new Error("Session cannot be resumed");
  return target;
}
