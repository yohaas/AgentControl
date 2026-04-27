import { create } from "zustand";
import type {
  AgentSnapshot,
  AutoApproveMode,
  Capabilities,
  Project,
  RunningAgent,
  TranscriptEvent,
  WsServerEvent
} from "@agent-control/shared";

export interface SettingsState {
  projectsRoot: string;
  models: string[];
  autoApprove: AutoApproveMode;
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
  capabilities?: Capabilities;
  settings: SettingsState;
  wsConnected: boolean;
  errors: string[];
  drafts: Record<string, string>;
  scrollPositions: Record<string, number>;
  flashModels: Record<string, boolean>;
  launchModal: LaunchModalState;
  sendDialog: SendDialogState;
  searchOpen: boolean;
  searchQuery: string;
  setProjects: (projects: Project[]) => void;
  setSelectedProject: (id?: string) => void;
  setSelectedAgent: (id?: string) => void;
  setCapabilities: (capabilities: Capabilities) => void;
  setSettings: (settings: SettingsState) => void;
  setWsConnected: (connected: boolean) => void;
  addError: (message: string) => void;
  hydrateSnapshot: (snapshot: AgentSnapshot) => void;
  handleServerEvent: (event: WsServerEvent) => void;
  setDraft: (id: string, text: string) => void;
  setScrollPosition: (id: string, top: number) => void;
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
  autoApprove: "off"
};

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

function agentMap(agents: RunningAgent[]) {
  return Object.fromEntries(agents.map((agent) => [agent.id, agent]));
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  agents: {},
  transcripts: {},
  settings: defaultSettings,
  wsConnected: false,
  errors: [],
  drafts: {},
  scrollPositions: {},
  flashModels: {},
  launchModal: { open: false },
  sendDialog: { open: false },
  searchOpen: false,
  searchQuery: "",
  setProjects: (projects) =>
    set((state) => ({
      projects,
      selectedProjectId: state.selectedProjectId || projects[0]?.id
    })),
  setSelectedProject: (id) => set({ selectedProjectId: id }),
  setSelectedAgent: (id) => set({ selectedAgentId: id }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setSettings: (settings) => set({ settings }),
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
          : snapshot.agents[0]?.id
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
          selectedAgentId: event.agent.id
        }));
        break;
      case "agent.status_changed":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, {
              status: event.status,
              statusMessage: event.statusMessage,
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
      case "agent.terminated":
        set((state) => ({
          agents: withAgent(state.agents, event.id, (agent) =>
            mergeAgent(agent, { status: event.status, updatedAt: event.updatedAt, pid: undefined })
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
    }
  },
  setDraft: (id, text) => set((state) => ({ drafts: { ...state.drafts, [id]: text } })),
  setScrollPosition: (id, top) => set((state) => ({ scrollPositions: { ...state.scrollPositions, [id]: top } })),
  openLaunchModal: (modal) => set({ launchModal: { open: true, ...modal } }),
  closeLaunchModal: () => set({ launchModal: { open: false } }),
  openSendDialog: (dialog) => set({ sendDialog: { open: true, ...dialog } }),
  closeSendDialog: () => set({ sendDialog: { open: false } }),
  setSendFraming: (framing) => set((state) => ({ sendDialog: { ...state.sendDialog, framing } })),
  setSearchOpen: (open) => set({ searchOpen: open }),
  setSearchQuery: (query) => set({ searchQuery: query })
}));
