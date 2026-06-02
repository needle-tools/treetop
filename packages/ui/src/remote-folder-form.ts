/**
 * Pure validation for the "add a folder on a remote daemon" dialog (#3 in
 * plans/PLAN-REMOTE-DAEMON.md). The user picks a remote daemon and types a
 * path that exists ON THAT BOX; on submit the UI POSTs
 * `apiUrl("/api/repos", daemonId)` so the local daemon proxies the add to
 * the remote, which registers the repo against its own filesystem.
 *
 * This module is UX-only: the remote daemon re-validates the path against its
 * fs and answers 409 with a clear message if it's missing / not a git repo,
 * so all this does is stop an obviously-empty submit and catch a daemon id
 * that's gone stale (the daemon was removed while the dialog was open). The
 * path is NOT shape-checked — the box may be Linux (`/srv/x`) or Windows
 * (`C:\x`), and only the box knows what's valid.
 */

export interface RemoteFolderFields {
  /** The remote daemon to add the folder on. */
  daemonId: string;
  /** Path of the repo/folder ON the remote machine. */
  path: string;
}

export interface RemoteFolderPayload {
  daemonId: string;
  path: string;
}

export interface RemoteFolderValidation {
  /** Present only when the form is valid. */
  payload?: RemoteFolderPayload;
  errors: Partial<Record<keyof RemoteFolderFields, string>>;
}

export function emptyRemoteFolderForm(daemonId = ""): RemoteFolderFields {
  return { daemonId, path: "" };
}

export function validateRemoteFolderForm(
  fields: RemoteFolderFields,
  availableDaemonIds: string[],
): RemoteFolderValidation {
  const errors: Partial<Record<keyof RemoteFolderFields, string>> = {};
  const daemonId = fields.daemonId.trim();
  const path = fields.path.trim();

  if (!daemonId) {
    errors.daemonId = "Choose a daemon";
  } else if (!availableDaemonIds.includes(daemonId)) {
    errors.daemonId = "That daemon is no longer connected";
  }
  if (!path) {
    errors.path = "Enter a path on the remote machine";
  }

  if (Object.keys(errors).length > 0) return { errors };
  return { payload: { daemonId, path }, errors: {} };
}
