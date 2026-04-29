export type AgentStatus =
  | "starting"
  | "running"
  | "idle"
  | "awaiting-permission"
  | "awaiting-input"
  | "switching-model"
  | "remote-controlled"
  | "error"
  | "killed"
  | "paused"
  | "interrupted";

export type AuthMethod = "claude.ai" | "api-key" | "unknown";
export type AgentProvider = "claude" | "codex" | "openai";

export type AutoApproveMode = "off" | "session" | "always";
export type AgentPermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type RemoteControlState = "starting" | "waiting-for-browser" | "connected" | "closed" | "error";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalTokens?: number;
}

export interface PermissionAllowRule {
  id: string;
  provider?: AgentProvider;
  model: string;
  toolName: string;
  command?: string;
  createdAt: string;
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  options: AgentQuestionOption[];
  multiSelect?: boolean;
}

export interface AgentQuestionAnswer {
  questionIndex: number;
  labels: string[];
  otherText?: string;
}

export type AgentPlanDecision = "approve" | "deny" | "keepPlanning" | "other";

export interface AgentDef {
  name: string;
  description?: string;
  color: string;
  provider?: AgentProvider;
  defaultModel?: string;
  tools: string[];
  plugins?: string[];
  systemPrompt: string;
  sourcePath?: string;
  sourceContent?: string;
  builtIn?: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  runtime?: "local" | "wsl";
  wslDistro?: string;
  wslPath?: string;
  agents: AgentDef[];
  builtInAgents?: AgentDef[];
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parentPath?: string;
  homePath: string;
  roots: DirectoryEntry[];
  entries: DirectoryEntry[];
}

export interface ProjectFileEntry {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}

export interface GitChangedFile {
  path: string;
  status: string;
}

export interface GitUnpushedCommit {
  hash: string;
  subject: string;
  authorName?: string;
  committedAt?: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  unpushedCommits?: GitUnpushedCommit[];
  files: GitChangedFile[];
  message?: string;
}

export interface GitWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  prunable?: boolean;
  current?: boolean;
  projectId?: string;
}

export interface GitWorktreeList {
  isRepo: boolean;
  projectId: string;
  repoPath?: string;
  currentPath?: string;
  worktrees: GitWorktree[];
  message?: string;
}

export interface GitWorktreeCreateRequest {
  path?: string;
  branch: string;
  base?: string;
  createBranch?: boolean;
  copyLocalAgentFiles?: boolean;
}

export interface GitWorktreeMergeRequest {
  sourcePath: string;
}

export interface GitWorktreeRemoveRequest {
  path: string;
  force?: boolean;
}

export interface RunningAgent {
  id: string;
  provider?: AgentProvider;
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
  turnStartedAt?: string;
  lastTokenUsage?: TokenUsage;
  sessionId?: string;
  pid?: number;
  remoteControl: boolean;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  thinking?: boolean;
  planMode?: boolean;
  rcUrl?: string;
  qr?: string;
  rcState?: RemoteControlState;
  rcDiagnostics?: string[];
  restorable?: boolean;
  sessionTools?: string[];
  mcpServers?: ClaudeMcpServer[];
  slashCommands?: SlashCommandInfo[];
  activePlugins?: string[];
}

export type SlashCommandSource = "agentcontrol" | "builtin" | "project" | "user" | "plugin" | "session";

export interface SlashCommandInfo {
  command: string;
  description?: string;
  argumentHint?: string;
  source: SlashCommandSource;
  sourcePath?: string;
  interactive?: boolean;
}

export interface SourceAgentRef {
  id: string;
  displayName: string;
  defName: string;
  color: string;
}

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind?: "image" | "file" | "context";
  path?: string;
  relativePath?: string;
  url?: string;
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
      attachments?: MessageAttachment[];
    })
  | (TranscriptBase & {
      kind: "assistant_text";
      text: string;
      streaming?: boolean;
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
      kind: "questions";
      toolUseId?: string;
      questions: AgentQuestion[];
      answered?: boolean;
      answers?: AgentQuestionAnswer[];
    })
  | (TranscriptBase & {
      kind: "plan";
      toolUseId?: string;
      plan: string;
      answered?: boolean;
      decision?: AgentPlanDecision;
      response?: string;
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
  agentSource?: "project" | "builtIn";
  provider?: AgentProvider;
  displayName?: string;
  model: string;
  initialPrompt?: string;
  remoteControl?: boolean;
  permissionMode?: AgentPermissionMode;
  effort?: AgentEffort;
  thinking?: boolean;
  planMode?: boolean;
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
  providers?: ProviderCapability[];
}

export interface ProviderCapability {
  provider: AgentProvider;
  label: string;
  available: boolean;
  version?: string;
  authMethod?: AuthMethod | "chatgpt" | "openai-api";
  command?: string;
  reason?: string;
  supportsRemoteControl?: boolean;
  supportsStreaming?: boolean;
  supportsImages?: boolean;
  supportsTools?: boolean;
  supportsMcp?: boolean;
  supportsPlugins?: boolean;
  supportsResume?: boolean;
}

export interface ModelProfile {
  id: string;
  label?: string;
  provider: AgentProvider;
  default?: boolean;
  supportsThinking?: boolean;
  supportedEfforts?: AgentEffort[];
}

export interface ClaudePlugin {
  name: string;
  version?: string;
  scope?: string;
  enabled: boolean;
}

export interface ClaudeMcpServer {
  name: string;
  status?: string;
}

export interface ClaudeAvailablePlugin {
  pluginId: string;
  name: string;
  description?: string;
  marketplaceName?: string;
  version?: string;
  installCount?: number;
  installed?: boolean;
}

export interface ClaudeMarketplace {
  name: string;
  source?: string;
  repo?: string;
  url?: string;
  path?: string;
  installLocation?: string;
}

export interface ClaudePluginCatalog {
  installed: ClaudePlugin[];
  available: ClaudeAvailablePlugin[];
  marketplaces: ClaudeMarketplace[];
}

export interface AgentSnapshot {
  agents: RunningAgent[];
  transcripts: Record<string, TranscriptEvent[]>;
  capabilities?: Capabilities;
}

export type TerminalStatus = "running" | "exited";

export interface TerminalSession {
  id: string;
  title?: string;
  projectId?: string;
  projectName?: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  startedAt: string;
  updatedAt: string;
  exitCode?: number | null;
  signal?: string | number | null;
}

export interface TerminalSnapshot {
  sessions: TerminalSession[];
  output: Record<string, string[]>;
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
      restorable?: boolean;
      pid?: number;
      turnStartedAt?: string;
      lastTokenUsage?: TokenUsage;
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
      type: "agent.plan_mode_changed";
      id: string;
      planMode: boolean;
      updatedAt: string;
    }
  | {
      type: "agent.permission_mode_changed";
      id: string;
      permissionMode: AgentPermissionMode;
      planMode: boolean;
      updatedAt: string;
    }
  | {
      type: "agent.effort_changed";
      id: string;
      effort: AgentEffort;
      updatedAt: string;
    }
  | {
      type: "agent.thinking_changed";
      id: string;
      thinking: boolean;
      updatedAt: string;
    }
  | {
      type: "agent.session_info_changed";
      id: string;
      tools: string[];
      mcpServers: ClaudeMcpServer[];
      slashCommands: SlashCommandInfo[];
      activePlugins: string[];
      updatedAt: string;
    }
  | {
      type: "agent.transcript";
      id: string;
      event: TranscriptEvent;
    }
  | {
      type: "agent.transcript_updated";
      id: string;
      event: TranscriptEvent;
    }
  | {
      type: "agent.terminated";
      id: string;
      status: AgentStatus;
      statusMessage?: string;
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
      type: "agent.remote_control_changed";
      id: string;
      rcState: RemoteControlState;
      diagnostics: string[];
      statusMessage?: string;
      updatedAt: string;
    }
  | {
      type: "agent.error";
      id?: string;
      message: string;
    }
  | {
      type: "terminal.snapshot";
      snapshot: TerminalSnapshot;
    }
  | {
      type: "terminal.started";
      session: TerminalSession;
      output: string[];
    }
  | {
      type: "terminal.output";
      id: string;
      chunk: string;
      updatedAt: string;
    }
  | {
      type: "terminal.exited";
      id: string;
      exitCode?: number | null;
      signal?: string | number | null;
      updatedAt: string;
    }
  | {
      type: "terminal.cleared";
      id: string;
    }
  | {
      type: "terminal.closed";
      id: string;
    }
  | {
      type: "terminal.renamed";
      id: string;
      title?: string;
      updatedAt: string;
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
      attachments?: MessageAttachment[];
    }
  | {
      type: "injectMessage";
      id: string;
      text: string;
      attachments?: MessageAttachment[];
    }
  | {
      type: "kill";
      id: string;
    }
  | {
      type: "interrupt";
      id: string;
    }
  | {
      type: "setModel";
      id: string;
      model: string;
    }
  | {
      type: "setPlanMode";
      id: string;
      planMode: boolean;
    }
  | {
      type: "setPermissionMode";
      id: string;
      permissionMode: AgentPermissionMode;
    }
  | {
      type: "setEffort";
      id: string;
      effort: AgentEffort;
    }
  | {
      type: "setThinking";
      id: string;
      thinking: boolean;
    }
  | {
      type: "nativeStatus";
      id: string;
    }
  | {
      type: "enablePlugin";
      plugin: string;
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
      type: "answerQuestions";
      id: string;
      eventId: string;
      answers: AgentQuestionAnswer[];
    }
  | {
      type: "answerPlan";
      id: string;
      eventId: string;
      decision: AgentPlanDecision;
      response?: string;
    }
  | {
      type: "clear";
      id: string;
    }
  | {
      type: "clearAll";
      projectId?: string;
    }
  | {
      type: "resume";
      id: string;
    }
  | {
      type: "restart";
      id: string;
    }
  | {
      type: "terminalStart";
      projectId?: string;
      command?: string;
      title?: string;
    }
  | {
      type: "terminalInput";
      id: string;
      input: string;
    }
  | {
      type: "terminalResize";
      id: string;
      cols: number;
      rows: number;
    }
  | {
      type: "terminalKill";
      id: string;
    }
  | {
      type: "terminalClear";
      id: string;
    }
  | {
      type: "terminalClose";
      id: string;
    }
  | {
      type: "terminalRename";
      id: string;
      title?: string;
    };
