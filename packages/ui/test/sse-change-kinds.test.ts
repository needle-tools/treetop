/**
 * Pins which `/api/stream` "change" payloads trigger the dashboard's
 * `load()` (full `/api/repos` refresh) and `refreshEvents()`. Adding a
 * new kind to the daemon's broadcast vocabulary should fail this test
 * until the gate is updated.
 */

import { test, expect, describe } from "bun:test";
import {
  changeKindRequiresEventsReload,
  changeKindRequiresReposReload,
} from "../src/sse-change-kinds";

describe("change-kind UI gating", () => {
  test("repo-affecting kinds trigger /api/repos reload", () => {
    for (const kind of [
      "fs_change",
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
      expect(changeKindRequiresReposReload(kind)).toBe(true);
    }
  });

  test("notification kinds do NOT trigger /api/repos reload", () => {
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
      // `fetch_complete` is covered by the subsequent `fs_change` for the
      // refs/FETCH_HEAD writes — load() runs through that path, not here.
      "fetch_complete",
    ]) {
      expect(changeKindRequiresReposReload(kind)).toBe(false);
    }
  });

  test("mutation kinds trigger /api/events reload", () => {
    for (const kind of [
      "note_create",
      "note_update",
      "note_delete",
      "undo",
      "redo",
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
    ]) {
      expect(changeKindRequiresEventsReload(kind)).toBe(true);
    }
  });

  test("notification + file-watcher kinds do NOT trigger /api/events reload", () => {
    for (const kind of [
      "fs_change",
      "sound_play",
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
      "fetch_complete",
      "repo_summary",
      "session_title",
      "session_title_migrate",
      "session_copied",
      "session_imported",
    ]) {
      expect(changeKindRequiresEventsReload(kind)).toBe(false);
    }
  });

  test("non-string kinds are ignored", () => {
    expect(changeKindRequiresReposReload(undefined)).toBe(false);
    expect(changeKindRequiresReposReload(null)).toBe(false);
    expect(changeKindRequiresReposReload(42)).toBe(false);
    expect(changeKindRequiresEventsReload(undefined)).toBe(false);
    expect(changeKindRequiresEventsReload(null)).toBe(false);
  });
});
