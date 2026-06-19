import type { FileStatus } from "./status-summary";

export type { FileStatus } from "./status-summary";

export interface BranchStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  aheadOldestTime: string | null;
  /** Commits reachable from HEAD but from no remote-tracking ref.
   *  Filled by the daemon only for branches with no upstream. */
  unpushed: number | null;
}

export interface LastCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  time: string;
}

export interface AgentSession {
  agent: "claude" | "codex" | "copilot" | "ollama" | "shell";
  cwd: string;
  lastActive: string;
  sessionId?: string;
  source: string;
  title?: string;
  lastUserMessage?: string;
  manualTitle?: string;
  aiTitle?: string;
  firstUserMessage?: string;
  lastUserMessages?: string[];
  userMessageCount?: number;
  messageCount?: number;
  recentMessageCount?: number;
  lastMessageTs?: string;
  contextTokens?: number;
  contextTokensExact?: boolean;
  contextWindow?: number;
  model?: string;
  importedFrom?: string;
  importedAt?: string;
}

export interface ShellRecord {
  termId: string;
  wt: string;
  spawnCwd: string;
  currentCwd?: string;
  createdAt: string;
  alive: boolean;
  cmdCount?: number;
  lastCmd?: string;
  lastCmdTs?: string;
  manualTitle?: string;
}

export interface ActivityEvent {
  agent: "claude" | "codex" | "copilot";
  cwd: string;
  sessionId: string;
  summary: string;
  timestamp: string;
  source: string;
}

export interface Worktree {
  path: string;
  branch: string;
  head: string;
  bare: boolean;
  detached: boolean;
  fileStatus: FileStatus;
  branchStatus: BranchStatus | null;
  lastCommit: LastCommit | null;
  agents?: AgentSession[];
  nonGit?: boolean;
}

export interface RemoteRef {
  name: string;
  url: string;
  webUrl: string | null;
  provider: string | null;
  host: string | null;
}

export type CommandRunMode = "internal" | "external" | "shell";

export type CustomLink =
  | { id: string; kind?: "url"; url: string; name?: string }
  | { id: string; kind: "file"; path: string; name?: string }
  | { id: string; kind: "folder"; path: string; name?: string }
  | {
      id: string;
      kind: "command";
      cmd: string;
      cwd?: string;
      runMode: CommandRunMode;
      name?: string;
    };

export interface Repo {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  /** Owning remote daemon; undefined means local. */
  daemonId?: string;
  /** Optional accent colour (#rrggbb). */
  color?: string;
  worktrees: Worktree[];
  remotes?: RemoteRef[];
  customLinks?: CustomLink[];
}

export type AddRepoResponse = Repo & { alreadyRegistered?: boolean };

export interface EditorDescriptor {
  name: string;
  cmd: string;
}

export interface WtCommit {
  sha: string;
  subject: string;
  author?: string;
  date?: string;
}

export interface NumstatEntry {
  added: number;
  removed: number;
  binary: boolean;
}

export interface WtSummary {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  unpushedCommits: WtCommit[];
  unfetchedCommits?: WtCommit[];
  stats?: Record<string, NumstatEntry>;
  stagedStats?: Record<string, NumstatEntry>;
  mtimes?: Record<string, number>;
}

export type WtSummaryState = WtSummary | "loading";

export interface DockWorktreeStatus {
  path: string;
  branch: string;
  ahead: number;
  aheadDanger?: boolean;
  behind: number;
  dirty: number;
  upstream: string | null;
  daemonId: string | undefined;
}

export interface DockEntry {
  source: string;
  wtPath: string;
  rowKey: string;
  repoId: string;
  agent: "claude" | "codex" | "copilot" | "ollama" | "shell";
  repoColor?: string;
  repoName: string;
  branch?: string;
  title?: string;
  manualTitle?: string;
  aiTitle?: string;
  lastUserMessage?: string;
  lastActive?: string;
  recentMessageCount?: number;
  lastMessageTs?: string;
  transcriptSource?: string;
  working: boolean;
  awaiting: boolean;
  exited: boolean;
  terminalActive: boolean;
  finishedAt?: number;
  ioDebugLabel?: string;
}

export interface DockRepoStatus {
  repoId: string;
  repoColor?: string;
  repoName: string;
  ahead: number;
  aheadDanger?: boolean;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  submoduleChanges?: number;
}

export type WorkspacePreviewSessionState =
  | "working"
  | "awaiting"
  | "idle"
  | "paused";

export interface WorkspacePreviewSession extends AgentSession {
  state: WorkspacePreviewSessionState;
  preview?: string;
  transcript?: WorkspacePreviewMessage[];
  claudeModel?: string;
  claudeEffort?: string;
}

export type WorkspacePreviewWorktreeOption = Pick<
  Worktree,
  "path" | "branch"
> &
  Partial<Pick<Worktree, "nonGit" | "detached" | "bare">>;

export interface WorkspacePreviewRow {
  key: string;
  folded?: boolean;
  repo: Pick<Repo, "id" | "name" | "path" | "color" | "daemonId">;
  worktree: Pick<
    Worktree,
    "path" | "branch" | "branchStatus" | "fileStatus" | "agents"
  > &
    Partial<Pick<Worktree, "nonGit" | "detached" | "bare">> & {
      branchChoices?: string[];
    };
  repoWorktrees?: WorkspacePreviewWorktreeOption[];
  summary?: WtSummary | WtSummaryState;
  sessions: WorkspacePreviewSession[];
}

export interface WorkspacePreviewBlock {
  type:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "media"
    | "ide_context"
    | "system_reminder"
    | "command"
    | "marker";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  tagName?: string;
  mediaKind?: "image" | "file" | "artifact";
  mimeType?: string;
  path?: string;
  url?: string;
  title?: string;
  alt?: string;
  hasAlpha?: boolean;
}

export interface WorkspacePreviewMessage {
  role: "user" | "assistant" | "system" | "tool";
  blocks: WorkspacePreviewBlock[];
  timestamp?: string;
  id?: string;
  author?: string;
}
