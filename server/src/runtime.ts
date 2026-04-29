import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import type {
  AgentDef,
  AgentEffort,
  AgentPlanDecision,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentProvider,
  ClaudeMcpServer,
  AgentSnapshot,
  AgentStatus,
  AgentPermissionMode,
  AutoApproveMode,
  Capabilities,
  LaunchRequest,
  MessageAttachment,
  Project,
  RemoteControlState,
  RunningAgent,
  SendToCommand,
  SlashCommandInfo,
  TranscriptEvent,
  WsServerEvent
} from "@agent-control/shared";
import { createStateWriter, readPersistedState, type PersistedState } from "./persistence.js";
import { DEFAULT_MODEL_PROFILES } from "./config.js";
import { resolveClaudeCommand, resolveCodexInvocation } from "./capabilities.js";
import { listPlugins, supportsPluginProvider } from "./plugins.js";
import { mergeSlashCommands, normalizeSlashCommandInfo, scanSlashCommands } from "./slash-commands.js";
import { isWslProject, windowsPathToWslPath, wslCommandArgs, wslProjectPath } from "./wsl.js";

type Broadcast = (event: WsServerEvent) => void;
type ProjectProvider = () => Project[];
type ClaudeRuntime = "cli" | "api";

interface AgentProcessState {
  agent: RunningAgent;
  def?: AgentDef;
  child?: ChildProcessWithoutNullStreams;
  transcript: TranscriptEvent[];
  streamingAssistantId?: string;
  rawLines: string[];
  stdoutBuffer: string;
  stderrBuffer: string;
  pendingInitialPrompt?: string;
  autoApprove?: AutoApproveMode;
  restartModel?: string;
  restartConfig?: boolean;
  restartConfigAfterTurn?: boolean;
  restartTimer?: NodeJS.Timeout;
  interrupting?: boolean;
  exiting?: boolean;
  activeTurn?: boolean;
  permissionToken?: string;
  permissionMcpConfigPath?: string;
  pendingPermissions?: Map<string, PendingPermissionRequest>;
  pendingQuestions?: Map<string, PendingQuestionRequest>;
  pendingPlans?: Map<string, PendingPlanRequest>;
  rcLastDiagnostic?: string;
  apiAbort?: AbortController;
}

type SpawnCommand = { command: string; args: string[]; cwd: string };

const RAW_LINE_LIMIT = 5000;
const TRANSCRIPT_PERSIST_LIMIT = 1000;
const RC_URL_PATTERN = /https:\/\/claude\.ai\/code(?:[/?#][^\s\u0007\u001b)]*)?/g;
const PERMISSION_MCP_SERVER_NAME = "agentcontrol_permissions";
const PERMISSION_MCP_TOOL_NAME = `mcp__${PERMISSION_MCP_SERVER_NAME}__approval_prompt`;
const PERMISSION_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
interface PendingPermissionRequest {
  toolUseId: string;
  toolName: string;
  input: unknown;
  resolve: (decision: "approve" | "deny") => void;
  timeout: NodeJS.Timeout;
}

interface PendingQuestionRequest {
  toolUseId: string;
  resolve: (message: string) => void;
  timeout: NodeJS.Timeout;
}

interface PendingPlanRequest {
  toolUseId: string;
  resolve: (result: PermissionPromptResult) => void;
  timeout: NodeJS.Timeout;
}

export interface PermissionPromptRequest {
  token?: string;
  toolName: string;
  input: unknown;
  toolUseId: string;
}

export interface PermissionPromptResult {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
}

function now(): string {
  return new Date().toISOString();
}

function transcriptId(): string {
  return nanoid(12);
}

function eventBase(agentId: string, model?: string) {
  return {
    id: transcriptId(),
    agentId,
    timestamp: now(),
    model
  };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function providerForModel(model: string): AgentProvider {
  const lower = model.toLowerCase();
  if (lower.includes("codex")) return "codex";
  if (lower.startsWith("gpt") || lower.startsWith("o")) return "openai";
  return "claude";
}

function isSyntheticModel(model: string | undefined): boolean {
  return model?.trim().toLowerCase() === "<synthetic>";
}

function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isTextLikeAttachment(attachment: MessageAttachment): boolean {
  if (attachment.mimeType.startsWith("text/")) return true;
  return [
    "application/json",
    "application/javascript",
    "application/typescript",
    "application/xml",
    "application/x-yaml",
    "application/yaml"
  ].includes(attachment.mimeType);
}

function readAttachmentContext(attachment: MessageAttachment): string {
  if (!attachment.path || !isTextLikeAttachment(attachment)) {
    return `- ${attachment.relativePath || attachment.name}: ${attachment.path || attachment.url || attachment.id}`;
  }

  try {
    const raw = readFileSync(attachment.path);
    if (raw.includes(0)) {
      return `- ${attachment.relativePath || attachment.name}: binary file at ${attachment.path}`;
    }
    const maxBytes = 180 * 1024;
    const truncated = raw.length > maxBytes;
    const text = raw.subarray(0, maxBytes).toString("utf8");
    const label = attachment.relativePath || attachment.name;
    return [`### ${label}`, "```", text, truncated ? "\n...truncated..." : "", "```"].filter(Boolean).join("\n");
  } catch (error) {
    return `- ${attachment.relativePath || attachment.name}: could not read file (${error instanceof Error ? error.message : String(error)})`;
  }
}

export class AgentRuntimeManager {
  private readonly states = new Map<string, AgentProcessState>();
  private readonly persist: () => void;

  constructor(
    private readonly getProjects: ProjectProvider,
    private readonly broadcast: Broadcast,
    private readonly getCapabilities: () => Capabilities,
    private readonly getClaudeRuntime: () => ClaudeRuntime = () => "cli"
  ) {
    this.cleanupStalePermissionMcpConfigs();
    this.persist = createStateWriter(() => this.persistedState());
  }

  private projectForState(state: AgentProcessState): Project | undefined {
    return this.getProjects().find((project) => project.id === state.agent.projectId);
  }

  private spawnCommand(state: AgentProcessState, command: string, args: string[]): SpawnCommand {
    const project = this.projectForState(state);
    if (project && isWslProject(project)) {
      const lowerCommand = command.toLowerCase();
      const linuxCommand =
        state.agent.provider === "codex"
          ? "codex"
          : lowerCommand.endsWith("claude.cmd") || lowerCommand.endsWith("claude.exe") || lowerCommand === "claude.cmd"
            ? "claude"
            : lowerCommand.endsWith("codex.cmd") || lowerCommand.endsWith("codex.exe") || lowerCommand === "codex.cmd"
              ? "codex"
              : path.basename(command).replace(/\.(cmd|exe|ps1)$/i, "");
      return {
        command: "wsl.exe",
        args: wslCommandArgs(project, linuxCommand, args),
        cwd: process.cwd()
      };
    }
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
      return {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", command, ...args],
        cwd: state.agent.projectPath
      };
    }
    if (process.platform === "win32" && /\.ps1$/i.test(command)) {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
        cwd: state.agent.projectPath
      };
    }
    return {
      command,
      args,
      cwd: state.agent.projectPath
    };
  }

  async loadPersistedState(): Promise<void> {
    const persisted = await readPersistedState();
    for (const agent of persisted.agents) {
      const persistedStatus = agent.status as AgentStatus | "restorable";
      const def = this.findAgentDef(agent);
      const provider = agent.provider || def?.provider || providerForModel(agent.currentModel);
      const currentModel = isSyntheticModel(agent.currentModel)
        ? this.defaultModelForDefinition(def, provider)
        : agent.currentModel;
      const restored: RunningAgent = {
        ...agent,
        provider,
        currentModel,
        status: agent.sessionId ? "paused" : persistedStatus === "restorable" ? "paused" : persistedStatus,
        restorable: Boolean(agent.sessionId),
        updatedAt: now()
      };
      this.states.set(restored.id, {
        agent: restored,
        def,
        transcript: persisted.transcripts[restored.id] || [],
        rawLines: [],
        stdoutBuffer: "",
        stderrBuffer: ""
      });
    }
  }

  listAgents(): RunningAgent[] {
    return [...this.states.values()].map((state) => state.agent);
  }

  snapshot(): AgentSnapshot {
    const transcripts: Record<string, TranscriptEvent[]> = {};
    for (const [id, state] of this.states.entries()) {
      transcripts[id] = state.transcript;
    }
    return {
      agents: this.listAgents(),
      transcripts,
      capabilities: this.getCapabilities()
    };
  }

  async launch(request: LaunchRequest): Promise<RunningAgent> {
    const project = this.getProjects().find((candidate) => candidate.id === request.projectId);
    if (!project) throw new Error("Project not found.");
    const projectDef = project.agents.find((candidate) => candidate.name === request.defName);
    const builtInDef = (project.builtInAgents || []).find((candidate) => candidate.name === request.defName);
    const def = request.agentSource === "builtIn" ? builtInDef || projectDef : projectDef || builtInDef;
    if (!def) throw new Error("Agent definition not found.");

    if (request.remoteControl) {
      throw new Error("Remote Control is temporarily unavailable until Claude exposes stable CLI transcript and input controls.");
    }
    const provider = request.provider || def.provider || providerForModel(request.model);

    const displayName = this.uniqueDisplayName(project.id, request.displayName?.trim() || def.name);
    const timestamp = now();
    const permissionMode = this.initialPermissionMode(request);
    const currentModel = isSyntheticModel(request.model) ? this.defaultModelForDefinition(def, provider) : request.model;
    const agent: RunningAgent = {
      id: nanoid(),
      provider,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      defName: def.name,
      displayName,
      color: def.color,
      status: "starting",
      currentModel,
      modelLastUpdated: timestamp,
      launchedAt: timestamp,
      updatedAt: timestamp,
      remoteControl: false,
      permissionMode,
      effort: request.effort || "medium",
      thinking: request.thinking ?? true,
      planMode: permissionMode === "plan",
      slashCommands: [],
      activePlugins: supportsPluginProvider(provider) ? def.plugins || [] : []
    };

    const state: AgentProcessState = {
      agent,
      def,
      transcript: [],
      rawLines: [],
      stdoutBuffer: "",
      stderrBuffer: "",
      permissionToken: nanoid(32),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      pendingPlans: new Map(),
      pendingInitialPrompt: request.initialPrompt?.trim() || undefined,
      autoApprove: request.autoApprove
    };
    this.states.set(agent.id, state);
    this.broadcast({ type: "agent.launched", agent });
    this.persist();
    void this.refreshSlashCommands(state, project, def, provider);

    if (provider === "openai") {
      this.setStatus(state, process.env.OPENAI_API_KEY ? "idle" : "error", process.env.OPENAI_API_KEY ? undefined : "OPENAI_API_KEY is not set.");
    } else if (provider === "codex") {
      this.setStatus(state, "idle");
    } else if (this.isClaudeApi(state)) {
      this.setStatus(
        state,
        process.env.ANTHROPIC_API_KEY ? "idle" : "error",
        process.env.ANTHROPIC_API_KEY ? undefined : "ANTHROPIC_API_KEY is not set."
      );
      if (process.env.ANTHROPIC_API_KEY && state.pendingInitialPrompt) {
        const initial = state.pendingInitialPrompt;
        state.pendingInitialPrompt = undefined;
        this.userMessage(state.agent.id, initial);
      }
    } else {
      this.spawnStandard(state);
    }

    return agent;
  }

  private async refreshSlashCommands(state: AgentProcessState, project: Project, def: AgentDef, provider: AgentProvider): Promise<void> {
    try {
      const installedPlugins = supportsPluginProvider(provider) ? await listPlugins(provider).catch(() => []) : [];
      const slashCommands = await scanSlashCommands(project.path, installedPlugins, def.plugins || [], provider).catch(() => []);
      if (this.states.get(state.agent.id) !== state) return;
      state.agent.slashCommands = slashCommands;
      state.agent.updatedAt = now();
      this.broadcast({
        type: "agent.session_info_changed",
        id: state.agent.id,
        tools: state.agent.sessionTools || [],
        mcpServers: state.agent.mcpServers || [],
        slashCommands,
        activePlugins: state.agent.activePlugins || [],
        updatedAt: state.agent.updatedAt
      });
      this.persist();
    } catch {
      // Slash command discovery is auxiliary; launching the process should not wait on it.
    }
  }

  resume(id: string): void {
    const state = this.requiredState(id);
    if (!state.agent.sessionId) throw new Error("Agent has no resumable session.");
    this.reconnectStandard(state, "Resuming Claude session...");
  }

  userMessage(id: string, text: string, sourceAgent?: TranscriptEvent["sourceAgent"], attachments: MessageAttachment[] = []): void {
    const state = this.requiredState(id);
    if (state.agent.remoteControl) {
      this.remoteControlUserMessage(state, text, attachments);
      return;
    }
    if (state.agent.provider === "openai" || state.agent.provider === "codex" || this.isClaudeApi(state)) {
      void this.providerUserMessage(state, text, sourceAgent, attachments).catch((error: unknown) => {
        state.activeTurn = false;
        this.finishAssistantStream(state, false);
        this.setStatus(state, "error", error instanceof Error ? error.message : String(error));
      });
      return;
    }
    const child = this.ensureStandardProcess(state, "Reconnecting Claude before sending...");

    const trimmed = text.trim();
    const imageAttachments = attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
    const contextAttachments = attachments.filter((attachment) => !attachment.mimeType.startsWith("image/"));
    if (!trimmed && attachments.length === 0) return;

    const attachmentNote = imageAttachments.length
      ? [
          "Attached image file(s):",
          ...imageAttachments.map((attachment) => `- ${attachment.name}: ${attachment.path || attachment.url || attachment.id}`)
        ].join("\n")
      : "";
    const contextNote = contextAttachments.length
      ? [
          "Attached context file(s):",
          ...contextAttachments.map((attachment) => `- ${attachment.relativePath || attachment.name}`)
        ].join("\n")
      : "";
    const fallbackText =
      imageAttachments.length && contextAttachments.length
        ? "Please inspect the attached image(s) and use the attached context file(s)."
        : imageAttachments.length
          ? "Please inspect the attached image(s)."
          : contextAttachments.length
            ? "Please use the attached context file(s)."
            : "";
    const displayText = [trimmed || fallbackText, attachmentNote, contextNote]
      .filter(Boolean)
      .join("\n\n");
    const contextPayload = contextAttachments.length
      ? ["Context file contents:", ...contextAttachments.map(readAttachmentContext)].join("\n\n")
      : "";
    const payloadText = [trimmed || fallbackText, attachmentNote, contextPayload]
      .filter(Boolean)
      .join("\n\n");

    const event: TranscriptEvent = {
      ...eventBase(id, state.agent.currentModel),
      kind: "user",
      text: displayText,
      sourceAgent,
      attachments
    };
    this.pushTranscript(state, event);
    state.activeTurn = true;
    this.setStatus(state, "running");

    const content: Record<string, unknown>[] = [{ type: "text", text: payloadText }];
    for (const attachment of imageAttachments) {
      if (!attachment.path) continue;
      try {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: attachment.mimeType,
            data: readFileSync(attachment.path).toString("base64")
          }
        });
      } catch (error) {
        this.pushTranscript(state, {
          ...eventBase(id, state.agent.currentModel),
          kind: "system",
          text: `Could not attach image ${attachment.name}: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }

    const payload = {
      type: "user",
      message: {
        role: "user",
        content
      }
    };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private remoteControlUserMessage(state: AgentProcessState, text: string, attachments: MessageAttachment[] = []): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (attachments.length > 0) throw new Error("Remote Control stdin bridge does not support attachments.");
    if (!state.child || state.child.killed || !state.child.stdin.writable) {
      throw new Error("Remote Control process is not running.");
    }
    this.pushTranscript(state, {
      ...eventBase(state.agent.id, state.agent.currentModel),
      kind: "user",
      text: trimmed
    });
    state.child.stdin.write(`${trimmed}\n`);
    this.addRemoteControlDiagnostic(state, "stdin", trimmed);
  }

  kill(id: string): void {
    const state = this.requiredState(id);
    state.exiting = true;
    this.denyPendingPermissions(state);
    state.apiAbort?.abort();
    state.apiAbort = undefined;
    if (state.agent.remoteControl) {
      if (state.child && !state.child.killed) {
        this.updateRemoteControlState(state, "closed", "Closing Remote Control session...");
        this.stopProcessTree(state);
        setTimeout(() => {
          if (this.states.get(state.agent.id) === state) this.removeExitedAgent(state);
        }, 5000);
      } else {
        this.updateRemoteControlState(state, "closed", "Remote Control closed.");
        this.removeExitedAgent(state);
      }
      return;
    }
    if (state.child && !state.child.killed) {
      this.stopProcessTree(state);
    } else {
      this.removeExitedAgent(state);
    }
  }

  setModel(id: string, model: string): void {
    const state = this.requiredState(id);
    if (state.agent.remoteControl) throw new Error("Remote Control agents cannot switch models from the dashboard.");
    if (state.agent.provider === "openai" || state.agent.provider === "codex" || this.isClaudeApi(state)) {
      this.updateModel(state, model);
      this.setStatus(state, "idle");
      return;
    }
    const child = this.ensureStandardProcess(state, "Reconnecting Claude before switching models...");

    this.setStatus(state, "switching-model", `Switching to ${model}...`);
    if (process.env.FORCE_FALLBACK_MODEL_SWITCH === "1") {
      this.fallbackModelSwitch(state, model);
      return;
    }

    try {
      child.stdin.write(`${JSON.stringify({ type: "control", subtype: "set_model", model })}\n`);
      this.updateModel(state, model);
      this.setStatus(state, "idle");
    } catch {
      this.fallbackModelSwitch(state, model);
    }
  }

  setPlanMode(id: string, planMode: boolean): void {
    this.setPermissionMode(id, planMode ? "plan" : "default");
  }

  setPermissionMode(id: string, permissionMode: AgentPermissionMode): void {
    const state = this.requiredState(id);
    if (state.agent.remoteControl) throw new Error("Remote Control agents cannot change mode from the dashboard.");

    state.agent.permissionMode = permissionMode;
    state.agent.planMode = permissionMode === "plan";
    state.agent.updatedAt = now();
    const deferredRestart = Boolean(state.activeTurn);
    const restarted = state.agent.provider === "claude" ? this.requestConfigRestart(state) : false;
    this.pushTranscript(state, {
      ...eventBase(state.agent.id, state.agent.currentModel),
      kind: "system",
      text: restarted && deferredRestart
        ? `Mode changed to ${this.permissionModeLabel(permissionMode)}. Claude will apply it after the current response.`
        : `Mode changed to ${this.permissionModeLabel(permissionMode)}.`
    });
    this.broadcast({
      type: "agent.permission_mode_changed",
      id: state.agent.id,
      permissionMode,
      planMode: state.agent.planMode,
      updatedAt: state.agent.updatedAt
    });
    this.broadcast({
      type: "agent.plan_mode_changed",
      id: state.agent.id,
      planMode: state.agent.planMode,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }

  setEffort(id: string, effort: AgentEffort): void {
    const state = this.requiredState(id);
    if (state.agent.remoteControl) throw new Error("Remote Control agents cannot change effort from the dashboard.");

    state.agent.effort = effort;
    state.agent.updatedAt = now();
    if (state.agent.provider === "claude" && state.child && !state.child.killed) {
      this.sendCliSlashCommand(state, `/effort ${effort}`);
    }
    this.pushTranscript(state, {
      ...eventBase(state.agent.id, state.agent.currentModel),
      kind: "system",
      text: `Effort changed to ${effort}.`
    });
    this.broadcast({
      type: "agent.effort_changed",
      id: state.agent.id,
      effort,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }

  setThinking(id: string, thinking: boolean): void {
    const state = this.requiredState(id);
    if (state.agent.remoteControl) throw new Error("Remote Control agents cannot change thinking from the dashboard.");

    state.agent.thinking = thinking;
    state.agent.updatedAt = now();
    const deferredRestart = Boolean(state.activeTurn);
    const restarted = state.agent.provider === "claude" ? this.requestConfigRestart(state) : false;
    this.pushTranscript(state, {
      ...eventBase(state.agent.id, state.agent.currentModel),
      kind: "system",
      text: restarted && deferredRestart
        ? `Thinking ${thinking ? "enabled" : "disabled"}. Claude will apply it after the current response.`
        : `Thinking ${thinking ? "enabled" : "disabled"}.`
    });
    this.broadcast({
      type: "agent.thinking_changed",
      id: state.agent.id,
      thinking,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }

  nativeStatus(id: string): void {
    const state = this.requiredState(id);
    const agent = state.agent;
    const lines = [
      `Status: ${this.statusLabel(agent.status)}`,
      `Model: ${agent.currentModel}`,
      `Mode: ${this.permissionModeLabel(this.permissionMode(state))}`,
      `Effort: ${agent.effort || "medium"}`,
      `Thinking: ${agent.thinking === false ? "off" : "on"}`,
      `Project: ${agent.projectName}`,
      `Session: ${agent.sessionId || "not started yet"}`,
      `Process: ${agent.pid ? `pid ${agent.pid}` : "not running"}`,
      `Tools: ${(agent.sessionTools || []).length}`,
      `MCP servers: ${(agent.mcpServers || []).length}`,
      `Slash commands: ${(agent.slashCommands || []).length}`,
      `Active plugins: ${(agent.activePlugins || []).length ? (agent.activePlugins || []).join(", ") : "none"}`,
      `Last activity: ${agent.updatedAt}`
    ];
    this.pushTranscript(state, {
      ...eventBase(agent.id, agent.currentModel),
      kind: "system",
      text: lines.join("\n")
    });
  }

  sendTo(command: SendToCommand): void {
    if (command.target.kind !== "existing") return;

    const source = this.requiredState(command.sourceAgentId).agent;
    const target = this.requiredState(command.target.agentId);
    if (target.agent.remoteControl) throw new Error("Remote Control agents cannot receive forwarded dashboard messages.");

    const quoted = command.selectedText
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n");
    const text = [
      `> Forwarded from ${source.displayName} (${source.currentModel}):`,
      ">",
      quoted,
      "",
      command.framing?.trim() || ""
    ]
      .join("\n")
      .trim();

    this.userMessage(target.agent.id, text, {
      id: source.id,
      displayName: source.displayName,
      defName: source.defName,
      color: source.color
    });
  }

  permission(id: string, toolUseId: string, decision: "approve" | "deny"): void {
    const state = this.requiredState(id);
    const child = this.ensureStandardProcess(state, "Reconnecting Claude before applying permission...");
    const pending = state.pendingPermissions?.get(toolUseId);
    if (pending) {
      clearTimeout(pending.timeout);
      state.pendingPermissions?.delete(toolUseId);
      pending.resolve(decision);
    } else {
      child.stdin.write(`${JSON.stringify({ type: "control", subtype: "tool_permission", tool_use_id: toolUseId, decision })}\n`);
    }
    this.resolveToolPermission(state, toolUseId);
    state.activeTurn = true;
    this.setStatus(state, "running");
  }

  answerQuestions(id: string, eventId: string, answers: AgentQuestionAnswer[]): void {
    const state = this.requiredState(id);
    const event = state.transcript.find((candidate) => candidate.id === eventId);
    if (event?.kind !== "questions") throw new Error("Question request not found.");
    if (event.answered) throw new Error("Question request was already answered.");
    const normalizedAnswers = this.normalizeQuestionAnswers(event.questions, answers);
    this.updateTranscript(state, {
      ...event,
      answered: true,
      answers: normalizedAnswers,
      timestamp: now()
    });
    const answerText = this.formatQuestionAnswers(event.questions, normalizedAnswers);
    if (event.toolUseId) {
      const answeredViaTool = this.answerQuestionToolUse(state, event.toolUseId, answerText);
      if (answeredViaTool) return;
    }
    this.userMessage(id, answerText);
  }

  answerPlan(id: string, eventId: string, decision: AgentPlanDecision, response?: string): void {
    const state = this.requiredState(id);
    const event = state.transcript.find((candidate) => candidate.id === eventId);
    if (event?.kind !== "plan") throw new Error("Plan request not found.");
    if (event.answered) throw new Error("Plan request was already answered.");
    const normalizedResponse = response?.trim();
    this.updateTranscript(state, {
      ...event,
      answered: true,
      decision,
      ...(normalizedResponse ? { response: normalizedResponse } : {}),
      timestamp: now()
    });
    if (decision === "approve" && state.agent.permissionMode === "plan") {
      this.setPermissionMode(id, "default");
    }
    if (event.toolUseId) {
      const answeredViaTool = this.answerPlanToolUse(state, event.toolUseId, decision, this.formatPlanAnswer(decision, normalizedResponse));
      if (answeredViaTool) return;
    }
    this.userMessage(id, this.formatPlanAnswer(decision, normalizedResponse));
  }

  private async providerUserMessage(
    state: AgentProcessState,
    text: string,
    sourceAgent?: TranscriptEvent["sourceAgent"],
    attachments: MessageAttachment[] = []
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (state.activeTurn) throw new Error("Agent is still responding.");

    const imageAttachments = attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
    const contextAttachments = attachments.filter((attachment) => !attachment.mimeType.startsWith("image/"));
    const fallbackText =
      imageAttachments.length && contextAttachments.length
        ? "Please inspect the attached image(s) and use the attached context file(s)."
        : imageAttachments.length
          ? "Please inspect the attached image(s)."
          : contextAttachments.length
            ? "Please use the attached context file(s)."
            : "";
    const attachmentNote = imageAttachments.length
      ? ["Attached image file(s):", ...imageAttachments.map((attachment) => `- ${attachment.name}: ${attachment.path || attachment.url || attachment.id}`)].join("\n")
      : "";
    const contextNote = contextAttachments.length
      ? ["Attached context file(s):", ...contextAttachments.map((attachment) => `- ${attachment.relativePath || attachment.name}`)].join("\n")
      : "";
    const contextPayload = contextAttachments.length
      ? ["Context file contents:", ...contextAttachments.map(readAttachmentContext)].join("\n\n")
      : "";
    const displayText = [trimmed || fallbackText, attachmentNote, contextNote].filter(Boolean).join("\n\n");
    const payloadText = [trimmed || fallbackText, attachmentNote, contextPayload].filter(Boolean).join("\n\n");

    this.pushTranscript(state, {
      ...eventBase(state.agent.id, state.agent.currentModel),
      kind: "user",
      text: displayText,
      sourceAgent,
      attachments
    });
    state.activeTurn = true;
    this.setStatus(state, "running");

    if (state.agent.provider === "codex") {
      await this.runCodexTurn(state, payloadText);
    } else if (this.isClaudeApi(state)) {
      await this.runAnthropicTurn(state, payloadText, imageAttachments);
    } else {
      await this.runOpenAiTurn(state, payloadText, imageAttachments);
    }
  }

  private isClaudeApi(state: AgentProcessState): boolean {
    return state.agent.provider === "claude" && !state.agent.remoteControl && this.getClaudeRuntime() === "api";
  }

  private async runCodexTurn(state: AgentProcessState, prompt: string): Promise<void> {
    const args = ["exec", "--json", "-m", state.agent.currentModel];
    args.push("-c", `model_reasoning_effort=${tomlBasicString(this.providerReasoningEffort(state))}`);
    const selectedPlugins = new Set(state.def?.plugins || []);
    const installedPlugins = await listPlugins("codex").catch(() => []);
    for (const plugin of installedPlugins) {
      args.push("-c", `plugins.${tomlBasicString(plugin.name)}.enabled=${selectedPlugins.has(plugin.name) ? "true" : "false"}`);
    }
    for (const plugin of selectedPlugins) {
      if (!installedPlugins.some((installed) => installed.name === plugin)) args.push("-c", `plugins.${tomlBasicString(plugin)}.enabled=true`);
    }
    args.push("-");
    const codexInvocation = resolveCodexInvocation();
    const command = this.spawnCommand(state, codexInvocation.command, [...codexInvocation.args, ...args]);
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: { ...process.env },
      windowsHide: true
    });
    state.child = child;
    state.agent.pid = child.pid;
    state.agent.updatedAt = now();
    this.persist();

    await new Promise<void>((resolve, reject) => {
      child.stdin.on("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        state.stdoutBuffer = this.consumeLines(`${state.stdoutBuffer}${chunk.toString("utf8")}`, (line) => {
          this.storeRawLine(state, line);
          this.handleCodexLine(state, line);
        });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        state.stderrBuffer = this.consumeLines(`${state.stderrBuffer}${chunk.toString("utf8")}`, (line) => {
          this.storeRawLine(state, `[stderr] ${line}`);
          if (this.shouldShowCodexStderrLine(line)) {
            this.pushTranscript(state, {
              ...eventBase(state.agent.id, state.agent.currentModel),
              kind: "system",
              text: line
            });
          }
        });
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        state.child = undefined;
        state.agent.pid = undefined;
        state.activeTurn = false;
        this.finishAssistantStream(state, false);
        if (state.interrupting) {
          state.interrupting = false;
          this.setStatus(state, "interrupted");
        } else if (code && code !== 0) this.setStatus(state, "error", `Codex exited with code ${code}.`);
        else this.setStatus(state, "idle");
        resolve();
      });
      child.stdin.end(prompt);
    });
  }

  private handleCodexLine(state: AgentProcessState, line: string): void {
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      const type = String(payload.type || "");
      const text = this.extractCodexText(payload);
      if (text) {
        const completedItem = this.isCodexCompletedItem(payload);
        this.appendAssistantText(state, text, completedItem, !completedItem);
        return;
      }
      if (type === "turn.completed") {
        this.finishAssistantStream(state, false);
        state.activeTurn = false;
        this.setStatus(state, "idle");
        return;
      }
      if (type === "thread.started") {
        const threadId = this.trimmedStringField(payload.thread_id) || this.trimmedStringField(payload.threadId);
        if (threadId) state.agent.sessionId = threadId;
        return;
      }
      if (type.includes("tool") || payload.tool || payload.command) {
        const toolUseId = this.trimmedStringField(payload.id) || transcriptId();
        this.pushTranscript(state, {
          ...eventBase(state.agent.id, state.agent.currentModel),
          kind: "tool_use",
          toolUseId,
          name: this.trimmedStringField(payload.name) || this.trimmedStringField(payload.tool) || "codex",
          input: payload.input ?? payload.command ?? payload
        });
      }
    } catch {
      this.appendAssistantText(state, `${line}\n`);
    }
  }

  private extractCodexText(payload: Record<string, unknown>): string | undefined {
    const item = payload.item && typeof payload.item === "object" ? (payload.item as Record<string, unknown>) : undefined;
    const direct = this.extractTextDelta(payload) || this.textField(payload.message) || this.textField(item?.text);
    if (direct) return direct;

    const content = Array.isArray(item?.content)
      ? item.content
      : Array.isArray(payload.content)
        ? payload.content
        : undefined;
    if (!content) return undefined;
    const parts = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        const value = block as Record<string, unknown>;
        return this.textField(value.text) || this.textField(value.content) || "";
      })
      .filter(Boolean);
    return parts.length ? parts.join("") : undefined;
  }

  private isCodexCompletedItem(payload: Record<string, unknown>): boolean {
    return String(payload.type || "") === "item.completed";
  }

  private shouldShowCodexStderrLine(line: string): boolean {
    const lower = line.toLowerCase();
    if (
      lower.includes("warn codex_core::plugins") ||
      lower.includes("warn codex_core_plugins::manifest") ||
      lower.includes("warn codex_analytics::client") ||
      lower.includes("failed to warm featured plugin ids cache") ||
      lower.includes("startup remote plugin sync failed") ||
      lower.includes("failed to record rollout items") ||
      lower.includes("/backend-api/plugins/") ||
      lower.includes("/backend-api/codex/analytics-events/")
    ) {
      return false;
    }
    if (/^\s*<\/?[a-z][^>]*>/i.test(line)) return false;
    if (/^\s*(window\._cf_chl_opt|var a = document\.createElement|history\.replaceState|document\.getElementsByTagName)/.test(line)) return false;
    return true;
  }

  private async runAnthropicTurn(state: AgentProcessState, prompt: string, images: MessageAttachment[]): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
    const controller = new AbortController();
    state.apiAbort = controller;
    const content: Record<string, unknown>[] = [{ type: "text", text: prompt }];
    for (const attachment of images) {
      if (!attachment.path) continue;
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: readFileSync(attachment.path).toString("base64")
        }
      });
    }

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: state.agent.currentModel,
          system: state.def?.systemPrompt || undefined,
          messages: [{ role: "user", content }],
          max_tokens: 8192,
          stream: true
        })
      });
      if (!response.ok || !response.body) throw new Error(await response.text());

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\n\n/);
        buffer = parts.pop() || "";
        for (const part of parts) this.handleAnthropicSse(state, part);
      }
      if (buffer.trim()) this.handleAnthropicSse(state, buffer);
      this.finishAssistantStream(state, false);
      state.activeTurn = false;
      this.setStatus(state, "idle");
    } catch (error) {
      state.activeTurn = false;
      this.finishAssistantStream(state, false);
      if ((error as { name?: string }).name === "AbortError") {
        this.setStatus(state, "interrupted");
        return;
      }
      throw error;
    } finally {
      state.apiAbort = undefined;
    }
  }

  private handleAnthropicSse(state: AgentProcessState, chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      this.storeRawLine(state, data);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(payload.type || "");
      if (type === "content_block_delta") {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (typeof delta?.text === "string") this.appendAssistantText(state, delta.text);
      } else if (type === "content_block_start") {
        const block = payload.content_block as Record<string, unknown> | undefined;
        if (typeof block?.text === "string") this.appendAssistantText(state, block.text);
      } else if (type === "message_stop") {
        this.finishAssistantStream(state, false);
      } else if (type === "error") {
        this.setStatus(state, "error", stringifyUnknown(payload.error || payload));
      }
    }
  }

  private async runOpenAiTurn(state: AgentProcessState, prompt: string, images: MessageAttachment[]): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
    const controller = new AbortController();
    state.apiAbort = controller;
    const content: Record<string, unknown>[] = [{ type: "input_text", text: prompt }];
    for (const attachment of images) {
      if (!attachment.path) continue;
      content.push({
        type: "input_image",
        image_url: `data:${attachment.mimeType};base64,${readFileSync(attachment.path).toString("base64")}`
      });
    }

    try {
      const body: Record<string, unknown> = {
        model: state.agent.currentModel,
        instructions: state.def?.systemPrompt || undefined,
        input: [{ role: "user", content }],
        reasoning: { effort: this.providerReasoningEffort(state) },
        stream: true
      };
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (!response.ok || !response.body) throw new Error(await response.text());

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\n\n/);
        buffer = parts.pop() || "";
        for (const part of parts) this.handleOpenAiSse(state, part);
      }
      if (buffer.trim()) this.handleOpenAiSse(state, buffer);
      this.finishAssistantStream(state, false);
      state.activeTurn = false;
      this.setStatus(state, "idle");
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        state.activeTurn = false;
        this.finishAssistantStream(state, false);
        this.setStatus(state, "interrupted");
        return;
      }
      throw error;
    } finally {
      state.apiAbort = undefined;
    }
  }

  private handleOpenAiSse(state: AgentProcessState, chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      this.storeRawLine(state, data);
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(payload.type || "");
      if (type === "response.output_text.delta" && typeof payload.delta === "string") {
        this.appendAssistantText(state, payload.delta);
      } else if (type === "response.completed") {
        this.finishAssistantStream(state, false);
      } else if (type === "response.failed" || type === "error") {
        this.setStatus(state, "error", stringifyUnknown(payload.error || payload));
      } else if (type.includes("tool") || type.includes("function_call")) {
        this.pushTranscript(state, {
          ...eventBase(state.agent.id, state.agent.currentModel),
          kind: "tool_use",
          toolUseId: this.trimmedStringField(payload.item_id) || this.trimmedStringField(payload.output_index) || transcriptId(),
          name: type,
          input: payload
        });
      }
    }
  }

  async requestPermission(id: string, request: PermissionPromptRequest): Promise<PermissionPromptResult> {
    const state = this.requiredState(id);
    if (!state.permissionToken || request.token !== state.permissionToken) {
      throw new Error("Permission request token is invalid.");
    }
    const toolUseId = request.toolUseId.trim();
    if (!toolUseId) throw new Error("Permission request is missing a tool use id.");

    const questionRequest = this.extractAskUserQuestionRequest(request.toolName || "tool", request.input ?? {});
    if (questionRequest) {
      this.pushQuestionRequest(state, questionRequest, toolUseId);
      const message = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          state.pendingQuestions?.delete(toolUseId);
          resolve("No answer was provided before the AgentControl question prompt timed out.");
        }, PERMISSION_REQUEST_TIMEOUT_MS);
        state.pendingQuestions ??= new Map();
        state.pendingQuestions.set(toolUseId, { toolUseId, resolve, timeout });
      });
      return {
        behavior: "deny",
        message
      };
    }

    const planRequest = this.extractExitPlanModeRequest(request.toolName || "tool", request.input ?? {});
    if (planRequest) {
      this.pushPlanRequest(state, planRequest, toolUseId);
      return await new Promise<PermissionPromptResult>((resolve) => {
        const timeout = setTimeout(() => {
          state.pendingPlans?.delete(toolUseId);
          resolve({
            behavior: "deny",
            message: "No plan decision was provided before the AgentControl plan prompt timed out."
          });
        }, PERMISSION_REQUEST_TIMEOUT_MS);
        state.pendingPlans ??= new Map();
        state.pendingPlans.set(toolUseId, { toolUseId, resolve, timeout });
      });
    }

    this.markToolAwaitingPermission(state, {
      toolUseId,
      name: request.toolName || "tool",
      input: request.input ?? {}
    });

    const decision = await new Promise<"approve" | "deny">((resolve) => {
      const timeout = setTimeout(() => {
        state.pendingPermissions?.delete(toolUseId);
        this.resolveToolPermission(state, toolUseId);
        resolve("deny");
      }, PERMISSION_REQUEST_TIMEOUT_MS);
      state.pendingPermissions ??= new Map();
      state.pendingPermissions.set(toolUseId, {
        toolUseId,
        toolName: request.toolName || "tool",
        input: request.input ?? {},
        resolve,
        timeout
      });
    });

    if (decision === "approve") {
      return {
        behavior: "allow",
        updatedInput: request.input ?? {}
      };
    }

    return {
      behavior: "deny",
      message: "Denied in AgentControl."
    };
  }

  clear(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.transcript = [];
    state.streamingAssistantId = undefined;
    state.rawLines = [];
    state.activeTurn = false;
    this.broadcast({ type: "agent.snapshot", snapshot: this.snapshot() });
    this.persist();
  }

  interrupt(id: string): void {
    const state = this.requiredState(id);
    if (state.apiAbort) {
      state.apiAbort.abort();
      state.apiAbort = undefined;
      state.activeTurn = false;
      this.finishAssistantStream(state, false);
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "system",
        text: "Interrupted current response."
      });
      this.setStatus(state, "interrupted");
      return;
    }
    if (!state.child || state.child.killed) return;
    state.interrupting = true;
    state.activeTurn = false;
    this.denyPendingPermissions(state);
    this.finishAssistantStream(state, false);
    this.pushTranscript(state, {
      ...eventBase(state.agent.id, state.agent.currentModel),
      kind: "system",
      text: "Interrupted current response."
    });
    state.child.kill();
  }

  rawLines(id: string): string[] {
    return this.states.get(id)?.rawLines.slice() || [];
  }

  clearAll(projectId?: string): void {
    for (const state of this.states.values()) {
      if (projectId && state.agent.projectId !== projectId) continue;
      state.exiting = true;
      this.stopProcessTree(state);
      this.states.delete(state.agent.id);
    }
    this.broadcast({ type: "agent.snapshot", snapshot: this.snapshot() });
    this.persist();
  }

  private persistedState(): PersistedState {
    const transcripts: Record<string, TranscriptEvent[]> = {};
    const agents = this.listAgents();
    for (const [id, state] of this.states.entries()) {
      transcripts[id] = state.transcript.slice(-TRANSCRIPT_PERSIST_LIMIT);
    }
    return { agents, transcripts };
  }

  private uniqueDisplayName(projectId: string, base: string): string {
    const existing = new Set(
      [...this.states.values()]
        .filter((state) => state.agent.projectId === projectId)
        .map((state) => state.agent.displayName)
    );
    if (!existing.has(base)) return base;
    let suffix = 2;
    while (existing.has(`${base} #${suffix}`)) suffix += 1;
    return `${base} #${suffix}`;
  }

  private requiredState(id: string): AgentProcessState {
    const state = this.states.get(id);
    if (!state) throw new Error("Agent not found.");
    return state;
  }

  private ensureStandardProcess(state: AgentProcessState, statusMessage: string): ChildProcessWithoutNullStreams {
    if (state.agent.remoteControl) throw new Error("Remote Control agents do not use a dashboard chat process.");
    if (state.agent.provider && state.agent.provider !== "claude") throw new Error("Agent does not use a persistent Claude process.");
    if (state.child && !state.child.killed) return state.child;
    this.reconnectStandard(state, statusMessage);
    if (!state.child || state.child.killed) throw new Error("Agent process is not running.");
    return state.child;
  }

  private reconnectStandard(state: AgentProcessState, statusMessage: string): void {
    state.child = undefined;
    state.agent.pid = undefined;
    state.agent.restorable = false;
    state.interrupting = false;
    state.exiting = false;
    this.setStatus(state, "starting", statusMessage);
    this.spawnStandard(state, state.agent.sessionId, state.agent.currentModel);
  }

  private spawnStandard(state: AgentProcessState, resumeSessionId?: string, modelOverride?: string): void {
    const model = modelOverride || state.agent.currentModel;
    const args = resumeSessionId
      ? [
          "--print",
          "--verbose",
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
          "--resume",
          resumeSessionId,
          "--model",
          model,
          "--append-system-prompt",
          state.def?.systemPrompt || ""
        ]
      : [
          "--print",
          "--verbose",
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
          "--append-system-prompt",
          state.def?.systemPrompt || "",
          "--model",
          model
        ];

    args.push(
      "--permission-mode",
      this.permissionMode(state),
      "--effort",
      state.agent.effort || "medium",
      "--settings",
      JSON.stringify({ alwaysThinkingEnabled: state.agent.thinking !== false })
    );
    const permissionMcpConfig = this.writePermissionMcpConfig(state);
    const project = this.projectForState(state);
    const mcpConfigArg = isWslProject(project) ? windowsPathToWslPath(permissionMcpConfig) : permissionMcpConfig;
    args.push(
      "--mcp-config",
      mcpConfigArg,
      "--permission-prompt-tool",
      PERMISSION_MCP_TOOL_NAME,
      "--allowedTools",
      PERMISSION_MCP_TOOL_NAME
    );

    const child = spawn(resolveClaudeCommand(), args, {
      cwd: state.agent.projectPath,
      windowsHide: true
    });
    state.child = child;
    state.agent.pid = child.pid;
    state.agent.updatedAt = now();
    this.persist();

    child.stdout.on("data", (chunk: Buffer) => {
      state.stdoutBuffer = this.consumeLines(`${state.stdoutBuffer}${chunk.toString("utf8")}`, (line) => {
        this.storeRawLine(state, line);
        this.handleStreamJsonLine(state, line);
      });
    });

    child.stderr.on("data", (chunk: Buffer) => {
      state.stderrBuffer = this.consumeLines(`${state.stderrBuffer}${chunk.toString("utf8")}`, (line) => {
        console.error(`[${state.agent.displayName}] ${line}`);
      });
    });

    child.on("error", (error) => {
      this.setStatus(state, "error", error.message);
    });

    child.on("exit", (code, signal) => {
      if (state.interrupting) {
        state.interrupting = false;
        state.child = undefined;
        state.agent.pid = undefined;
        state.agent.restorable = Boolean(state.agent.sessionId);
        this.setStatus(state, state.agent.sessionId ? "paused" : "interrupted");
        if (!state.agent.sessionId) {
          setTimeout(() => this.spawnStandard(state), 250);
        }
        return;
      }
      if (state.restartModel) {
        const nextModel = state.restartModel;
        state.restartModel = undefined;
        if (state.restartTimer) clearTimeout(state.restartTimer);
        this.spawnStandard(state, state.agent.sessionId, nextModel);
        return;
      }
      if (state.restartConfig) {
        state.restartConfig = false;
        this.spawnStandard(state, state.agent.sessionId, state.agent.currentModel);
        return;
      }
      this.markTerminated(state, code, signal);
    });

    this.setStatus(state, "idle");
    if (state.pendingInitialPrompt) {
      const initial = state.pendingInitialPrompt;
      state.pendingInitialPrompt = undefined;
      this.userMessage(state.agent.id, initial);
    }
  }

  private async spawnRemoteControl(state: AgentProcessState): Promise<void> {
    const args = [
      "remote-control",
      "--name",
      state.agent.displayName,
      "--spawn",
      "session"
    ];
    if (this.permissionMode(state) === "bypassPermissions") args.push("--permission-mode", "bypassPermissions");

    const command = this.spawnCommand(state, resolveClaudeCommand(), args);
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: this.claudeEnv(state),
      windowsHide: true
    });
    state.child = child;
    state.agent.pid = child.pid;
    state.agent.updatedAt = now();
    this.persist();
    this.updateRemoteControlState(state, "waiting-for-browser", "Waiting for Remote Control link...");

    const parseRcLine = async (line: string, stream: "stdout" | "stderr") => {
      const url = this.remoteControlUrl(line);
      const diagnosticLine = this.remoteControlDiagnosticLine(line);
      console.log(`[${state.agent.displayName}:rc] ${diagnosticLine || line}`);
      this.storeRawLine(state, line);
      if (diagnosticLine) this.addRemoteControlDiagnostic(state, stream, diagnosticLine);
      if (stream === "stdout" && diagnosticLine) this.pushRemoteControlTranscriptLine(state, diagnosticLine);
      if (/connected|joined|opened/i.test(diagnosticLine || line)) {
        this.updateRemoteControlState(state, "connected", "Remote Control connected.");
      }
      if (!url || state.agent.rcUrl) return;
      state.agent.rcUrl = url;
      state.agent.qr = await QRCode.toDataURL(url);
      state.agent.modelLastUpdated = state.agent.launchedAt;
      state.agent.rcState = "waiting-for-browser";
      this.setStatus(state, "remote-controlled", "Remote Control connected.");
      this.updateRemoteControlState(state, "waiting-for-browser", "Remote Control link ready.");
      this.broadcast({
        type: "agent.rc_url_ready",
        id: state.agent.id,
        url,
        qr: state.agent.qr,
        updatedAt: state.agent.updatedAt
      });
      this.persist();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      state.stdoutBuffer = this.consumeLines(`${state.stdoutBuffer}${chunk.toString("utf8")}`, (line) => {
        void parseRcLine(line, "stdout");
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      state.stderrBuffer = this.consumeLines(`${state.stderrBuffer}${chunk.toString("utf8")}`, (line) => {
        void parseRcLine(line, "stderr");
      });
    });
    child.on("error", (error) => {
      this.updateRemoteControlState(state, "error", error.message);
      this.setStatus(state, "error", error.message);
    });
    child.on("exit", (code, signal) => {
      this.updateRemoteControlState(state, "closed", code === 0 || code === null ? "Remote Control closed." : `Remote Control exited with code ${code}.`);
      this.markTerminated(state, code, signal);
    });
  }

  private fallbackModelSwitch(state: AgentProcessState, model: string): void {
    if (!state.agent.sessionId) {
      this.setStatus(state, "error", "Cannot switch models without a Claude session id.");
      return;
    }
    state.restartModel = model;
    this.stopProcessTree(state);
  }

  private requestConfigRestart(state: AgentProcessState): boolean {
    const child = state.child;
    if (!child || child.killed) return false;

    if (state.activeTurn) {
      state.restartConfigAfterTurn = true;
      return true;
    }

    state.restartConfig = true;
    this.setStatus(state, "starting", "Applying Claude session settings...");
    this.stopProcessTree(state);
    return true;
  }

  private applyDeferredConfigRestart(state: AgentProcessState): void {
    if (!state.restartConfigAfterTurn) return;
    state.restartConfigAfterTurn = false;
    this.requestConfigRestart(state);
  }

  private sendCliSlashCommand(state: AgentProcessState, command: string): void {
    if (!state.child || state.child.killed) return;
    state.child.stdin.write(
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: command }]
        }
      })}\n`
    );
  }

  private initialPermissionMode(request: LaunchRequest): AgentPermissionMode {
    if (request.permissionMode) return request.permissionMode;
    if (request.planMode) return "plan";
    if (request.autoApprove === "always") return "bypassPermissions";
    return "default";
  }

  private permissionMode(state: AgentProcessState): AgentPermissionMode {
    if (state.agent.permissionMode) return state.agent.permissionMode;
    if (state.agent.planMode) return "plan";
    if (state.autoApprove === "always") return "bypassPermissions";
    return "default";
  }

  private permissionModeLabel(permissionMode: AgentPermissionMode): string {
    if (permissionMode === "acceptEdits") return "Edit automatically";
    if (permissionMode === "plan") return "Plan mode";
    if (permissionMode === "bypassPermissions") return "Bypass permissions";
    return "Ask before edits";
  }

  private statusLabel(status: AgentStatus): string {
    if (status === "awaiting-permission") return "Awaiting permission";
    if (status === "awaiting-input") return "Awaiting answer";
    if (status === "remote-controlled") return "Remote controlled";
    if (status === "switching-model") return "Switching model";
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  private providerReasoningEffort(state: AgentProcessState): Exclude<AgentEffort, "max"> {
    return state.agent.effort === "max" ? "xhigh" : state.agent.effort || "medium";
  }

  private writePermissionMcpConfig(state: AgentProcessState): string {
    state.permissionToken ??= nanoid(32);
    state.pendingPermissions ??= new Map();
    this.cleanupPermissionMcpConfig(state);
    const configDir = path.join(os.homedir(), ".agent-dashboard", "mcp");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(configDir, 0o700);
    } catch {
      // Best effort on Windows, where POSIX modes may not map cleanly to ACLs.
    }
    const project = this.projectForState(state);
    const script = this.permissionMcpScriptPath();
    const mcpCommand = isWslProject(project) ? "node" : script.command;
    const mcpArgs = isWslProject(project) ? script.args.map((arg) => (path.isAbsolute(arg) ? windowsPathToWslPath(arg) : arg)) : script.args;
    const configPath = path.join(configDir, `${state.agent.id}-permissions.json`);
    const config = {
      mcpServers: {
        [PERMISSION_MCP_SERVER_NAME]: {
          command: mcpCommand,
          args: mcpArgs,
          env: {
            AGENTCONTROL_AGENT_ID: state.agent.id,
            AGENTCONTROL_PERMISSION_TOKEN: state.permissionToken,
            AGENTCONTROL_PERMISSION_URL: this.permissionRequestUrl()
          }
        }
      }
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(configPath, 0o600);
    } catch {
      // Best effort on Windows, where POSIX modes may not map cleanly to ACLs.
    }
    state.permissionMcpConfigPath = configPath;
    return configPath;
  }

  private cleanupPermissionMcpConfig(state: AgentProcessState): void {
    if (!state.permissionMcpConfigPath) return;
    try {
      rmSync(state.permissionMcpConfigPath, { force: true });
    } catch {
      // Cleanup is best effort; a missing stale file should not affect agent shutdown.
    }
    state.permissionMcpConfigPath = undefined;
  }

  private cleanupStalePermissionMcpConfigs(): void {
    const configDir = path.join(os.homedir(), ".agent-dashboard", "mcp");
    try {
      for (const entry of readdirSync(configDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith("-permissions.json")) {
          rmSync(path.join(configDir, entry.name), { force: true });
        }
      }
    } catch {
      // The directory may not exist yet; stale cleanup is best effort.
    }
  }

  private claudeEnv(state: AgentProcessState): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (state.agent.thinking === false) env.MAX_THINKING_TOKENS = "0";
    else delete env.MAX_THINKING_TOKENS;
    return env;
  }

  private permissionMcpScriptPath(): { command: string; args: string[] } {
    const compiledScript = path.join(__dirname, "permission-mcp.js");
    if (existsSync(compiledScript)) {
      return { command: process.execPath, args: [compiledScript] };
    }

    const sourceScript = path.resolve(__dirname, "permission-mcp.ts");
    const tsxCommand = path.resolve(__dirname, "../../node_modules/.bin/tsx.cmd");
    if (process.platform === "win32" && existsSync(tsxCommand)) {
      return { command: tsxCommand, args: [sourceScript] };
    }

    return { command: "npx", args: ["tsx", sourceScript] };
  }

  private permissionRequestUrl(): string {
    return process.env.AGENTCONTROL_PERMISSION_URL || `http://127.0.0.1:${process.env.PORT || 4317}/api/permissions/request`;
  }

  private stopProcessTree(state: AgentProcessState): void {
    const child = state.child;
    if (!child || child.killed) return;

    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true
      });
      killer.on("error", () => {
        child.kill("SIGTERM");
      });
      return;
    }

    child.kill("SIGTERM");
    setTimeout(() => {
      if (state.child && !state.child.killed) state.child.kill("SIGKILL");
    }, 3000);
  }

  private consumeLines(buffer: string, onLine: (line: string) => void): string {
    const lines = buffer.split(/\r?\n/);
    const remainder = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
    return remainder;
  }

  private storeRawLine(state: AgentProcessState, line: string): void {
    state.rawLines.push(line);
    if (state.rawLines.length > RAW_LINE_LIMIT) {
      state.rawLines.splice(0, state.rawLines.length - RAW_LINE_LIMIT);
    }
  }

  private handleStreamJsonLine(state: AgentProcessState, line: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.error("Unparseable stream-json line", line);
      return;
    }

    const type = String(payload.type || "");
    const subtype = String(payload.subtype || "");

    const questionRequest = this.extractQuestionRequest(payload);
    if (questionRequest) {
      this.pushQuestionRequest(state, questionRequest);
      return;
    }

    if ((type === "system" && subtype === "init") || type === "system.init") {
      const model = this.modelOrDefault(state, this.trimmedStringField(payload.model) || this.trimmedStringField(payload.current_model));
      const sessionId = this.trimmedStringField(payload.session_id) || this.trimmedStringField(payload.sessionId);
      if (sessionId) state.agent.sessionId = sessionId;
      if (model) this.updateModel(state, model);
      this.updateSessionInfo(state, payload);
      if (!state.activeTurn) this.setStatus(state, "idle");
      return;
    }

    const directText = this.extractTextDelta(payload);
    if (directText) {
      this.appendAssistantText(state, directText);
      return;
    }

    if (type === "content_block_start") {
      const block = (payload.content_block || payload.block) as Record<string, unknown> | undefined;
      if (block) this.handleContentBlock(state, block);
      return;
    }

    if (type === "content_block_delta") {
      const delta = (payload.delta || payload) as Record<string, unknown>;
      const text = this.extractTextDelta(delta);
      if (text) this.appendAssistantText(state, text);
      return;
    }

    if (type === "content_block_stop") {
      this.finishAssistantStream(state, false);
      return;
    }

    const message = (payload.message || payload) as Record<string, unknown>;
    const messageModel = this.modelOrDefault(state, this.trimmedStringField(message.model) || this.trimmedStringField(payload.model));
    if (messageModel && messageModel !== state.agent.currentModel) {
      this.updateModel(state, messageModel);
    }

    const content = Array.isArray(message.content) ? message.content : Array.isArray(payload.content) ? payload.content : [];
    if (type === "assistant" || content.length > 0) {
      for (const block of content) this.handleContentBlock(state, block);
    }

    const permissionRequest = this.extractPermissionToolRequest(payload);
    if (permissionRequest) {
      const questionRequest = this.extractAskUserQuestionRequest(permissionRequest.name, permissionRequest.input);
      if (questionRequest) {
        this.pushQuestionRequest(state, questionRequest, permissionRequest.toolUseId);
        return;
      }
      this.markToolAwaitingPermission(state, permissionRequest);
      return;
    }

    if (type === "result") {
      this.finishAssistantStream(state, false);
      state.activeTurn = false;
      this.setStatus(state, "idle");
      this.applyDeferredConfigRestart(state);
    } else if (type === "error") {
      state.activeTurn = false;
      this.setStatus(state, "error", stringifyUnknown(payload));
    } else if (type.includes("permission") || subtype.includes("permission")) {
      this.setStatus(state, "awaiting-permission");
    }
  }

  private handleContentBlock(state: AgentProcessState, block: unknown): void {
    if (!block || typeof block !== "object") return;
    const value = block as Record<string, unknown>;
    const type = String(value.type || "");

    if (type === "text" && typeof value.text === "string" && value.text.length > 0) {
      this.appendAssistantText(state, value.text, true, false);
      return;
    }

    if (type === "tool_use") {
      state.activeTurn = true;
      const toolUseId = this.trimmedStringField(value.id) || this.trimmedStringField(value.tool_use_id) || this.trimmedStringField(value.toolUseId) || transcriptId();
      const toolName = this.trimmedStringField(value.name) || "tool";
      const questionRequest = this.extractAskUserQuestionRequest(toolName, value.input ?? value);
      if (questionRequest) {
        this.pushQuestionRequest(state, questionRequest, toolUseId);
        return;
      }
      if (this.isExitPlanModeToolUse(value)) {
        this.pushPlanRequest(state, this.extractPlanText(value), toolUseId);
        return;
      }
      const awaitingPermission = this.isAwaitingPermissionToolUse(value);
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "tool_use",
        toolUseId,
        name: toolName,
        input: value.input ?? {},
        awaitingPermission
      });
      if (awaitingPermission) this.setStatus(state, "awaiting-permission");
      else this.setStatus(state, "running");
      return;
    }

    if (type === "tool_result") {
      state.activeTurn = true;
      const toolUseId = this.trimmedStringField(value.tool_use_id) || this.trimmedStringField(value.toolUseId) || transcriptId();
      if (this.hasQuestionForToolUseId(state, toolUseId)) {
        this.setStatus(state, "running");
        return;
      }
      if (this.hasPlanForToolUseId(state, toolUseId)) {
        this.setStatus(state, "running");
        return;
      }
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "tool_result",
        toolUseId,
        output: value.content ?? value.output ?? "",
        isError: Boolean(value.is_error || value.isError)
      });
      this.setStatus(state, "running");
    }
  }

  private isAskUserQuestionToolName(name: string): boolean {
    return /^(askuserquestion|ask_user_question)$/i.test(name.trim());
  }

  private extractAskUserQuestionRequest(name: string, input: unknown): AgentQuestion[] | undefined {
    if (!this.isAskUserQuestionToolName(name) || !input || typeof input !== "object") return undefined;
    return this.extractQuestionRequest(input as Record<string, unknown>);
  }

  private extractExitPlanModeRequest(name: string, input: unknown): string | undefined {
    if (!this.isExitPlanModeToolName(name) || !input || typeof input !== "object") return undefined;
    const plan = this.extractPlanText({ name, input });
    return plan.trim() ? plan : undefined;
  }

  private answerQuestionToolUse(state: AgentProcessState, toolUseId: string, message: string): boolean {
    this.resolveToolPermission(state, toolUseId);
    const pendingQuestion = state.pendingQuestions?.get(toolUseId);
    if (pendingQuestion) {
      clearTimeout(pendingQuestion.timeout);
      state.pendingQuestions?.delete(toolUseId);
      pendingQuestion.resolve(message);
      return true;
    }
    const pending = state.pendingPermissions?.get(toolUseId);
    if (pending) {
      clearTimeout(pending.timeout);
      state.pendingPermissions?.delete(toolUseId);
      pending.resolve("deny");
      return true;
    }
    if (state.child && !state.child.killed && state.child.stdin.writable) {
      state.child.stdin.write(`${JSON.stringify({ type: "control", subtype: "tool_permission", tool_use_id: toolUseId, decision: "deny" })}\n`);
      return true;
    }
    return false;
  }

  private answerPlanToolUse(state: AgentProcessState, toolUseId: string, decision: AgentPlanDecision, message: string): boolean {
    this.resolveToolPermission(state, toolUseId);
    state.activeTurn = true;
    this.setStatus(state, "running");
    const pendingPlan = state.pendingPlans?.get(toolUseId);
    if (pendingPlan) {
      clearTimeout(pendingPlan.timeout);
      state.pendingPlans?.delete(toolUseId);
      pendingPlan.resolve(
        decision === "approve"
          ? { behavior: "allow" }
          : {
              behavior: "deny",
              message
            }
      );
      return true;
    }
    const pending = state.pendingPermissions?.get(toolUseId);
    if (pending) {
      clearTimeout(pending.timeout);
      state.pendingPermissions?.delete(toolUseId);
      pending.resolve(decision === "approve" ? "approve" : "deny");
      return true;
    }
    if (state.child && !state.child.killed && state.child.stdin.writable) {
      const toolDecision = decision === "approve" ? "approve" : "deny";
      state.child.stdin.write(`${JSON.stringify({ type: "control", subtype: "tool_permission", tool_use_id: toolUseId, decision: toolDecision })}\n`);
      return true;
    }
    return false;
  }

  private isExitPlanModeToolUse(value: Record<string, unknown>): boolean {
    return this.isExitPlanModeToolName(this.trimmedStringField(value.name) || "");
  }

  private isExitPlanModeToolName(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized === "exitplanmode" || normalized === "exit_plan_mode";
  }

  private extractPlanText(value: Record<string, unknown>): string {
    const input = value.input && typeof value.input === "object" ? (value.input as Record<string, unknown>) : {};
    return (
      this.textField(input.plan) ||
      this.textField(input.content) ||
      this.textField(input.text) ||
      this.textField(value.plan) ||
      stringifyUnknown(input || value)
    );
  }

  private pushPlanRequest(state: AgentProcessState, plan: string, toolUseId?: string): void {
    state.activeTurn = false;
    this.finishAssistantStream(state, false);
    const existing = toolUseId
      ? state.transcript.find((event) => event.kind === "plan" && event.toolUseId === toolUseId)
      : undefined;
    if (existing?.kind === "plan") {
      this.updateTranscript(state, {
        ...existing,
        plan,
        timestamp: now()
      });
      this.setStatus(state, "awaiting-input");
      return;
    }
    this.pushTranscript(state, {
      ...eventBase(state.agent.id, state.agent.currentModel),
      kind: "plan",
      ...(toolUseId ? { toolUseId } : {}),
      plan
    });
    this.setStatus(state, "awaiting-input");
  }

  private formatPlanAnswer(decision: AgentPlanDecision, response?: string): string {
    if (decision === "approve") return "I approve this plan. Proceed with implementation.";
    if (decision === "deny") return response ? `I do not approve this plan.\n\n${response}` : "I do not approve this plan. Do not implement it.";
    if (decision === "keepPlanning") return response ? `Keep planning. Please revise the plan with this feedback:\n\n${response}` : "Keep planning. Please revise the plan before implementing.";
    return response || "Other response.";
  }

  private extractQuestionRequest(payload: Record<string, unknown>): AgentQuestion[] | undefined {
    const source = Array.isArray(payload.questions)
      ? payload.questions
      : payload.question_request && typeof payload.question_request === "object" && Array.isArray((payload.question_request as Record<string, unknown>).questions)
        ? ((payload.question_request as Record<string, unknown>).questions as unknown[])
        : undefined;
    if (!source?.length) return undefined;
    const questions: AgentQuestion[] = [];
    for (const item of source) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const question = this.trimmedStringField(record.question);
      if (!question || !Array.isArray(record.options)) continue;
      const options: AgentQuestion["options"] = [];
      for (const option of record.options) {
        if (!option || typeof option !== "object") continue;
        const optionRecord = option as Record<string, unknown>;
        const label = this.trimmedStringField(optionRecord.label);
        if (!label) continue;
        const description = this.textField(optionRecord.description);
        options.push(description ? { label, description } : { label });
      }
      if (options.length === 0) continue;
      const header = this.trimmedStringField(record.header);
      questions.push({
        question,
        ...(header ? { header } : {}),
        options,
        multiSelect: Boolean(record.multiSelect)
      });
    }
    return questions.length ? questions : undefined;
  }

  private pushQuestionRequest(state: AgentProcessState, questions: AgentQuestion[], toolUseId?: string): void {
    state.activeTurn = false;
    this.finishAssistantStream(state, false);
    const existing = toolUseId
      ? state.transcript.find((event) => event.kind === "questions" && event.toolUseId === toolUseId)
      : undefined;
    if (existing?.kind === "questions") {
      this.updateTranscript(state, {
        ...existing,
        questions,
        timestamp: now()
      });
      this.setStatus(state, "awaiting-input");
      return;
    }
    this.pushTranscript(state, {
      ...eventBase(state.agent.id, state.agent.currentModel),
      kind: "questions",
      ...(toolUseId ? { toolUseId } : {}),
      questions
    });
    this.setStatus(state, "awaiting-input");
  }

  private hasQuestionForToolUseId(state: AgentProcessState, toolUseId: string): boolean {
    return state.transcript.some((event) => event.kind === "questions" && event.toolUseId === toolUseId);
  }

  private hasPlanForToolUseId(state: AgentProcessState, toolUseId: string): boolean {
    return state.transcript.some((event) => event.kind === "plan" && event.toolUseId === toolUseId);
  }

  private normalizeQuestionAnswers(questions: AgentQuestion[], answers: AgentQuestionAnswer[]): AgentQuestionAnswer[] {
    return questions.map((question, questionIndex) => {
      const requested = answers.find((answer) => answer.questionIndex === questionIndex);
      const allowed = new Set(question.options.map((option) => option.label));
      const labels = (requested?.labels || []).filter((label) => allowed.has(label));
      const otherText = requested?.otherText?.trim();
      return {
        questionIndex,
        labels: question.multiSelect ? labels : labels.slice(0, 1),
        ...(otherText ? { otherText } : {})
      };
    });
  }

  private formatQuestionAnswers(questions: AgentQuestion[], answers: AgentQuestionAnswer[]): string {
    const byIndex = new Map(answers.map((answer) => [answer.questionIndex, answer.labels]));
    return [
      "Answers to your questions:",
      ...questions.map((question, index) => {
        const answer = answers.find((item) => item.questionIndex === index);
        const labels = byIndex.get(index) || [];
        const parts = [...labels, answer?.otherText ? `Other: ${answer.otherText}` : ""].filter(Boolean);
        return [`${index + 1}. ${question.header || question.question}`, `Answer: ${parts.length ? parts.join(", ") : "No selection"}`].join("\n");
      })
    ].join("\n\n");
  }

  private isAwaitingPermissionToolUse(value: Record<string, unknown>): boolean {
    return Boolean(
      value.awaitingPermission ||
        value.awaiting_permission ||
        value.needs_permission ||
        value.requires_permission ||
        value.requiresPermission ||
        value.permission_required ||
        value.permissionRequired
    );
  }

  private extractPermissionToolRequest(payload: Record<string, unknown>): { toolUseId: string; name: string; input: unknown } | undefined {
    const type = String(payload.type || "").toLowerCase();
    const subtype = String(payload.subtype || "").toLowerCase();
    const looksLikePermission = type.includes("permission") || subtype.includes("permission");
    if (!looksLikePermission) return undefined;

    const toolUse =
      payload.tool_use && typeof payload.tool_use === "object"
        ? (payload.tool_use as Record<string, unknown>)
        : payload.toolUse && typeof payload.toolUse === "object"
          ? (payload.toolUse as Record<string, unknown>)
          : payload.tool && typeof payload.tool === "object"
            ? (payload.tool as Record<string, unknown>)
            : undefined;
    const toolUseId =
      this.trimmedStringField(payload.tool_use_id) ||
      this.trimmedStringField(payload.toolUseId) ||
      this.trimmedStringField(toolUse?.id) ||
      this.trimmedStringField(toolUse?.tool_use_id) ||
      this.trimmedStringField(payload.id);
    if (!toolUseId) return undefined;

    return {
      toolUseId,
      name: this.trimmedStringField(payload.tool_name) || this.trimmedStringField(payload.toolName) || this.trimmedStringField(toolUse?.name) || "tool",
      input: payload.input ?? toolUse?.input ?? {}
    };
  }

  private markToolAwaitingPermission(state: AgentProcessState, request: { toolUseId: string; name: string; input: unknown }): void {
    state.activeTurn = true;
    const existing = state.transcript.find(
      (event) => event.kind === "tool_use" && event.toolUseId === request.toolUseId
    );
    if (existing?.kind === "tool_use") {
      this.updateTranscript(state, {
        ...existing,
        name: request.name || existing.name,
        input: request.input ?? existing.input,
        awaitingPermission: true,
        timestamp: now()
      });
    } else {
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "tool_use",
        toolUseId: request.toolUseId,
        name: request.name || "tool",
        input: request.input ?? {},
        awaitingPermission: true
      });
    }
    this.setStatus(state, "awaiting-permission");
  }

  private resolveToolPermission(state: AgentProcessState, toolUseId: string): void {
    const existing = state.transcript.find((event) => event.kind === "tool_use" && event.toolUseId === toolUseId);
    if (existing?.kind !== "tool_use" || !existing.awaitingPermission) return;
    this.updateTranscript(state, {
      ...existing,
      awaitingPermission: false,
      timestamp: now()
    });
  }

  private denyPendingPermissions(state: AgentProcessState): void {
    for (const pending of state.pendingQuestions?.values() || []) {
      clearTimeout(pending.timeout);
      pending.resolve("Question prompt closed before an answer was provided.");
    }
    state.pendingQuestions?.clear();
    for (const pending of state.pendingPlans?.values() || []) {
      clearTimeout(pending.timeout);
      pending.resolve({
        behavior: "deny",
        message: "Plan prompt closed before a decision was provided."
      });
    }
    state.pendingPlans?.clear();
    for (const pending of state.pendingPermissions?.values() || []) {
      clearTimeout(pending.timeout);
      this.resolveToolPermission(state, pending.toolUseId);
      pending.resolve("deny");
    }
    state.pendingPermissions?.clear();
  }

  private trimmedStringField(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private textField(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private extractTextDelta(payload: Record<string, unknown>): string | undefined {
    const delta = payload.delta && typeof payload.delta === "object" ? (payload.delta as Record<string, unknown>) : undefined;
    const message = payload.message && typeof payload.message === "object" ? (payload.message as Record<string, unknown>) : undefined;
    const candidate =
      this.textField(payload.text) ||
      this.textField(payload.completion) ||
      this.textField(payload.response) ||
      this.textField(delta?.text) ||
      this.textField(delta?.completion) ||
      this.textField(message?.text);
    return candidate;
  }

  private pushTranscript(state: AgentProcessState, event: TranscriptEvent): void {
    state.transcript.push(event);
    this.broadcast({ type: "agent.transcript", id: state.agent.id, event });
    this.persist();
  }

  private updateTranscript(state: AgentProcessState, event: TranscriptEvent): void {
    const index = state.transcript.findIndex((candidate) => candidate.id === event.id);
    if (index >= 0) state.transcript[index] = event;
    this.broadcast({ type: "agent.transcript_updated", id: state.agent.id, event });
    this.persist();
  }

  private appendAssistantText(state: AgentProcessState, text: string, forceNew = false, streaming = true): void {
    if (!text && !forceNew) return;
    const existing = state.streamingAssistantId
      ? state.transcript.find((event) => event.id === state.streamingAssistantId && event.kind === "assistant_text")
      : undefined;

    if (forceNew && existing?.kind === "assistant_text" && (existing.text === text || text.startsWith(existing.text))) {
      this.updateTranscript(state, {
        ...existing,
        text,
        streaming,
        timestamp: now()
      });
      state.streamingAssistantId = streaming ? existing.id : undefined;
      state.activeTurn = streaming || state.activeTurn;
      this.setStatus(state, "running");
      return;
    }

    if (!existing || existing.kind !== "assistant_text" || forceNew) {
      const event: TranscriptEvent = {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "assistant_text",
        text,
        streaming
      };
      state.streamingAssistantId = streaming ? event.id : undefined;
      state.activeTurn = streaming || state.activeTurn;
      this.pushTranscript(state, event);
      this.setStatus(state, "running");
      return;
    }

    const updated: TranscriptEvent = {
      ...existing,
      text: `${existing.text}${text}`,
      streaming,
      timestamp: now()
    };
    this.updateTranscript(state, updated);
    state.activeTurn = streaming || state.activeTurn;
    this.setStatus(state, "running");
  }

  private finishAssistantStream(state: AgentProcessState, streaming: boolean): void {
    const existing = state.streamingAssistantId
      ? state.transcript.find((event) => event.id === state.streamingAssistantId && event.kind === "assistant_text")
      : undefined;
    if (existing?.kind === "assistant_text") {
      this.updateTranscript(state, {
        ...existing,
        streaming,
        timestamp: now()
      });
    }
    state.streamingAssistantId = undefined;
  }

  private setStatus(state: AgentProcessState, status: AgentStatus, statusMessage?: string): void {
    state.agent.status = status;
    state.agent.statusMessage = statusMessage;
    state.agent.updatedAt = now();
    this.broadcast({
      type: "agent.status_changed",
      id: state.agent.id,
      status,
      statusMessage,
      restorable: state.agent.restorable,
      pid: state.agent.pid,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }

  private remoteControlUrl(line: string): string | undefined {
    RC_URL_PATTERN.lastIndex = 0;
    const urls = [...line.matchAll(RC_URL_PATTERN)].map((match) => match[0]);
    return urls.find((url) => url.includes("?environment=")) || urls[0];
  }

  private remoteControlDiagnosticLine(line: string): string | undefined {
    const withLinks = line.replace(/\u001B]8;;([^\u0007]*)\u0007([^\u001B\u0007]*)\u001B]8;;\u0007/g, (_match, url: string, label: string) =>
      label && url ? `${label} (${url})` : label || url
    );
    const stripped = withLinks
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\u001B[=>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!stripped) return undefined;
    if (/^\d+[A-Z]?$/.test(stripped)) return undefined;
    return stripped;
  }

  private remoteControlConversationText(line: string): string | undefined {
    const text = line.trim();
    if (!text || text.length > 4000) return undefined;
    if (this.remoteControlUrl(text)) return undefined;
    if (/^(remote control|status:|uptime:|pid:|open\b|scan\b|qr\b|waiting\b|connected\b|joined\b|opened\b)/i.test(text)) return undefined;
    if (/^(http|ws)s?:\/\//i.test(text)) return undefined;
    if (/^[\W_]+$/.test(text)) return undefined;
    return text;
  }

  private pushRemoteControlTranscriptLine(state: AgentProcessState, line: string): void {
    const text = this.remoteControlConversationText(line);
    if (!text) return;
    const recentDuplicate = state.transcript
      .slice(-8)
      .some((event) => (event.kind === "user" || event.kind === "assistant_text" || event.kind === "system") && event.text.trim() === text);
    if (recentDuplicate) return;
    this.pushTranscript(state, {
      ...eventBase(state.agent.id, state.agent.currentModel),
      kind: "user",
      text
    });
  }

  private addRemoteControlDiagnostic(state: AgentProcessState, stream: "stdout" | "stderr" | "stdin", line: string): void {
    const formatted = `[${stream}] ${line}`;
    if (state.rcLastDiagnostic === formatted || (state.agent.rcDiagnostics || []).includes(formatted)) return;
    state.rcLastDiagnostic = formatted;
    const diagnostics = [...(state.agent.rcDiagnostics || []), formatted].slice(-80);
    state.agent.rcDiagnostics = diagnostics;
    state.agent.updatedAt = now();
    this.broadcast({
      type: "agent.remote_control_changed",
      id: state.agent.id,
      rcState: state.agent.rcState || "starting",
      diagnostics,
      statusMessage: state.agent.statusMessage,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }

  private updateRemoteControlState(state: AgentProcessState, rcState: RemoteControlState, statusMessage?: string): void {
    state.agent.rcState = rcState;
    state.agent.statusMessage = statusMessage;
    state.agent.updatedAt = now();
    this.broadcast({
      type: "agent.remote_control_changed",
      id: state.agent.id,
      rcState,
      diagnostics: state.agent.rcDiagnostics || [],
      statusMessage,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }

  private updateModel(state: AgentProcessState, model: string): void {
    model = this.modelOrDefault(state, model) || model;
    const previousModel = state.agent.currentModel;
    if (previousModel === model) return;
    state.agent.currentModel = model;
    state.agent.modelLastUpdated = now();
    state.agent.updatedAt = state.agent.modelLastUpdated;
    this.pushTranscript(state, {
      ...eventBase(state.agent.id, model),
      kind: "model_switch",
      from: previousModel,
      to: model
    });
    this.broadcast({
      type: "agent.model_changed",
      id: state.agent.id,
      model,
      previousModel,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }

  private findAgentDef(agent: RunningAgent): AgentDef | undefined {
    const project = this.getProjects().find((candidate) => candidate.id === agent.projectId) || this.getProjects().find((candidate) => candidate.path === agent.projectPath);
    return project?.agents.find((candidate) => candidate.name === agent.defName) || project?.builtInAgents?.find((candidate) => candidate.name === agent.defName);
  }

  private defaultModelForDefinition(def: AgentDef | undefined, provider: AgentProvider): string {
    const agentDefault = def?.defaultModel?.trim();
    if (agentDefault) return agentDefault;
    return (
      DEFAULT_MODEL_PROFILES.find((profile) => profile.provider === provider && profile.default)?.id ||
      DEFAULT_MODEL_PROFILES.find((profile) => profile.provider === provider)?.id ||
      DEFAULT_MODEL_PROFILES.find((profile) => profile.provider === "claude" && profile.default)?.id ||
      "claude-sonnet-4-6"
    );
  }

  private modelOrDefault(state: AgentProcessState, model: string | undefined): string | undefined {
    if (!isSyntheticModel(model)) return model;
    const provider = state.agent.provider || state.def?.provider || providerForModel(state.agent.currentModel);
    return this.defaultModelForDefinition(state.def || this.findAgentDef(state.agent), provider);
  }

  private updateSessionInfo(state: AgentProcessState, payload: Record<string, unknown>): void {
    const tools = this.stringArrayField(payload.tools);
    const slashCommands = this.slashCommandsField(payload.slash_commands) || this.slashCommandsField(payload.slashCommands);
    const mcpServers = this.mcpServersField(payload.mcp_servers ?? payload.mcpServers);
    if (!tools && !slashCommands && !mcpServers) return;

    state.agent.sessionTools = tools || state.agent.sessionTools || [];
    state.agent.slashCommands = slashCommands ? mergeSlashCommands(state.agent.slashCommands || [], slashCommands) : state.agent.slashCommands || [];
    state.agent.mcpServers = mcpServers || state.agent.mcpServers || [];
    state.agent.activePlugins = this.activePluginNames(state.agent.mcpServers);
    state.agent.updatedAt = now();
    this.broadcast({
      type: "agent.session_info_changed",
      id: state.agent.id,
      tools: state.agent.sessionTools,
      mcpServers: state.agent.mcpServers,
      slashCommands: state.agent.slashCommands,
      activePlugins: state.agent.activePlugins,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }

  private stringArrayField(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }

  private slashCommandsField(value: unknown): SlashCommandInfo[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const commands = value
      .map((item) => normalizeSlashCommandInfo(item, "session"))
      .filter((item): item is SlashCommandInfo => Boolean(item));
    return commands.length > 0 ? commands : undefined;
  }

  private mcpServersField(value: unknown): ClaudeMcpServer[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value
      .map((item) => {
        if (typeof item === "string" && item.trim()) return { name: item.trim() };
        if (!item || typeof item !== "object") return undefined;
        const record = item as Record<string, unknown>;
        const name = this.trimmedStringField(record.name);
        if (!name) return undefined;
        return {
          name,
          status: this.trimmedStringField(record.status)
        };
      })
      .filter((item): item is ClaudeMcpServer => Boolean(item));
  }

  private activePluginNames(mcpServers: ClaudeMcpServer[]): string[] {
    return [
      ...new Set(
        mcpServers
          .map((server) => server.name.match(/^plugin:([^:]+)(?::|$)/)?.[1])
          .filter((name): name is string => Boolean(name))
      )
    ];
  }

  private removeExitedAgent(state: AgentProcessState): void {
    this.cleanupPermissionMcpConfig(state);
    this.states.delete(state.agent.id);
    this.broadcast({ type: "agent.snapshot", snapshot: this.snapshot() });
    this.persist();
  }

  private markTerminated(state: AgentProcessState, exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.denyPendingPermissions(state);
    this.cleanupPermissionMcpConfig(state);
    if (state.exiting) {
      this.removeExitedAgent(state);
      return;
    }

    const failed = typeof exitCode === "number" && exitCode !== 0;
    const status: AgentStatus = failed ? "error" : "killed";
    const statusMessage = failed
      ? state.rawLines.at(-1) || `Agent process exited with code ${exitCode}.`
      : undefined;

    state.agent.status = status;
    state.agent.statusMessage = statusMessage;
    state.agent.updatedAt = now();
    state.agent.pid = undefined;
    this.broadcast({
      type: "agent.terminated",
      id: state.agent.id,
      status,
      statusMessage,
      exitCode,
      signal,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }
}
