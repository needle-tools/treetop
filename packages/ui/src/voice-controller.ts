import {
  subscribeCodexEvents,
  type CodexAppEvent,
  type CodexEventStreamState,
} from "./codex-event-stream";
import type { TreetopVoiceContext } from "./voice-context";

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
  handleTool?(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> | unknown;
}

async function defaultRequest(
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
}

export async function getBrowserUserMedia(
  constraints: MediaStreamConstraints,
  navigatorLike: Pick<Navigator, "mediaDevices"> | undefined =
    globalThis.navigator,
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

  constructor(deps: Partial<VoiceDependencies> = {}) {
    this.deps = { ...defaultDependencies(), ...deps };
  }

  get snapshot(): GlobalVoiceState {
    return this.state;
  }

  async start(context: TreetopVoiceContext): Promise<void> {
    if (
      this.state.phase === "connecting" ||
      this.state.phase === "listening" ||
      this.state.phase === "speaking"
    ) {
      return;
    }
    const generation = ++this.generation;
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
      const audio = this.deps.createAudioElement();
      audio.autoplay = true;
      this.audio = audio;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? null;
        void audio.play().catch(() => {});
      };
      peer.onconnectionstatechange = () => {
        if (
          peer.connectionState === "failed" ||
          peer.connectionState === "disconnected"
        ) {
          void this.fail(new Error("Realtime voice connection was lost"));
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
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
          void this.deps
            .request("/api/voice/stop", { threadId })
            .catch(() => {});
        }
        return;
      }
      if (!threadId || !answer) {
        throw new Error("Treetop voice did not return a WebRTC answer");
      }
      this.threadId = threadId;
      this.unsubscribe = this.deps.subscribe(threadId, {
        onEvent: (event) => this.handleEvent(event),
        onState: (streamState) => {
          if (
            streamState === "reconnecting" &&
            this.state.phase !== "stopping"
          ) {
            this.setState({
              ...this.state,
              error: "Voice status stream is reconnecting…",
            });
          }
        },
      });
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      this.setState({ phase: "listening" });
    } catch (error) {
      await this.fail(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const threadId = this.threadId;
    ++this.generation;
    if (this.state.phase !== "off") this.setState({ phase: "stopping" });
    this.releaseLocalResources();
    if (threadId) {
      try {
        await this.deps.request("/api/voice/stop", { threadId });
      } catch {}
    }
    this.threadId = null;
    this.setState({ phase: "off" });
  }

  private handleEvent(event: VoiceRealtimeEvent): void {
    if (event.method === "thread/realtime/started") {
      this.setState({ phase: "listening" });
      return;
    }
    if (event.method === "thread/realtime/transcript/delta") {
      const role =
        typeof event.params.role === "string" ? event.params.role : "";
      this.setState({
        ...this.state,
        phase: role === "assistant" ? "speaking" : "listening",
      });
      return;
    }
    if (event.method === "thread/realtime/transcript/done") {
      const role: GlobalVoiceMessage["role"] =
        event.params.role === "assistant" || event.params.role === "user"
          ? event.params.role
          : "assistant";
      const text =
        typeof event.params.text === "string"
          ? event.params.text.trim()
          : "";
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
      void this.stop();
      return;
    }
    if (
      event.kind === "request" &&
      event.method === "item/tool/call" &&
      event.id !== undefined
    ) {
      void this.answerToolCall(event);
    }
  }

  private async answerToolCall(event: VoiceRealtimeEvent): Promise<void> {
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
    try {
      await this.deps.request(
        `/api/codex-app/requests/${encodeURIComponent(String(event.id))}/respond`,
        { result },
      );
    } catch (error) {
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
    if (threadId) {
      try {
        await this.deps.request("/api/voice/stop", { threadId });
      } catch {}
    }
    this.setState({
      phase: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private releaseLocalResources(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dataChannel?.close();
    this.dataChannel = null;
    this.peer?.close();
    this.peer = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.audio?.pause();
    if (this.audio) this.audio.srcObject = null;
    this.audio = null;
  }

  private setState(state: GlobalVoiceState): void {
    this.state = state;
    this.deps.onState?.(state);
  }
}
