export type AgentStatus =
  | "starting"
  | "running"
  | "idle"
  | "awaiting-permission"
  | "switching-model"
  | "remote-controlled"
  | "error"
  | "killed"
  | "restorable";

export type AuthMethod = "claude.ai" | "api-key" | "unknown";

export type AutoApproveMode = "off" | "session" | "always";

export interface AgentDef {
  name: string;
  description?: string;
  color: string;
  defaultModel?: string;
  tools: string[];
  systemPrompt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  agents: AgentDef[];
}

export interface RunningAgent {
  id: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  defName: string;
  displayName: string;
  color: string;
  status: AgentStatus;
  statusMessage?: string;
  currentModel: string;
  modelLastUpdated: string;
  launchedAt: string;
  updatedAt: string;
  sessionId?: string;
  pid?: number;
  remoteControl: boolean;
  rcUrl?: string;
  qr?: string;
  restorable?: boolean;
}

export interface SourceAgentRef {
  id: string;
  displayName: string;
  defName: string;
  color: string;
}

export interface TranscriptBase {
  id: string;
  agentId: string;
  timestamp: string;
  model?: string;
  sourceAgent?: SourceAgentRef;
}

export type TranscriptEvent =
  | (TranscriptBase & {
      kind: "user";
      text: string;
    })
  | (TranscriptBase & {
      kind: "assistant_text";
      text: string;
    })
  | (TranscriptBase & {
      kind: "tool_use";
      toolUseId: string;
      name: string;
      input: unknown;
      awaitingPermission?: boolean;
    })
  | (TranscriptBase & {
      kind: "tool_result";
      toolUseId: string;
      output: unknown;
      isError?: boolean;
    })
  | (TranscriptBase & {
      kind: "model_switch";
      from?: string;
      to: string;
    })
  | (TranscriptBase & {
      kind: "system";
      text: string;
    });

export interface LaunchRequest {
  projectId: string;
  defName: string;
  displayName?: string;
  model: string;
  initialPrompt?: string;
  remoteControl?: boolean;
  autoApprove?: AutoApproveMode;
}

export interface SendToCommand {
  sourceAgentId: string;
  selectedText: string;
  target:
    | {
        kind: "existing";
        agentId: string;
      }
    | {
        kind: "new";
        projectId: string;
        defName: string;
      };
  framing?: string;
}

export interface Capabilities {
  cliVersion?: string;
  supportsRemoteControl: boolean;
  authMethod: AuthMethod;
  remoteControlReason?: string;
}

export interface AgentSnapshot {
  agents: RunningAgent[];
  transcripts: Record<string, TranscriptEvent[]>;
  capabilities?: Capabilities;
}

export type WsServerEvent =
  | {
      type: "agent.snapshot";
      snapshot: AgentSnapshot;
    }
  | {
      type: "agent.launched";
      agent: RunningAgent;
    }
  | {
      type: "agent.status_changed";
      id: string;
      status: AgentStatus;
      statusMessage?: string;
      updatedAt: string;
    }
  | {
      type: "agent.model_changed";
      id: string;
      model: string;
      previousModel?: string;
      updatedAt: string;
    }
  | {
      type: "agent.transcript";
      id: string;
      event: TranscriptEvent;
    }
  | {
      type: "agent.terminated";
      id: string;
      status: AgentStatus;
      exitCode?: number | null;
      signal?: string | null;
      updatedAt: string;
    }
  | {
      type: "agent.rc_url_ready";
      id: string;
      url: string;
      qr?: string;
      updatedAt: string;
    }
  | {
      type: "agent.error";
      id?: string;
      message: string;
    };

export type WsClientCommand =
  | {
      type: "snapshot";
    }
  | {
      type: "launch";
      request: LaunchRequest;
    }
  | {
      type: "userMessage";
      id: string;
      text: string;
    }
  | {
      type: "kill";
      id: string;
    }
  | {
      type: "setModel";
      id: string;
      model: string;
    }
  | {
      type: "sendTo";
      command: SendToCommand;
    }
  | {
      type: "permission";
      id: string;
      toolUseId: string;
      decision: "approve" | "deny";
    }
  | {
      type: "clear";
      id: string;
    }
  | {
      type: "clearAll";
    }
  | {
      type: "resume";
      id: string;
    };
