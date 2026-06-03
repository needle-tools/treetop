/**
 * Classifies the `kind` of a `broadcast("change", { kind, … })` event so
 * the daemon only invalidates caches that actually depend on it.
 *
 * Before this split the broadcast handler invalidated repos/worktree caches
 * on EVERY non-`fs_change` event — including chatty
 * notifications (`sound_play`, `note_*`, `undo`/`redo`, `peerDiscovery`,
 * `command_*`, `message_*`, `session_invite_*`) that never touch repo or
 * agent state. With a live TUI writing JSONL those bursts blew the cache
 * many times per second, so every concurrent `/api/repos` call ran the
 * full git fan-out + `detectAgents` JSONL scan (~800 ms on big workspaces).
 *
 * The two sets are deliberately small and explicit; new kinds default to
 * "no invalidation" so a stray notification can't accidentally cost us
 * the cache. If a future kind needs invalidation, add it here and to the
 * matching UI gate in `packages/ui/src/sse-change-kinds.ts`.
 */

export const CHANGE_KINDS_INVALIDATING_REPOS: ReadonlySet<string> = new Set([
  // Repo-level mutations.
  "add_repo",
  "remove_repo",
  "rename_repo",
  "repo_color",
  "repo_summary",
  "repos_reorder",
  // Worktree-level mutations.
  "create_worktree",
  "remove_worktree",
  "pull",
  "push",
  "checkout_branch",
  // Custom links live on the repo record.
  "custom_link_add",
  "custom_link_remove",
  "custom_link_reorder",
  "custom_link_update",
  // Note: `fetch_complete` is intentionally NOT here. `git fetch` always
  // writes `.git/FETCH_HEAD` (and `refs/remotes/origin/*` when something
  // updated), which the worktree watcher catches and broadcasts as
  // `fs_change`. The fs_change-driven /api/repos call naturally refreshes
  // when the worktree-details cache for that path has been invalidated,
  // and stays a cheap cache hit otherwise. Invalidating the repos cache
  // every fetch — including the ~75% of visible-fetch cycles that
  // report "0/1 repos updated" — produced a regular 2-second CPU burst
  // pulse (rebuild + git fan-out across ~20 worktrees).
  // Titles surface as `agent.manualTitle` in the enriched repo response.
  "session_title",
  "session_title_migrate",
  // Session copy/import creates new JSONLs and the enrichment picks them up.
  "session_copied",
  "session_imported",
]);

export function changeKindInvalidatesRepos(kind: unknown): boolean {
  return typeof kind === "string" && CHANGE_KINDS_INVALIDATING_REPOS.has(kind);
}
