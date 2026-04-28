import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import type {
  AgentDef,
  AgentSnapshot,
  AgentStatus,
  AutoApproveMode,
  Capabilities,
  LaunchRequest,
  MessageAttachment,
  Project,
  RunningAgent,
  SendToCommand,
  TranscriptEvent,
  WsServerEvent
} from "@agent-control/shared";
import { createStateWriter, readPersistedState, type PersistedState } from "./persistence.js";
import { resolveClaudeCommand } from "./capabilities.js";

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
  restartTimer?: NodeJS.Timeout;
  interrupting?: boolean;
  exiting?: boolean;
}

const RAW_LINE_LIMIT = 5000;
const TRANSCRIPT_PERSIST_LIMIT = 1000;
const RC_URL_PATTERN = /https:\/\/claude\.ai\/code\/[\w-]+/;

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
    const def = project.agents.find((candidate) => candidate.name === request.defName);
    if (!def) throw new Error("Agent definition not found.");

    if (request.remoteControl && !this.getCapabilities().supportsRemoteControl) {
      throw new Error(this.getCapabilities().remoteControlReason || "Remote Control is not available.");
    }

    const displayName = this.uniqueDisplayName(request.displayName?.trim() || def.name);
    const timestamp = now();
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
      remoteControl: Boolean(request.remoteControl)
    };

    const state: AgentProcessState = {
      agent,
      def,
      transcript: [],
      rawLines: [],
      stdoutBuffer: "",
      stderrBuffer: "",
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
    if (!trimmed && imageAttachments.length === 0) return;

    const attachmentNote = imageAttachments.length
      ? [
          "Attached image file(s):",
          ...imageAttachments.map((attachment) => `- ${attachment.name}: ${attachment.path || attachment.url || attachment.id}`)
        ].join("\n")
      : "";
    const displayText = [trimmed || (imageAttachments.length ? "Please inspect the attached image(s)." : ""), attachmentNote]
      .filter(Boolean)
      .join("\n\n");

    const event: TranscriptEvent = {
      ...eventBase(id, state.agent.currentModel),
      kind: "user",
      text: displayText,
      sourceAgent,
      attachments: imageAttachments
    };
    this.pushTranscript(state, event);
    this.setStatus(state, "running");

    const content: Record<string, unknown>[] = [{ type: "text", text: displayText }];
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
    state.child.stdin.write(`${JSON.stringify({ type: "control", subtype: "tool_permission", tool_use_id: toolUseId, decision })}\n`);
    this.setStatus(state, "running");
  }

  clear(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.transcript = [];
    state.streamingAssistantId = undefined;
    state.rawLines = [];
    this.broadcast({ type: "agent.snapshot", snapshot: this.snapshot() });
    this.persist();
  }

  interrupt(id: string): void {
    const state = this.requiredState(id);
    if (!state.child || state.child.killed) return;
    state.interrupting = true;
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

    if (state.autoApprove === "always") args.push("--dangerously-skip-permissions");

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
    if (state.autoApprove === "always") args.push("--permission-mode", "bypassPermissions");

    const child = spawn(resolveClaudeCommand(), args, {
      cwd: state.agent.projectPath,
      windowsHide: true
    });
    state.child = child;
    state.agent.pid = child.pid;
    state.agent.updatedAt = now();
    this.persist();

    const parseRcLine = async (line: string) => {
      console.log(`[${state.agent.displayName}:rc] ${line}`);
      this.storeRawLine(state, line);
      const url = line.match(RC_URL_PATTERN)?.[0];
      if (!url || state.agent.rcUrl) return;
      state.agent.rcUrl = url;
      state.agent.qr = await QRCode.toDataURL(url);
      state.agent.modelLastUpdated = state.agent.launchedAt;
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
        void parseRcLine(line);
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      state.stderrBuffer = this.consumeLines(`${state.stderrBuffer}${chunk.toString("utf8")}`, (line) => {
        void parseRcLine(line);
      });
    });
    child.on("error", (error) => this.setStatus(state, "error", error.message));
    child.on("exit", (code, signal) => this.markTerminated(state, code, signal));
  }

  private fallbackModelSwitch(state: AgentProcessState, model: string): void {
    if (!state.agent.sessionId) {
      this.setStatus(state, "error", "Cannot switch models without a Claude session id.");
      return;
    }
    state.restartModel = model;
    this.stopProcessTree(state);
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
      this.setStatus(state, "idle");
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

    if (type === "result") {
      this.finishAssistantStream(state, false);
      this.setStatus(state, "idle");
    } else if (type === "error") {
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
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "tool_use",
        toolUseId: this.trimmedStringField(value.id) || transcriptId(),
        name: this.trimmedStringField(value.name) || "tool",
        input: value.input ?? {},
        awaitingPermission: Boolean(value.awaitingPermission || value.needs_permission)
      });
      if (value.awaitingPermission || value.needs_permission) this.setStatus(state, "awaiting-permission");
      return;
    }

    if (type === "tool_result") {
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "tool_result",
        toolUseId: this.trimmedStringField(value.tool_use_id) || this.trimmedStringField(value.toolUseId) || transcriptId(),
        output: value.content ?? value.output ?? "",
        isError: Boolean(value.is_error || value.isError)
      });
    }
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

  private removeExitedAgent(state: AgentProcessState): void {
    this.states.delete(state.agent.id);
    this.broadcast({ type: "agent.snapshot", snapshot: this.snapshot() });
    this.persist();
  }

  private markTerminated(state: AgentProcessState, exitCode: number | null, signal: NodeJS.Signals | null): void {
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
