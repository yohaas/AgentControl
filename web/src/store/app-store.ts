import { create } from "zustand";
import type {
  AgentSnapshot,
  AutoApproveMode,
  Capabilities,
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
  autoApprove: AutoApproveMode;
  tileHeight: number;
  tileColumns: number;
}

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
  scrollPositions: Record<string, number>;
  flashModels: Record<string, boolean>;
  tileOrder: string[];
  tileWidths: Record<string, number>;
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
  hydrateSnapshot: (snapshot: AgentSnapshot) => void;
  handleServerEvent: (event: WsServerEvent) => void;
  setDraft: (id: string, text: string) => void;
  setScrollPosition: (id: string, top: number) => void;
  setTileOrder: (ids: string[]) => void;
  setTileWidth: (id: string, width: number) => void;
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
  autoApprove: "off",
  tileHeight: 460,
  tileColumns: 2
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeSettings(settings: SettingsState): SettingsState {
  return {
    ...defaultSettings,
    ...settings,
    tileHeight: clampNumber(settings.tileHeight, defaultSettings.tileHeight, 320, 760),
    tileColumns: clampNumber(settings.tileColumns, defaultSettings.tileColumns, 1, 6)
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
  scrollPositions: {},
  flashModels: {},
  tileOrder: [],
  tileWidths: {},
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
  addError: (message) => set((state) => ({ errors: [message, ...state.errors].slice(0, 5) })),
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
  setScrollPosition: (id, top) => set((state) => ({ scrollPositions: { ...state.scrollPositions, [id]: top } })),
  setTileOrder: (ids) => set({ tileOrder: ids }),
  setTileWidth: (id, width) => set((state) => ({ tileWidths: { ...state.tileWidths, [id]: width } })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  setActiveTerminal: (id) => set({ activeTerminalId: id }),
  openLaunchModal: (modal) => set({ launchModal: { open: true, ...modal } }),
  closeLaunchModal: () => set({ launchModal: { open: false } }),
  openSendDialog: (dialog) => set({ sendDialog: { open: true, ...dialog } }),
  closeSendDialog: () => set({ sendDialog: { open: false } }),
  setSendFraming: (framing) => set((state) => ({ sendDialog: { ...state.sendDialog, framing } })),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setSearchQuery: (query) => set({ searchQuery: query })
}));
