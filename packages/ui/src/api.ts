/**
 * Daemon URL routing for the UI.
 *
 * Every fetch / EventSource / WebSocket the UI makes goes to either:
 *  - the LOCAL daemon (same-origin `/api/...`, the default), or
 *  - a REMOTE daemon, reverse-proxied by the local daemon at
 *    `/api/daemons/<id>/...` (Phase 4b — a remote box as a folder row).
 *
 * Callers pass the SAME `/api/...` path they always used plus an optional
 * `daemonId`. With no daemonId the path is returned byte-for-byte
 * unchanged, so routing the existing call sites through apiUrl() is a pure
 * no-op for local requests. See plans/PLAN-REMOTE-DAEMON.md.
 */

/**
 * Resolve an `/api/...` path for a given daemon. Local (no id) → unchanged;
 * remote → `/api/daemons/<id>/...`. Only the leading `/api` segment is
 * rewritten, so query values that contain `/api` are left intact.
 */
export function apiUrl(path: string, daemonId?: string | null): string {
  if (!daemonId) return path;
  return path.replace(/^\/api/, `/api/daemons/${daemonId}`);
}

/**
 * Build an absolute ws:// (or wss://) URL for a daemon path. Mirrors
 * apiUrl()'s local-vs-remote routing but also carries the host + protocol
 * (WebSocket needs an absolute URL). `proto` is `location.protocol`-style
 * ("ws:"/"wss:"); host is `location.host`.
 */
export function apiWsUrl(
  path: string,
  host: string,
  wsProto: string,
  daemonId?: string | null,
): string {
  return `${wsProto}//${host}${apiUrl(path, daemonId)}`;
}
