import { expect, test } from "bun:test";
import {
  VoiceMessagePlayer,
  MCP_VOICE_SETTINGS,
} from "../src/voice-message-player";

test("one-shot voice plays, then closes audio and the remote thread without microphone capture", async () => {
  const calls: string[] = [];
  const channel: any = {
    send: () => {},
    close: () => calls.push("channel closed"),
  };
  const audio: any = {
    play: async () => {
      calls.push("played");
    },
    pause: () => calls.push("paused"),
  };
  const peer: any = {
    iceGatheringState: "complete",
    localDescription: { sdp: "offer" },
    createDataChannel: () => channel,
    addTrack: () => calls.push("synthetic track"),
    createOffer: async () => ({ type: "offer", sdp: "offer" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {
      peer.ontrack({ streams: [{}] });
      channel.onopen();
      channel.onmessage({ data: JSON.stringify({ type: "session.started" }) });
    },
    getStats: async () =>
      new Map([
        [
          "audio",
          {
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: 100,
            totalAudioEnergy: 1,
          },
        ],
      ]),
    close: () => calls.push("peer closed"),
  };
  const player = new VoiceMessagePlayer({
    createPeer: () => peer,
    createAudio: () => audio,
    createSilence: () => ({
      stream: { getTracks: () => [{}] } as any,
      close: async () => {
        calls.push("silence closed");
      },
    }),
    request: async (path) => {
      calls.push(path);
      if (path.endsWith("start")) return { threadId: "speech", sdp: "answer" };
      if (path.endsWith("speak"))
        channel.onmessage({
          data: JSON.stringify({
            type: "turn.done",
            turn: { role: "assistant" },
          }),
        });
      return { ok: true };
    },
  });
  await player.play("Tests finished", "/repo");
  expect(calls).toEqual([
    "synthetic track",
    "/api/voice/start",
    "played",
    "/api/voice/speak",
    "channel closed",
    "peer closed",
    "silence closed",
    "paused",
    "/api/voice/stop",
  ]);
  expect(MCP_VOICE_SETTINGS.settings[0]).toMatchObject({
    key: "mcp.voiceMessage",
    default: true,
  });
});

test("speech waits for Codex session readiness after the data channel opens", async () => {
  const channel: any = { close() {} };
  let speechSent = false;
  let offerSet!: () => void;
  const remoteReady = new Promise<void>((resolve) => {
    offerSet = resolve;
  });
  const player = new VoiceMessagePlayer({
    createPeer: () =>
      ({
        iceGatheringState: "complete",
        localDescription: { sdp: "offer" },
        createDataChannel: () => channel,
        addTrack() {},
        createOffer: async () => ({}),
        setLocalDescription: async () => {},
        setRemoteDescription: async () => {
          channel.onopen();
          offerSet();
        },
        getStats: async () => new Map(),
        close() {},
      }) as any,
    createAudio: () => ({ pause() {} }) as any,
    createSilence: () => ({
      stream: { getTracks: () => [] } as any,
      close: async () => {},
    }),
    request: async (path) => {
      if (path.endsWith("start")) return { threadId: "speech", sdp: "answer" };
      if (path.endsWith("speak")) speechSent = true;
      return { ok: true };
    },
  });
  const playback = player.play("Hello", "/repo");
  void playback.catch(() => {});
  try {
    await remoteReady;
    await Bun.sleep(5);
    expect(speechSent).toBe(false);
    channel.onmessage({ data: JSON.stringify({ type: "session.started" }) });
    await Bun.sleep(5);
    expect(speechSent).toBe(true);
  } finally {
    player.stop();
    await expect(playback).rejects.toThrow("cancelled");
  }
});

test("voice startup errors release local resources and do not claim playback", async () => {
  let closed = false;
  const player = new VoiceMessagePlayer({
    createPeer: () =>
      ({
        iceGatheringState: "complete",
        createDataChannel: () => ({ close() {} }),
        addTrack() {},
        createOffer: async () => ({}),
        setLocalDescription: async () => {},
        close: () => {
          closed = true;
        },
      }) as any,
    createAudio: () => ({ pause() {} }) as any,
    createSilence: () => ({
      stream: { getTracks: () => [] } as any,
      close: async () => {},
    }),
    request: async () => {
      throw new Error("Subscription voice unavailable");
    },
  });
  await expect(player.play("Hello", "/repo")).rejects.toThrow(
    "Subscription voice unavailable",
  );
  expect(closed).toBe(true);
});
