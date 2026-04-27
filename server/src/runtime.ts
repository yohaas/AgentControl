import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import type {
  AgentDef,
  AgentSnapshot,
  AgentStatus,
  AutoApproveMode,
  Capabilities,
  LaunchRequest,
  Project,
  RunningAgent,
  SendToCommand,
  TranscriptEvent,
  WsServerEvent
} from "@agent-control/shared";
import { createStateWriter, readPersistedState, type PersistedState } from "./persistence.js";

type Broadcast = (event: WsServerEvent) => void;
type ProjectProvider = () => Project[];

interface AgentProcessState {
  agent: RunningAgent;
  def?: AgentDef;
  child?: ChildProcessWithoutNullStreams;
  transcript: TranscriptEvent[];
  rawLines: string[];
  stdoutBuffer: string;
  stderrBuffer: string;
  pendingInitialPrompt?: string;
  autoApprove?: AutoApproveMode;
  restartModel?: string;
  restartTimer?: NodeJS.Timeout;
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
      const restored: RunningAgent = {
        ...agent,
        status: agent.sessionId ? "restorable" : agent.status,
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

  userMessage(id: string, text: string, sourceAgent?: TranscriptEvent["sourceAgent"]): void {
    const state = this.requiredState(id);
    if (state.agent.remoteControl) throw new Error("Remote Control agents do not accept dashboard messages.");
    if (!state.child || state.child.killed) throw new Error("Agent process is not running.");

    const trimmed = text.trim();
    if (!trimmed) return;

    const event: TranscriptEvent = {
      ...eventBase(id, state.agent.currentModel),
      kind: "user",
      text: trimmed,
      sourceAgent
    };
    this.pushTranscript(state, event);
    this.setStatus(state, "running");

    const payload = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: trimmed }]
      }
    };
    state.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  kill(id: string): void {
    const state = this.requiredState(id);
    if (state.child && !state.child.killed) {
      state.child.kill("SIGTERM");
      setTimeout(() => {
        if (state.child && !state.child.killed) state.child.kill("SIGKILL");
      }, 3000);
    } else {
      this.markTerminated(state, null, null);
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
    if (state.child && !state.child.killed) state.child.kill("SIGTERM");
    this.states.delete(id);
    this.broadcast({ type: "agent.snapshot", snapshot: this.snapshot() });
    this.persist();
  }

  clearAll(): void {
    for (const state of this.states.values()) {
      if (state.child && !state.child.killed) state.child.kill("SIGTERM");
    }
    this.states.clear();
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
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
          "--resume",
          resumeSessionId,
          "--model",
          model,
          "--append-system-prompt",
          state.def?.systemPrompt || "",
          "--cwd",
          state.agent.projectPath
        ]
      : [
          "--output-format",
          "stream-json",
          "--input-format",
          "stream-json",
          "--append-system-prompt",
          state.def?.systemPrompt || "",
          "--model",
          model,
          "--cwd",
          state.agent.projectPath
        ];

    if (state.autoApprove === "always") args.push("--dangerously-skip-permissions");

    const child = spawn("claude", args, {
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
      if (state.restartModel) {
        const nextModel = state.restartModel;
        state.restartModel = undefined;
        if (state.restartTimer) clearTimeout(state.restartTimer);
        this.spawnStandard(state, state.agent.sessionId, nextModel);
        return;
      }
      this.markTerminated(state, code, signal);
    });
  }

  private async spawnRemoteControl(state: AgentProcessState): Promise<void> {
    const args = [
      "remote-control",
      "--append-system-prompt",
      state.def?.systemPrompt || "",
      "--model",
      state.agent.currentModel,
      "--cwd",
      state.agent.projectPath
    ];
    if (state.autoApprove === "always") args.push("--dangerously-skip-permissions");

    const child = spawn("claude", args, {
      cwd: state.agent.projectPath,
      windowsHide: true
    });
    state.child = child;
    state.agent.pid = child.pid;
    state.agent.updatedAt = now();
    this.persist();

    const parseRcLine = async (line: string) => {
      console.log(`[${state.agent.displayName}:rc] ${line}`);
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
    state.restartTimer = setTimeout(() => {
      if (state.child && !state.child.killed) state.child.kill("SIGKILL");
    }, 3000);
    state.child?.kill("SIGTERM");
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
      const model = this.stringField(payload.model) || this.stringField(payload.current_model);
      const sessionId = this.stringField(payload.session_id) || this.stringField(payload.sessionId);
      if (sessionId) state.agent.sessionId = sessionId;
      if (model) this.updateModel(state, model);
      this.setStatus(state, "idle");
      if (state.pendingInitialPrompt) {
        const initial = state.pendingInitialPrompt;
        state.pendingInitialPrompt = undefined;
        this.userMessage(state.agent.id, initial);
      }
      return;
    }

    const message = (payload.message || payload) as Record<string, unknown>;
    const messageModel = this.stringField(message.model) || this.stringField(payload.model);
    if (messageModel && messageModel !== state.agent.currentModel) {
      this.updateModel(state, messageModel);
    }

    const content = Array.isArray(message.content) ? message.content : Array.isArray(payload.content) ? payload.content : [];
    if (type === "assistant" || content.length > 0) {
      for (const block of content) this.handleContentBlock(state, block);
    }

    if (type === "result") {
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
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "assistant_text",
        text: value.text
      });
      return;
    }

    if (type === "tool_use") {
      this.pushTranscript(state, {
        ...eventBase(state.agent.id, state.agent.currentModel),
        kind: "tool_use",
        toolUseId: this.stringField(value.id) || transcriptId(),
        name: this.stringField(value.name) || "tool",
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
        toolUseId: this.stringField(value.tool_use_id) || this.stringField(value.toolUseId) || transcriptId(),
        output: value.content ?? value.output ?? "",
        isError: Boolean(value.is_error || value.isError)
      });
    }
  }

  private stringField(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private pushTranscript(state: AgentProcessState, event: TranscriptEvent): void {
    state.transcript.push(event);
    this.broadcast({ type: "agent.transcript", id: state.agent.id, event });
    this.persist();
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

  private markTerminated(state: AgentProcessState, exitCode: number | null, signal: NodeJS.Signals | null): void {
    state.agent.status = "killed";
    state.agent.updatedAt = now();
    state.agent.pid = undefined;
    this.broadcast({
      type: "agent.terminated",
      id: state.agent.id,
      status: "killed",
      exitCode,
      signal,
      updatedAt: state.agent.updatedAt
    });
    this.persist();
  }
}
