import { create } from "zustand";
import type {
  AgentSnapshot,
  AgentPermissionMode,
  AutoApproveMode,
  Capabilities,
  ModelProfile,
  MessageAttachment,
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
  defaultAgentMode: AgentPermissionMode;
  tileHeight: number;
  tileColumns: number;
  sidebarWidth: number;
  pinLastSentMessage: boolean;
  terminalDock: TerminalDockPosition;
  themeMode: ThemeMode;
}

export type TerminalDockPosition = "float" | "left" | "bottom" | "right";
export type ThemeMode = "auto" | "light" | "dark";

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
  initialPrompt?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: MessageAttachment[];
}

interface AppState {
  projects: Project[];
  selectedProjectId?: string;
  agents: Record<string, RunningAgent>;
  transcripts: Record<string, TranscriptEvent[]>;
  selectedAgentId?: string;
  focusedAgentId?: string;
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
  currentTileHeight?: number;
  sidebarCollapsed: boolean;
  terminalOpen: boolean;
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
  setCurrentTileHeight: (height?: number) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTerminalOpen: (open: boolean) => void;
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
    { id: "gpt-5.3-codex", provider: "codex", default: true, supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.3-codex-spark", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.2-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.1-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.1-codex-max", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5.1-codex-mini", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
    { id: "gpt-5-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] }
  ],
  autoApprove: "off",
  defaultAgentMode: "acceptEdits",
  tileHeight: 460,
  tileColumns: 2,
  sidebarWidth: 280,
  pinLastSentMessage: true,
  terminalDock: "bottom",
  themeMode: "auto",
  claudeAgentDir: ".claude/agents",
  codexAgentDir: ".codex/agents",
  openaiAgentDir: ".agent-control/openai-agents",
  builtInAgentDir: "~/.agent-control/built-in-agents"
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeSettings(settings: SettingsState): SettingsState {
  const terminalDock = ["float", "left", "bottom", "right"].includes(settings.terminalDock)
    ? settings.terminalDock
    : defaultSettings.terminalDock;
  const defaultAgentMode = ["default", "acceptEdits", "plan", "bypassPermissions"].includes(settings.defaultAgentMode)
    ? settings.defaultAgentMode
    : defaultSettings.defaultAgentMode;
  const themeMode = ["auto", "light", "dark"].includes(settings.themeMode) ? settings.themeMode : defaultSettings.themeMode;
  return {
    ...defaultSettings,
    ...settings,
    modelProfiles: Array.isArray(settings.modelProfiles) && settings.modelProfiles.length ? settings.modelProfiles : defaultSettings.modelProfiles,
    defaultAgentMode,
    tileHeight: clampNumber(settings.tileHeight, defaultSettings.tileHeight, 320, 760),
    tileColumns: clampNumber(settings.tileColumns, defaultSettings.tileColumns, 1, 6),
    sidebarWidth: clampNumber(settings.sidebarWidth, defaultSettings.sidebarWidth, 240, 420),
    terminalDock,
    themeMode
  };
}

function mergeAgent(agent: RunningAgent, patch: Partial<RunningAgent>): RunningAgent {
  return { ...agent, ...patch };
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

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  agents: {},
  transcripts: {},
  focusedAgentId: undefined,
  settings: defaultSettings,
  wsConnected: false,
  errors: [],
  drafts: {},
  messageQueues: {},
  scrollPositions: {},
  flashModels: {},
  tileOrder: [],
  tileWidths: {},
  currentTileHeight: undefined,
  sidebarCollapsed: false,
  terminalOpen: false,
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
        activeTerminalId: latestTerminalForProject(state.terminalSessions, selectedProjectId)
      };
    }),
  setSelectedProject: (id) =>
    set((state) => ({
      selectedProjectId: id,
      selectedAgentId: undefined,
      focusedAgentId: undefined,
      activeTerminalId: latestTerminalForProject(state.terminalSessions, id)
    })),
  setSelectedAgent: (id) => set({ selectedAgentId: id }),
  setFocusedAgent: (id) => set({ focusedAgentId: id }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setSettings: (settings) => set({ settings: normalizeSettings(settings) }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
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
    set((state) => ({
      agents: agentMap(snapshot.agents),
      transcripts: snapshot.transcripts,
      capabilities: snapshot.capabilities || state.capabilities,
      selectedAgentId:
        state.selectedAgentId && snapshot.agents.some((agent) => agent.id === state.selectedAgentId)
          ? state.selectedAgentId
          : undefined,
      focusedAgentId:
        state.focusedAgentId && snapshot.agents.some((agent) => agent.id === state.focusedAgentId)
          ? state.focusedAgentId
          : undefined,
      tileOrder: [
        ...state.tileOrder.filter((id) => snapshot.agents.some((agent) => agent.id === id)),
        ...snapshot.agents.filter((agent) => !state.tileOrder.includes(agent.id)).map((agent) => agent.id)
      ],
      tileWidths: Object.fromEntries(Object.entries(state.tileWidths).filter(([id]) => snapshot.agents.some((agent) => agent.id === id)))
    })),
  handleServerEvent: (event) => {
    switch (event.type) {
      case "agent.snapshot":
        get().hydrateSnapshot(event.snapshot);
        break;
      case "agent.launched":
        set((state) => ({
          agents: { ...state.agents, [event.agent.id]: event.agent },
          transcripts: { ...state.transcripts, [event.agent.id]: state.transcripts[event.agent.id] || [] },
          selectedAgentId: state.selectedAgentId ? event.agent.id : undefined,
          focusedAgentId: event.agent.id,
          tileOrder: [...state.tileOrder.filter((id) => id !== event.agent.id), event.agent.id]
        }));
        break;
      case "agent.status_changed":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              status: event.status,
              statusMessage: event.statusMessage,
              restorable: event.restorable,
              pid: event.pid,
              updatedAt: event.updatedAt
            })
          )
        }));
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
          const activeTerminalId =
            state.activeTerminalId && terminalSessions[state.activeTerminalId]
              ? state.activeTerminalId
              : event.snapshot.sessions[event.snapshot.sessions.length - 1]?.id;
          return {
            terminalSessions,
            terminalOutput: event.snapshot.output,
            activeTerminalId
          };
        });
        break;
      case "terminal.started":
        set((state) => ({
          terminalOpen: true,
          terminalSessions: { ...state.terminalSessions, [event.session.id]: event.session },
          terminalOutput: { ...state.terminalOutput, [event.session.id]: event.output },
          activeTerminalId: event.session.id
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
          const activeTerminalId =
            state.activeTerminalId === event.id ? remainingIds[remainingIds.length - 1] : state.activeTerminalId;
          return {
            terminalSessions,
            terminalOutput,
            activeTerminalId,
            terminalOpen: remainingIds.length > 0 ? state.terminalOpen : false
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
    set((state) => ({
      messageQueues: {
        ...state.messageQueues,
        [id]: [...(state.messageQueues[id] || []), { ...message, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` }]
      }
    })),
  updateQueuedMessage: (id, messageId, patch) =>
    set((state) => ({
      messageQueues: {
        ...state.messageQueues,
        [id]: (state.messageQueues[id] || []).map((message) => (message.id === messageId ? { ...message, ...patch } : message))
      }
    })),
  removeQueuedMessage: (id, messageId) =>
    set((state) => ({
      messageQueues: {
        ...state.messageQueues,
        [id]: (state.messageQueues[id] || []).filter((message) => message.id !== messageId)
      }
    })),
  reorderQueuedMessages: (id, orderedIds) =>
    set((state) => {
      const queue = state.messageQueues[id] || [];
      const byId = new Map(queue.map((message) => [message.id, message]));
      const ordered = orderedIds.map((messageId) => byId.get(messageId)).filter((message): message is QueuedMessage => Boolean(message));
      const missing = queue.filter((message) => !orderedIds.includes(message.id));
      return {
        messageQueues: {
          ...state.messageQueues,
          [id]: [...ordered, ...missing]
        }
      };
    }),
  popNextQueuedMessage: (id) => {
    const queue = get().messageQueues[id] || [];
    const [next, ...rest] = queue;
    set((state) => ({
      messageQueues: {
        ...state.messageQueues,
        [id]: rest
      }
    }));
    return next;
  },
  setScrollPosition: (id, top) => set((state) => ({ scrollPositions: { ...state.scrollPositions, [id]: top } })),
  setTileOrder: (ids) => set({ tileOrder: ids }),
  setTileWidth: (id, width) => set((state) => ({ tileWidths: { ...state.tileWidths, [id]: width } })),
  setCurrentTileHeight: (height) => set({ currentTileHeight: height }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setTerminalOpen: (open) => set({ terminalOpen: open }),
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
