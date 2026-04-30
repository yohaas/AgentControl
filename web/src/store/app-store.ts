import { create } from "zustand";
import type {
  AgentSnapshot,
  AgentPermissionMode,
  AutoApproveMode,
  Capabilities,
  ModelProfile,
  MessageAttachment,
  PermissionAllowRule,
  Project,
  RunningAgent,
  TerminalSession,
  TranscriptEvent,
  WsServerEvent
} from "@agent-control/shared";

export interface SettingsState {
  projectsRoot: string;
  projectPaths?: string[];
  models: string[];
  modelProfiles?: ModelProfile[];
  gitPath?: string;
  claudePath?: string;
  claudeRuntime?: ClaudeRuntime;
  codexPath?: string;
  claudeAgentDir?: string;
  codexAgentDir?: string;
  openaiAgentDir?: string;
  builtInAgentDir?: string;
  anthropicKeySaved?: boolean;
  openaiKeySaved?: boolean;
  anthropicKeySource?: "env" | "local" | "missing";
  openaiKeySource?: "env" | "local" | "missing";
  anthropicApiKey?: string;
  openaiApiKey?: string;
  clearAnthropicApiKey?: boolean;
  clearOpenaiApiKey?: boolean;
  autoApprove: AutoApproveMode;
  permissionAllowRules?: PermissionAllowRule[];
  defaultAgentMode: AgentPermissionMode;
  tileHeight: number;
  tileColumns: number;
  tileScrolling: TileScrollingMode;
  menuDisplay: MenuDisplayMode;
  sidebarWidth: number;
  pinLastSentMessage: boolean;
  terminalDock: TerminalDockPosition;
  fileExplorerDock: FileExplorerDockPosition;
  themeMode: ThemeMode;
  agentControlProjectPath?: string;
  updateChecksEnabled: boolean;
  updateCommands: string[];
  inputNotificationsEnabled: boolean;
  externalEditor: ExternalEditor;
  externalEditorUrlTemplate?: string;
}

export type TerminalDockPosition = "float" | "left" | "bottom" | "right";
export type FileExplorerDockPosition = "tile" | "left" | "bottom" | "right";
export type ThemeMode = "auto" | "light" | "dark";
export type ClaudeRuntime = "cli" | "api";
export type MenuDisplayMode = "iconOnly" | "iconText";
export type TileScrollingMode = "vertical" | "horizontal";
export type ExternalEditor = "none" | "vscode" | "cursor" | "custom";

interface SendDialogState {
  open: boolean;
  sourceAgentId?: string;
  targetAgentId?: string;
  selectedText?: string;
  framing?: string;
}

interface LaunchModalState {
  open: boolean;
  projectId?: string;
  defName?: string;
  agentSource?: "project" | "builtIn";
  initialPrompt?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: MessageAttachment[];
}

const MESSAGE_QUEUES_STORAGE_KEY = "agent-control-message-queues";
const TILE_LAYOUT_STORAGE_KEY = "agent-control-tile-layout";
const SELECTED_PROJECT_STORAGE_KEY = "agent-control-selected-project";
const WINDOWS_UPDATE_COMMANDS = [
  "powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\start-update.ps1"
];
const PREVIOUS_WINDOWS_UPDATE_COMMANDS = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-control.ps1'; $command = \"Write-Host 'Starting AgentControl updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const OLDER_WINDOWS_UPDATE_COMMANDS = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-control.ps1'; $command = \"Write-Host 'Starting AgentControl updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const POSIX_UPDATE_COMMANDS = ["bash ./scripts/update-agent-control.sh"];
const LEGACY_UPDATE_COMMANDS = ["git pull", "npm ci", "npm run build", "Restart-Service AgentControl"];

function defaultUpdateCommands(): string[] {
  const platform = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  return platform.includes("win") ? WINDOWS_UPDATE_COMMANDS : POSIX_UPDATE_COMMANDS;
}

interface StoredTileLayout {
  order: string[];
  widths: Record<string, number>;
  minimized: Record<string, boolean>;
}

function normalizeQueuedMessage(value: unknown): QueuedMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Partial<QueuedMessage>;
  if (typeof message.id !== "string" || typeof message.text !== "string") return undefined;
  return {
    id: message.id,
    text: message.text,
    attachments: Array.isArray(message.attachments) ? (message.attachments as MessageAttachment[]) : []
  };
}

function normalizeMessageQueues(value: unknown): Record<string, QueuedMessage[]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([agentId, queue]) => [
        agentId,
        Array.isArray(queue) ? queue.map(normalizeQueuedMessage).filter((message): message is QueuedMessage => Boolean(message)) : []
      ])
      .filter(([, queue]) => queue.length > 0)
  );
}

function readStoredMessageQueues(): Record<string, QueuedMessage[]> {
  if (typeof window === "undefined") return {};
  try {
    return normalizeMessageQueues(JSON.parse(window.localStorage.getItem(MESSAGE_QUEUES_STORAGE_KEY) || "{}"));
  } catch {
    return {};
  }
}

function writeStoredMessageQueues(queues: Record<string, QueuedMessage[]>): Record<string, QueuedMessage[]> {
  const normalized = normalizeMessageQueues(queues);
  if (typeof window !== "undefined") {
    if (Object.keys(normalized).length === 0) window.localStorage.removeItem(MESSAGE_QUEUES_STORAGE_KEY);
    else window.localStorage.setItem(MESSAGE_QUEUES_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function pruneMessageQueues(queues: Record<string, QueuedMessage[]>, agentIds: Set<string>): Record<string, QueuedMessage[]> {
  return writeStoredMessageQueues(Object.fromEntries(Object.entries(queues).filter(([agentId]) => agentIds.has(agentId))));
}

function normalizeTileLayout(value: unknown): StoredTileLayout {
  if (!value || typeof value !== "object") return { order: [], widths: {}, minimized: {} };
  const layout = value as Partial<StoredTileLayout>;
  const order = Array.isArray(layout.order) ? layout.order.filter((id): id is string => typeof id === "string" && Boolean(id)) : [];
  const widths = Object.fromEntries(
    Object.entries(layout.widths || {})
      .map(([id, width]) => [id, clampNumber(width, 0, 0, 1200)] as const)
      .filter(([id, width]) => Boolean(id) && width > 0)
  );
  const minimized = Object.fromEntries(Object.entries(layout.minimized || {}).filter(([id, value]) => Boolean(id) && value === true));
  return { order, widths, minimized };
}

function readStoredTileLayout(): StoredTileLayout {
  if (typeof window === "undefined") return { order: [], widths: {}, minimized: {} };
  try {
    return normalizeTileLayout(JSON.parse(window.localStorage.getItem(TILE_LAYOUT_STORAGE_KEY) || "{}"));
  } catch {
    return { order: [], widths: {}, minimized: {} };
  }
}

function writeStoredTileLayout(layout: StoredTileLayout): StoredTileLayout {
  const normalized = normalizeTileLayout(layout);
  if (typeof window !== "undefined") {
    const empty = normalized.order.length === 0 && Object.keys(normalized.widths).length === 0 && Object.keys(normalized.minimized).length === 0;
    if (empty) window.localStorage.removeItem(TILE_LAYOUT_STORAGE_KEY);
    else window.localStorage.setItem(TILE_LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function pruneTileLayout(layout: StoredTileLayout, agentIds: Set<string>): StoredTileLayout {
  const allowed = (id: string) => id === "file-explorer" || agentIds.has(id);
  return writeStoredTileLayout({
    order: layout.order.filter(allowed),
    widths: Object.fromEntries(Object.entries(layout.widths).filter(([id]) => allowed(id))),
    minimized: Object.fromEntries(Object.entries(layout.minimized).filter(([id]) => allowed(id)))
  });
}

function readStoredSelectedProjectId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY) || undefined;
}

function writeStoredSelectedProjectId(id?: string) {
  if (typeof window === "undefined") return;
  if (id) window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, id);
  else window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
}

interface AppState {
  projects: Project[];
  selectedProjectId?: string;
  agents: Record<string, RunningAgent>;
  transcripts: Record<string, TranscriptEvent[]>;
  selectedAgentId?: string;
  focusedAgentId?: string;
  chatFocusedAgentId?: string;
  doneAgentIds: Record<string, boolean>;
  capabilities?: Capabilities;
  settings: SettingsState;
  wsConnected: boolean;
  errors: string[];
  drafts: Record<string, string>;
  messageQueues: Record<string, QueuedMessage[]>;
  scrollPositions: Record<string, number>;
  flashModels: Record<string, boolean>;
  tileOrder: string[];
  tileWidths: Record<string, number>;
  minimizedTiles: Record<string, boolean>;
  currentTileHeight?: number;
  sidebarCollapsed: boolean;
  terminalOpen: boolean;
  fileExplorerOpen: boolean;
  fileExplorerMaximized: boolean;
  terminalInFileExplorer: boolean;
  terminalSessions: Record<string, TerminalSession>;
  terminalOutput: Record<string, string[]>;
  activeTerminalId?: string;
  launchModal: LaunchModalState;
  sendDialog: SendDialogState;
  searchOpen: boolean;
  searchQuery: string;
  setProjects: (projects: Project[]) => void;
  setSelectedProject: (id?: string) => void;
  setSelectedAgent: (id?: string) => void;
  setFocusedAgent: (id?: string) => void;
  setChatFocusedAgent: (id?: string) => void;
  setCapabilities: (capabilities: Capabilities) => void;
  setSettings: (settings: SettingsState) => void;
  setWsConnected: (connected: boolean) => void;
  addError: (message: string) => void;
  dismissError: (index: number) => void;
  hydrateSnapshot: (snapshot: AgentSnapshot) => void;
  handleServerEvent: (event: WsServerEvent) => void;
  setDraft: (id: string, text: string) => void;
  enqueueMessage: (id: string, message: Omit<QueuedMessage, "id">) => void;
  updateQueuedMessage: (id: string, messageId: string, patch: Partial<Omit<QueuedMessage, "id">>) => void;
  removeQueuedMessage: (id: string, messageId: string) => void;
  reorderQueuedMessages: (id: string, orderedIds: string[]) => void;
  popNextQueuedMessage: (id: string) => QueuedMessage | undefined;
  setScrollPosition: (id: string, top: number) => void;
  setTileOrder: (ids: string[]) => void;
  setTileWidth: (id: string, width: number) => void;
  setTileMinimized: (id: string, minimized: boolean) => void;
  setCurrentTileHeight: (height?: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
  setFileExplorerOpen: (open: boolean) => void;
  setFileExplorerMaximized: (maximized: boolean) => void;
  setFileExplorerDock: (dock: FileExplorerDockPosition) => void;
  setTerminalInFileExplorer: (docked: boolean) => void;
  setActiveTerminal: (id?: string) => void;
  openLaunchModal: (state?: Partial<LaunchModalState>) => void;
  closeLaunchModal: () => void;
  openSendDialog: (state: Omit<SendDialogState, "open">) => void;
  closeSendDialog: () => void;
  setSendFraming: (framing: string) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
}

const defaultSettings: SettingsState = {
  projectsRoot: "",
  models: ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  modelProfiles: [
    { id: "claude-opus-4-7", provider: "claude" },
    { id: "claude-opus-4-6", provider: "claude" },
    { id: "claude-sonnet-4-6", provider: "claude", default: true },
    { id: "claude-haiku-4-5", provider: "claude" },
    { id: "gpt-5.5", provider: "openai", default: true, supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.4", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.4-mini", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.4-nano", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "o3-deep-research", provider: "openai", supportedEfforts: ["low", "medium", "high"] },
    { id: "o4-mini-deep-research", provider: "openai", supportedEfforts: ["low", "medium", "high"] },
    { id: "gpt-5.3-codex", provider: "codex", default: true, supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.3-codex-spark", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.2-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.1-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.1-codex-max", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.1-codex-mini", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] }
  ],
  autoApprove: "off",
  permissionAllowRules: [],
  defaultAgentMode: "acceptEdits",
  tileHeight: 460,
  tileColumns: 2,
  tileScrolling: "vertical",
  menuDisplay: "iconOnly",
  sidebarWidth: 280,
  pinLastSentMessage: true,
  terminalDock: "bottom",
  fileExplorerDock: "left",
  themeMode: "auto",
  agentControlProjectPath: "",
  updateChecksEnabled: true,
  updateCommands: defaultUpdateCommands(),
  inputNotificationsEnabled: false,
  externalEditor: "none",
  externalEditorUrlTemplate: "",
  claudeRuntime: "cli",
  claudeAgentDir: ".claude/agents",
  codexAgentDir: ".codex/agents",
  openaiAgentDir: ".agent-control/openai-agents",
  builtInAgentDir: ".agent-control/built-in-agents"
};

function initialFileExplorerOpen(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem("agent-control-file-explorer-open") !== "false";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function resolveTileHeight(value: unknown): number {
  if (value === 0) return 0;
  return clampNumber(value, defaultSettings.tileHeight, 320, 2000);
}

function normalizeSettings(settings: SettingsState): SettingsState {
  const terminalDock = ["float", "left", "bottom", "right"].includes(settings.terminalDock)
    ? settings.terminalDock
    : defaultSettings.terminalDock;
  const fileExplorerDock = ["tile", "left", "bottom", "right"].includes(settings.fileExplorerDock)
    ? settings.fileExplorerDock
    : defaultSettings.fileExplorerDock;
  const defaultAgentMode = ["default", "acceptEdits", "plan", "bypassPermissions"].includes(settings.defaultAgentMode)
    ? settings.defaultAgentMode
    : defaultSettings.defaultAgentMode;
  const themeMode = ["auto", "light", "dark"].includes(settings.themeMode) ? settings.themeMode : defaultSettings.themeMode;
  const claudeRuntime = settings.claudeRuntime === "api" ? "api" : "cli";
  const menuDisplay = settings.menuDisplay === "iconText" ? "iconText" : "iconOnly";
  const tileScrolling = settings.tileScrolling === "horizontal" ? "horizontal" : "vertical";
  const externalEditor = ["none", "vscode", "cursor", "custom"].includes(settings.externalEditor)
    ? settings.externalEditor
    : defaultSettings.externalEditor;
  return {
    ...defaultSettings,
    ...settings,
    modelProfiles: Array.isArray(settings.modelProfiles) && settings.modelProfiles.length ? settings.modelProfiles : defaultSettings.modelProfiles,
    permissionAllowRules: Array.isArray(settings.permissionAllowRules) ? settings.permissionAllowRules : defaultSettings.permissionAllowRules,
    updateChecksEnabled: settings.updateChecksEnabled !== false,
    inputNotificationsEnabled: settings.inputNotificationsEnabled === true,
    agentControlProjectPath: typeof settings.agentControlProjectPath === "string" ? settings.agentControlProjectPath : "",
    externalEditor,
    externalEditorUrlTemplate: typeof settings.externalEditorUrlTemplate === "string" ? settings.externalEditorUrlTemplate : "",
    updateCommands: (() => {
      const normalized = Array.isArray(settings.updateCommands) ? settings.updateCommands.map((command) => command.trim()).filter(Boolean) : [];
      const commandKey = normalized.join("\n");
      return normalized.length &&
        commandKey !== LEGACY_UPDATE_COMMANDS.join("\n") &&
        commandKey !== PREVIOUS_WINDOWS_UPDATE_COMMANDS.join("\n") &&
        commandKey !== OLDER_WINDOWS_UPDATE_COMMANDS.join("\n")
        ? normalized
        : defaultSettings.updateCommands;
    })(),
    defaultAgentMode,
    tileHeight: resolveTileHeight(settings.tileHeight),
    tileColumns: clampNumber(settings.tileColumns, defaultSettings.tileColumns, 1, 6),
    sidebarWidth: clampNumber(settings.sidebarWidth, defaultSettings.sidebarWidth, 240, 420),
    terminalDock,
    fileExplorerDock,
    themeMode,
    claudeRuntime,
    menuDisplay,
    tileScrolling
  };
}

function mergeAgent(agent: RunningAgent, patch: Partial<RunningAgent>): RunningAgent {
  return { ...agent, ...patch };
}

function statusMarksResponseInProgress(status?: RunningAgent["status"]): boolean {
  return status === "running" || status === "starting" || status === "switching-model";
}

function withAgent(
  agents: Record<string, RunningAgent>,
  id: string,
  updater: (agent: RunningAgent) => RunningAgent
): Record<string, RunningAgent> {
  const agent = agents[id];
  if (!agent) return agents;
  return { ...agents, [id]: updater(agent) };
}

function withTerminal(
  terminals: Record<string, TerminalSession>,
  id: string,
  updater: (terminal: TerminalSession) => TerminalSession
): Record<string, TerminalSession> {
  const terminal = terminals[id];
  if (!terminal) return terminals;
  return { ...terminals, [id]: updater(terminal) };
}

function agentMap(agents: RunningAgent[]) {
  return Object.fromEntries(agents.map((agent) => [agent.id, agent]));
}

function latestTerminalForProject(terminals: Record<string, TerminalSession>, projectId?: string) {
  return Object.values(terminals)
    .filter((terminal) => !projectId || terminal.projectId === projectId)
    .sort((left, right) => +new Date(left.startedAt) - +new Date(right.startedAt))
    .at(-1)?.id;
}

const TRANSIENT_WS_NOT_CONNECTED_ERROR = "Backend server not running.";
const initialTileLayout = readStoredTileLayout();

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  selectedProjectId: readStoredSelectedProjectId(),
  agents: {},
  transcripts: {},
  focusedAgentId: undefined,
  chatFocusedAgentId: undefined,
  doneAgentIds: {},
  settings: defaultSettings,
  wsConnected: false,
  errors: [],
  drafts: {},
  messageQueues: readStoredMessageQueues(),
  scrollPositions: {},
  flashModels: {},
  tileOrder: initialTileLayout.order,
  tileWidths: initialTileLayout.widths,
  minimizedTiles: initialTileLayout.minimized,
  currentTileHeight: undefined,
  sidebarCollapsed: false,
  terminalOpen: false,
  fileExplorerOpen: initialFileExplorerOpen(),
  fileExplorerMaximized: false,
  terminalInFileExplorer: false,
  terminalSessions: {},
  terminalOutput: {},
  activeTerminalId: undefined,
  launchModal: { open: false },
  sendDialog: { open: false },
  searchOpen: false,
  searchQuery: "",
  setProjects: (projects) =>
    set((state) => {
      const selectedProjectId =
        state.selectedProjectId && projects.some((project) => project.id === state.selectedProjectId)
          ? state.selectedProjectId
          : projects[0]?.id;
      writeStoredSelectedProjectId(selectedProjectId);
      const selectedAgent =
        state.selectedAgentId && state.agents[state.selectedAgentId]?.projectId === selectedProjectId
          ? state.selectedAgentId
          : undefined;
      const focusedAgent =
        state.focusedAgentId && state.agents[state.focusedAgentId]?.projectId === selectedProjectId
          ? state.focusedAgentId
          : undefined;
      return {
        projects,
        selectedProjectId,
        selectedAgentId: selectedAgent,
        focusedAgentId: focusedAgent,
        chatFocusedAgentId:
          state.chatFocusedAgentId && state.agents[state.chatFocusedAgentId]?.projectId === selectedProjectId
            ? state.chatFocusedAgentId
            : undefined,
        activeTerminalId: latestTerminalForProject(state.terminalSessions, selectedProjectId)
      };
    }),
  setSelectedProject: (id) =>
    set((state) => {
      writeStoredSelectedProjectId(id);
      return {
        selectedProjectId: id,
        selectedAgentId: undefined,
        focusedAgentId: undefined,
        chatFocusedAgentId: undefined,
        activeTerminalId: latestTerminalForProject(state.terminalSessions, id)
      };
    }),
  setSelectedAgent: (id) => set({ selectedAgentId: id }),
  setFocusedAgent: (id) => set({ focusedAgentId: id }),
  setChatFocusedAgent: (id) =>
    set((state) => ({
      chatFocusedAgentId: id,
      doneAgentIds: id ? { ...state.doneAgentIds, [id]: false } : state.doneAgentIds
    })),
  setCapabilities: (capabilities) => set({ capabilities }),
  setSettings: (settings) => set({ settings: normalizeSettings(settings) }),
  setWsConnected: (connected) =>
    set((state) => ({
      wsConnected: connected,
      errors: connected ? state.errors.filter((error) => error !== TRANSIENT_WS_NOT_CONNECTED_ERROR) : state.errors
    })),
  addError: (message) =>
    set((state) => {
      const normalized = message.trim();
      if (!normalized) return state;
      return {
        errors: [normalized, ...state.errors.filter((error) => error !== normalized)].slice(0, 5)
      };
    }),
  dismissError: (index) => set((state) => ({ errors: state.errors.filter((_, candidateIndex) => candidateIndex !== index) })),
  hydrateSnapshot: (snapshot) =>
    set((state) => {
      const agentIds = new Set(snapshot.agents.map((agent) => agent.id));
      const tileLayout = pruneTileLayout(
        {
          order: state.tileOrder,
          widths: state.tileWidths,
          minimized: state.minimizedTiles
        },
        agentIds
      );
      return {
        agents: agentMap(snapshot.agents),
        transcripts: snapshot.transcripts,
        capabilities: snapshot.capabilities || state.capabilities,
        messageQueues: pruneMessageQueues(state.messageQueues, agentIds),
        selectedAgentId: state.selectedAgentId && agentIds.has(state.selectedAgentId) ? state.selectedAgentId : undefined,
        focusedAgentId: state.focusedAgentId && agentIds.has(state.focusedAgentId) ? state.focusedAgentId : undefined,
        chatFocusedAgentId: state.chatFocusedAgentId && agentIds.has(state.chatFocusedAgentId) ? state.chatFocusedAgentId : undefined,
        doneAgentIds: Object.fromEntries(Object.entries(state.doneAgentIds).filter(([id]) => agentIds.has(id))),
        tileOrder: [
          ...tileLayout.order,
          ...snapshot.agents.filter((agent) => !tileLayout.order.includes(agent.id)).map((agent) => agent.id)
        ],
        tileWidths: tileLayout.widths,
        minimizedTiles: tileLayout.minimized
      };
    }),
  handleServerEvent: (event) => {
    switch (event.type) {
      case "agent.snapshot":
        get().hydrateSnapshot(event.snapshot);
        break;
      case "agent.launched":
        set((state) => {
          const tileLayout = writeStoredTileLayout({
            order: [...state.tileOrder.filter((id) => id !== event.agent.id), event.agent.id],
            widths: state.tileWidths,
            minimized: Object.fromEntries(Object.entries(state.minimizedTiles).filter(([id]) => id !== event.agent.id))
          });
          return {
            agents: { ...state.agents, [event.agent.id]: event.agent },
            transcripts: { ...state.transcripts, [event.agent.id]: state.transcripts[event.agent.id] || [] },
            selectedAgentId: state.selectedAgentId ? event.agent.id : undefined,
            focusedAgentId: event.agent.id,
            chatFocusedAgentId: undefined,
            doneAgentIds: { ...state.doneAgentIds, [event.agent.id]: false },
            tileOrder: tileLayout.order,
            minimizedTiles: tileLayout.minimized
          };
        });
        break;
      case "agent.status_changed":
        set((state) => {
          const previousStatus = state.agents[event.id]?.status;
          const responseFinishedAwayFromChat =
            event.status === "idle" && statusMarksResponseInProgress(previousStatus) && state.chatFocusedAgentId !== event.id;
          const nextDoneAgentIds =
            responseFinishedAwayFromChat || event.status !== "idle"
              ? { ...state.doneAgentIds, [event.id]: responseFinishedAwayFromChat }
              : state.doneAgentIds;
          return {
            agents: withAgent(state.agents, event.id, (agent) =>
              mergeAgent(agent, {
                status: event.status,
                statusMessage: event.statusMessage,
                restorable: event.restorable,
                pid: event.pid,
                turnStartedAt: event.turnStartedAt,
                lastTokenUsage: event.lastTokenUsage,
                updatedAt: event.updatedAt
              })
            ),
            doneAgentIds: nextDoneAgentIds
          };
        });
        break;
      case "agent.model_changed":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              currentModel: event.model,
              modelLastUpdated: event.updatedAt,
              updatedAt: event.updatedAt
            })
          ),
          flashModels: { ...state.flashModels, [event.id]: true }
        }));
        window.setTimeout(() => {
          set((state) => ({ flashModels: { ...state.flashModels, [event.id]: false } }));
        }, 900);
        break;
      case "agent.plan_mode_changed":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              planMode: event.planMode,
              updatedAt: event.updatedAt
            })
          )
        }));
        break;
      case "agent.permission_mode_changed":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              permissionMode: event.permissionMode,
              planMode: event.planMode,
              updatedAt: event.updatedAt
            })
          )
        }));
        break;
      case "agent.effort_changed":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              effort: event.effort,
              updatedAt: event.updatedAt
            })
          )
        }));
        break;
      case "agent.thinking_changed":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              thinking: event.thinking,
              updatedAt: event.updatedAt
            })
          )
        }));
        break;
      case "agent.session_info_changed":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              sessionTools: event.tools,
              mcpServers: event.mcpServers,
              slashCommands: event.slashCommands,
              activePlugins: event.activePlugins,
              updatedAt: event.updatedAt
            })
          )
        }));
        break;
      case "agent.transcript":
        set((state) => ({
          transcripts: {
            ...state.transcripts,
            [event.id]: [...(state.transcripts[event.id] || []), event.event]
          }
        }));
        break;
      case "agent.transcript_updated":
        set((state) => ({
          transcripts: {
            ...state.transcripts,
            [event.id]: (state.transcripts[event.id] || []).map((item) => (item.id === event.event.id ? event.event : item))
          }
        }));
        break;
      case "agent.terminated":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              status: event.status,
              statusMessage: event.statusMessage,
              updatedAt: event.updatedAt,
              pid: undefined
            })
          )
        }));
        break;
      case "agent.rc_url_ready":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              rcUrl: event.url,
              qr: event.qr,
              status: "remote-controlled",
              rcState: agent.rcState || "waiting-for-browser",
              updatedAt: event.updatedAt
            })
          )
        }));
        break;
      case "agent.remote_control_changed":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              rcState: event.rcState,
              rcDiagnostics: event.diagnostics,
              statusMessage: event.statusMessage,
              updatedAt: event.updatedAt
            })
          )
        }));
        break;
      case "agent.error":
        get().addError(event.message);
        break;
      case "terminal.snapshot":
        set((state) => {
          const terminalSessions = Object.fromEntries(event.snapshot.sessions.map((session) => [session.id, session]));
          const visibleSessions = event.snapshot.sessions.filter((session) => !session.hidden);
          const activeTerminalId =
            state.activeTerminalId && terminalSessions[state.activeTerminalId] && !terminalSessions[state.activeTerminalId].hidden
              ? state.activeTerminalId
              : visibleSessions[visibleSessions.length - 1]?.id;
          return {
            terminalSessions,
            terminalOutput: event.snapshot.output,
            activeTerminalId
          };
        });
        break;
      case "terminal.started":
        set((state) => ({
          terminalOpen: event.session.hidden ? state.terminalOpen : true,
          terminalSessions: { ...state.terminalSessions, [event.session.id]: event.session },
          terminalOutput: { ...state.terminalOutput, [event.session.id]: event.output },
          activeTerminalId: event.session.hidden ? state.activeTerminalId : event.session.id
        }));
        break;
      case "terminal.output":
        set((state) => ({
          terminalSessions: withTerminal(state.terminalSessions, event.id, (terminal) => ({
            ...terminal,
            updatedAt: event.updatedAt
          })),
          terminalOutput: {
            ...state.terminalOutput,
            [event.id]: [...(state.terminalOutput[event.id] || []), event.chunk].slice(-1200)
          }
        }));
        break;
      case "terminal.exited":
        set((state) => ({
          terminalSessions: withTerminal(state.terminalSessions, event.id, (terminal) => ({
            ...terminal,
            status: "exited",
            exitCode: event.exitCode,
            signal: event.signal,
            updatedAt: event.updatedAt
          }))
        }));
        break;
      case "terminal.cleared":
        set((state) => ({
          terminalOutput: { ...state.terminalOutput, [event.id]: [] }
        }));
        break;
      case "terminal.closed":
        set((state) => {
          const { [event.id]: _closedSession, ...terminalSessions } = state.terminalSessions;
          const { [event.id]: _closedOutput, ...terminalOutput } = state.terminalOutput;
          const remainingIds = Object.keys(terminalSessions);
          const visibleRemainingIds = remainingIds.filter((id) => !terminalSessions[id]?.hidden);
          const activeTerminalId =
            state.activeTerminalId === event.id ? visibleRemainingIds[visibleRemainingIds.length - 1] : state.activeTerminalId;
          return {
            terminalSessions,
            terminalOutput,
            activeTerminalId,
            terminalOpen: visibleRemainingIds.length > 0 ? state.terminalOpen : false
          };
        });
        break;
      case "terminal.renamed":
        set((state) => ({
          terminalSessions: withTerminal(state.terminalSessions, event.id, (terminal) => ({
            ...terminal,
            title: event.title,
            updatedAt: event.updatedAt
          }))
        }));
        break;
    }
  },
  setDraft: (id, text) => set((state) => ({ drafts: { ...state.drafts, [id]: text } })),
  enqueueMessage: (id, message) =>
    set((state) => {
      const messageQueues = writeStoredMessageQueues({
        ...state.messageQueues,
        [id]: [...(state.messageQueues[id] || []), { ...message, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` }]
      });
      return { messageQueues };
    }),
  updateQueuedMessage: (id, messageId, patch) =>
    set((state) => {
      const messageQueues = writeStoredMessageQueues({
        ...state.messageQueues,
        [id]: (state.messageQueues[id] || []).map((message) => (message.id === messageId ? { ...message, ...patch } : message))
      });
      return { messageQueues };
    }),
  removeQueuedMessage: (id, messageId) =>
    set((state) => {
      const messageQueues = writeStoredMessageQueues({
        ...state.messageQueues,
        [id]: (state.messageQueues[id] || []).filter((message) => message.id !== messageId)
      });
      return { messageQueues };
    }),
  reorderQueuedMessages: (id, orderedIds) =>
    set((state) => {
      const queue = state.messageQueues[id] || [];
      const byId = new Map(queue.map((message) => [message.id, message]));
      const ordered = orderedIds.map((messageId) => byId.get(messageId)).filter((message): message is QueuedMessage => Boolean(message));
      const missing = queue.filter((message) => !orderedIds.includes(message.id));
      const messageQueues = writeStoredMessageQueues({
        ...state.messageQueues,
        [id]: [...ordered, ...missing]
      });
      return {
        messageQueues
      };
    }),
  popNextQueuedMessage: (id) => {
    const queue = get().messageQueues[id] || [];
    const [next, ...rest] = queue;
    set((state) => ({
      messageQueues: writeStoredMessageQueues({
        ...state.messageQueues,
        [id]: rest
      })
    }));
    return next;
  },
  setScrollPosition: (id, top) => set((state) => ({ scrollPositions: { ...state.scrollPositions, [id]: top } })),
  setTileOrder: (ids) =>
    set((state) => ({
      tileOrder: writeStoredTileLayout({ order: ids, widths: state.tileWidths, minimized: state.minimizedTiles }).order
    })),
  setTileWidth: (id, width) =>
    set((state) => {
      const tileLayout = writeStoredTileLayout({
        order: state.tileOrder,
        widths: { ...state.tileWidths, [id]: width },
        minimized: state.minimizedTiles
      });
      return { tileWidths: tileLayout.widths };
    }),
  setTileMinimized: (id, minimized) =>
    set((state) => {
      const minimizedTiles = { ...state.minimizedTiles };
      if (minimized) minimizedTiles[id] = true;
      else delete minimizedTiles[id];
      return { minimizedTiles: writeStoredTileLayout({ order: state.tileOrder, widths: state.tileWidths, minimized: minimizedTiles }).minimized };
    }),
  setCurrentTileHeight: (height) => set({ currentTileHeight: height }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setFileExplorerOpen: (open) => {
    if (typeof window !== "undefined") window.localStorage.setItem("agent-control-file-explorer-open", String(open));
    set({
      fileExplorerOpen: open,
      fileExplorerMaximized: open ? get().fileExplorerMaximized : false,
      terminalInFileExplorer: open ? get().terminalInFileExplorer : false
    });
  },
  setFileExplorerMaximized: (maximized) => set({ fileExplorerMaximized: maximized, fileExplorerOpen: maximized ? true : get().fileExplorerOpen }),
  setFileExplorerDock: (dock) => {
    if (typeof window !== "undefined") window.localStorage.setItem("agent-control-file-explorer-open", "true");
    set({ settings: { ...get().settings, fileExplorerDock: dock }, fileExplorerOpen: true, fileExplorerMaximized: false });
  },
  setTerminalInFileExplorer: (docked) => set({ terminalInFileExplorer: docked }),
  setActiveTerminal: (id) =>
    set((state) => ({
      activeTerminalId: id,
      terminalSessions: id
        ? withTerminal(state.terminalSessions, id, (terminal) => ({ ...terminal, updatedAt: new Date().toISOString() }))
        : state.terminalSessions
    })),
  openLaunchModal: (modal) => set({ launchModal: { open: true, ...modal } }),
  closeLaunchModal: () => set({ launchModal: { open: false } }),
  openSendDialog: (dialog) => set({ sendDialog: { open: true, ...dialog } }),
  closeSendDialog: () => set({ sendDialog: { open: false } }),
  setSendFraming: (framing) => set((state) => ({ sendDialog: { ...state.sendDialog, framing } })),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setSearchQuery: (query) => set({ searchQuery: query })
}));
