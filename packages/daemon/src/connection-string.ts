/**
 * Remote-daemon "connection string" — the one-paste onboarding token.
 *
 * The whole point: after `install.sh` runs on the box, it prints ONE
 * opaque string. The user pastes it into the local UI's "Add remote
 * daemon" dialog and everything is configured — host, ssh user/port,
 * daemon port, AND the private key — with no manual key-file juggling and
 * without the secret ever touching the browser's form fields or the
 * clipboard as separate pieces.
 *
 * Format: `supergit1:<base64url(JSON)>` where JSON is a `ConnectionPayload`.
 * The version prefix lets the decoder reject anything that isn't ours (or
 * a future incompatible format) with a clear error instead of a confusing
 * JSON-parse failure. base64url (no `+`/`/`/`=`) so the token is a single
 * word that survives copy/paste, shells, and URLs unmangled.
 *
 * This is encoding, NOT encryption — the token carries a private key in
 * cleartext-after-decode, exactly like handing someone a `.pem`. It is a
 * secret; treat it like one (the key is forward-only + port-restricted by
 * the installer, so its blast radius is just "tunnel to that daemon", but
 * still: don't paste it in public). Decoding happens in the LOCAL daemon
 * (server-side), which writes the key to `<workspace>/keys/` at 0600 — the
 * browser only ever sends the opaque string, never sees the stored key.
 *
 * Pure module (encode/decode/validate) so the contract is unit-tested with
 * no filesystem or network. `server.ts` calls `decodeConnectionString`,
 * persists the key, and registers via `workspace.addRemoteDaemon`.
 */

export const CONNECTION_STRING_PREFIX = "supergit1:";

/** Everything needed to stand up a remote-daemon row from one token. */
export interface ConnectionPayload {
  /** SSH host (hostname or IP) of the remote box. */
  host: string;
  /** Remote supergit daemon's loopback port (the `-L` target). */
  port: number;
  /** SSH user (the installer's forward-only user, e.g. "supergit"). */
  user?: string;
  /** SSH port; omit ⇒ 22. */
  sshPort?: number;
  /** The forward-only private key, PEM text. */
  privateKey?: string;
  /** Suggested row label; omit ⇒ caller defaults to host. */
  label?: string;
}

/** base64url encode/decode without `Buffer` assumptions that differ across
 *  runtimes — uses the standard btoa/atob available in Bun + browsers,
 *  then swaps to the URL-safe alphabet and strips padding. */
function toBase64Url(s: string): string {
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  // atob tolerates missing padding in Bun, but pad anyway for portability.
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return decodeURIComponent(escape(atob(padded)));
}

/** Encode a payload into a single connection string. Throws on a missing
 *  host (the one irreducible field) so a caller can't mint a useless token. */
export function encodeConnectionString(payload: ConnectionPayload): string {
  if (!payload.host || payload.host.trim() === "") {
    throw new Error("connection string requires a host");
  }
  // Drop blank optionals so the token is compact and the decoded object
  // doesn't carry empty strings the registry would have to special-case.
  const clean: ConnectionPayload = { host: payload.host.trim(), port: payload.port };
  if (payload.user?.trim()) clean.user = payload.user.trim();
  if (payload.sshPort != null) clean.sshPort = payload.sshPort;
  if (payload.privateKey?.trim()) clean.privateKey = payload.privateKey;
  if (payload.label?.trim()) clean.label = payload.label.trim();
  return CONNECTION_STRING_PREFIX + toBase64Url(JSON.stringify(clean));
}

export type DecodeResult =
  | { ok: true; payload: ConnectionPayload }
  | { ok: false; error: string };

/** Decode + validate a connection string. Never throws — returns a result
 *  so the route can surface a clean error to the dialog. Validates the
 *  version prefix, the base64/JSON, and the required fields, mirroring the
 *  daemon's `addRemoteDaemon` contract (host required; port defaults 7777). */
export function decodeConnectionString(input: string): DecodeResult {
  const raw = input.trim();
  if (!raw.startsWith(CONNECTION_STRING_PREFIX)) {
    return {
      ok: false,
      error: `not a supergit connection string (must start with "${CONNECTION_STRING_PREFIX}")`,
    };
  }
  const body = raw.slice(CONNECTION_STRING_PREFIX.length);
  let json: string;
  try {
    json = fromBase64Url(body);
  } catch {
    return { ok: false, error: "connection string is not valid base64" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "connection string payload is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "connection string payload must be an object" };
  }
  const o = parsed as Record<string, unknown>;
  const host = typeof o.host === "string" ? o.host.trim() : "";
  if (host === "") {
    return { ok: false, error: "connection string is missing a host" };
  }
  const payload: ConnectionPayload = {
    host,
    port: typeof o.port === "number" ? o.port : 7777,
  };
  if (typeof o.user === "string" && o.user.trim()) payload.user = o.user.trim();
  if (typeof o.sshPort === "number") payload.sshPort = o.sshPort;
  if (typeof o.privateKey === "string" && o.privateKey.trim()) {
    payload.privateKey = o.privateKey;
  }
  if (typeof o.label === "string" && o.label.trim()) payload.label = o.label.trim();
  return { ok: true, payload };
}
