/**
 * Gates the dashboard's reaction to `/api/stream` "change" events. The
 * daemon broadcasts a wide variety of kinds — `fs_change`, mutations,
 * notifications (sound_play, note_*, undo/redo, peerDiscovery,
 * command_*, message_*, session_invite_*) — and before this gate the
 * SSE handler unconditionally called `load()` (full `/api/repos` refresh)
 * AND `refreshEvents()` on every event. With a live TUI emitting
 * activity that storm could trigger `/api/repos` multiple times per
 * second, and each call cost 500–1000 ms scanning JSONLs + spawning
 * git per worktree.
 *
 * Keep this in sync with `packages/daemon/src/sse-change-kinds.ts` —
 * the daemon's cache-invalidation list and the UI's reload list cover
 * the same set of repo-affecting kinds.
 */

/** Kinds that change `/api/repos` enrichment (repo list, worktree state,
 *  enriched agent fields like `manualTitle`). */
export const CHANGE_KINDS_REQUIRING_REPOS_RELOAD: ReadonlySet<string> = new Set(
  [
    // File-watcher signal — worktree status / lastCommit may have changed.
    "fs_change",
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
    // Note: `fetch_complete` is intentionally NOT here. `git fetch` writes
    // .git/FETCH_HEAD and refs/remotes/origin/*, which the worktree watcher
    // sees and broadcasts as `fs_change` for each affected worktree —
    // that's the load() trigger we want. Reacting to both kinds caused
    // every visible-fetch tick to fire two redundant `/api/repos` streams.
    // Titles surface as `agent.manualTitle` in the enriched response.
    "session_title",
    "session_title_migrate",
    // Session copy/import creates new JSONLs.
    "session_copied",
    "session_imported",
  ],
);

/** Kinds that mutate the `/api/events` log. Notifications and
 *  file-watcher signals don't write to events.jsonl, so refetching for
 *  them is wasted work. */
export const CHANGE_KINDS_REQUIRING_EVENTS_RELOAD: ReadonlySet<string> =
  new Set([
    // Notes are events under the hood.
    "note_create",
    "note_update",
    "note_delete",
    // Undo / redo toggles re-broadcast as { kind: "undo" | "redo", eventId }.
    "undo",
    "redo",
    // Repo / worktree mutations all log an event.
    "add_repo",
    "remove_repo",
    "rename_repo",
    "repo_color",
    "create_worktree",
    "remove_worktree",
    "pull",
    "push",
    "checkout_branch",
    "custom_link_add",
    "custom_link_remove",
    "custom_link_reorder",
    "custom_link_update",
  ]);

export function changeKindRequiresReposReload(kind: unknown): boolean {
  return (
    typeof kind === "string" && CHANGE_KINDS_REQUIRING_REPOS_RELOAD.has(kind)
  );
}

export function changeKindRequiresEventsReload(kind: unknown): boolean {
  return (
    typeof kind === "string" && CHANGE_KINDS_REQUIRING_EVENTS_RELOAD.has(kind)
  );
}
