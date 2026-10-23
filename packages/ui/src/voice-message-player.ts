import type { SettingsSection } from "./settings-registry";
import {
  VOICE_MESSAGE_EAGERNESS_KEY,
  VOICE_MESSAGE_EAGERNESS_OPTIONS,
} from "../../daemon/src/voice-message";

export const MCP_VOICE_SETTINGS: SettingsSection = {
  id: "mcp",
  title: "MCP",
  order: 19,
  settings: [
    {
      key: "mcp.voiceMessage",
      label: "MCP: Voice message",
      description:
        "Allow AI sessions to speak a single message through Codex subscription voice. Never enables the microphone or continuous voice mode.",
      type: "boolean",
      default: true,
    },
    {
      key: VOICE_MESSAGE_EAGERNESS_KEY,
      label: "Voice message eagerness",
      description:
        "How proactively AI should speak about its progress. Changes the MCP tool description; clients that cache tools need to reconnect or refresh their tool list.",
      type: "enum",
      default: "milestones",
      options: VOICE_MESSAGE_EAGERNESS_OPTIONS.map((option) => ({ ...option })),
    },
  ],
};
export interface VoiceMessageDependencies {
  createPeer: () => RTCPeerConnection;
  createAudio: () => HTMLAudioElement;
  createSilence?: () => { stream: MediaStream; close(): Promise<void> };
  request: (path: string, body: object) => Promise<Record<string, unknown>>;
  timeoutMs?: number;
}
/** Speech uses synthetic silence for the audio clock, never microphone capture. */
export class VoiceMessagePlayer {
  private cancel: (() => void) | null = null;
  constructor(
    private deps: VoiceMessageDependencies = {
      createPeer: () => new RTCPeerConnection(),
      createAudio: () => new Audio(),
      request: async (path, body) => {
        const response = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error ?? `Voice request failed: ${response.status}`,
          );
        return result;
      },
    },
  ) {}
  stop(): void {
    this.cancel?.();
  }
  async play(text: string, cwd: string): Promise<void> {
    if (this.cancel) throw new Error("A voice message is already playing");
    const peer = this.deps.createPeer(),
      audio = this.deps.createAudio();
    let silence: { stream: MediaStream; close(): Promise<void> } | undefined;
    let threadId: string | undefined,
      closed = false,
      playbackStarted = false,
      finished = false;
    let stage = "preparing the audio connection";
    let lastBytes = 0,
      lastEnergy = 0,
      lastAudioAt = Date.now(),
      receivedAudio = false;
    let resolve!: () => void, reject!: (error: Error) => void;
    const done = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void done.catch(() => {});
    let failure: Error | null = null;
    const fail = (message: string) => {
      failure ??= new Error(message);
      reject(failure);
    };
    this.cancel = () => fail("Voice message cancelled");
    const timer = setTimeout(
      () => fail(`Voice message timed out while ${stage}`),
      this.deps.timeoutMs ?? 90_000,
    );
    const channel = peer.createDataChannel("oai-events");
    let connected!: () => void;
    const ready = new Promise<void>((res) => {
      connected = res;
    });
    let channelOpen = false,
      sessionStarted = false;
    const connectWhenReady = () => {
      if (channelOpen && sessionStarted) connected();
    };
    channel.onopen = () => {
      channelOpen = true;
      connectWhenReady();
    };
    channel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let message: any;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "session.started") {
        sessionStarted = true;
        connectWhenReady();
      }
      if (message.type === "output_transcript.added")
        stage = "waiting for Codex to finish speaking";
      if (
        [
          "output_audio_buffer.stopped",
          "response.done",
          "response.output_audio.done",
        ].includes(message.type)
      )
        finished = true;
      if (message.type === "turn.done" && message.turn?.role === "assistant")
        finished = true;
      if (finished) stage = "waiting for audio playback to finish";
      if (message.type === "session.closed")
        fail("Voice session closed before playback completed");
      if (message.type === "error")
        fail(message.error?.message ?? message.message ?? "Codex voice failed");
    };

    peer.ontrack = (event) => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio
        .play()
        .then(() => {
          playbackStarted = true;
        })
        .catch((error) => fail(`Voice playback blocked: ${error}`));
    };
    peer.onconnectionstatechange = () => {
      if (!closed && ["failed", "closed"].includes(peer.connectionState))
        fail("Voice audio connection failed");
    };
    let polling = false;
    const poll = setInterval(() => {
      if (closed || polling) return;
      polling = true;
      void peer
        .getStats()
        .then((stats) => {
          if (closed) return;
          let bytes = 0,
            energy = 0,
            hasEnergy = false;
          stats.forEach((report) => {
            if (
              report.type === "inbound-rtp" &&
              (report.kind === "audio" || report.mediaType === "audio")
            ) {
              bytes += report.bytesReceived ?? 0;
              if (typeof report.totalAudioEnergy === "number") {
                hasEnergy = true;
                energy += report.totalAudioEnergy;
              }
            }
          });
          if (bytes > 0) receivedAudio = true;
          if (hasEnergy ? energy > lastEnergy + 1e-9 : bytes > lastBytes)
            lastAudioAt = Date.now();
          lastBytes = bytes;
          lastEnergy = energy;
          if (
            finished &&
            playbackStarted &&
            receivedAudio &&
            Date.now() - lastAudioAt > 1200
          )
            resolve();
        })
        .catch((error) => fail(`Voice audio status failed: ${error}`))
        .finally(() => {
          polling = false;
        });
    }, 250);
    try {
      if (this.deps.createSilence) silence = this.deps.createSilence();
      else {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const source = context.createConstantSource();
        source.offset.value = 0;
        source.connect(destination);
        source.start();
        silence = {
          stream: destination.stream,
          close: async () => {
            source.stop();
            destination.stream.getTracks().forEach((track) => track.stop());
            await context.close();
          },
        };
        await context.resume();
      }
      for (const track of silence.stream.getTracks())
        peer.addTrack(track, silence.stream);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== "complete") {
        await Promise.race([
          new Promise<void>((res) => {
            const changed = () => {
              if (peer.iceGatheringState === "complete") {
                peer.removeEventListener("icegatheringstatechange", changed);
                res();
              }
            };
            peer.addEventListener("icegatheringstatechange", changed);
          }),
          done,
        ]);
      }
      stage = "starting the Codex voice session";
      const started = await this.deps.request("/api/voice/start", {
        cwd,
        text,
        sdp: peer.localDescription?.sdp,
        speechOnly: true,
      });
      threadId =
        typeof started.threadId === "string" ? started.threadId : undefined;
      if (!threadId || typeof started.sdp !== "string")
        throw new Error("Codex did not return a speech connection");
      if (failure) throw failure;
      await peer.setRemoteDescription({ type: "answer", sdp: started.sdp });
      stage = "waiting for the Codex audio session to become ready";
      await Promise.race([ready, done]);
      if (failure) throw failure;
      stage = "waiting for Codex to produce speech";
      await this.deps.request("/api/voice/speak", { threadId, text });
      await done;
    } finally {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      this.cancel = null;
      channel.close();
      peer.close();
      if (silence)
        await silence
          .close()
          .catch((error) =>
            console.warn("Voice audio clock cleanup failed", error),
          );
      audio.pause();
      audio.srcObject = null;
      if (threadId) await this.deps.request("/api/voice/stop", { threadId });
    }
  }
}
