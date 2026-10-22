import { describe, expect, test } from "bun:test";
import {
  GlobalVoiceController,
  getBrowserUserMedia,
  type VoiceRealtimeEvent,
} from "../src/voice-controller";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function restartHarness() {
  const peers: any[] = [];
  const events: Array<(event: VoiceRealtimeEvent) => void> = [];
  const stops: string[] = [];
  const pendingStop = deferred<Record<string, unknown>>();
  let negotiate = async () => {};
  const streamStates: Array<(state: "live" | "reconnecting") => void> = [];
  let nextThread = 0;
  const controller = new GlobalVoiceController({
    disconnectGraceMs: 5,
    getUserMedia: async () =>
      ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
    createPeerConnection: () => {
      const peer = {
        addTrack() {},
        createDataChannel: () => ({ close() {} }),
        createOffer: async () => ({ type: "offer", sdp: "offer" }),
        setLocalDescription: async () => {},
        localDescription: { sdp: "offer" },
        iceGatheringState: "complete",
        connectionState: "connected",
        addEventListener() {},
        removeEventListener() {},
        setRemoteDescription: () => negotiate(),
        close() {},
        ontrack: null,
        onconnectionstatechange: null,
      };
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    createAudioElement: () =>
      ({ play: async () => {}, pause() {} }) as unknown as HTMLAudioElement,
    request: async (path, body) => {
      if (path === "/api/voice/start")
        return { threadId: `voice-${++nextThread}`, sdp: "answer" };
      stops.push((body as { threadId: string }).threadId);
      return pendingStop.promise;
    },
    subscribe: (_id, handlers) => {
      events.push(handlers.onEvent);
      streamStates.push((state) => handlers.onState?.(state));
      return () => {};
    },
  });
  const context = {
    product: "Treetop" as const,
    cwd: "/repo",
    zenMode: { active: false },
    projects: [],
    sessions: [],
  };
  return {
    controller,
    peers,
    events,
    streamStates,
    stops,
    pendingStop,
    context,
    setNegotiation: (fn: () => Promise<void>) => {
      negotiate = fn;
    },
  };
}

describe("GlobalVoiceController", () => {
  test("a connection failure releases local state immediately even if server stop hangs; stale callbacks cannot kill its replacement", async () => {
    const h = restartHarness();
    await h.controller.start(h.context);
    const staleConnection = h.peers[0].onconnectionstatechange;
    h.peers[0].connectionState = "failed";
    staleConnection();
    expect(h.controller.snapshot.phase).toBe("error");
    await h.controller.start(h.context);
    expect(h.controller.snapshot.phase).toBe("listening");
    staleConnection();
    h.events[0]!({
      kind: "notification",
      method: "thread/realtime/closed",
      params: { threadId: "voice-1" },
    });
    expect(h.controller.snapshot.phase).toBe("listening");
    expect(h.stops).toEqual(["voice-1"]);
    h.pendingStop.resolve({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.controller.snapshot.phase).toBe("listening");
    await h.controller.stop();
  });

  test("stop immediately permits restarting and a late stop response cannot reset the new session", async () => {
    const h = restartHarness();
    await h.controller.start(h.context);
    const stopping = h.controller.stop();
    expect(h.controller.snapshot.phase).toBe("off");
    await h.controller.start(h.context);
    h.pendingStop.resolve({ ok: true });
    await stopping;
    expect(h.controller.snapshot.phase).toBe("listening");
    await h.controller.stop();
  });

  test("a canceled startup cannot revive itself after remote-description negotiation finishes", async () => {
    const h = restartHarness();
    const negotiation = deferred<void>();
    const started = h.controller.start(h.context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Start another lifecycle with a deliberately delayed SDP application.
    h.pendingStop.resolve({ ok: true });
    await started;
    await h.controller.stop();
    h.setNegotiation(() => negotiation.promise);
    const restarting = h.controller.start(h.context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.controller.stop();
    negotiation.resolve();
    await restarting;
    expect(h.controller.snapshot.phase).toBe("off");
  });

  test("a transient WebRTC disconnect can recover, but a persistent disconnect becomes retryable", async () => {
    const h = restartHarness();
    await h.controller.start(h.context);
    const peer = h.peers[0];
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange();
    expect(h.controller.snapshot.phase).toBe("listening");
    peer.connectionState = "connected";
    peer.onconnectionstatechange();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.controller.snapshot.phase).toBe("listening");
    expect(h.stops).toEqual([]);
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(h.controller.snapshot.phase).toBe("error");
    h.pendingStop.resolve({ ok: true });
    await h.controller.stop();
  });

  test("a recovered status stream clears its warning and an old stream cannot affect the next lifecycle", async () => {
    const h = restartHarness();
    await h.controller.start(h.context);
    h.streamStates[0]!("reconnecting");
    expect(h.controller.snapshot.error).toContain("reconnecting");
    h.streamStates[0]!("live");
    expect(h.controller.snapshot.error).toBeUndefined();
    await h.controller.stop();
    await h.controller.start(h.context);
    h.streamStates[0]!("reconnecting");
    expect(h.controller.snapshot.error).toBeUndefined();
    h.pendingStop.resolve({ ok: true });
    await h.controller.stop();
  });
  test("reports missing browser microphone capture without a raw mediaDevices crash", async () => {
    await expect(
      getBrowserUserMedia({ audio: true }, {
        mediaDevices: undefined,
      } as unknown as Navigator),
    ).rejects.toThrow("Microphone capture is not available");
  });

  test("owns microphone/WebRTC lifecycle and answers Treetop tool calls", async () => {
    const stoppedTracks: string[] = [];
    const remoteDescriptions: RTCSessionDescriptionInit[] = [];
    let realtimeEvent: ((event: VoiceRealtimeEvent) => void) | undefined;
    let realtimeClosed = false;
    const posted: Array<{ path: string; body: unknown }> = [];
    const handledTools: string[] = [];
    const states: string[] = [];
    const dataChannel = { close() {} };
    const peer = {
      addTrack() {},
      createDataChannel() {
        return dataChannel;
      },
      async createOffer() {
        return { type: "offer" as const, sdp: "browser-offer" };
      },
      async setLocalDescription() {},
      localDescription: { type: "offer" as const, sdp: "browser-offer" },
      iceGatheringState: "complete" as RTCIceGatheringState,
      addEventListener() {},
      removeEventListener() {},
      async setRemoteDescription(description: RTCSessionDescriptionInit) {
        remoteDescriptions.push(description);
      },
      close() {},
      ontrack: null,
      onconnectionstatechange: null,
      connectionState: "connected" as RTCPeerConnectionState,
    };
    const audio = {
      autoplay: false,
      srcObject: null as MediaStream | null,
      play: async () => {},
      pause() {},
    };
    const controller = new GlobalVoiceController({
      getUserMedia: async () =>
        ({
          getTracks: () => [
            {
              stop() {
                stoppedTracks.push("mic");
              },
            },
          ],
        }) as unknown as MediaStream,
      createPeerConnection: () => peer as unknown as RTCPeerConnection,
      createAudioElement: () => audio as unknown as HTMLAudioElement,
      request: async (path, body) => {
        posted.push({ path, body });
        if (path === "/api/voice/start") {
          return { threadId: "thr_voice", sdp: "server-answer" };
        }
        return { ok: true };
      },
      subscribe: (_threadId, handlers) => {
        realtimeEvent = handlers.onEvent;
        return () => {
          realtimeClosed = true;
        };
      },
      onState: (state) => states.push(state.phase),
      handleTool: async (tool, args) => {
        handledTools.push(tool);
        return { tool, args, ok: true };
      },
    });

    await controller.start({
      product: "Treetop",
      cwd: "/repo",
      zenMode: { active: false },
      projects: [],
      sessions: [],
    });

    expect(posted[0]).toEqual({
      path: "/api/voice/start",
      body: {
        cwd: "/repo",
        sdp: "browser-offer",
        voice: "sol",
        context: {
          product: "Treetop",
          cwd: "/repo",
          zenMode: { active: false },
          projects: [],
          sessions: [],
        },
      },
    });
    expect(remoteDescriptions).toEqual([
      { type: "answer", sdp: "server-answer" },
    ]);
    expect(states).toContain("listening");

    realtimeEvent?.({
      kind: "notification",
      method: "thread/realtime/transcript/delta",
      params: { threadId: "thr_voice", role: "assistant", delta: "Re" },
    });
    expect(controller.snapshot).toMatchObject({
      phase: "speaking",
    });
    expect(controller.snapshot.messages).toBeUndefined();
    realtimeEvent?.({
      kind: "notification",
      method: "thread/realtime/transcript/done",
      params: { threadId: "thr_voice", role: "assistant", text: "Ready." },
      seq: 3,
    });
    const toolCall: VoiceRealtimeEvent = {
      kind: "request",
      id: 42,
      method: "item/tool/call",
      params: {
        threadId: "thr_voice",
        tool: "get_context",
        arguments: {},
      },
      seq: 4,
    };
    realtimeEvent?.(toolCall);
    // The daemon replays its bounded event history after an SSE reconnect.
    // A replay is the same delivery identity, not another model action.
    realtimeEvent?.({
      kind: "notification",
      method: "thread/realtime/transcript/done",
      params: { threadId: "thr_voice", role: "assistant", text: "Ready." },
      seq: 3,
    });
    realtimeEvent?.(toolCall);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(controller.snapshot).toMatchObject({
      phase: "speaking",
      messages: [
        expect.objectContaining({
          role: "assistant",
          text: "Ready.",
        }),
      ],
    });
    expect(handledTools).toEqual(["get_context"]);
    expect(
      posted.filter((entry) => entry.path.includes("/respond")),
    ).toHaveLength(1);
    expect(posted[1]).toEqual({
      path: "/api/codex-app/requests/42/respond",
      body: {
        result: {
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                tool: "get_context",
                args: {},
                ok: true,
              }),
            },
          ],
          success: true,
        },
      },
    });

    await controller.stop();
    expect(posted.at(-1)).toEqual({
      path: "/api/voice/stop",
      body: { threadId: "thr_voice" },
    });
    expect(stoppedTracks).toEqual(["mic"]);
    expect(realtimeClosed).toBe(true);
    expect(controller.snapshot.phase).toBe("off");
  });

  test("does not answer an in-flight tool call after its voice lifecycle stops", async () => {
    const toolResult = deferred<unknown>();
    let realtimeEvent: ((event: VoiceRealtimeEvent) => void) | undefined;
    const posted: Array<{ path: string; body: unknown }> = [];
    const controller = new GlobalVoiceController({
      getUserMedia: async () =>
        ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
      createPeerConnection: () =>
        ({
          addTrack() {},
          createDataChannel: () => ({ close() {} }),
          createOffer: async () => ({ type: "offer", sdp: "offer" }),
          setLocalDescription: async () => {},
          localDescription: { type: "offer", sdp: "offer" },
          iceGatheringState: "complete",
          addEventListener() {},
          removeEventListener() {},
          setRemoteDescription: async () => {},
          close() {},
        }) as unknown as RTCPeerConnection,
      createAudioElement: () =>
        ({
          autoplay: false,
          play: async () => {},
          pause() {},
        }) as unknown as HTMLAudioElement,
      request: async (path, body) => {
        posted.push({ path, body });
        return path === "/api/voice/start"
          ? { threadId: "thr_voice", sdp: "answer" }
          : { ok: true };
      },
      subscribe: (_threadId, handlers) => {
        realtimeEvent = handlers.onEvent;
        return () => {};
      },
      handleTool: () => toolResult.promise,
    });

    await controller.start({
      product: "Treetop",
      cwd: "/repo",
      zenMode: { active: false },
      projects: [],
      sessions: [],
    });
    realtimeEvent?.({
      kind: "request",
      id: 7,
      method: "item/tool/call",
      params: { threadId: "thr_voice", tool: "get_context", arguments: {} },
      seq: 8,
    });
    await controller.stop();
    toolResult.resolve({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted.some((entry) => entry.path.endsWith("/7/respond"))).toBe(
      false,
    );
  });

  test("surfaces unsupported realtime availability without leaking the microphone", async () => {
    const stopped = deferred<void>();
    const controller = new GlobalVoiceController({
      getUserMedia: async () =>
        ({
          getTracks: () => [{ stop: stopped.resolve }],
        }) as unknown as MediaStream,
      createPeerConnection: () =>
        ({
          addTrack() {},
          createDataChannel() {
            return { close() {} };
          },
          createOffer: async () => ({
            type: "offer" as const,
            sdp: "offer",
          }),
          setLocalDescription: async () => {},
          localDescription: { type: "offer" as const, sdp: "offer" },
          iceGatheringState: "complete",
          addEventListener() {},
          removeEventListener() {},
          close() {},
        }) as unknown as RTCPeerConnection,
      createAudioElement: () =>
        ({
          autoplay: false,
          srcObject: null,
          play: async () => {},
          pause() {},
        }) as unknown as HTMLAudioElement,
      request: async () => {
        throw new Error("Method not found: thread/realtime/start");
      },
      subscribe: () => () => {},
    });

    await expect(
      controller.start({
        product: "Treetop",
        cwd: "/repo",
        zenMode: { active: false },
        projects: [],
        sessions: [],
      }),
    ).rejects.toThrow("Method not found");
    await stopped.promise;
    expect(controller.snapshot).toMatchObject({
      phase: "error",
      error: "Method not found: thread/realtime/start",
    });
  });
});
