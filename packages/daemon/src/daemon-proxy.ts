/**
 * Pure routing helpers for the remote-daemon reverse proxy (Phase 4b).
 *
 * The local daemon exposes `/api/daemons/<id>/*` and forwards each request
 * over the SSH tunnel to the remote daemon's own `/api/...` surface at
 * `127.0.0.1:<localPort>`. Keeping the path-splitting + URL-building pure
 * and separate from server.ts makes them unit-testable without booting the
 * HTTP listener. See plans/PLAN-REMOTE-DAEMON.md.
 */

export interface DaemonProxyPath {
  /** The RemoteDaemon.id being addressed. */
  id: string;
  /** The remainder path to forward, always starting with "/". A bare
   *  `/api/daemons/<id>` (or with a trailing slash) forwards to "/". */
  rest: string;
}

const PREFIX = "/api/daemons/";

/**
 * Split `/api/daemons/<id>/<rest>` into `{ id, rest }`. Returns null when
 * the path is not a proxy path — including the collection route
 * `/api/daemons` (and `/api/daemons/`), which the CRUD handlers own and
 * the catch-all must not swallow.
 */
export function parseDaemonProxyPath(pathname: string): DaemonProxyPath | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const tail = pathname.slice(PREFIX.length); // "<id>" | "<id>/..." | ""
  if (tail.length === 0) return null; // "/api/daemons/" → collection, not proxy
  const slash = tail.indexOf("/");
  if (slash === -1) return { id: tail, rest: "/" }; // "/api/daemons/<id>"
  const id = tail.slice(0, slash);
  if (id.length === 0) return null;
  const rest = tail.slice(slash); // includes the leading "/"
  return { id, rest: rest === "" ? "/" : rest };
}

/**
 * Build the URL the proxy fetches: the tunnel's local loopback port plus
 * the remote daemon's `/api` prefix, the forwarded remainder, and the
 * original query string (passed verbatim, leading "?" included or empty).
 */
export function buildProxyTargetUrl(
  localPort: number,
  rest: string,
  search: string,
): string {
  return `http://127.0.0.1:${localPort}/api${rest}${search}`;
}
