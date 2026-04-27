import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ExternalLink,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Square,
  Trash2,
  X
} from "lucide-react";
import type { AgentDef, RunningAgent, TranscriptEvent } from "@agent-control/shared";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from "./components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "./components/ui/dropdown-menu";
import { Input } from "./components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Textarea } from "./components/ui/textarea";
import { useTextSelection } from "./hooks/use-text-selection";
import { api } from "./lib/api";
import { cn, downloadText, formatDuration, prettyJson } from "./lib/utils";
import { connectWebSocket, disconnectWebSocket, sendCommand } from "./lib/ws-client";
import { useAppStore } from "./store/app-store";

const DEFAULT_MODEL = "claude-sonnet-4-6";

function AgentDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("h-3 w-3 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

function StatusPill({ status }: { status: RunningAgent["status"] }) {
  const className =
    status === "running"
      ? "border-blue-400/40 bg-blue-500/15 text-blue-200 animate-pulse"
      : status === "idle"
        ? "border-zinc-500/40 bg-zinc-500/10 text-zinc-300"
        : status === "awaiting-permission"
          ? "border-amber-400/40 bg-amber-500/15 text-amber-200"
          : status === "error"
            ? "border-red-400/40 bg-red-500/15 text-red-200"
            : status === "killed"
              ? "border-zinc-700 bg-zinc-800 text-zinc-500"
              : "border-teal-400/40 bg-teal-500/15 text-teal-200";
  return <Badge className={cn("capitalize", className)}>{status}</Badge>;
}

function wrapForwardedText(source: RunningAgent, selectedText: string, framing?: string) {
  const quoted = selectedText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return [`> Forwarded from ${source.displayName} (${source.currentModel}):`, ">", quoted, "", framing || ""]
    .join("\n")
    .trim();
}

function Header() {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const wsConnected = useAppStore((state) => state.wsConnected);
  const setProjects = useAppStore((state) => state.setProjects);
  const addError = useAppStore((state) => state.addError);

  async function refresh() {
    try {
      setProjects(await api.refresh());
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Bot className="h-5 w-5 text-primary" />
        <h1 className="truncate text-base font-semibold">Agent Control</h1>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Select value={selectedProjectId} onValueChange={setSelectedProject}>
          <SelectTrigger className="w-60">
            <SelectValue placeholder="Select project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={refresh} title="Refresh projects">
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button disabled={!selectedProjectId} onClick={() => openLaunchModal({ projectId: selectedProjectId })}>
          <Plus className="h-4 w-4" />
          Launch Agent
        </Button>
        <SettingsDialog />
        <Badge className={wsConnected ? "border-teal-400/40 text-teal-200" : "border-red-400/40 text-red-200"}>
          {wsConnected ? "WS live" : "WS offline"}
        </Badge>
      </div>
    </header>
  );
}

function Sidebar() {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const agents = useAppStore((state) => Object.values(state.agents));
  const selectedAgentId = useAppStore((state) => state.selectedAgentId);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);

  const project = projects.find((candidate) => candidate.id === selectedProjectId);
  const running = [...agents].sort((left, right) => +new Date(right.launchedAt) - +new Date(left.launchedAt));

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-card/45">
      <section className="min-h-0 border-b border-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Running</h2>
          {running.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => sendCommand({ type: "clearAll" })}>
              Clear All
            </Button>
          )}
        </div>
        <div className="max-h-[42vh] space-y-1 overflow-auto pr-1">
          {running.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
              No agents running.
            </p>
          ) : (
            running.map((agent) => (
              <button
                key={agent.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent",
                  selectedAgentId === agent.id && "bg-accent"
                )}
                onClick={() => setSelectedAgent(agent.id)}
              >
                <AgentDot color={agent.color} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 truncate text-sm">
                    {agent.displayName}
                    {agent.remoteControl && <Badge className="px-1 py-0 text-[10px]">RC</Badge>}
                  </span>
                  <ModelText agent={agent} />
                </span>
                <StatusPill status={agent.status} />
              </button>
            ))
          )}
        </div>
      </section>
      <section className="min-h-0 flex-1 p-3">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent definitions</h2>
        <div className="space-y-1 overflow-auto pr-1">
          {!project ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
              Select a project.
            </p>
          ) : project.agents.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
              No agent definition files found.
            </p>
          ) : (
            project.agents.map((agent) => (
              <button
                key={agent.name}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
                onClick={() => openLaunchModal({ projectId: project.id, defName: agent.name })}
              >
                <AgentDot color={agent.color} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-normal">{agent.name}</span>
                  {agent.defaultModel && (
                    <span className="block truncate text-xs text-muted-foreground">{agent.defaultModel}</span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </section>
    </aside>
  );
}

function ModelText({ agent }: { agent: RunningAgent }) {
  const flash = useAppStore((state) => state.flashModels[agent.id]);
  return (
    <span
      className={cn("block truncate rounded-sm text-xs text-muted-foreground", flash && "animate-model-flash text-primary")}
      title={agent.remoteControl ? "Last known model. May have changed in claude.ai/code." : agent.currentModel}
    >
      {agent.currentModel}
    </span>
  );
}

function LaunchDialog() {
  const projects = useAppStore((state) => state.projects);
  const modal = useAppStore((state) => state.launchModal);
  const settings = useAppStore((state) => state.settings);
  const capabilities = useAppStore((state) => state.capabilities);
  const closeLaunchModal = useAppStore((state) => state.closeLaunchModal);
  const [projectId, setProjectId] = useState("");
  const [defName, setDefName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [remoteControl, setRemoteControl] = useState(false);

  const project = projects.find((candidate) => candidate.id === projectId);
  const def = project?.agents.find((candidate) => candidate.name === defName);

  useEffect(() => {
    if (!modal.open) return;
    const nextProjectId = modal.projectId || useAppStore.getState().selectedProjectId || projects[0]?.id || "";
    const nextProject = projects.find((candidate) => candidate.id === nextProjectId);
    const nextDefName = modal.defName || nextProject?.agents[0]?.name || "";
    const nextDef = nextProject?.agents.find((candidate) => candidate.name === nextDefName);
    setProjectId(nextProjectId);
    setDefName(nextDefName);
    setDisplayName("");
    setModel(nextDef?.defaultModel || settings.models[0] || DEFAULT_MODEL);
    setInitialPrompt(modal.initialPrompt || "");
    setRemoteControl(false);
  }, [modal, projects, settings.models]);

  useEffect(() => {
    if (def) setModel(def.defaultModel || model || DEFAULT_MODEL);
  }, [defName]);

  function launch() {
    if (!projectId || !defName) return;
    sendCommand({
      type: "launch",
      request: {
        projectId,
        defName,
        displayName,
        model,
        initialPrompt: remoteControl ? undefined : initialPrompt,
        remoteControl,
        autoApprove: settings.autoApprove
      }
    });
    closeLaunchModal();
  }

  const rcDisabled = !capabilities?.supportsRemoteControl;

  return (
    <Dialog open={modal.open} onOpenChange={(open) => !open && closeLaunchModal()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Launch Agent</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm">
            Project
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger>
                <SelectValue placeholder="Project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm">
            Agent type
            <Select value={defName} onValueChange={setDefName}>
              <SelectTrigger>
                <SelectValue placeholder="Agent type" />
              </SelectTrigger>
              <SelectContent>
                {project?.agents.map((agent) => (
                  <SelectItem key={agent.name} value={agent.name}>
                    <span className="inline-flex items-center gap-2">
                      <AgentDot color={agent.color} />
                      {agent.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm">
            Display name
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={def?.name || "Agent"} />
          </label>
          <label className="grid gap-1.5 text-sm">
            Model
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {settings.models.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm" title={rcDisabled ? capabilities?.remoteControlReason : undefined}>
            <input
              type="checkbox"
              className="mt-1"
              checked={remoteControl}
              disabled={rcDisabled}
              onChange={(event) => setRemoteControl(event.target.checked)}
            />
            <span>
              <span className="block font-medium">Remote Control</span>
              <span className="block text-xs text-muted-foreground">
                Live transcript and interaction happen in claude.ai/code or the Claude mobile app. The dashboard tracks status,
                model, and uptime.
              </span>
            </span>
          </label>
          <label className="grid gap-1.5 text-sm">
            Initial prompt
            <Textarea
              value={initialPrompt}
              disabled={remoteControl}
              onChange={(event) => setInitialPrompt(event.target.value)}
              placeholder="Optional"
            />
          </label>
          <Button onClick={launch} disabled={!projectId || !defName || !model}>
            <Plus className="h-4 w-4" />
            Launch
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog() {
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const setProjects = useAppStore((state) => state.setProjects);
  const addError = useAppStore((state) => state.addError);
  const [open, setOpen] = useState(false);
  const [projectsRoot, setProjectsRoot] = useState(settings.projectsRoot);
  const [modelsText, setModelsText] = useState(settings.models.join("\n"));
  const [autoApprove, setAutoApprove] = useState(settings.autoApprove);

  useEffect(() => {
    if (!open) return;
    setProjectsRoot(settings.projectsRoot);
    setModelsText(settings.models.join("\n"));
    setAutoApprove(settings.autoApprove);
  }, [open, settings]);

  async function save() {
    try {
      const next = await api.saveSettings({
        projectsRoot,
        models: modelsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        autoApprove
      });
      setSettings(next);
      setProjects(await api.refresh());
      setOpen(false);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="icon" onClick={() => setOpen(true)} title="Settings">
        <Settings className="h-4 w-4" />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm">
            PROJECTS_ROOT
            <Input value={projectsRoot} onChange={(event) => setProjectsRoot(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm">
            Models
            <Textarea value={modelsText} onChange={(event) => setModelsText(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm">
            Auto-approve tool use
            <Select value={autoApprove} onValueChange={(value) => setAutoApprove(value as typeof autoApprove)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Off</SelectItem>
                <SelectItem value="session">This session</SelectItem>
                <SelectItem value="always">Always</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {autoApprove === "always" && (
            <p className="rounded-md border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-100">
              Always passes --dangerously-skip-permissions when launching agents.
            </p>
          )}
          <Button onClick={save}>
            <Check className="h-4 w-4" />
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentPanel() {
  const selectedAgentId = useAppStore((state) => state.selectedAgentId);
  const agent = useAppStore((state) => (selectedAgentId ? state.agents[selectedAgentId] : undefined));

  if (!agent) {
    return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">No agent selected.</div>;
  }
  if (agent.remoteControl) return <RemoteControlPanel agent={agent} />;
  return <StandardAgentPanel agent={agent} />;
}

function RemoteControlPanel({ agent }: { agent: RunningAgent }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [showQr, setShowQr] = useState(false);

  return (
    <main className="flex flex-1 flex-col">
      <AgentPanelHeader agent={agent} />
      <div className="grid flex-1 place-items-center p-6">
        <div className="grid max-w-xl gap-4 text-center">
          <div className="mx-auto flex items-center gap-2 text-lg font-semibold">
            <AgentDot color={agent.color} />
            {agent.displayName} <Badge>RC</Badge> <span className="text-muted-foreground">({agent.currentModel})</span>
          </div>
          <p className="text-muted-foreground">
            This agent runs in Remote Control mode. Live transcript and interaction happen in claude.ai/code or the Claude
            mobile app.
          </p>
          <div className="flex justify-center gap-2">
            <Button disabled={!agent.rcUrl} onClick={() => agent.rcUrl && window.open(agent.rcUrl, "_blank", "noopener")}>
              <ExternalLink className="h-4 w-4" />
              Open in claude.ai/code
            </Button>
            <Button variant="outline" disabled={!agent.qr} onClick={() => setShowQr((value) => !value)}>
              Show QR
            </Button>
          </div>
          {showQr && agent.qr && <img className="mx-auto h-56 w-56 rounded-md bg-white p-3" src={agent.qr} alt="Remote Control QR code" />}
          <p className="text-sm text-muted-foreground">
            Status: {agent.status} · Uptime: {formatDuration(agent.launchedAt)} · PID: {agent.pid || "n/a"}
          </p>
        </div>
      </div>
    </main>
  );
}

function AgentPanelHeader({ agent }: { agent: RunningAgent }) {
  const settings = useAppStore((state) => state.settings);
  const transcripts = useAppStore((state) => state.transcripts[agent.id] || []);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const flash = useAppStore((state) => state.flashModels[agent.id]);

  function exportJson() {
    downloadText(`${agent.displayName}.json`, JSON.stringify({ agent, transcript: transcripts }, null, 2), "application/json");
  }

  function exportMarkdown() {
    const lines = agent.remoteControl
      ? [`# ${agent.displayName}`, "", "Remote Control agent. Live transcript lives in claude.ai/code.", "", `Model: ${agent.currentModel}`]
      : [
          `# ${agent.displayName}`,
          "",
          ...transcripts.map((event) => {
            const time = new Date(event.timestamp).toLocaleTimeString();
            if (event.kind === "assistant_text") return `### Assistant (${event.model || agent.currentModel}) · ${time}\n\n${event.text}`;
            if (event.kind === "user") return `### User · ${time}\n\n${event.text}`;
            if (event.kind === "tool_use") return `### Tool Use: ${event.name} · ${time}\n\n\`\`\`json\n${prettyJson(event.input)}\n\`\`\``;
            if (event.kind === "tool_result") return `### Tool Result · ${time}\n\n\`\`\`\n${prettyJson(event.output)}\n\`\`\``;
            if (event.kind === "model_switch") return `---\n\nswitched to ${event.to}`;
            return `### System · ${time}\n\n${event.text}`;
          })
        ];
    downloadText(`${agent.displayName}.md`, lines.join("\n\n"), "text/markdown");
  }

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
      <AgentDot color={agent.color} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">
          {agent.displayName} {agent.remoteControl && <Badge className="ml-1">RC</Badge>}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <button
              disabled={agent.remoteControl || agent.status === "switching-model"}
              className={cn("rounded-sm text-xs text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground", flash && "animate-model-flash text-primary")}
              title={agent.remoteControl ? "Last known model. May have changed in claude.ai/code." : "Switch model"}
            >
              {agent.status === "switching-model" ? agent.statusMessage || "Switching model..." : agent.currentModel}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64">
            <div className="grid gap-2">
              <p className="text-sm font-medium">Switch model</p>
              {settings.models.map((model) => (
                <Button key={model} variant="ghost" className="justify-start" onClick={() => sendCommand({ type: "setModel", id: agent.id, model })}>
                  {model}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {agent.restorable && (
        <Button variant="outline" onClick={() => sendCommand({ type: "resume", id: agent.id })}>
          Resume
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={exportMarkdown}>Export Markdown</DropdownMenuItem>
          <DropdownMenuItem onClick={exportJson}>Export JSON</DropdownMenuItem>
          <DropdownMenuItem onClick={() => sendCommand({ type: "clear", id: agent.id })}>Clear</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" onClick={() => sendCommand({ type: "kill", id: agent.id })}>
        <X className="h-4 w-4" />
        {agent.remoteControl ? "Stop" : "Kill"}
      </Button>
      <Button variant="ghost" size="icon" onClick={() => setSelectedAgent(undefined)} title="Close panel">
        <Square className="h-4 w-4" />
      </Button>
    </div>
  );
}

function StandardAgentPanel({ agent }: { agent: RunningAgent }) {
  const transcript = useAppStore((state) => state.transcripts[agent.id] || []);
  const draft = useAppStore((state) => state.drafts[agent.id] || "");
  const setDraft = useAppStore((state) => state.setDraft);
  const scrollTop = useAppStore((state) => state.scrollPositions[agent.id] || 0);
  const setScrollPosition = useAppStore((state) => state.setScrollPosition);
  const searchOpen = useAppStore((state) => state.searchOpen);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedText = useTextSelection("#transcript-root");
  const isBusy = agent.status === "running" || agent.status === "switching-model";

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.scrollTop = scrollTop;
  }, [agent.id]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 140;
    if (nearBottom) root.scrollTop = root.scrollHeight;
  }, [transcript.length, agent.id]);

  function send() {
    if (!draft.trim()) return;
    sendCommand({ type: "userMessage", id: agent.id, text: draft });
    setDraft(agent.id, "");
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <AgentPanelHeader agent={agent} />
      {searchOpen && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search active transcript" />
        </div>
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            id="transcript-root"
            ref={rootRef}
            className="min-h-0 flex-1 overflow-auto p-4"
            onScroll={(event) => setScrollPosition(agent.id, event.currentTarget.scrollTop)}
          >
            <div className="mx-auto grid max-w-4xl gap-3">
              {transcript.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-12 text-center text-sm text-muted-foreground">
                  No transcript yet.
                </p>
              ) : (
                transcript.map((event) => <TranscriptItem key={event.id} event={event} agent={agent} query={searchQuery} />)
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <SendToMenu source={agent} selectedText={selectedText} />
      </ContextMenu>
      <div className="border-t border-border p-3">
        <div className="mx-auto flex max-w-4xl gap-2">
          <Textarea
            className="min-h-16 resize-none"
            value={draft}
            disabled={isBusy || agent.status === "killed" || agent.restorable}
            onChange={(event) => setDraft(agent.id, event.target.value)}
            placeholder={isBusy ? "Agent is busy..." : "Message this agent"}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") send();
            }}
          />
          <Button className="self-end" disabled={isBusy || !draft.trim()} onClick={send}>
            <Send className="h-4 w-4" />
            Send
          </Button>
        </div>
      </div>
    </main>
  );
}

function SendToMenu({ source, selectedText }: { source: RunningAgent; selectedText: string }) {
  const projects = useAppStore((state) => state.projects);
  const agents = useAppStore((state) => Object.values(state.agents));
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const openSendDialog = useAppStore((state) => state.openSendDialog);
  const project = projects.find((candidate) => candidate.id === source.projectId);

  return (
    <ContextMenuContent>
      <ContextMenuSub>
        <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-45" disabled={!selectedText}>
          Send to
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent">
              New agent
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {project?.agents.map((def) => (
                <ContextMenuItem
                  key={def.name}
                  onClick={() =>
                    openLaunchModal({
                      projectId: source.projectId,
                      defName: def.name,
                      initialPrompt: wrapForwardedText(source, selectedText)
                    })
                  }
                >
                  <AgentDot color={def.color} />
                  <span className="ml-2">{def.name}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent">
              Existing agent
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {agents
                .filter((agent) => agent.id !== source.id)
                .map((agent) => (
                  <ContextMenuItem
                    key={agent.id}
                    disabled={agent.remoteControl}
                    onClick={() =>
                      openSendDialog({
                        sourceAgentId: source.id,
                        targetAgentId: agent.id,
                        selectedText,
                        framing: ""
                      })
                    }
                    title={agent.remoteControl ? "Remote Control agents cannot receive dashboard messages." : undefined}
                  >
                    <AgentDot color={agent.color} />
                    <span className="ml-2">{agent.displayName}</span>
                    {agent.remoteControl && <Badge className="ml-2">RC</Badge>}
                  </ContextMenuItem>
                ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </ContextMenuContent>
  );
}

function TranscriptItem({ event, agent, query }: { event: TranscriptEvent; agent: RunningAgent; query: string }) {
  if (event.kind === "model_switch") {
    return (
      <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        switched to {event.to}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (event.kind === "tool_use" || event.kind === "tool_result") {
    return <ToolCard event={event} agent={agent} />;
  }
  if (event.kind === "system") {
    return <p className="text-center text-xs text-muted-foreground">{event.text}</p>;
  }

  const isUser = event.kind === "user";
  return (
    <div className={cn("flex", isUser && "justify-end")}>
      <div
        className={cn(
          "max-w-[78%] whitespace-pre-wrap rounded-lg border border-border px-3 py-2 text-sm leading-6",
          isUser ? "bg-primary text-primary-foreground" : "bg-card"
        )}
        style={!isUser ? { borderLeftColor: agent.color, borderLeftWidth: 4 } : undefined}
      >
        {event.sourceAgent && (
          <Badge className="mb-2" style={{ borderColor: event.sourceAgent.color, color: event.sourceAgent.color }}>
            from {event.sourceAgent.displayName}
          </Badge>
        )}
        <HighlightedText text={event.text} query={query} />
      </div>
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={index} className="rounded bg-primary/40 text-foreground">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  );
}

function ToolCard({ event, agent }: { event: Extract<TranscriptEvent, { kind: "tool_use" | "tool_result" }>; agent: RunningAgent }) {
  const [open, setOpen] = useState(false);
  const isUse = event.kind === "tool_use";
  return (
    <div className="rounded-md border border-border bg-card text-sm">
      <button className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left" onClick={() => setOpen((value) => !value)}>
        <span className="min-w-0 truncate">
          {isUse ? `Tool: ${event.name}` : `Tool result: ${event.toolUseId}`}
          {isUse && event.awaitingPermission && <Badge className="ml-2 border-amber-400/40 text-amber-200">awaiting permission</Badge>}
        </span>
        <Badge>{open ? "Hide" : "Show"}</Badge>
      </button>
      {isUse && event.awaitingPermission && (
        <div className="flex gap-2 border-t border-border px-3 py-2">
          <Button size="sm" onClick={() => sendCommand({ type: "permission", id: agent.id, toolUseId: event.toolUseId, decision: "approve" })}>
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => sendCommand({ type: "permission", id: agent.id, toolUseId: event.toolUseId, decision: "deny" })}>
            Deny
          </Button>
        </div>
      )}
      {open && (
        <pre className="max-h-80 overflow-auto border-t border-border p-3 text-xs text-muted-foreground">
          {prettyJson(isUse ? event.input : event.output)}
        </pre>
      )}
    </div>
  );
}

function SendDialog() {
  const dialog = useAppStore((state) => state.sendDialog);
  const agents = useAppStore((state) => state.agents);
  const setSendFraming = useAppStore((state) => state.setSendFraming);
  const closeSendDialog = useAppStore((state) => state.closeSendDialog);
  const source = dialog.sourceAgentId ? agents[dialog.sourceAgentId] : undefined;
  const target = dialog.targetAgentId ? agents[dialog.targetAgentId] : undefined;
  const preview = source && dialog.selectedText ? wrapForwardedText(source, dialog.selectedText, dialog.framing) : "";

  function send() {
    if (!source || !target || !dialog.selectedText) return;
    sendCommand({
      type: "sendTo",
      command: {
        sourceAgentId: source.id,
        selectedText: dialog.selectedText,
        target: { kind: "existing", agentId: target.id },
        framing: dialog.framing
      }
    });
    closeSendDialog();
  }

  return (
    <Dialog open={dialog.open} onOpenChange={(open) => !open && closeSendDialog()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send to {target?.displayName}</DialogTitle>
        </DialogHeader>
        <label className="grid gap-1.5 text-sm">
          Framing
          <Textarea value={dialog.framing || ""} onChange={(event) => setSendFraming(event.target.value)} placeholder="Optional instruction for the receiving agent" />
        </label>
        <label className="grid gap-1.5 text-sm">
          Preview
          <Textarea readOnly value={preview} className="min-h-48 text-xs" />
        </label>
        <Button onClick={send}>Send</Button>
      </DialogContent>
    </Dialog>
  );
}

function ErrorStack() {
  const errors = useAppStore((state) => state.errors);
  if (errors.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 grid max-w-md gap-2">
      {errors.map((error, index) => (
        <div key={`${error}-${index}`} className="rounded-md border border-red-400/40 bg-red-500/15 px-3 py-2 text-sm text-red-100 shadow-lg">
          {error}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const setProjects = useAppStore((state) => state.setProjects);
  const setCapabilities = useAppStore((state) => state.setCapabilities);
  const setSettings = useAppStore((state) => state.setSettings);
  const addError = useAppStore((state) => state.addError);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const selectedAgentId = useAppStore((state) => state.selectedAgentId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const setSearchOpen = useAppStore((state) => state.setSearchOpen);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);

  useEffect(() => {
    void Promise.all([api.projects(), api.capabilities(), api.settings()])
      .then(([projects, capabilities, settings]) => {
        setProjects(projects);
        setCapabilities(capabilities);
        setSettings(settings);
      })
      .catch((error: unknown) => addError(error instanceof Error ? error.message : String(error)));
    connectWebSocket();
    return () => disconnectWebSocket();
  }, [addError, setCapabilities, setProjects, setSettings]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        openLaunchModal({ projectId: selectedProjectId });
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key.toLowerCase() === "w" && selectedAgentId) {
        event.preventDefault();
        sendCommand({ type: "kill", id: selectedAgentId });
        setSelectedAgent(undefined);
      } else if (/^[1-9]$/.test(event.key)) {
        const agents = Object.values(useAppStore.getState().agents).sort((left, right) => +new Date(right.launchedAt) - +new Date(left.launchedAt));
        const agent = agents[Number(event.key) - 1];
        if (agent) {
          event.preventDefault();
          setSelectedAgent(agent.id);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openLaunchModal, selectedAgentId, selectedProjectId, setSearchOpen, setSelectedAgent]);

  return (
    <div className="flex h-screen min-w-[900px] flex-col overflow-hidden bg-background text-foreground">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <AgentPanel />
      </div>
      <LaunchDialog />
      <SendDialog />
      <ErrorStack />
    </div>
  );
}
