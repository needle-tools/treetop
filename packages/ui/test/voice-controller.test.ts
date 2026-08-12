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

describe("GlobalVoiceController", () => {
  test("reports missing browser microphone capture without a raw mediaDevices crash", async () => {
    await expect(
      getBrowserUserMedia(
        { audio: true },
        { mediaDevices: undefined } as unknown as Navigator,
      ),
    ).rejects.toThrow("Microphone capture is not available");
  });

  test("owns microphone/WebRTC lifecycle and answers Treetop tool calls", async () => {
    const stoppedTracks: string[] = [];
    const remoteDescriptions: RTCSessionDescriptionInit[] = [];
    let realtimeEvent: ((event: VoiceRealtimeEvent) => void) | undefined;
    let realtimeClosed = false;
    const posted: Array<{ path: string; body: unknown }> = [];
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
      handleTool: async (tool, args) => ({ tool, args, ok: true }),
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
    });
    realtimeEvent?.({
      kind: "request",
      id: 42,
      method: "item/tool/call",
      params: {
        threadId: "thr_voice",
        tool: "get_treetop_context",
        arguments: {},
      },
    });
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
    expect(posted[1]).toEqual({
      path: "/api/codex-app/requests/42/respond",
      body: {
        result: {
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                tool: "get_treetop_context",
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
