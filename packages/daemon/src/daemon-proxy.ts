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

/**
 * Forward a request to a remote daemon at `127.0.0.1:<localPort>` (the
 * local end of its ssh -L tunnel) and return a Response that streams the
 * upstream body straight back. Extracted from the route handler so it can
 * be tested against a real in-process remote (Tier 2 — see
 * daemon-proxy-forward.test.ts) without booting the full daemon.
 *
 * - Method, headers, and (for non-GET/HEAD) the body are forwarded.
 * - The Host header is dropped — it's the local daemon's host, meaningless
 *   to the remote and a DNS-rebinding signal we don't want to relay.
 * - The upstream status + headers pass through, plus the caller's CORS
 *   headers (so the browser, talking same-origin to the local daemon,
 *   still gets them).
 * - A failed fetch (tunnel/remote down) becomes a 502 with a JSON error,
 *   distinct from a real upstream 404/5xx which passes through verbatim.
 */
export async function forwardToRemote(
  localPort: number,
  proxied: DaemonProxyPath,
  req: Request,
  search: string,
  cors: Record<string, string>,
): Promise<Response> {
  const target = buildProxyTargetUrl(localPort, proxied.rest, search);
  const fwdHeaders = new Headers(req.headers);
  fwdHeaders.delete("host");
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: fwdHeaders,
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      // @ts-expect-error Bun supports duplex for streaming request bodies
      duplex: "half",
    });
    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) respHeaders.set(k, v);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: `remote daemon unreachable: ${String(
          e instanceof Error ? e.message : e,
        )}`,
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...cors },
      },
    );
  }
}
