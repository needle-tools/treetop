/**
 * Pure validation + normalization for the "Add remote daemon" dialog
 * (remote-daemon Phase C). Mirrors the daemon-side contract in
 * `packages/daemon/src/workspace.ts` `addRemoteDaemon()`:
 *
 *   - `host` is the only required field; empty ⇒ rejected.
 *   - `label` defaults to `host` when blank.
 *   - `port` defaults to 7777 (the daemon's `DEFAULT_REMOTE_DAEMON_PORT`).
 *   - `user`, `sshPort`, `identityPath`, `color` are optional; blank ⇒
 *     omitted entirely (so the server stores nothing and ssh falls back
 *     to its own defaults — agent key, port 22, config user).
 *
 * Kept pure + separate from the .svelte dialog so the contract is
 * unit-tested without mounting a component (there's no DOM test stack —
 * see terminal-view-mount.test.ts). The dialog calls `normalizeDaemonForm`
 * on submit and only POSTs when `ok` is true. The daemon re-validates, so
 * this is UX (inline errors), not the security boundary.
 */

export const DEFAULT_REMOTE_DAEMON_PORT = 7777;
export const DEFAULT_SSH_PORT = 22;

/** Raw form field values, all strings (straight from <input>). */
export interface DaemonFormFields {
  label: string;
  host: string;
  user: string;
  port: string;
  sshPort: string;
  identityPath: string;
  color: string;
}

/** The POST body shape (matches daemon `RemoteDaemonInput`). Optional
 *  fields are omitted when blank rather than sent empty. */
export interface DaemonFormPayload {
  label: string;
  host: string;
  user?: string;
  port?: number;
  sshPort?: number;
  identityPath?: string;
  color?: string;
}

export type DaemonFormResult =
  | { ok: true; payload: DaemonFormPayload }
  | { ok: false; errors: Partial<Record<keyof DaemonFormFields, string>> };

/** Empty form (dialog initial state). */
export function emptyDaemonForm(): DaemonFormFields {
  return {
    label: "",
    host: "",
    user: "",
    port: "",
    sshPort: "",
    identityPath: "",
    color: "",
  };
}

/** Parse a port string. Returns the number, `null` for blank (⇒ use the
 *  default / omit), or `NaN`-signalling `undefined`-with-error via the
 *  caller. Valid range is 1–65535. */
function parsePort(raw: string): { value: number | null; error?: string } {
  const s = raw.trim();
  if (s === "") return { value: null };
  if (!/^\d+$/.test(s)) return { value: null, error: "must be a number" };
  const n = Number(s);
  if (n < 1 || n > 65535) return { value: null, error: "must be 1–65535" };
  return { value: n };
}

/** A #rgb or #rrggbb hex color, else null. Blank is allowed (no color). */
function isHexColor(s: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s);
}

/**
 * Validate + normalize the form. On success returns the POST payload with
 * blank optionals omitted and defaults applied (label←host, port←7777).
 * On failure returns per-field error messages for inline display.
 */
export function normalizeDaemonForm(fields: DaemonFormFields): DaemonFormResult {
  const errors: Partial<Record<keyof DaemonFormFields, string>> = {};

  const host = fields.host.trim();
  if (host === "") errors.host = "host is required";

  const port = parsePort(fields.port);
  if (port.error) errors.port = port.error;

  const sshPort = parsePort(fields.sshPort);
  if (sshPort.error) errors.sshPort = sshPort.error;

  const color = fields.color.trim();
  if (color !== "" && !isHexColor(color)) {
    errors.color = "must be #rgb or #rrggbb";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const label = fields.label.trim() || host;
  const payload: DaemonFormPayload = { label, host };
  if (port.value != null) payload.port = port.value;
  if (sshPort.value != null) payload.sshPort = sshPort.value;
  const user = fields.user.trim();
  if (user !== "") payload.user = user;
  const identityPath = fields.identityPath.trim();
  if (identityPath !== "") payload.identityPath = identityPath;
  if (color !== "") payload.color = color;

  return { ok: true, payload };
}

// ── Provision form ("provision a fresh box over SSH") ────────────────────
// The provision flow takes the box's ADMIN ssh details (host/user/sshPort),
// ships the bundled source, and runs the installer — which mints the
// forward-only key + prints the token we register. So this form is a SUBSET
// of the manual one: no daemon port / identity / color (the installer
// produces those), just where to ssh in + an optional label. host is
// required; sshPort optional-numeric. Matches POST /api/daemons/provision.

export interface ProvisionFormFields {
  host: string;
  user: string;
  sshPort: string;
  label: string;
  /** Target OS: "" / "posix" (Linux/macOS, the default) or "windows".
   *  Windows boxes need cmd/PowerShell remote commands + install.ps1. */
  os: string;
}

export interface ProvisionFormPayload {
  host: string;
  user?: string;
  sshPort?: number;
  label?: string;
  /** Only sent for Windows; absent ⇒ the daemon defaults to posix. */
  os?: "windows";
}

export type ProvisionFormResult =
  | { ok: true; payload: ProvisionFormPayload }
  | { ok: false; errors: Partial<Record<keyof ProvisionFormFields, string>> };

export function emptyProvisionForm(): ProvisionFormFields {
  return { host: "", user: "", sshPort: "", label: "", os: "" };
}

export function normalizeProvisionForm(
  fields: ProvisionFormFields,
): ProvisionFormResult {
  const errors: Partial<Record<keyof ProvisionFormFields, string>> = {};

  const host = fields.host.trim();
  if (host === "") errors.host = "host is required";

  const sshPort = parsePort(fields.sshPort);
  if (sshPort.error) errors.sshPort = sshPort.error;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const payload: ProvisionFormPayload = { host };
  const user = fields.user.trim();
  if (user !== "") {
    payload.user = user;
  } else if (fields.os !== "windows") {
    // install.sh requires root. With a blank user, ssh falls back to the
    // operator's LOCAL username (e.g. "marcel@box") which a fresh box rejects
    // ("Permission denied (publickey,password)"). Default POSIX provisioning
    // to root; Windows has no universal admin name, so leave it to the form.
    payload.user = "root";
  }
  if (sshPort.value != null) payload.sshPort = sshPort.value;
  const label = fields.label.trim();
  if (label !== "") payload.label = label;
  // Only Windows needs to be carried — posix is the daemon's default, so we
  // keep the payload clean (an empty/"posix" selection sends nothing).
  if (fields.os === "windows") payload.os = "windows";

  return { ok: true, payload };
}
