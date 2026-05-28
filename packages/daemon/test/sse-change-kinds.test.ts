/**
 * Pins which `broadcast("change", { kind })` payloads invalidate the
 * daemon-side caches. The previous behavior (invalidate on every
 * non-`fs_change` kind) made the dashboard hammer `/api/repos` because
 * notification kinds — `sound_play`, `note_*`, `undo`/`redo`,
 * `peerDiscovery`, `command_*`, `message_*`, `session_invite_*` — kept
 * blowing the cache every few hundred ms.
 */

import { test, expect, describe } from "bun:test";
import {
  changeKindInvalidatesAgents,
  changeKindInvalidatesRepos,
} from "../src/sse-change-kinds";

describe("change-kind cache gating", () => {
  test("repo mutations invalidate repos cache", () => {
    for (const kind of [
      "add_repo",
      "remove_repo",
      "rename_repo",
      "repo_color",
      "repo_summary",
      "create_worktree",
      "remove_worktree",
      "pull",
      "push",
      "checkout_branch",
      "custom_link_add",
      "custom_link_remove",
      "custom_link_reorder",
      "custom_link_update",
      "session_title",
      "session_title_migrate",
      "session_copied",
      "session_imported",
    ]) {
      expect(changeKindInvalidatesRepos(kind)).toBe(true);
    }
  });

  test("notification kinds do NOT invalidate repos cache", () => {
    for (const kind of [
      "sound_play",
      "note_create",
      "note_update",
      "note_delete",
      "undo",
      "redo",
      "peerDiscovery",
      "command_start",
      "command_exit",
      "command_url",
      "message_received",
      "message_mute",
      "message_unmute",
      "message_deleted",
      "session_invite_received",
      "session_invite_declined",
      "fs_change",
      // fetch_complete is intentionally NOT invalidating — the fs_change
      // from .git/FETCH_HEAD covers the refresh, and invalidating every
      // visible-fetch cycle (~once per 2 s on a 20-repo workspace)
      // produced an audible CPU pulse.
      "fetch_complete",
    ]) {
      expect(changeKindInvalidatesRepos(kind)).toBe(false);
    }
  });

  test("only session_copied / session_imported invalidate agents cache", () => {
    expect(changeKindInvalidatesAgents("session_copied")).toBe(true);
    expect(changeKindInvalidatesAgents("session_imported")).toBe(true);

    for (const kind of [
      "add_repo",
      "remove_repo",
      "rename_repo",
      "repo_color",
      "create_worktree",
      "pull",
      "push",
      "checkout_branch",
      "fetch_complete",
      "fs_change",
      "sound_play",
      "note_create",
      "session_title",
      "undo",
      "redo",
    ]) {
      expect(changeKindInvalidatesAgents(kind)).toBe(false);
    }
  });

  test("non-string kinds are ignored", () => {
    expect(changeKindInvalidatesRepos(undefined)).toBe(false);
    expect(changeKindInvalidatesRepos(null)).toBe(false);
    expect(changeKindInvalidatesRepos(42)).toBe(false);
    expect(changeKindInvalidatesAgents(undefined)).toBe(false);
    expect(changeKindInvalidatesAgents(null)).toBe(false);
  });
});
