import {
  subscribeCodexEvents,
  type CodexAppEvent,
  type CodexEventStreamState,
} from "./codex-event-stream";
import type { TreetopVoiceContext } from "./voice-context";
import { withRequestDeadline } from "./api";

export type VoicePhase =
  | "off"
  | "connecting"
  | "listening"
  | "speaking"
  | "stopping"
  | "error";

export interface GlobalVoiceState {
  phase: VoicePhase;
  messages?: GlobalVoiceMessage[];
  error?: string;
}

export interface GlobalVoiceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export type VoiceRealtimeEvent = Omit<CodexAppEvent, "receivedAt"> & {
  receivedAt?: string;
};

interface VoiceDependencies {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeerConnection(): RTCPeerConnection;
  createAudioElement(): HTMLAudioElement;
  request(path: string, body: unknown): Promise<Record<string, unknown>>;
  subscribe(
    threadId: string,
    handlers: {
      onEvent(event: VoiceRealtimeEvent): void;
      onState?(state: CodexEventStreamState): void;
    },
  ): () => void;
  onState?(state: GlobalVoiceState): void;
  diagnostic?(message: string, extra: Record<string, unknown>): void;
  disconnectGraceMs?: number;
  audioPollMs?: number;
  audioTimeoutMs?: number;
  handleTool?(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> | unknown;
}

async function defaultRequest(
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  return withRequestDeadline(20_000, async (signal) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      throw new Error(
        typeof data?.error === "string"
          ? data.error
          : `Treetop voice request failed (HTTP ${response.status})`,
      );
    }
    return data ?? {};
  });
}

export async function getBrowserUserMedia(
  constraints: MediaStreamConstraints,
  navigatorLike:
    | Pick<Navigator, "mediaDevices">
    | undefined = globalThis.navigator,
): Promise<MediaStream> {
  const mediaDevices = navigatorLike?.mediaDevices;
  if (typeof mediaDevices?.getUserMedia !== "function") {
    throw new Error(
      "Microphone capture is not available in this Treetop runtime.",
    );
  }
  return mediaDevices.getUserMedia(constraints);
}

function defaultDependencies(): VoiceDependencies {
  return {
    getUserMedia: getBrowserUserMedia,
    createPeerConnection: () => new RTCPeerConnection(),
    createAudioElement: () => new Audio(),
    request: defaultRequest,
    subscribe: (threadId, handlers) =>
      subscribeCodexEvents(undefined, threadId, {
        onEvent: handlers.onEvent as (event: CodexAppEvent) => void,
        onState: handlers.onState,
      }),
  };
}

function cleanArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return {};
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, 2_000);
    function done() {
      clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed() {
      if (peer.iceGatheringState === "complete") done();
    }
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

export class GlobalVoiceController {
  private readonly deps: VoiceDependencies;
  private state: GlobalVoiceState = { phase: "off" };
  private threadId: string | null = null;
  private stream: MediaStream | null = null;
  private peer: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private audio: HTMLAudioElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private audioTimer: ReturnType<typeof setInterval> | null = null;
  private audioAcknowledgements = 0;
  private recoveryAttempts = 0;
  private readonly handledDeliveries = new Set<string>();

  constructor(deps: Partial<VoiceDependencies> = {}) {
    this.deps = { ...defaultDependencies(), ...deps };
  }

  get snapshot(): GlobalVoiceState {
    return this.state;
  }

  async start(context: TreetopVoiceContext, recovering = false): Promise<void> {
    if (
      this.state.phase === "connecting" ||
      this.state.phase === "listening" ||
      this.state.phase === "speaking"
    ) {
      return;
    }
    const generation = ++this.generation;
    if (!recovering) this.recoveryAttempts = 0;
    this.handledDeliveries.clear();
    this.setState({ phase: "connecting" });
    try {
      const stream = await this.deps.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (generation !== this.generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      const peer = this.deps.createPeerConnection();
      this.peer = peer;
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      this.dataChannel = peer.createDataChannel("oai-events");
      this.dataChannel.onmessage = (event) => {
        if (generation !== this.generation || typeof event.data !== "string")
          return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!message || typeof message !== "object") return;
        if (
          message.type === "input_transcript.added" ||
          message.type === "output_transcript.added"
        ) {
          this.audioAcknowledgements++;
        } else if (message.type === "error") {
          const error = message.error as { message?: unknown } | undefined;
          void this.fail(
            new Error(
              typeof error?.message === "string"
                ? error.message
                : "Voice service reported an error",
            ),
          );
        } else if (message.type === "session.closed") {
          void this.fail(
            new Error("Voice service closed the audio session. Please retry."),
          );
        }
      };
      const audio = this.deps.createAudioElement();
      audio.autoplay = true;
      this.audio = audio;
      peer.ontrack = (event) => {
        if (generation !== this.generation) return;
        audio.srcObject = event.streams[0] ?? null;
        void audio.play().catch((error) =>
          this.deps.diagnostic?.("audio playback failed", {
            message: String(error),
          }),
        );
      };
      peer.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        this.deps.diagnostic?.("connection state", {
          connectionState: peer.connectionState,
          iceConnectionState: peer.iceConnectionState,
          signalingState: peer.signalingState,
        });
        this.clearDisconnectTimer();
        if (peer.connectionState === "failed") {
          void this.fail(new Error("Realtime voice connection was lost"));
        } else if (peer.connectionState === "disconnected") {
          // WebRTC may recover a brief network/sleep interruption itself.
          this.disconnectTimer = setTimeout(() => {
            this.disconnectTimer = null;
            if (
              generation === this.generation &&
              peer.connectionState === "disconnected"
            )
              void this.fail(new Error("Realtime voice connection was lost"));
          }, this.deps.disconnectGraceMs ?? 3_000);
        }
      };
      const offer = await peer.createOffer();
      if (generation !== this.generation) return;
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      if (generation !== this.generation) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Browser did not create a WebRTC offer");

      const result = await this.deps.request("/api/voice/start", {
        cwd: context.cwd,
        sdp,
        voice: "sol",
        context,
      });
      const threadId =
        typeof result.threadId === "string" ? result.threadId : "";
      const answer = typeof result.sdp === "string" ? result.sdp : "";
      if (generation !== this.generation) {
        if (threadId) {
          this.stopRemoteThread(threadId);
        }
        return;
      }
      if (!threadId || !answer) {
        throw new Error("Treetop voice did not return a WebRTC answer");
      }
      this.threadId = threadId;
      const unsubscribe = this.deps.subscribe(threadId, {
        onEvent: (event) => {
          if (generation === this.generation) this.handleEvent(event);
        },
        onState: (streamState) => {
          if (generation !== this.generation) return;
          if (
            streamState === "reconnecting" &&
            this.state.phase !== "stopping"
          ) {
            this.setState({
              ...this.state,
              error: "Voice status stream is reconnecting…",
            });
          } else if (
            streamState === "live" &&
            this.state.error === "Voice status stream is reconnecting…"
          ) {
            this.setState({ ...this.state, error: undefined });
          }
        },
      });
      if (generation !== this.generation) {
        unsubscribe();
        return;
      }
      this.unsubscribe = unsubscribe;
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      if (generation !== this.generation) return;
      this.setState({ phase: "listening" });
      this.monitorAudio(peer, context, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      await this.fail(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const threadId = this.threadId;
    ++this.generation;
    if (this.state.phase !== "off") this.setState({ phase: "stopping" });
    this.releaseLocalResources();
    this.threadId = null;
    this.setState({ phase: "off" });
    if (threadId) this.stopRemoteThread(threadId);
  }

  private handleEvent(event: VoiceRealtimeEvent): void {
    if (event.method === "thread/realtime/started") {
      this.setState({ phase: "listening" });
      return;
    }
    if (event.method === "thread/realtime/transcript/delta") {
      this.audioAcknowledgements++;
      const role =
        typeof event.params.role === "string" ? event.params.role : "";
      this.setState({
        ...this.state,
        phase: role === "assistant" ? "speaking" : "listening",
      });
      return;
    }
    if (event.method === "thread/realtime/transcript/done") {
      this.audioAcknowledgements++;
      if (!this.markDeliveryHandled(event)) return;
      const role: GlobalVoiceMessage["role"] =
        event.params.role === "assistant" || event.params.role === "user"
          ? event.params.role
          : "assistant";
      const text =
        typeof event.params.text === "string" ? event.params.text.trim() : "";
      const messages = text
        ? [
            ...(this.state.messages ?? []),
            {
              id: `${Date.now()}:${this.state.messages?.length ?? 0}`,
              role,
              text,
              at: new Date().toISOString(),
            },
          ].slice(-20)
        : (this.state.messages ?? []);
      this.setState({
        ...this.state,
        phase: role === "assistant" ? "speaking" : "listening",
        messages,
      });
      return;
    }
    if (event.method === "thread/realtime/error") {
      const message =
        typeof event.params.message === "string"
          ? event.params.message
          : "Codex realtime voice failed";
      void this.fail(new Error(message));
      return;
    }
    if (event.method === "thread/realtime/closed") {
      if (this.state.phase === "stopping") return;
      this.deps.diagnostic?.("realtime closed", {
        threadId: this.threadId,
        reason: event.params.reason,
      });
      void this.stop();
      return;
    }
    if (
      event.kind === "request" &&
      event.method === "item/tool/call" &&
      event.id !== undefined
    ) {
      if (!this.markDeliveryHandled(event)) return;
      void this.answerToolCall(event, this.generation);
    }
  }

  private markDeliveryHandled(event: VoiceRealtimeEvent): boolean {
    const identity =
      event.kind === "request" && event.id !== undefined
        ? `request:${String(event.id)}`
        : event.seq !== undefined
          ? `event:${event.seq}`
          : null;
    if (!identity) return true;
    if (this.handledDeliveries.has(identity)) return false;
    this.handledDeliveries.add(identity);
    if (this.handledDeliveries.size > 2_000) {
      const oldest = this.handledDeliveries.values().next().value;
      if (oldest !== undefined) this.handledDeliveries.delete(oldest);
    }
    return true;
  }

  private async answerToolCall(
    event: VoiceRealtimeEvent,
    generation: number,
  ): Promise<void> {
    const tool = typeof event.params.tool === "string" ? event.params.tool : "";
    if (!tool || event.id === undefined) return;
    let result: Record<string, unknown>;
    try {
      const output = await this.deps.handleTool?.(
        tool,
        cleanArgs(event.params.arguments),
      );
      result = {
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify(output ?? { ok: true }),
          },
        ],
        success: true,
      };
    } catch (error) {
      result = {
        contentItems: [
          {
            type: "inputText",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        success: false,
      };
    }
    if (
      generation !== this.generation ||
      this.threadId !== event.params.threadId
    ) {
      return;
    }
    try {
      await this.deps.request(
        `/api/codex-app/requests/${encodeURIComponent(String(event.id))}/respond`,
        { result },
      );
    } catch (error) {
      if (generation !== this.generation) return;
      this.setState({
        ...this.state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fail(error: unknown): Promise<void> {
    ++this.generation;
    const threadId = this.threadId;
    this.releaseLocalResources();
    this.threadId = null;
    this.setState({
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    if (threadId) this.stopRemoteThread(threadId);
  }

  private stopRemoteThread(threadId: string): void {
    // Cleanup must never hold the microphone/button hostage or mutate the
    // next lifecycle when an old stop request eventually resolves.
    void this.deps.request("/api/voice/stop", { threadId }).catch((error) => {
      this.deps.diagnostic?.("remote cleanup failed", {
        threadId,
        message: String(error),
      });
    });
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer !== null) clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private monitorAudio(
    peer: RTCPeerConnection,
    context: TreetopVoiceContext,
    generation: number,
  ): void {
    if (typeof peer.getStats !== "function") return;
    let energy = 0,
      acknowledged = this.audioAcknowledgements;
    let pendingSince: number | null = null;
    let sampling = false;
    this.audioTimer = setInterval(async () => {
      if (
        sampling ||
        generation !== this.generation ||
        peer.connectionState !== "connected"
      )
        return;
      sampling = true;
      try {
        const stats = await peer.getStats();
        if (generation !== this.generation) return;
        let currentEnergy = 0,
          bytesSent = 0;
        stats.forEach((report) => {
          if (report.kind !== "audio") return;
          if (report.type === "media-source")
            currentEnergy += report.totalAudioEnergy ?? 0;
          if (report.type === "outbound-rtp")
            bytesSent += report.bytesSent ?? 0;
        });
        if (acknowledged !== this.audioAcknowledgements) {
          acknowledged = this.audioAcknowledgements;
          pendingSince = null;
        } else if (bytesSent > 0 && currentEnergy - energy > 0.001) {
          pendingSince ??= Date.now();
        }
        energy = currentEnergy;
        if (
          pendingSince === null ||
          Date.now() - pendingSince < (this.deps.audioTimeoutMs ?? 12_000)
        )
          return;
        this.deps.diagnostic?.("audio acknowledgement timeout", {
          bytesSent,
          microphoneEnergy: currentEnergy,
          recoveryAttempts: this.recoveryAttempts,
        });
        if (this.recoveryAttempts >= 1) {
          void this.fail(
            new Error(
              "Microphone audio was sent, but the voice service did not acknowledge it. Please retry.",
            ),
          );
          return;
        }
        this.recoveryAttempts++;
        // A fresh media session recovered the reproduced silent connection.
        // Do it once; never leave an unbounded background reconnect loop.
        await this.stop();
        const stoppedGeneration = generation + 1;
        if (this.generation !== stoppedGeneration) return;
        await this.start(context, true);
      } catch (error) {
        if (generation === this.generation)
          this.deps.diagnostic?.("audio monitor failed", {
            message: String(error),
          });
      } finally {
        sampling = false;
      }
    }, this.deps.audioPollMs ?? 2_000);
  }

  private releaseLocalResources(): void {
    if (this.audioTimer !== null) clearInterval(this.audioTimer);
    this.audioTimer = null;
    this.clearDisconnectTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.dataChannel) {
      this.dataChannel.onmessage = null;
      this.dataChannel.close();
    }
    this.dataChannel = null;
    if (this.peer) {
      this.peer.ontrack = this.peer.onconnectionstatechange = null;
      this.peer.close();
    }
    this.peer = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.audio?.pause();
    if (this.audio) this.audio.srcObject = null;
    this.audio = null;
  }

  private setState(state: GlobalVoiceState): void {
    if (state.phase !== this.state.phase || state.error !== this.state.error)
      this.deps.diagnostic?.("state", {
        phase: state.phase,
        error: state.error,
        threadId: this.threadId,
      });
    this.state = state;
    this.deps.onState?.(state);
  }
}
