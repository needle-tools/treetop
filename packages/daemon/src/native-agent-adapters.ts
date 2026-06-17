export type NativeAgentKind = "claude" | "codex";

export interface NativeAgentTurnRequest {
  agent: string;
  cwd: string;
  text: string;
  sessionId?: string;
}

export interface NativeAgentStartRequest {
  agent: string;
  cwd: string;
}

export interface NativeAgentStartedSession {
  agent: NativeAgentKind;
  sessionId: string;
  cwd: string;
  source?: string;
  model?: string;
}

export interface NativeAgentRun {
  pid: number;
  exited: Promise<unknown>;
  kill(signal?: string): void;
}

export interface NativeAgentAdapter {
  agent: NativeAgentKind;
  startSession?(req: NativeAgentStartRequest): Promise<NativeAgentStartedSession>;
  sendTurn(req: NativeAgentTurnRequest): NativeAgentRun;
}

export interface NativeAgentRegistry {
  startSession(req: NativeAgentStartRequest): Promise<NativeAgentStartedSession>;
  sendTurn(req: NativeAgentTurnRequest): NativeAgentRun;
}

export function createNativeAgentRegistry(adapters: {
  claude: NativeAgentAdapter;
  codex: NativeAgentAdapter;
}): NativeAgentRegistry {
  const byAgent = new Map<string, NativeAgentAdapter>([
    [adapters.claude.agent, adapters.claude],
    [adapters.codex.agent, adapters.codex],
  ]);
  return {
    async startSession(req) {
      const adapter = byAgent.get(req.agent);
      if (!adapter)
        throw new Error(`starting ${req.agent} not supported yet`);
      if (!adapter.startSession)
        throw new Error(`starting ${req.agent} not supported yet`);
      return adapter.startSession(req);
    },
    sendTurn(req) {
      const adapter = byAgent.get(req.agent);
      if (!adapter)
        throw new Error(`sending to ${req.agent} not supported yet`);
      return adapter.sendTurn(req);
    },
  };
}
