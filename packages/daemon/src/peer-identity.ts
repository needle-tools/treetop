/**
 * Stable `(id, label)` pair that identifies this daemon on the LAN.
 * - `id` is a uuid generated on first run, persisted under
 *   `<workspace>/peer-identity.json`, never regenerated. Other peers
 *   key their dedupe map on it — regenerating would make us look
 *   like a new daemon every restart.
 * - `label` is the human-friendly name shown in the Share dialog and
 *   in receiver inbox cards. Defaults to `<username>@<hostname>`,
 *   user-editable via PATCH /api/identity.
 */

import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const FILE = "peer-identity.json";

export interface PeerIdentity {
  id: string;
  label: string;
}

export interface LoadOpts {
  /** Used only when the on-disk file is missing or unparseable —
   *  never overrides an existing label. Caller derives this from
   *  `<username>@<hostname>` so a brand-new daemon already shows up
   *  with a recognisable name before the user touches anything. */
  defaultLabel: string;
}

/** Read the identity from `<workspace>/peer-identity.json`. If the
 *  file is missing or partially corrupt, repair what we can and write
 *  the result back. The id is preserved across calls — only the
 *  default label is consulted when fields are missing. */
export async function loadOrCreatePeerIdentity(
  workspaceDir: string,
  opts: LoadOpts,
): Promise<PeerIdentity> {
  const path = join(workspaceDir, FILE);
  let parsed: Partial<PeerIdentity> = {};
  try {
    parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<PeerIdentity>;
  } catch {
    // Missing or malformed — fall through to create-from-defaults.
  }
  const id =
    typeof parsed.id === "string" && parsed.id.length > 0
      ? parsed.id
      : randomUUID();
  const label =
    typeof parsed.label === "string" && parsed.label.trim().length > 0
      ? parsed.label
      : opts.defaultLabel;
  const identity: PeerIdentity = { id, label };
  // Always rewrite so a malformed / partial file gets repaired.
  await writeFile(path, JSON.stringify(identity, null, 2));
  return identity;
}

/** Rename this daemon. Trims whitespace and rejects an empty result —
 *  mDNS advertises `label`, so a blank value would silently confuse
 *  peer discovery. */
export async function setPeerLabel(
  workspaceDir: string,
  label: string,
): Promise<PeerIdentity> {
  const trimmed = label.trim();
  if (!trimmed) throw new Error("label must not be empty");
  const path = join(workspaceDir, FILE);
  let parsed: Partial<PeerIdentity> = {};
  try {
    parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<PeerIdentity>;
  } catch {
    // No prior file — caller is expected to have called
    // loadOrCreatePeerIdentity first, but be lenient.
  }
  const id =
    typeof parsed.id === "string" && parsed.id.length > 0
      ? parsed.id
      : randomUUID();
  const identity: PeerIdentity = { id, label: trimmed };
  await writeFile(path, JSON.stringify(identity, null, 2));
  return identity;
}
