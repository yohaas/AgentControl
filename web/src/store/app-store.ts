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
  QueuedMessage,
  RunningAgent,
  TerminalSession,
  TranscriptEvent,
  WsServerEvent
} from "@agent-hero/shared";

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
  chatTranscriptDetail: ChatTranscriptDetailMode;
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
  accessTokenEnabled: boolean;
  accessTokenSaved?: boolean;
  accessToken?: string;
}

export type TerminalDockPosition = "float" | "left" | "bottom" | "right";
export type FileExplorerDockPosition = "tile" | "left" | "bottom" | "right";
export type ThemeMode = "auto" | "light" | "dark";
export type ClaudeRuntime = "cli" | "api";
export type MenuDisplayMode = "iconOnly" | "iconText";
export type TileScrollingMode = "vertical" | "horizontal";
export type ChatTranscriptDetailMode = "responses" | "actions" | "detailed" | "raw";
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

interface FilePreviewRequest {
  id: number;
  projectId: string;
  path: string;
  line?: number;
}

interface TerminalProjectUiState {
  open: boolean;
  inFileExplorer: boolean;
  activeTerminalId?: string;
}

interface FileExplorerProjectUiState {
  open: boolean;
  maximized: boolean;
}

const MESSAGE_QUEUES_STORAGE_KEY = "agent-hero-message-queues";
const TILE_LAYOUT_STORAGE_KEY = "agent-hero-tile-layout";
const SELECTED_PROJECT_STORAGE_KEY = "agent-hero-selected-project";
const LEGACY_MESSAGE_QUEUES_STORAGE_KEY = "agent-control-message-queues";
const LEGACY_TILE_LAYOUT_STORAGE_KEY = "agent-control-tile-layout";
const LEGACY_SELECTED_PROJECT_STORAGE_KEY = "agent-control-selected-project";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "agent-hero-sidebar-collapsed";
const LEGACY_SIDEBAR_COLLAPSED_STORAGE_KEY = "agent-control-sidebar-collapsed";
const FILE_EXPLORER_OPEN_STORAGE_KEY = "agent-hero-file-explorer-open";
const LEGACY_FILE_EXPLORER_OPEN_STORAGE_KEY = "agent-control-file-explorer-open";
const FILE_EXPLORER_PROJECT_UI_STORAGE_KEY = "agent-hero-file-explorer-project-ui";
const LEGACY_FILE_EXPLORER_PROJECT_UI_STORAGE_KEY = "agent-control-file-explorer-project-ui";
const FILE_EXPLORER_POPOUT_STORAGE_KEY = "agent-hero-file-explorer-popout";
const FILE_EXPLORER_PREVIEW_STORAGE_KEY = "agent-hero-file-explorer-preview-request";
const REMOVED_QUEUE_TOMBSTONE_TTL_MS = 5 * 60 * 1000;
const removedQueueMessageIds = new Map<string, number>();
const WINDOWS_UPDATE_COMMANDS = [
  "powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\start-update.ps1"
];
const PREVIOUS_WINDOWS_UPDATE_COMMANDS = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-hero.ps1'; $command = \"Write-Host 'Starting AgentHero updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const OLDER_WINDOWS_UPDATE_COMMANDS = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-hero.ps1'; $command = \"Write-Host 'Starting AgentHero updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const POSIX_UPDATE_COMMANDS = ["bash ./scripts/update-agent-hero.sh"];
const PREVIOUS_WINDOWS_UPDATE_COMMANDS_LEGACY = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-control.ps1'; $command = \"Write-Host 'Starting AgentControl updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const OLDER_WINDOWS_UPDATE_COMMANDS_LEGACY = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-control.ps1'; $command = \"Write-Host 'Starting AgentControl updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const POSIX_UPDATE_COMMANDS_LEGACY = ["bash ./scripts/update-agent-control.sh"];
const LEGACY_UPDATE_COMMANDS = ["git pull", "npm ci", "npm run build", "Restart-Service AgentControl"];

function defaultUpdateCommands(): string[] {
  const platform = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  return platform.includes("win") ? WINDOWS_UPDATE_COMMANDS : POSIX_UPDATE_COMMANDS;
}

function readLocalStorageWithLegacy(key: string, legacyKey: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.localStorage.getItem(key) || undefined;
  if (value !== undefined) return value;
  const legacyValue = window.localStorage.getItem(legacyKey) || undefined;
  if (legacyValue !== undefined) window.localStorage.setItem(key, legacyValue);
  return legacyValue;
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
    return normalizeMessageQueues(JSON.parse(readLocalStorageWithLegacy(MESSAGE_QUEUES_STORAGE_KEY, LEGACY_MESSAGE_QUEUES_STORAGE_KEY) || "{}"));
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

function rememberRemovedQueuedMessage(id: string) {
  const now = Date.now();
  removedQueueMessageIds.set(id, now);
  for (const [messageId, removedAt] of removedQueueMessageIds) {
    if (now - removedAt > REMOVED_QUEUE_TOMBSTONE_TTL_MS) removedQueueMessageIds.delete(messageId);
  }
}

function wasRecentlyRemovedQueuedMessage(id: string): boolean {
  const removedAt = removedQueueMessageIds.get(id);
  if (!removedAt) return false;
  if (Date.now() - removedAt <= REMOVED_QUEUE_TOMBSTONE_TTL_MS) return true;
  removedQueueMessageIds.delete(id);
  return false;
}

function pruneMessageQueues(queues: Record<string, QueuedMessage[]>, agentIds: Set<string>): Record<string, QueuedMessage[]> {
  return writeStoredMessageQueues(Object.fromEntries(Object.entries(queues).filter(([agentId]) => agentIds.has(agentId))));
}

function mergeMessageQueues(
  primaryQueues: Record<string, QueuedMessage[]> | undefined,
  fallbackQueues: Record<string, QueuedMessage[]>,
  agentIds: Set<string>
): Record<string, QueuedMessage[]> {
  const merged: Record<string, QueuedMessage[]> = {};
  for (const agentId of agentIds) {
    const seen = new Set<string>();
    const queue = [...(primaryQueues?.[agentId] || []), ...(fallbackQueues[agentId] || [])].filter((message) => {
      if (wasRecentlyRemovedQueuedMessage(message.id)) return false;
      if (seen.has(message.id)) return false;
      seen.add(message.id);
      return true;
    });
    if (queue.length > 0) merged[agentId] = queue;
  }
  return writeStoredMessageQueues(merged);
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
    return normalizeTileLayout(JSON.parse(readLocalStorageWithLegacy(TILE_LAYOUT_STORAGE_KEY, LEGACY_TILE_LAYOUT_STORAGE_KEY) || "{}"));
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
  return readLocalStorageWithLegacy(SELECTED_PROJECT_STORAGE_KEY, LEGACY_SELECTED_PROJECT_STORAGE_KEY);
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
  chatTranscriptDetails: Record<string, ChatTranscriptDetailMode>;
  scrollPositions: Record<string, number>;
  flashModels: Record<string, boolean>;
  tileOrder: string[];
  tileWidths: Record<string, number>;
  minimizedTiles: Record<string, boolean>;
  currentTileHeight?: number;
  sidebarCollapsed: boolean;
  terminalOpen: boolean;
  terminalProjectUi: Record<string, TerminalProjectUiState>;
  fileExplorerProjectUi: Record<string, FileExplorerProjectUiState>;
  fileExplorerOpen: boolean;
  fileExplorerMaximized: boolean;
  filePreviewRequest?: FilePreviewRequest;
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
  setChatTranscriptDetail: (id: string, detail?: ChatTranscriptDetailMode) => void;
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
  openFilePreview: (projectId: string, path: string, line?: number) => void;
  receiveFilePreview: (projectId: string, path: string, line?: number, id?: number) => void;
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
  chatTranscriptDetail: "actions",
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
  accessTokenEnabled: false,
  claudeRuntime: "cli",
  claudeAgentDir: ".claude/agents",
  codexAgentDir: ".codex/agents",
  openaiAgentDir: ".agent-hero/openai-agents",
  builtInAgentDir: ".agent-hero/built-in-agents"
};

function initialFileExplorerOpen(): boolean {
  if (typeof window === "undefined") return true;
  return readLocalStorageWithLegacy(FILE_EXPLORER_OPEN_STORAGE_KEY, LEGACY_FILE_EXPLORER_OPEN_STORAGE_KEY) !== "false";
}

function normalizeFileExplorerProjectUi(value: unknown): Record<string, FileExplorerProjectUiState> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([projectId, state]) => {
        const record = state && typeof state === "object" ? (state as Partial<FileExplorerProjectUiState>) : {};
        return [
          projectId,
          {
            open: record.open === true,
            maximized: record.maximized === true
          }
        ] as const;
      })
      .filter(([projectId]) => Boolean(projectId))
  );
}

function readStoredFileExplorerProjectUi(): Record<string, FileExplorerProjectUiState> {
  if (typeof window === "undefined") return {};
  try {
    return normalizeFileExplorerProjectUi(
      JSON.parse(readLocalStorageWithLegacy(FILE_EXPLORER_PROJECT_UI_STORAGE_KEY, LEGACY_FILE_EXPLORER_PROJECT_UI_STORAGE_KEY) || "{}")
    );
  } catch {
    return {};
  }
}

function writeStoredFileExplorerProjectUi(ui: Record<string, FileExplorerProjectUiState>): Record<string, FileExplorerProjectUiState> {
  const normalized = normalizeFileExplorerProjectUi(ui);
  if (typeof window !== "undefined") {
    if (Object.keys(normalized).length === 0) window.localStorage.removeItem(FILE_EXPLORER_PROJECT_UI_STORAGE_KEY);
    else window.localStorage.setItem(FILE_EXPLORER_PROJECT_UI_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function readStoredSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return readLocalStorageWithLegacy(SIDEBAR_COLLAPSED_STORAGE_KEY, LEGACY_SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
}

function writeStoredSidebarCollapsed(collapsed: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
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
  const chatTranscriptDetail = ["responses", "actions", "detailed", "raw"].includes(settings.chatTranscriptDetail)
    ? settings.chatTranscriptDetail
    : defaultSettings.chatTranscriptDetail;
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
    accessTokenEnabled: settings.accessTokenEnabled === true,
    accessTokenSaved: settings.accessTokenSaved === true,
    agentControlProjectPath: typeof settings.agentControlProjectPath === "string" ? settings.agentControlProjectPath : "",
    externalEditor,
    externalEditorUrlTemplate: typeof settings.externalEditorUrlTemplate === "string" ? settings.externalEditorUrlTemplate : "",
    updateCommands: (() => {
      const normalized = Array.isArray(settings.updateCommands) ? settings.updateCommands.map((command) => command.trim()).filter(Boolean) : [];
      const commandKey = normalized.join("\n");
      return normalized.length &&
        commandKey !== LEGACY_UPDATE_COMMANDS.join("\n") &&
        commandKey !== PREVIOUS_WINDOWS_UPDATE_COMMANDS.join("\n") &&
        commandKey !== OLDER_WINDOWS_UPDATE_COMMANDS.join("\n") &&
        commandKey !== PREVIOUS_WINDOWS_UPDATE_COMMANDS_LEGACY.join("\n") &&
        commandKey !== OLDER_WINDOWS_UPDATE_COMMANDS_LEGACY.join("\n") &&
        commandKey !== POSIX_UPDATE_COMMANDS_LEGACY.join("\n")
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
    tileScrolling,
    chatTranscriptDetail
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
    .filter((terminal) => !terminal.hidden && (!projectId || terminal.projectId === projectId))
    .sort((left, right) => +new Date(left.startedAt) - +new Date(right.startedAt))
    .at(-1)?.id;
}

function visibleTerminalsForProject(terminals: Record<string, TerminalSession>, projectId?: string) {
  return Object.values(terminals).filter((terminal) => !terminal.hidden && (!projectId || terminal.projectId === projectId));
}

function saveCurrentProjectTerminalUi(state: AppState): Record<string, TerminalProjectUiState> {
  if (!state.selectedProjectId) return state.terminalProjectUi;
  return {
    ...state.terminalProjectUi,
    [state.selectedProjectId]: {
      open: state.terminalOpen,
      inFileExplorer: state.terminalInFileExplorer,
      activeTerminalId: state.activeTerminalId
    }
  };
}

function terminalUiForProject(state: AppState, projectId: string | undefined, terminalProjectUi = state.terminalProjectUi) {
  const projectTerminals = visibleTerminalsForProject(state.terminalSessions, projectId);
  const projectTerminalIds = new Set(projectTerminals.map((terminal) => terminal.id));
  const stored = projectId ? terminalProjectUi[projectId] : undefined;
  const activeTerminalId =
    stored?.activeTerminalId && projectTerminalIds.has(stored.activeTerminalId)
      ? stored.activeTerminalId
      : latestTerminalForProject(state.terminalSessions, projectId);
  const terminalOpen = Boolean(stored?.open && projectTerminals.length > 0);
  return {
    terminalOpen,
    terminalInFileExplorer: terminalOpen ? Boolean(stored?.inFileExplorer) : false,
    activeTerminalId
  };
}

function saveCurrentProjectFileExplorerUi(state: AppState): Record<string, FileExplorerProjectUiState> {
  if (!state.selectedProjectId) return state.fileExplorerProjectUi;
  return writeStoredFileExplorerProjectUi({
    ...state.fileExplorerProjectUi,
    [state.selectedProjectId]: {
      open: state.fileExplorerOpen,
      maximized: state.fileExplorerMaximized
    }
  });
}

function fileExplorerUiForProject(
  projectId: string | undefined,
  fileExplorerProjectUi: Record<string, FileExplorerProjectUiState>
) {
  const stored = projectId ? fileExplorerProjectUi[projectId] : undefined;
  return {
    fileExplorerOpen: stored ? stored.open : initialFileExplorerOpen(),
    fileExplorerMaximized: stored ? stored.maximized : false
  };
}

const TRANSIENT_WS_NOT_CONNECTED_ERROR = "Backend server not running.";
const initialTileLayout = readStoredTileLayout();
const initialFileExplorerProjectUi = readStoredFileExplorerProjectUi();
const initialFileExplorerUi = fileExplorerUiForProject(readStoredSelectedProjectId(), initialFileExplorerProjectUi);

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
  chatTranscriptDetails: {},
  scrollPositions: {},
  flashModels: {},
  tileOrder: initialTileLayout.order,
  tileWidths: initialTileLayout.widths,
  minimizedTiles: initialTileLayout.minimized,
  currentTileHeight: undefined,
  sidebarCollapsed: readStoredSidebarCollapsed(),
  terminalOpen: false,
  terminalProjectUi: {},
  fileExplorerProjectUi: initialFileExplorerProjectUi,
  fileExplorerOpen: initialFileExplorerUi.fileExplorerOpen,
  fileExplorerMaximized: initialFileExplorerUi.fileExplorerMaximized,
  filePreviewRequest: undefined,
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
      const terminalProjectUi =
        state.selectedProjectId && state.selectedProjectId !== selectedProjectId ? saveCurrentProjectTerminalUi(state) : state.terminalProjectUi;
      const terminalUi = terminalUiForProject(state, selectedProjectId, terminalProjectUi);
      const fileExplorerProjectUi =
        state.selectedProjectId && state.selectedProjectId !== selectedProjectId ? saveCurrentProjectFileExplorerUi(state) : state.fileExplorerProjectUi;
      const fileExplorerUi = fileExplorerUiForProject(selectedProjectId, fileExplorerProjectUi);
      return {
        projects,
        selectedProjectId,
        selectedAgentId: selectedAgent,
        focusedAgentId: focusedAgent,
        chatFocusedAgentId:
          state.chatFocusedAgentId && state.agents[state.chatFocusedAgentId]?.projectId === selectedProjectId
            ? state.chatFocusedAgentId
            : undefined,
        fileExplorerProjectUi,
        terminalProjectUi,
        ...terminalUi,
        ...fileExplorerUi
      };
    }),
  setSelectedProject: (id) =>
    set((state) => {
      writeStoredSelectedProjectId(id);
      const terminalProjectUi = saveCurrentProjectTerminalUi(state);
      const terminalUi = terminalUiForProject(state, id, terminalProjectUi);
      const fileExplorerProjectUi = saveCurrentProjectFileExplorerUi(state);
      const fileExplorerUi = fileExplorerUiForProject(id, fileExplorerProjectUi);
      return {
        selectedProjectId: id,
        selectedAgentId: undefined,
        focusedAgentId: undefined,
        chatFocusedAgentId: undefined,
        fileExplorerProjectUi,
        terminalProjectUi,
        ...terminalUi,
        ...fileExplorerUi
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
        messageQueues: snapshot.messageQueues
          ? mergeMessageQueues(snapshot.messageQueues, state.messageQueues, agentIds)
          : pruneMessageQueues(state.messageQueues, agentIds),
        chatTranscriptDetails: Object.fromEntries(Object.entries(state.chatTranscriptDetails).filter(([id]) => agentIds.has(id))),
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
      case "agent.message_queues":
        set((state) => {
          const agentIds = new Set(Object.keys(state.agents));
          return { messageQueues: mergeMessageQueues(event.messageQueues, state.messageQueues, agentIds) };
        });
        break;
      case "agent.launched":
        set((state) => {
          writeStoredSidebarCollapsed(true);
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
            minimizedTiles: tileLayout.minimized,
            sidebarCollapsed: true
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
            [event.id]: (state.transcripts[event.id] || []).some((item) => item.id === event.event.id)
              ? (state.transcripts[event.id] || []).map((item) => (item.id === event.event.id ? event.event : item))
              : [...(state.transcripts[event.id] || []), event.event]
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
          const terminalUi = terminalUiForProject({ ...state, terminalSessions }, state.selectedProjectId);
          return {
            terminalSessions,
            terminalOutput: event.snapshot.output,
            ...terminalUi
          };
        });
        break;
      case "terminal.started":
        set((state) => {
          const terminalSessions = { ...state.terminalSessions, [event.session.id]: event.session };
          const sessionProjectId = event.session.projectId;
          const selectedSession = !sessionProjectId || sessionProjectId === state.selectedProjectId;
          const terminalProjectUi =
            !event.session.hidden && sessionProjectId
              ? {
                  ...state.terminalProjectUi,
                  [sessionProjectId]: {
                    open: true,
                    inFileExplorer: state.terminalProjectUi[sessionProjectId]?.inFileExplorer || false,
                    activeTerminalId: event.session.id
                  }
                }
              : state.terminalProjectUi;
          return {
            terminalOpen: !event.session.hidden && selectedSession ? true : state.terminalOpen,
            terminalProjectUi,
            terminalSessions,
            terminalOutput: { ...state.terminalOutput, [event.session.id]: event.output },
            activeTerminalId: !event.session.hidden && selectedSession ? event.session.id : state.activeTerminalId
          };
        });
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
          const closedProjectId = _closedSession?.projectId;
          const selectedVisibleRemainingIds = visibleTerminalsForProject(terminalSessions, state.selectedProjectId).map((terminal) => terminal.id);
          const closedProjectVisibleRemainingIds = visibleTerminalsForProject(terminalSessions, closedProjectId).map((terminal) => terminal.id);
          const activeTerminalId =
            state.activeTerminalId === event.id ? selectedVisibleRemainingIds[selectedVisibleRemainingIds.length - 1] : state.activeTerminalId;
          const terminalProjectUi =
            closedProjectId && state.terminalProjectUi[closedProjectId]
              ? {
                  ...state.terminalProjectUi,
                  [closedProjectId]: {
                    ...state.terminalProjectUi[closedProjectId],
                    open: closedProjectVisibleRemainingIds.length > 0 ? state.terminalProjectUi[closedProjectId].open : false,
                    activeTerminalId:
                      state.terminalProjectUi[closedProjectId].activeTerminalId === event.id
                        ? closedProjectVisibleRemainingIds[closedProjectVisibleRemainingIds.length - 1]
                        : state.terminalProjectUi[closedProjectId].activeTerminalId
                  }
                }
              : state.terminalProjectUi;
          return {
            terminalSessions,
            terminalOutput,
            terminalProjectUi,
            activeTerminalId,
            terminalOpen: selectedVisibleRemainingIds.length > 0 ? state.terminalOpen : false
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
  setChatTranscriptDetail: (id, detail) =>
    set((state) => {
      const chatTranscriptDetails = { ...state.chatTranscriptDetails };
      if (detail) chatTranscriptDetails[id] = detail;
      else delete chatTranscriptDetails[id];
      return { chatTranscriptDetails };
    }),
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
      rememberRemovedQueuedMessage(messageId);
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
    if (next) rememberRemovedQueuedMessage(next.id);
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
  setSidebarCollapsed: (collapsed) => {
    writeStoredSidebarCollapsed(collapsed);
    set({ sidebarCollapsed: collapsed });
  },
  setTerminalOpen: (open) =>
    set((state) => ({
      terminalOpen: open,
      terminalInFileExplorer: open ? state.terminalInFileExplorer : false,
      terminalProjectUi: state.selectedProjectId
        ? {
            ...state.terminalProjectUi,
            [state.selectedProjectId]: {
              open,
              inFileExplorer: open ? state.terminalInFileExplorer : false,
              activeTerminalId: state.activeTerminalId
            }
          }
        : state.terminalProjectUi
    })),
  setFileExplorerOpen: (open) => {
    set((state) => {
      const terminalInFileExplorer = open ? state.terminalInFileExplorer : false;
      const fileExplorerProjectUi = state.selectedProjectId
        ? writeStoredFileExplorerProjectUi({
            ...state.fileExplorerProjectUi,
            [state.selectedProjectId]: {
              open,
              maximized: open ? state.fileExplorerMaximized : false
            }
          })
        : state.fileExplorerProjectUi;
      return {
        fileExplorerProjectUi,
        fileExplorerOpen: open,
        fileExplorerMaximized: open ? state.fileExplorerMaximized : false,
        terminalInFileExplorer,
        terminalProjectUi: state.selectedProjectId
          ? {
              ...state.terminalProjectUi,
              [state.selectedProjectId]: {
                open: state.terminalOpen,
                inFileExplorer: terminalInFileExplorer,
                activeTerminalId: state.activeTerminalId
              }
            }
          : state.terminalProjectUi
      };
    });
  },
  setFileExplorerMaximized: (maximized) =>
    set((state) => {
      const fileExplorerOpen = maximized ? true : state.fileExplorerOpen;
      const fileExplorerProjectUi = state.selectedProjectId
        ? writeStoredFileExplorerProjectUi({
            ...state.fileExplorerProjectUi,
            [state.selectedProjectId]: {
              open: fileExplorerOpen,
              maximized
            }
          })
        : state.fileExplorerProjectUi;
      return { fileExplorerProjectUi, fileExplorerMaximized: maximized, fileExplorerOpen };
    }),
  openFilePreview: (projectId, path, line) => {
    const requestId = Date.now();
    if (typeof window !== "undefined") {
      const popoutOpen = window.localStorage.getItem(FILE_EXPLORER_POPOUT_STORAGE_KEY) === "true";
      if (popoutOpen && !get().fileExplorerOpen) {
        window.localStorage.setItem(FILE_EXPLORER_PREVIEW_STORAGE_KEY, JSON.stringify({ id: requestId, projectId, path, line }));
        writeStoredSelectedProjectId(projectId);
        set({ selectedProjectId: projectId });
        return;
      }
      window.localStorage.setItem(FILE_EXPLORER_OPEN_STORAGE_KEY, "true");
    }
    set((state) => {
      writeStoredSelectedProjectId(projectId);
      const tileOrder = state.tileOrder.includes("file-explorer") ? state.tileOrder : ["file-explorer", ...state.tileOrder];
      const currentTargetUi = state.fileExplorerProjectUi[projectId];
      const fileExplorerProjectUi = writeStoredFileExplorerProjectUi({
        ...saveCurrentProjectFileExplorerUi(state),
        [projectId]: {
          open: true,
          maximized: currentTargetUi?.maximized || false
        }
      });
      return {
        selectedProjectId: projectId,
        fileExplorerProjectUi,
        fileExplorerOpen: true,
        fileExplorerMaximized: currentTargetUi?.maximized || false,
        tileOrder: writeStoredTileLayout({ order: tileOrder, widths: state.tileWidths, minimized: state.minimizedTiles }).order,
        filePreviewRequest: {
          id: requestId,
          projectId,
          path,
          line
        }
      };
    });
  },
  receiveFilePreview: (projectId, path, line, id) => {
    writeStoredSelectedProjectId(projectId);
    set((state) => ({
      selectedProjectId: projectId,
      fileExplorerProjectUi: writeStoredFileExplorerProjectUi({
        ...saveCurrentProjectFileExplorerUi(state),
        [projectId]: {
          open: true,
          maximized: false
        }
      }),
      fileExplorerOpen: true,
      fileExplorerMaximized: false,
      filePreviewRequest: {
        id: id || Date.now(),
        projectId,
        path,
        line
      }
    }));
  },
  setFileExplorerDock: (dock) => {
    set((state) => ({
      settings: { ...state.settings, fileExplorerDock: dock },
      fileExplorerProjectUi: state.selectedProjectId
        ? writeStoredFileExplorerProjectUi({
            ...state.fileExplorerProjectUi,
            [state.selectedProjectId]: {
              open: true,
              maximized: false
            }
          })
        : state.fileExplorerProjectUi,
      fileExplorerOpen: true,
      fileExplorerMaximized: false
    }));
  },
  setTerminalInFileExplorer: (docked) =>
    set((state) => ({
      terminalInFileExplorer: docked,
      terminalProjectUi: state.selectedProjectId
        ? {
            ...state.terminalProjectUi,
            [state.selectedProjectId]: {
              open: state.terminalOpen,
              inFileExplorer: docked,
              activeTerminalId: state.activeTerminalId
            }
          }
        : state.terminalProjectUi
    })),
  setActiveTerminal: (id) =>
    set((state) => ({
      activeTerminalId: id,
      terminalProjectUi:
        id && state.selectedProjectId
          ? {
              ...state.terminalProjectUi,
              [state.selectedProjectId]: {
                open: state.terminalOpen,
                inFileExplorer: state.terminalInFileExplorer,
                activeTerminalId: id
              }
            }
          : state.terminalProjectUi,
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
