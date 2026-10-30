import { test, expect, describe } from "bun:test";
import { apiUrl, apiWsUrl, withRequestDeadline, requestTerminalStop, attachTerminalStopChannel, startTerminalBootstrap } from "../src/api";

test("terminal inventory is applied before unrelated startup metadata completes", async () => {
  const order:string[]=[];
  let releaseSnapshot!:(value:string[])=>void, releaseMetadata!:(value:string)=>void;
  const bootstrap=startTerminalBootstrap(
    ()=>{order.push("inventory-request");return new Promise<string[]>(resolve=>{releaseSnapshot=resolve;});},
    value=>{order.push(`attached:${value[0]}`);},
    ()=>{order.push("metadata-request");return new Promise<string>(resolve=>{releaseMetadata=resolve;});},
  );
  expect(order).toEqual(["inventory-request","metadata-request"]);
  releaseSnapshot(["live-terminal"]);
  await bootstrap.snapshot;
  expect(order).toEqual(["inventory-request","metadata-request","attached:live-terminal"]);
  releaseMetadata("events");expect(await bootstrap.metadata).toBe("events");
});

test("stop uses an acknowledged live terminal socket instead of the HTTP request queue", async () => {
  let httpStops = 0, socketStops = 0;
  const server = Bun.serve({hostname:"127.0.0.1",port:0,
    fetch(request,server) {
      if (server.upgrade(request)) return;
      httpStops++;return Response.json({ok:true});
    },
    websocket:{open(socket){socket.send(JSON.stringify({type:"capabilities",controls:["stop"]}));},
      message(socket,raw){const message=JSON.parse(String(raw));expect(message.type).toBe("stop");socketStops++;
        socket.send(JSON.stringify({type:"stop-accepted",requestId:message.requestId}));}},
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/io`);
  const detach = attachTerminalStopChannel(socket,"socket-session");
  try {
    await new Promise<void>((resolve,reject)=>{socket.addEventListener("message",()=>resolve(),{once:true});socket.addEventListener("error",reject,{once:true});});
    await requestTerminalStop("socket-session",undefined,server.url.origin);
    expect(socketStops).toBe(1);
    expect(httpStops).toBe(0);
  } finally {detach();socket.close();server.stop(true);}
});

test("an unconfirmed socket stop reports a close event without sending a duplicate HTTP stop", async () => {
  let httpStops=0;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){httpStops++;return Response.json({ok:true});}});
  // Exercise the browser close-event contract directly. Bun 1.3.14 on Windows
  // can omit this event after a same-process test server terminates a socket.
  class ClosingSocket extends EventTarget {
    readyState=1;
    send() {this.readyState=3;queueMicrotask(()=>this.dispatchEvent(new Event("close")));}
  }
  const socket=new ClosingSocket() as unknown as WebSocket;
  const detach=attachTerminalStopChannel(socket,"unconfirmed","remote");
  try {
    socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"capabilities",controls:["stop"]})}));
    await expect(requestTerminalStop("unconfirmed","remote",server.url.origin)).rejects.toThrow("before stop was confirmed");
    expect(httpStops).toBe(0);
  } finally {detach();server.stop(true);}
});

test("session stop waits past five seconds for confirmation and accepts an already stopped terminal", async () => {
  let calls = 0;
  const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).pathname).toBe("/api/terminals/session");
    if (++calls === 1) { await Bun.sleep(5100); return Response.json({ok:true}); }
    return Response.json({error:"not found"},{status:404});
  }});
  try {
    await requestTerminalStop("session", undefined, server.url.origin);
    await requestTerminalStop("session", undefined, server.url.origin);
    expect(calls).toBe(2);
  } finally { server.stop(true); }
},10000);

test("session stop reports server failures without treating them as confirmation", async () => {
  const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch() {
    return Response.json({error:"Broker unavailable"},{status:503});
  }});
  try {
    await expect(requestTerminalStop("session", undefined, server.url.origin)).rejects.toThrow("Broker unavailable");
  } finally { server.stop(true); }
});
import {
  isLocalFileMarkdownHref,
  resolveLocalFileMarkdownHref,
  shouldOpenHrefOutsideApp,
  shouldUseWindowOpenFallback,
} from "../src/open-url";

/**
 * apiUrl()/apiWsUrl() route a daemon request to either the LOCAL daemon
 * (same-origin, unchanged) or a REMOTE daemon via the reverse proxy
 * (/api/daemons/<id>/…). The whole UI funnels its fetch/WS/SSE URLs
 * through these so a remote folder row reaches the right daemon.
 *
 * Critical invariant: with NO daemonId the output is byte-identical to the
 * input — so wrapping the existing ~153 call sites is a pure no-op for the
 * local case (the UI behaves exactly as before until a remote row is used).
 */
describe("apiUrl", () => {
  test("returns the path unchanged when there is no daemonId (local)", () => {
    expect(apiUrl("/api/repos")).toBe("/api/repos");
    expect(apiUrl("/api/diff?path=/x&all=1")).toBe("/api/diff?path=/x&all=1");
    expect(apiUrl("/api/open-default")).toBe("/api/open-default");
  });

  test("treats null/undefined daemonId as local", () => {
    expect(apiUrl("/api/repos", null)).toBe("/api/repos");
    expect(apiUrl("/api/repos", undefined)).toBe("/api/repos");
  });

  test("inserts /daemons/<id> after /api for a remote daemon", () => {
    expect(apiUrl("/api/repos", "hz")).toBe("/api/daemons/hz/repos");
    expect(apiUrl("/api/diff?path=/x", "hz")).toBe(
      "/api/daemons/hz/diff?path=/x",
    );
  });

  test("handles the bare /api root for a remote daemon", () => {
    expect(apiUrl("/api", "hz")).toBe("/api/daemons/hz");
  });

  test("only rewrites the leading /api, not later occurrences", () => {
    // A query value that happens to contain '/api' must be left alone.
    expect(apiUrl("/api/open?path=/api/foo", "hz")).toBe(
      "/api/daemons/hz/open?path=/api/foo",
    );
  });
});

describe("withRequestDeadline", () => {
  test("aborts an operation that never settles", async () => {
    const started = Date.now();
    const operation = withRequestDeadline(
      5,
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    await expect(operation).rejects.toThrow("request timed out after 5ms");
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("clears the deadline after a successful operation", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      withRequestDeadline(5, async (requestSignal) => {
        signal = requestSignal;
        return "done";
      }),
    ).resolves.toBe("done");

    await Bun.sleep(10);
    expect(signal?.aborted).toBe(false);
  });
});

describe("apiWsUrl", () => {
  const host = "localhost:7777";

  test("builds a same-origin ws URL when local", () => {
    expect(apiWsUrl("/api/terminals/t1/io", host, "ws:")).toBe(
      "ws://localhost:7777/api/terminals/t1/io",
    );
  });

  test("uses wss when the page is https", () => {
    expect(apiWsUrl("/api/terminals/t1/io", host, "wss:")).toBe(
      "wss://localhost:7777/api/terminals/t1/io",
    );
  });

  test("routes through the proxy for a remote daemon", () => {
    expect(apiWsUrl("/api/terminals/t1/io", host, "ws:", "hz")).toBe(
      "ws://localhost:7777/api/daemons/hz/terminals/t1/io",
    );
  });
});

describe("shouldOpenHrefOutsideApp", () => {
  const currentHref = "http://localhost:27787/workspace?repo=supergit";

  test("routes same-origin http links outside the app shell", () => {
    expect(
      shouldOpenHrefOutsideApp(
        "http://localhost:27787/api/attachments/img.png",
        currentHref,
      ),
    ).toBe(true);
    expect(
      shouldOpenHrefOutsideApp("/api/attachments/img.png", currentHref),
    ).toBe(true);
  });

  test("routes external web and default-app links", () => {
    expect(shouldOpenHrefOutsideApp("https://example.com", currentHref)).toBe(
      true,
    );
    expect(
      shouldOpenHrefOutsideApp("mailto:test@example.com", currentHref),
    ).toBe(true);
    expect(
      shouldOpenHrefOutsideApp("file:///tmp/report.txt", currentHref),
    ).toBe(true);
  });

  test("does not route hash-only or unsafe/browser-owned protocols", () => {
    expect(shouldOpenHrefOutsideApp("#events", currentHref)).toBe(false);
    expect(shouldOpenHrefOutsideApp("javascript:alert(1)", currentHref)).toBe(
      false,
    );
    expect(shouldOpenHrefOutsideApp("data:text/plain,hello", currentHref)).toBe(
      false,
    );
    expect(
      shouldOpenHrefOutsideApp("blob:http://localhost:27787/id", currentHref),
    ).toBe(false);
  });
});

describe("transcript markdown file links", () => {
  const cwd = "/Users/herbst/git/usd-viewer";

  test("classifies relative and absolute filesystem hrefs as local files", () => {
    expect(isLocalFileMarkdownHref("README_BUILDING.md")).toBe(true);
    expect(isLocalFileMarkdownHref("./docs/openusd.md#notes")).toBe(true);
    expect(isLocalFileMarkdownHref("../shared/file with spaces.md")).toBe(true);
    expect(
      isLocalFileMarkdownHref("/Users/herbst/git/usd-viewer/package.json"),
    ).toBe(true);
    expect(isLocalFileMarkdownHref("file:///Users/herbst/file.md")).toBe(true);
  });

  test("does not classify web or browser-owned hrefs as local files", () => {
    expect(isLocalFileMarkdownHref("https://example.com")).toBe(false);
    expect(isLocalFileMarkdownHref("http://localhost:27787/api/events")).toBe(
      false,
    );
    expect(isLocalFileMarkdownHref("//example.com/file.md")).toBe(false);
    expect(isLocalFileMarkdownHref("#section")).toBe(false);
    expect(isLocalFileMarkdownHref("mailto:test@example.com")).toBe(false);
    expect(isLocalFileMarkdownHref("data:text/plain,hello")).toBe(false);
  });

  test("resolves relative transcript file links against the session cwd", () => {
    expect(resolveLocalFileMarkdownHref("README_BUILDING.md", cwd)).toBe(
      "/Users/herbst/git/usd-viewer/README_BUILDING.md",
    );
    expect(
      resolveLocalFileMarkdownHref(
        "docs/openusd-26.05-modernization.md#release",
        cwd,
      ),
    ).toBe("/Users/herbst/git/usd-viewer/docs/openusd-26.05-modernization.md");
    expect(resolveLocalFileMarkdownHref("../shared/file%20name.md", cwd)).toBe(
      "/Users/herbst/git/shared/file name.md",
    );
  });

  test("preserves absolute filesystem and file URL targets", () => {
    expect(
      resolveLocalFileMarkdownHref(
        "/Users/herbst/git/usd-viewer/package.json",
        cwd,
      ),
    ).toBe("/Users/herbst/git/usd-viewer/package.json");
    expect(
      resolveLocalFileMarkdownHref("file:///Users/herbst/file%20name.md", cwd),
    ).toBe("/Users/herbst/file name.md");
  });

  test("refuses relative file links without an absolute cwd", () => {
    expect(resolveLocalFileMarkdownHref("README.md", "")).toBe(null);
    expect(resolveLocalFileMarkdownHref("README.md", "relative-cwd")).toBe(
      null,
    );
    expect(resolveLocalFileMarkdownHref("~/README.md", cwd)).toBe(null);
  });
});

describe("shouldUseWindowOpenFallback", () => {
  test("keeps the browser fallback for web-style targets", () => {
    expect(shouldUseWindowOpenFallback("https://example.com")).toBe(true);
    expect(shouldUseWindowOpenFallback("http://localhost:27787/api/events")).toBe(
      true,
    );
    expect(shouldUseWindowOpenFallback("mailto:test@example.com")).toBe(true);
  });

  test("does not fallback-navigate filesystem targets", () => {
    expect(shouldUseWindowOpenFallback("/Users/herbst/git/usd-viewer/README.md")).toBe(
      false,
    );
    expect(shouldUseWindowOpenFallback("README.md")).toBe(false);
    expect(shouldUseWindowOpenFallback("file:///Users/herbst/file.md")).toBe(
      false,
    );
  });
});
