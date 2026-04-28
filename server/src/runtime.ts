import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import type {
  AgentDef,
  AgentEffort,
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
import { resolveClaudeCommand } from "./capabilities.js";
import { listPlugins } from "./plugins.js";
import { mergeSlashCommands, normalizeSlashCommandInfo, scanSlashCommands } from "./slash-commands.js";

type Broadcast = (event: WsServerEvent) => void;
type ProjectProvider = () => Project[];

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
  pendingPermissions?: Map<string, PendingPermissionRequest>;
}

const RAW_LINE_LIMIT = 5000;
const TRANSCRIPT_PERSIST_LIMIT = 1000;
const RC_URL_PATTERN = /https:\/\/claude\.ai\/code\/[\w-]+/;
const PERMISSION_MCP_SERVER_NAME = "agentcontrol_permissions";
const PERMISSION_MCP_TOOL_NAME = `mcp__${PERMISSION_MCP_SERVER_NAME}__approval_prompt`;
const PERMISSION_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERIC_AGENT_DEF: AgentDef = {
  name: "Generic",
  description: "General-purpose Claude agent",
  color: "#ffffff",
  tools: [],
  systemPrompt: ""
};

interface PendingPermissionRequest {
  toolUseId: string;
  toolName: string;
  input: unknown;
  resolve: (decision: "approve" | "deny") => void;
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
    private readonly getCapabilities: () => Capabilities
  ) {
    this.persist = createStateWriter(() => this.persistedState());
  }

  async loadPersistedState(): Promise<void> {
    const persisted = await readPersistedState();
    for (const agent of persisted.agents) {
      const persistedStatus = agent.status as AgentStatus | "restorable";
      const restored: RunningAgent = {
        ...agent,
        status: agent.sessionId ? "paused" : persistedStatus === "restorable" ? "paused" : persistedStatus,
        restorable: Boolean(agent.sessionId),
        updatedAt: now()
      };
      this.states.set(restored.id, {
        agent: restored,
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
    const def =
      project.agents.find((candidate) => candidate.name === request.defName) ||
      (request.defName.toLowerCase() === "generic" ? GENERIC_AGENT_DEF : undefined);
    if (!def) throw new Error("Agent definition not found.");

    if (request.remoteControl && !this.getCapabilities().supportsRemoteControl) {
      throw new Error(this.getCapabilities().remoteControlReason || "Remote Control is not available.");
    }

    const displayName = this.uniqueDisplayName(request.displayName?.trim() || def.name);
    const timestamp = now();
    const permissionMode = this.initialPermissionMode(request);
    const installedPlugins = await listPlugins().catch(() => []);
    const slashCommands = await scanSlashCommands(project.path, installedPlugins, def.plugins || []).catch(() => []);
    const agent: RunningAgent = {
      id: nanoid(),
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      defName: def.name,
      displayName,
      color: def.color,
      status: "starting",
      currentModel: request.model,
      modelLastUpdated: timestamp,
      launchedAt: timestamp,
      updatedAt: timestamp,
      remoteControl: Boolean(request.remoteControl),
      rcState: request.remoteControl ? "starting" : undefined,
      rcDiagnostics: request.remoteControl ? [] : undefined,
      permissionMode,
      effort: request.effort || "medium",
      thinking: request.thinking ?? true,
      planMode: permissionMode === "plan",
      slashCommands
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
      pendingInitialPrompt: request.initialPrompt?.trim() || undefined,
      autoApprove: request.autoApprove
    };
    this.states.set(agent.id, state);
    this.broadcast({ type: "agent.launched", agent });
    this.persist();

    if (request.remoteControl) {
      await this.spawnRemoteControl(state);
    } else {
      this.spawnStandard(state);
    }

    return agent;
  }

  resume(id: string): void {
    const state = this.requiredState(id);
    if (!state.agent.sessionId) throw new Error("Agent has no resumable session.");
    state.agent.restorable = false;
    this.setStatus(state, "starting");
    this.spawnStandard(state, state.agent.sessionId, state.agent.currentModel);
  }

  userMessage(id: string, text: string, sourceAgent?: TranscriptEvent["sourceAgent"], attachments: MessageAttachment[] = []): void {
    const state = this.requiredState(id);
    if (state.agent.remoteControl) throw new Error("Remote Control agents do not accept dashboard messages.");
    if (!state.child || state.child.killed) throw new Error("Agent process is not running.");

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
    state.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  kill(id: string): void {
    const state = this.requiredState(id);
    state.exiting = true;
    this.denyPendingPermissions(state);
    if (state.child && !state.child.killed) {
      this.stopProcessTree(state);
    } else {
      this.removeExitedAgent(state);
    }
  }

  setModel(id: string, model: string): void {
    const state = this.requiredState(id);
    if (state.agent.remoteControl) throw new Error("Remote Control agents cannot switch models from the dashboard.");
    if (!state.child || state.child.killed) throw new Error("Agent process is not running.");

    this.setStatus(state, "switching-model", `Switching to ${model}...`);
    if (process.env.FORCE_FALLBACK_MODEL_SWITCH === "1") {
      this.fallbackModelSwitch(state, model);
      return;
    }

    try {
      state.child.stdin.write(`${JSON.stringify({ type: "control", subtype: "set_model", model })}\n`);
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
    const restarted = this.requestConfigRestart(state);
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
    if (state.child && !state.child.killed) {
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
    const restarted = this.requestConfigRestart(state);
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
    if (!state.child || state.child.killed) throw new Error("Agent process is not running.");
    const pending = state.pendingPermissions?.get(toolUseId);
    if (pending) {
      clearTimeout(pending.timeout);
      state.pendingPermissions?.delete(toolUseId);
      pending.resolve(decision);
    } else {
      state.child.stdin.write(`${JSON.stringify({ type: "control", subtype: "tool_permission", tool_use_id: toolUseId, decision })}\n`);
    }
    this.resolveToolPermission(state, toolUseId);
    state.activeTurn = true;
    this.setStatus(state, "running");
  }

  async requestPermission(id: string, request: PermissionPromptRequest): Promise<PermissionPromptResult> {
    const state = this.requiredState(id);
    if (!state.permissionToken || request.token !== state.permissionToken) {
      throw new Error("Permission request token is invalid.");
    }
    const toolUseId = request.toolUseId.trim();
    if (!toolUseId) throw new Error("Permission request is missing a tool use id.");

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

  private uniqueDisplayName(base: string): string {
    const existing = new Set([...this.states.values()].map((state) => state.agent.displayName));
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
    args.push(
      "--mcp-config",
      permissionMcpConfig,
      "--permission-prompt-tool",
      PERMISSION_MCP_TOOL_NAME,
      "--allowedTools",
      PERMISSION_MCP_TOOL_NAME
    );

    const child = spawn(resolveClaudeCommand(), args, {
      cwd: state.agent.projectPath,
      env: this.claudeEnv(state),
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
      state.agent.displayName
    ];
    if (this.permissionMode(state) === "bypassPermissions") args.push("--permission-mode", "bypassPermissions");

    const child = spawn(resolveClaudeCommand(), args, {
      cwd: state.agent.projectPath,
      windowsHide: true
    });
    state.child = child;
    state.agent.pid = child.pid;
    state.agent.updatedAt = now();
    this.persist();
    this.updateRemoteControlState(state, "waiting-for-browser", "Waiting for Remote Control link...");

    const parseRcLine = async (line: string, stream: "stdout" | "stderr") => {
      console.log(`[${state.agent.displayName}:rc] ${line}`);
      this.storeRawLine(state, line);
      this.addRemoteControlDiagnostic(state, stream, line);
      if (/connected|joined|opened/i.test(line)) {
        this.updateRemoteControlState(state, "connected", "Remote Control connected.");
      }
      const url = line.match(RC_URL_PATTERN)?.[0];
      if (!url || state.agent.rcUrl) return;
      state.agent.rcUrl = url;
      state.agent.qr = await QRCode.toDataURL(url);
      state.agent.modelLastUpdated = state.agent.launchedAt;
      state.agent.rcState = "waiting-for-browser";
      this.setStatus(state, "remote-controlled", "Remote Control connected.");
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

  private writePermissionMcpConfig(state: AgentProcessState): string {
    state.permissionToken ??= nanoid(32);
    state.pendingPermissions ??= new Map();
    const configDir = path.join(os.homedir(), ".agent-dashboard", "mcp");
    mkdirSync(configDir, { recursive: true });
    const script = this.permissionMcpScriptPath();
    const configPath = path.join(configDir, `${state.agent.id}-permissions.json`);
    const config = {
      mcpServers: {
        [PERMISSION_MCP_SERVER_NAME]: {
          command: script.command,
          args: script.args,
          env: {
            AGENTCONTROL_AGENT_ID: state.agent.id,
            AGENTCONTROL_PERMISSION_TOKEN: state.permissionToken,
            AGENTCONTROL_PERMISSION_URL: this.permissionRequestUrl()
          }
        }
      }
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return configPath;
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

    if ((type === "system" && subtype === "init") || type === "system.init") {
      const model = this.trimmedStringField(payload.model) || this.trimmedStringField(payload.current_model);
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
    const messageModel = this.trimmedStringField(message.model) || this.trimmedStringField(payload.model);
    if (messageModel && messageModel !== state.agent.currentModel) {
      this.updateModel(state, messageModel);
    }

    const content = Array.isArray(message.content) ? message.content : Array.isArray(payload.content) ? payload.content : [];
    if (type === "assistant" || content.length > 0) {
      for (const block of content) this.handleContentBlock(state, block);
    }

    const permissionRequest = this.extractPermissionToolRequest(payload);
    if (permissionRequest) {
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
      const awaitingPermission = this.isAwaitingPermissionToolUse(value);
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "tool_use",
        toolUseId,
        name: this.trimmedStringField(value.name) || "tool",
        input: value.input ?? {},
        awaitingPermission
      });
      if (awaitingPermission) this.setStatus(state, "awaiting-permission");
      else this.setStatus(state, "running");
      return;
    }

    if (type === "tool_result") {
      state.activeTurn = true;
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "tool_result",
        toolUseId: this.trimmedStringField(value.tool_use_id) || this.trimmedStringField(value.toolUseId) || transcriptId(),
        output: value.content ?? value.output ?? "",
        isError: Boolean(value.is_error || value.isError)
      });
      this.setStatus(state, "running");
    }
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

  private addRemoteControlDiagnostic(state: AgentProcessState, stream: "stdout" | "stderr", line: string): void {
    const diagnostics = [...(state.agent.rcDiagnostics || []), `[${stream}] ${line}`].slice(-120);
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
    this.states.delete(state.agent.id);
    this.broadcast({ type: "agent.snapshot", snapshot: this.snapshot() });
    this.persist();
  }

  private markTerminated(state: AgentProcessState, exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.denyPendingPermissions(state);
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
