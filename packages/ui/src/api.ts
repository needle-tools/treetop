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
/** Start and apply terminal inventory independently of slower dashboard metadata. */
export function startTerminalBootstrap<Snapshot, Metadata>(
  readSnapshot: () => Promise<Snapshot>,
  applySnapshot: (snapshot: Snapshot) => void,
  loadMetadata: () => Promise<Metadata>,
) {
  const snapshot = readSnapshot().then((value) => {
    applySnapshot(value);
    return value;
  });
  const metadata = loadMetadata();
  return { snapshot, metadata };
}

export function apiUrl(path: string, daemonId?: string | null): string {
  if (!daemonId) return path;
  return path.replace(/^\/api/, `/api/daemons/${daemonId}`);
}

const terminalStopChannels = new Map<string, {socket:WebSocket;stop:()=>Promise<void>}>();
let stopRequestSequence = 0;
const terminalStopKey = (id:string,daemonId?:string) => `${daemonId ?? ""}\0${id}`;

/** Use the already-connected terminal transport for urgent controls. The
 * daemon advertises support, so older/remote daemons retain the HTTP path. */
export function attachTerminalStopChannel(socket: WebSocket, terminalId: string, daemonId?: string): () => void {
  const key = terminalStopKey(terminalId,daemonId);
  let pending: {id:string;resolve:()=>void;reject:(error:Error)=>void;promise:Promise<void>} | undefined;
  const channel = {socket,stop:()=>{
    if (pending) return pending.promise;
    let resolve!:()=>void,reject!:(error:Error)=>void;
    const promise=new Promise<void>((ok,fail)=>{resolve=ok;reject=fail;});
    pending={id:`stop-${++stopRequestSequence}`,resolve,reject,promise};
    try {socket.send(JSON.stringify({type:"stop",requestId:pending.id}));}
    catch(error){pending=undefined;reject(error instanceof Error?error:new Error(String(error)));}
    return promise;
  }};
  const onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let message:any;
    try {message=JSON.parse(event.data);} catch {return;}
    if (message?.type === "capabilities" && message.controls?.includes("stop")) terminalStopChannels.set(key,channel);
    if (message?.type === "exit") {
      pending?.resolve();pending=undefined;
      if(terminalStopChannels.get(key)===channel)terminalStopChannels.delete(key);
    }
    if (pending && message?.requestId === pending.id) {
      if(message.type==="stop-accepted"){pending.resolve();pending=undefined;}
      else if(message.type==="stop-error"){pending.reject(new Error(message.error ?? "Stop failed"));pending=undefined;}
    }
  };
  const detach = () => {
    if(terminalStopChannels.get(key)===channel)terminalStopChannels.delete(key);
    pending?.reject(new Error("Terminal connection closed before stop was confirmed; check the session before retrying"));
    pending=undefined;
    socket.removeEventListener("message",onMessage);
    socket.removeEventListener("close",detach);
    socket.removeEventListener("error",detach);
  };
  socket.addEventListener("message",onMessage);
  socket.addEventListener("close",detach);
  socket.addEventListener("error",detach);
  return detach;
}

/** Do not abort a queued stop after five seconds: aborting HTTP cannot undo
 * a stop already accepted by the daemon. Keep the attachment until a reply. */
export async function requestTerminalStop(terminalId: string, daemonId?: string, baseUrl = ""): Promise<void> {
  const channel=terminalStopChannels.get(terminalStopKey(terminalId,daemonId));
  if(channel?.socket.readyState===1){await channel.stop();return;}
  const response = await fetch(baseUrl + apiUrl(`/api/terminals/${encodeURIComponent(terminalId)}`, daemonId), {method:"DELETE"});
  if (response.ok || response.status === 404) return;
  const body = await response.json().catch(() => null);
  throw new Error(body?.error ?? `Stop failed (HTTP ${response.status})`);
}

export async function bindTerminalSessionOwner(terminalId: string, sessionId: string, daemonId?: string): Promise<void> {
  const response = await fetch(apiUrl(`/api/terminals/${encodeURIComponent(terminalId)}/owner`, daemonId), {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) throw new Error((await response.json()).error ?? `HTTP ${response.status}`);
}

/**
 * Bound an entire request operation, including response-body decoding. The
 * callback owns the signal so callers cannot accidentally clear the timeout
 * as soon as response headers arrive while a streamed body remains stuck.
 */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
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
