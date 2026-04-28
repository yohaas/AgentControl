import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  ArrowDownAZ,
  Bot,
  Check,
  ChevronDown,
  Clipboard,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  GripVertical,
  HardDrive,
  Home,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Send,
  Settings,
  SquareTerminal,
  Trash2,
  X
} from "lucide-react";
import type {
  AgentDef,
  ClaudePluginCatalog,
  DirectoryEntry,
  DirectoryListing,
  MessageAttachment,
  RunningAgent,
  TerminalSession,
  TranscriptEvent
} from "@agent-control/shared";
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
import { getSelectionInRoot, useTextSelection } from "./hooks/use-text-selection";
import { api } from "./lib/api";
import { cn, downloadText, formatDuration, prettyJson } from "./lib/utils";
import { connectWebSocket, disconnectWebSocket, sendCommand } from "./lib/ws-client";
import { useAppStore } from "./store/app-store";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const EMPTY_TRANSCRIPT: TranscriptEvent[] = [];
const EMPTY_QUEUE: { id: string; text: string; attachments: MessageAttachment[] }[] = [];
const THINKING_PHRASES = [
  "Discombobulating",
  "Cogitating",
  "Triangulating",
  "Untangling",
  "Percolating",
  "Recalibrating",
  "Synthesizing",
  "Mulling",
  "Connecting dots"
];

function useThinkingPhrase(active = true) {
  const [index, setIndex] = useState(() => Math.floor(Date.now() / 1800) % THINKING_PHRASES.length);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % THINKING_PHRASES.length);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [active]);

  return THINKING_PHRASES[index];
}

function ThinkingText({ prefix }: { prefix?: string }) {
  const phrase = useThinkingPhrase();
  return (
    <span className="inline-flex items-center gap-1 text-xs text-primary">
      {prefix}
      <span>{phrase}</span>
      <span className="inline-flex w-4 animate-pulse">...</span>
    </span>
  );
}

function isAgentBusy(agent: RunningAgent) {
  return (
    agent.status === "running" ||
    agent.status === "starting" ||
    agent.status === "switching-model" ||
    agent.status === "awaiting-permission"
  );
}

function hasStreamingAssistantText(transcript: TranscriptEvent[]) {
  return transcript.some((event) => event.kind === "assistant_text" && event.streaming);
}

function AgentActivityIndicator({ agent, compact = false }: { agent: RunningAgent; compact?: boolean }) {
  return (
    <div className="flex">
      <div
        className={cn(
          "inline-flex min-w-0 items-center rounded-md border border-border bg-background/70 px-3 py-2",
          compact ? "text-xs" : "text-sm"
        )}
        style={{ borderLeftColor: agent.color, borderLeftWidth: 4 }}
      >
        <ThinkingText />
      </div>
    </div>
  );
}

function AgentDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("h-3 w-3 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

function StatusPill({ status }: { status: RunningAgent["status"] }) {
  const busy = status === "running" || status === "starting" || status === "switching-model";
  const thinkingPhrase = useThinkingPhrase(busy);
  const label =
    status === "running"
      ? thinkingPhrase
      : status === "starting"
        ? thinkingPhrase
        : status === "switching-model"
          ? thinkingPhrase
          : status === "awaiting-permission"
            ? "Needs approval"
            : status === "remote-controlled"
              ? "Remote"
              : status === "killed"
                ? "Exited"
                : status === "interrupted"
                  ? "Interrupted"
                  : status;
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
              : status === "interrupted"
                ? "border-amber-400/40 bg-amber-500/15 text-amber-200"
              : status === "paused"
                ? "border-purple-400/40 bg-purple-500/15 text-purple-200"
                : "border-teal-400/40 bg-teal-500/15 text-teal-200";
  return <Badge className={cn("capitalize", className)}>{label}</Badge>;
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

function transcriptToPlainText(agent: RunningAgent, transcripts: TranscriptEvent[]) {
  if (agent.remoteControl && transcripts.length === 0) {
    return [`Remote Control agent: ${agent.displayName}`, `Model: ${agent.currentModel}`, agent.rcUrl ? `URL: ${agent.rcUrl}` : ""]
      .filter(Boolean)
      .join("\n");
  }

  return transcripts
    .map((event) => {
      if (event.kind === "assistant_text") return `Assistant (${event.model || agent.currentModel}):\n${event.text}`;
      if (event.kind === "user") return `User:\n${event.text}`;
      if (event.kind === "tool_use") return `Tool Use: ${event.name}\n${prettyJson(event.input)}`;
      if (event.kind === "tool_result") return `Tool Result:\n${prettyJson(event.output)}`;
      if (event.kind === "model_switch") return `System: switched to ${event.to}`;
      return `System:\n${event.text}`;
    })
    .join("\n\n")
    .trim();
}

function toolValueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          return toolValueText(record.text ?? record.content ?? record.output ?? item);
        }
        return prettyJson(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct = record.text ?? record.content ?? record.output ?? record.stdout ?? record.stderr;
    if (typeof direct === "string") return direct;
  }
  return prettyJson(value);
}

function compactToolText(value: unknown, maxLength = 220): string {
  const text = toolValueText(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function toolUseSummary(event: Extract<TranscriptEvent, { kind: "tool_use" }>) {
  if (event.input && typeof event.input === "object") {
    const input = event.input as Record<string, unknown>;
    const summary = input.command ?? input.pattern ?? input.file_path ?? input.path ?? input.url ?? input.prompt ?? input.description;
    if (summary) return compactToolText(summary);
  }
  return compactToolText(event.input);
}

function fieldText(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const text = toolValueText(record[key]).trim();
    if (text) return text;
  }
  return "";
}

function toolPath(value: unknown) {
  return fieldText(value, ["file_path", "path", "notebook_path", "url"]);
}

function toolSummary(event: Extract<TranscriptEvent, { kind: "tool_use" | "tool_result" }>) {
  if (event.kind === "tool_use") {
    const name = event.name.toLowerCase();
    if (name.includes("bash")) return fieldText(event.input, ["command"]) || toolUseSummary(event);
    if (name.includes("read") || name.includes("edit") || name.includes("write")) return toolPath(event.input) || toolUseSummary(event);
    if (name.includes("grep") || name.includes("glob") || name.includes("search")) return fieldText(event.input, ["pattern", "query"]) || toolUseSummary(event);
    return toolUseSummary(event);
  }

  const output = event.output;
  const stdout = fieldText(output, ["stdout"]);
  const stderr = fieldText(output, ["stderr"]);
  const exit = fieldText(output, ["exit_code", "exitCode", "code"]);
  if (stdout || stderr || exit) {
    return [exit ? `exit ${exit}` : "", stdout || stderr].filter(Boolean).join(" · ");
  }
  return compactToolText(output, 320);
}

function toolDetail(event: Extract<TranscriptEvent, { kind: "tool_use" | "tool_result" }>) {
  if (event.kind === "tool_use") {
    const command = fieldText(event.input, ["command"]);
    const pathText = toolPath(event.input);
    const body = prettyJson(event.input);
    return [command ? `$ ${command}` : "", pathText ? `Path: ${pathText}` : "", body].filter(Boolean).join("\n\n");
  }

  const stdout = fieldText(event.output, ["stdout"]);
  const stderr = fieldText(event.output, ["stderr"]);
  if (stdout || stderr) {
    return [stdout ? `stdout\n${stdout}` : "", stderr ? `stderr\n${stderr}` : ""].filter(Boolean).join("\n\n");
  }
  return toolValueText(event.output);
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("Could not read pasted image.")));
    reader.readAsDataURL(file);
  });
}

function pastedImageFiles(event: ReactClipboardEvent<HTMLTextAreaElement>) {
  return Array.from(event.clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function insertPastedText(textarea: HTMLTextAreaElement, current: string, text: string) {
  if (!text) return current;
  const start = textarea.selectionStart ?? current.length;
  const end = textarea.selectionEnd ?? current.length;
  return `${current.slice(0, start)}${text}${current.slice(end)}`;
}

async function uploadPastedImages(files: File[]) {
  return Promise.all(
    files.map(async (file) =>
      api.uploadAttachment({
        name: file.name || `pasted-image.${file.type.split("/")[1] || "png"}`,
        mimeType: file.type,
        dataUrl: await readFileAsDataUrl(file)
      })
    )
  );
}

function AttachmentChips({
  attachments,
  onRemove
}: {
  attachments: MessageAttachment[];
  onRemove: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <span key={attachment.id} className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs">
          <ImageIcon className="h-3.5 w-3.5 text-primary" />
          {attachment.url && <img src={attachment.url} alt="" className="h-6 w-6 rounded object-cover" />}
          <span className="truncate">{attachment.name}</span>
          <button className="text-muted-foreground hover:text-foreground" onClick={() => onRemove(attachment.id)} title="Remove image">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}

function exportAgentJson(agent: RunningAgent, transcripts: TranscriptEvent[]) {
  downloadText(`${agent.displayName}.json`, JSON.stringify({ agent, transcript: transcripts }, null, 2), "application/json");
}

async function exportAgentRawStream(agent: RunningAgent, addError: (message: string) => void) {
  try {
    const raw = await api.rawAgentStream(agent.id);
    downloadText(`${agent.displayName}-raw-stream.jsonl`, raw, "application/jsonl");
  } catch (error) {
    addError(error instanceof Error ? error.message : String(error));
  }
}

function exportAgentMarkdown(agent: RunningAgent, transcripts: TranscriptEvent[]) {
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

function handleNativeSlashCommand(agent: RunningAgent, text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const [command, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  if (command === "clear") {
    sendCommand({ type: "clear", id: agent.id });
    return true;
  }
  if (command === "exit" || command === "quit") {
    sendCommand({ type: "kill", id: agent.id });
    return true;
  }
  if (command === "stop" || command === "interrupt") {
    sendCommand({ type: "interrupt", id: agent.id });
    return true;
  }
  if (command === "model" && arg) {
    sendCommand({ type: "setModel", id: agent.id, model: arg });
    return true;
  }
  return false;
}

function agentsForProject(agentsById: Record<string, RunningAgent>, projectId?: string) {
  return Object.values(agentsById).filter((agent) => !projectId || agent.projectId === projectId);
}

function terminalsForProject(sessionsById: Record<string, TerminalSession>, projectId?: string) {
  return Object.values(sessionsById).filter((session) => !projectId || session.projectId === projectId);
}

function devCommandStorageKey(projectId: string) {
  return `agent-control-dev-command:${projectId}`;
}

function isDevTerminal(session: TerminalSession) {
  return session.title?.startsWith("Dev: ") || session.title === "npm run dev";
}

function agentHasProcess(agent: RunningAgent) {
  return Boolean(agent.pid) && agent.status !== "killed" && agent.status !== "error" && agent.status !== "paused" && !agent.restorable;
}

function orderedAgentsForTiles(agents: RunningAgent[], tileOrder: string[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return [
    ...tileOrder.map((id) => byId.get(id)).filter((agent): agent is RunningAgent => Boolean(agent)),
    ...agents.filter((agent) => !tileOrder.includes(agent.id))
  ];
}

function Header() {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const agentsById = useAppStore((state) => state.agents);
  const tileOrder = useAppStore((state) => state.tileOrder);
  const setTileOrder = useAppStore((state) => state.setTileOrder);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const terminalSessions = useAppStore((state) => state.terminalSessions);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const wsConnected = useAppStore((state) => state.wsConnected);
  const setProjects = useAppStore((state) => state.setProjects);
  const addError = useAppStore((state) => state.addError);
  const [devCommand, setDevCommand] = useState("npm run dev");
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const projectAgents = useMemo(() => agentsForProject(agentsById, selectedProjectId), [agentsById, selectedProjectId]);
  const agentCount = projectAgents.length;
  const terminalCount = useMemo(
    () => terminalsForProject(terminalSessions, selectedProjectId).length,
    [terminalSessions, selectedProjectId]
  );
  const projectDevTerminals = useMemo(
    () => terminalsForProject(terminalSessions, selectedProjectId).filter(isDevTerminal),
    [terminalSessions, selectedProjectId]
  );

  useEffect(() => {
    if (!selectedProjectId) {
      setDevCommand("npm run dev");
      return;
    }
    setDevCommand(window.localStorage.getItem(devCommandStorageKey(selectedProjectId)) || "npm run dev");
  }, [selectedProjectId]);

  async function refresh() {
    try {
      setProjects(await api.refresh());
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function sortChatsByAgentType() {
    const sorted = orderedAgentsForTiles(projectAgents, tileOrder)
      .map((agent, index) => ({ agent, index }))
      .sort(
        (left, right) =>
          left.agent.defName.localeCompare(right.agent.defName, undefined, { sensitivity: "base" }) ||
          left.index - right.index
      )
      .map(({ agent }) => agent.id);
    const sortedIds = new Set(sorted);
    setTileOrder([...sorted, ...tileOrder.filter((id) => !sortedIds.has(id))]);
    setSelectedAgent(undefined);
  }

  function toggleTerminal() {
    if (!terminalOpen && terminalCount === 0) {
      sendCommand({ type: "terminalStart", projectId: selectedProjectId });
    }
    setTerminalOpen(!terminalOpen);
  }

  function runProjectDev() {
    if (!selectedProjectId) return;
    const command = devCommand.trim() || "npm run dev";
    setTerminalOpen(true);
    sendCommand({ type: "terminalStart", projectId: selectedProjectId, command, title: `Dev: ${command}` });
  }

  function stopProjectDev() {
    projectDevTerminals.forEach((session) => sendCommand({ type: "terminalClose", id: session.id }));
  }

  function restartProjectDev() {
    stopProjectDev();
    window.setTimeout(runProjectDev, 150);
  }

  function customizeProjectDev() {
    if (!selectedProjectId) return;
    const nextCommand = window.prompt("Command to run for this project", devCommand.trim() || "npm run dev");
    if (nextCommand === null) return;
    const trimmed = nextCommand.trim() || "npm run dev";
    window.localStorage.setItem(devCommandStorageKey(selectedProjectId), trimmed);
    setDevCommand(trimmed);
  }

  async function closeSelectedProject() {
    if (!selectedProjectId || !selectedProject) return;
    const confirmed = window.confirm(
      `Close ${selectedProject.name}? This exits its agents and terminals, and removes it from the dashboard. Files stay on disk.`
    );
    if (!confirmed) return;
    try {
      setProjects(await api.closeProject(selectedProjectId));
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
        <Select value={selectedProjectId ?? ""} onValueChange={setSelectedProject}>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" disabled={!selectedProjectId} title={`Dev command: ${devCommand}`}>
              <SquareTerminal className="h-4 w-4" />
              Dev
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={runProjectDev}>Run {devCommand}</DropdownMenuItem>
            <DropdownMenuItem onClick={restartProjectDev}>Restart {devCommand}</DropdownMenuItem>
            <DropdownMenuItem disabled={projectDevTerminals.length === 0} onClick={stopProjectDev}>
              Stop dev command
            </DropdownMenuItem>
            <DropdownMenuItem onClick={customizeProjectDev}>Customize...</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" size="icon" onClick={refresh} title="Refresh projects">
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          disabled={!selectedProjectId}
          onClick={() => void closeSelectedProject()}
          title="Close project"
        >
          <X className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          disabled={agentCount < 2}
          onClick={sortChatsByAgentType}
          title="Sort chats by agent type"
        >
          <ArrowDownAZ className="h-4 w-4" />
        </Button>
        <AddProjectDialog />
        <Button disabled={!selectedProjectId} onClick={() => openLaunchModal({ projectId: selectedProjectId })}>
          <Plus className="h-4 w-4" />
          Launch Agent
        </Button>
        <Button variant={terminalOpen ? "default" : "outline"} size="icon" onClick={toggleTerminal} title="Terminal">
          <SquareTerminal className="h-4 w-4" />
        </Button>
        <AppAdminMenu />
        <PluginsDialog />
        <SettingsDialog />
        <Badge className={wsConnected ? "border-teal-400/40 text-teal-200" : "border-red-400/40 text-red-200"}>
          {wsConnected ? "Connected" : "Disconnected"}
        </Badge>
      </div>
    </header>
  );
}

function AddProjectDialog() {
  const setProjects = useAppStore((state) => state.setProjects);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const addError = useAppStore((state) => state.addError);
  const [open, setOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [path, setPath] = useState("");

  async function addProject() {
    const trimmed = path.trim();
    if (!trimmed) return;
    try {
      const projects = await api.addProject(trimmed);
      setProjects(projects);
      const added = projects.find((project) => project.path.toLowerCase() === trimmed.toLowerCase()) || projects[projects.length - 1];
      setSelectedProject(added?.id);
      setPath("");
      setOpen(false);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <FolderPlus className="h-4 w-4" />
        Add Project
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Add a project folder directly. Agent definitions are loaded from its `.claude/agents` folder when present.
          </p>
          <label className="grid gap-1.5 text-sm">
            Project path
            <div className="flex gap-2">
              <Input
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder=""
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addProject();
                }}
              />
              <Button type="button" variant="outline" onClick={() => setBrowserOpen(true)}>
                <FolderOpen className="h-4 w-4" />
                Browse
              </Button>
            </div>
          </label>
          <Button onClick={addProject} disabled={!path.trim()}>
            <FolderPlus className="h-4 w-4" />
            Add
          </Button>
        </div>
      </DialogContent>
      <FolderBrowserDialog
        open={browserOpen}
        initialPath={path}
        onOpenChange={setBrowserOpen}
        onSelect={(selectedPath) => {
          setPath(selectedPath);
          setBrowserOpen(false);
        }}
      />
    </Dialog>
  );
}

function AppAdminMenu() {
  const addError = useAppStore((state) => state.addError);
  const [supervised, setSupervised] = useState<boolean | undefined>();

  async function refreshStatus() {
    try {
      const status = await api.adminStatus();
      setSupervised(status.supervised);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function restart() {
    if (!window.confirm("Restart AgentControl? The dashboard will disconnect briefly.")) return;
    try {
      await api.restartApp();
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function shutdown() {
    if (!window.confirm("Shutdown AgentControl? You will need to start it again from a terminal unless supervised.")) return;
    try {
      await api.shutdownApp();
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void refreshStatus();
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" title="AgentControl process controls">
          <Settings className="h-4 w-4" />
          App
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={restart} disabled={supervised === false}>
          Restart AgentControl
        </DropdownMenuItem>
        <DropdownMenuItem onClick={shutdown}>Shutdown AgentControl</DropdownMenuItem>
        {supervised === false && (
          <div className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
            Restart is available after launching with npm run dev:supervised.
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FolderBrowserDialog({
  open,
  initialPath,
  onOpenChange,
  onSelect
}: {
  open: boolean;
  initialPath: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const addError = useAppStore((state) => state.addError);
  const [listing, setListing] = useState<DirectoryListing | undefined>();
  const [loading, setLoading] = useState(false);

  async function load(path?: string) {
    setLoading(true);
    try {
      setListing(await api.directories(path));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void load(initialPath.trim() || undefined);
  }, [open, initialPath]);

  function DirectoryButton({ entry, root = false }: { entry: DirectoryEntry; root?: boolean }) {
    return (
      <button
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent"
        onClick={() => void load(entry.path)}
        title={entry.path}
      >
        {root ? <HardDrive className="h-4 w-4 text-muted-foreground" /> : <FolderOpen className="h-4 w-4 text-muted-foreground" />}
        <span className="truncate text-sm">{entry.name}</span>
      </button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Select Folder</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="rounded-md border border-border bg-background px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">
            {listing?.path || "Loading..."}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!listing || loading} onClick={() => listing && onSelect(listing.path)}>
              <Check className="h-4 w-4" />
              Select
            </Button>
            <Button variant="outline" size="sm" disabled={!listing?.parentPath || loading} onClick={() => void load(listing?.parentPath)}>
              Up
            </Button>
            <Button variant="outline" size="sm" disabled={!listing || loading} onClick={() => void load(listing?.homePath)}>
              <Home className="h-4 w-4" />
              Home
            </Button>
          </div>
          <div className="grid max-h-[52vh] gap-3 overflow-auto rounded-md border border-border p-2">
            {loading ? (
              <p className="px-2 py-8 text-center text-sm text-muted-foreground">Loading folders...</p>
            ) : !listing ? (
              <p className="px-2 py-8 text-center text-sm text-muted-foreground">No folder loaded.</p>
            ) : (
              <>
                {listing.roots.length > 1 && (
                  <div className="grid gap-1 border-b border-border pb-2">
                    {listing.roots.map((root) => (
                      <DirectoryButton key={root.path} entry={root} root />
                    ))}
                  </div>
                )}
                <div className="grid gap-1">
                  {listing.entries.length === 0 ? (
                    <p className="px-2 py-8 text-center text-sm text-muted-foreground">No subfolders.</p>
                  ) : (
                    listing.entries.map((entry) => <DirectoryButton key={entry.path} entry={entry} />)
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PluginsDialog() {
  const addError = useAppStore((state) => state.addError);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ClaudePluginCatalog>({ installed: [], available: [], marketplaces: [] });
  const [loading, setLoading] = useState(false);
  const [pluginQuery, setPluginQuery] = useState("");
  const [pluginScope, setPluginScope] = useState("user");
  const [manualPlugin, setManualPlugin] = useState("");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [marketplaceBrowserOpen, setMarketplaceBrowserOpen] = useState(false);
  const [installingPlugin, setInstallingPlugin] = useState<string | undefined>();
  const [addingMarketplace, setAddingMarketplace] = useState(false);

  async function loadCatalog() {
    setLoading(true);
    try {
      setCatalog(await api.pluginCatalog());
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function enable(plugin: string) {
    try {
      await api.enablePlugin(plugin);
      setCatalog(await api.pluginCatalog());
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function install(plugin: string) {
    const id = plugin.trim();
    if (!id) return;
    setInstallingPlugin(id);
    try {
      setCatalog(await api.installPlugin(id, pluginScope));
      setManualPlugin("");
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingPlugin(undefined);
    }
  }

  async function addMarketplace() {
    const source = marketplaceSource.trim();
    if (!source) return;
    setAddingMarketplace(true);
    try {
      setCatalog(await api.addPluginMarketplace(source));
      setMarketplaceSource("");
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddingMarketplace(false);
    }
  }

  useEffect(() => {
    if (open) void loadCatalog();
  }, [open]);

  const installedIds = useMemo(() => new Set(catalog.installed.map((plugin) => plugin.name)), [catalog.installed]);
  const filteredAvailable = useMemo(() => {
    const query = pluginQuery.trim().toLowerCase();
    return catalog.available
      .filter((plugin) => {
        if (!query) return true;
        return (
          plugin.name.toLowerCase().includes(query) ||
          plugin.pluginId.toLowerCase().includes(query) ||
          plugin.marketplaceName?.toLowerCase().includes(query) ||
          plugin.description?.toLowerCase().includes(query)
        );
      })
      .slice(0, 80);
  }, [catalog.available, pluginQuery]);

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="outline" size="icon" onClick={() => setOpen(true)} title="Plugins">
          <Puzzle className="h-4 w-4" />
        </Button>
        <DialogContent className="w-[min(94vw,920px)]">
          <DialogHeader>
            <DialogTitle>Plugins</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <section className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Installed</h3>
                <Button variant="outline" size="sm" onClick={loadCatalog} disabled={loading}>
                  <RefreshCw className="h-4 w-4" />
                  Refresh
                </Button>
              </div>
              {loading ? (
                <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                  Loading plugins...
                </p>
              ) : catalog.installed.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                  No installed plugins found.
                </p>
              ) : (
                <div className="grid max-h-56 gap-2 overflow-auto pr-1">
                  {catalog.installed.map((plugin) => (
                    <div key={plugin.name} className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                      <Puzzle className="h-4 w-4 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{plugin.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {plugin.version || "unknown version"} · {plugin.scope || "unknown scope"}
                        </div>
                      </div>
                      <Badge className={plugin.enabled ? "border-teal-400/40 text-teal-200" : "border-zinc-500/40 text-zinc-300"}>
                        {plugin.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      <Button size="sm" variant="outline" disabled={plugin.enabled} onClick={() => enable(plugin.name)}>
                        Enable
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="grid gap-2">
              <h3 className="text-sm font-semibold">Add Marketplace</h3>
              <div className="flex min-w-0 gap-2">
                <Input
                  value={marketplaceSource}
                  onChange={(event) => setMarketplaceSource(event.target.value)}
                  placeholder="GitHub repo, URL, or local marketplace path"
                />
                <Button variant="outline" onClick={() => setMarketplaceBrowserOpen(true)}>
                  <FolderOpen className="h-4 w-4" />
                  Browse
                </Button>
                <Button disabled={!marketplaceSource.trim() || addingMarketplace} onClick={addMarketplace}>
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
              </div>
              {catalog.marketplaces.length > 0 && (
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {catalog.marketplaces.map((marketplace) => (
                    <span key={marketplace.name} className="rounded-md border border-border px-2 py-1">
                      {marketplace.name}
                    </span>
                  ))}
                </div>
              )}
            </section>

            <section className="grid gap-2">
              <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
                <Input value={pluginQuery} onChange={(event) => setPluginQuery(event.target.value)} placeholder="Search available plugins" />
                <Select value={pluginScope} onValueChange={setPluginScope}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">User scope</SelectItem>
                    <SelectItem value="project">Project scope</SelectItem>
                    <SelectItem value="local">Local scope</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-w-0 gap-2">
                <Input value={manualPlugin} onChange={(event) => setManualPlugin(event.target.value)} placeholder="Install by exact plugin id" />
                <Button disabled={!manualPlugin.trim() || Boolean(installingPlugin)} onClick={() => void install(manualPlugin)}>
                  <Plus className="h-4 w-4" />
                  Install
                </Button>
              </div>
              <div className="grid max-h-[38vh] gap-2 overflow-auto pr-1">
                {filteredAvailable.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                    No available plugins match.
                  </p>
                ) : (
                  filteredAvailable.map((plugin) => {
                    const installed = installedIds.has(plugin.pluginId);
                    return (
                      <div key={plugin.pluginId} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                        <Puzzle className="mt-0.5 h-4 w-4 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium">{plugin.name}</span>
                            {plugin.marketplaceName && <Badge>{plugin.marketplaceName}</Badge>}
                            {plugin.installCount !== undefined && (
                              <span className="text-xs text-muted-foreground">{plugin.installCount.toLocaleString()} installs</span>
                            )}
                          </div>
                          {plugin.description && (
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{plugin.description}</p>
                          )}
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={installed || Boolean(installingPlugin)}
                          onClick={() => void install(plugin.pluginId)}
                        >
                          {installed ? "Installed" : installingPlugin === plugin.pluginId ? "Installing" : "Install"}
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
      <FolderBrowserDialog
        open={marketplaceBrowserOpen}
        initialPath={marketplaceSource}
        onOpenChange={setMarketplaceBrowserOpen}
        onSelect={(path) => {
          setMarketplaceSource(path);
          setMarketplaceBrowserOpen(false);
        }}
      />
    </>
  );
}

function Sidebar() {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const agentsById = useAppStore((state) => state.agents);
  const selectedAgentId = useAppStore((state) => state.selectedAgentId);
  const focusedAgentId = useAppStore((state) => state.focusedAgentId);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const setFocusedAgent = useAppStore((state) => state.setFocusedAgent);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const setCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const settings = useAppStore((state) => state.settings);

  const project = projects.find((candidate) => candidate.id === selectedProjectId);
  const running = useMemo(
    () =>
      agentsForProject(agentsById, selectedProjectId).sort(
        (left, right) => +new Date(right.launchedAt) - +new Date(left.launchedAt)
      ),
    [agentsById, selectedProjectId]
  );
  const activeAgentId = selectedAgentId || focusedAgentId;

  function focusRunningAgent(id: string) {
    setSelectedAgent(undefined);
    setFocusedAgent(id);
  }

  function launchAllDefinitions() {
    if (!project || project.agents.length === 0) return;
    project.agents.forEach((agent) => {
      sendCommand({
        type: "launch",
        request: {
          projectId: project.id,
          defName: agent.name,
          model: agent.defaultModel || settings.models[0] || DEFAULT_MODEL,
          autoApprove: settings.autoApprove
        }
      });
    });
    setSelectedAgent(undefined);
  }

  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-border bg-card/45 py-3">
        <Button variant="ghost" size="icon" onClick={() => setCollapsed(false)} title="Expand sidebar">
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <div className="h-px w-8 bg-border" />
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-auto">
          {running.map((agent) => (
            <button
              key={agent.id}
              className={cn(
                "grid h-9 w-9 place-items-center rounded-md hover:bg-accent",
                activeAgentId === agent.id && "bg-accent"
              )}
              onClick={() => focusRunningAgent(agent.id)}
              title={agent.displayName}
            >
              <AgentDot color={agent.color} />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-card/45">
      <section className="min-h-0 border-b border-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setCollapsed(true)} title="Collapse sidebar">
              <PanelLeftClose className="h-4 w-4" />
            </Button>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Running</h2>
          </div>
          {running.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (window.confirm("Exit all open agents in this project?")) {
                  sendCommand({ type: "clearAll", projectId: selectedProjectId });
                }
              }}
            >
              Exit All
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
                  activeAgentId === agent.id && "bg-accent"
                )}
                onClick={() => focusRunningAgent(agent.id)}
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
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent definitions</h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={!project || project.agents.length === 0}
            onClick={launchAllDefinitions}
            title="Launch all definitions with defaults"
          >
            <Plus className="h-4 w-4" />
            Launch All
          </Button>
        </div>
        <div className="space-y-1 overflow-auto pr-1">
          {!project ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
              Add a project to get started.
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

function ModelMenu({ agent, compact = false }: { agent: RunningAgent; compact?: boolean }) {
  const settings = useAppStore((state) => state.settings);
  const canSwitch = !agent.remoteControl && agent.status !== "switching-model" && agentHasProcess(agent);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          disabled={!canSwitch}
          className={cn(
            "truncate rounded-sm text-left text-xs text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground",
            compact ? "max-w-40" : "max-w-full"
          )}
          title={agent.remoteControl ? "Last known model. May have changed in claude.ai/code." : canSwitch ? "Switch model" : "Agent process is not running."}
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
  const modelOptions = useMemo(
    () => Array.from(new Set([def?.defaultModel, ...settings.models].filter((item): item is string => Boolean(item)))),
    [def?.defaultModel, settings.models]
  );

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
    if (!def) return;
    setModel(def.defaultModel || settings.models[0] || DEFAULT_MODEL);
  }, [def, settings.models]);

  function selectProject(nextProjectId: string) {
    const nextProject = projects.find((candidate) => candidate.id === nextProjectId);
    const nextDefName = nextProject?.agents[0]?.name || "";
    const nextDef = nextProject?.agents.find((candidate) => candidate.name === nextDefName);
    setProjectId(nextProjectId);
    setDefName(nextDefName);
    setModel(nextDef?.defaultModel || settings.models[0] || DEFAULT_MODEL);
  }

  function selectDef(nextDefName: string) {
    const nextDef = project?.agents.find((candidate) => candidate.name === nextDefName);
    setDefName(nextDefName);
    setModel(nextDef?.defaultModel || settings.models[0] || DEFAULT_MODEL);
  }

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
            <Select value={projectId} onValueChange={selectProject}>
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
            <Select value={defName} onValueChange={selectDef}>
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
                {modelOptions.map((item) => (
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
  const [projectPathsText, setProjectPathsText] = useState((settings.projectPaths || []).join("\n"));
  const [modelsText, setModelsText] = useState(settings.models.join("\n"));
  const [autoApprove, setAutoApprove] = useState(settings.autoApprove);
  const [tileHeight, setTileHeight] = useState(settings.tileHeight);
  const [tileColumns, setTileColumns] = useState(settings.tileColumns);

  useEffect(() => {
    if (!open) return;
    setProjectPathsText((settings.projectPaths || []).join("\n"));
    setModelsText(settings.models.join("\n"));
    setAutoApprove(settings.autoApprove);
    setTileHeight(settings.tileHeight);
    setTileColumns(settings.tileColumns);
  }, [open, settings]);

  async function save() {
    try {
      const next = await api.saveSettings({
        ...settings,
        projectPaths: projectPathsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        models: modelsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        autoApprove,
        tileHeight,
        tileColumns
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
            Project folders
            <Textarea value={projectPathsText} onChange={(event) => setProjectPathsText(event.target.value)} placeholder="One absolute path per line" />
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
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1.5 text-sm">
              Tile height
              <Input
                type="number"
                min={320}
                max={760}
                step={20}
                value={tileHeight}
                onChange={(event) => setTileHeight(Number(event.target.value))}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              Columns
              <Input
                type="number"
                min={1}
                max={6}
                step={1}
                value={tileColumns}
                onChange={(event) => setTileColumns(Number(event.target.value))}
              />
            </label>
          </div>
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
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const agentsById = useAppStore((state) => state.agents);
  const selectedAgent = selectedAgentId ? agentsById[selectedAgentId] : undefined;
  const agent = selectedAgent && (!selectedProjectId || selectedAgent.projectId === selectedProjectId) ? selectedAgent : undefined;
  const agents = useMemo(
    () =>
      agentsForProject(agentsById, selectedProjectId).sort(
        (left, right) => +new Date(right.launchedAt) - +new Date(left.launchedAt)
      ),
    [agentsById, selectedProjectId]
  );

  if (agent) {
    return agent.remoteControl ? <RemoteControlPanel agent={agent} /> : <StandardAgentPanel agent={agent} />;
  }
  return <AgentTileGrid agents={agents} />;
}

function AgentTileGrid({ agents }: { agents: RunningAgent[] }) {
  const tileOrder = useAppStore((state) => state.tileOrder);
  const setTileOrder = useAppStore((state) => state.setTileOrder);
  const tileHeight = useAppStore((state) => state.settings.tileHeight);
  const tileColumns = useAppStore((state) => state.settings.tileColumns);
  const tileWidths = useAppStore((state) => state.tileWidths);
  const orderedAgents = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    return [
      ...tileOrder.map((id) => byId.get(id)).filter((agent): agent is RunningAgent => Boolean(agent)),
      ...agents.filter((agent) => !tileOrder.includes(agent.id))
    ];
  }, [agents, tileOrder]);

  function moveTile(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const ids = orderedAgents.map((agent) => agent.id);
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = ids.splice(sourceIndex, 1);
    ids.splice(targetIndex, 0, moved);
    setTileOrder(ids);
  }

  if (agents.length === 0) {
    return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">No agents open.</div>;
  }

  return (
    <main className="min-w-0 flex-1 overflow-auto">
      <div className="flex flex-wrap items-start gap-4 p-4">
        {orderedAgents.map((agent) => (
          <AgentTile
            key={agent.id}
            agent={agent}
            height={tileHeight}
            width={tileWidths[agent.id]}
            defaultWidth={`calc((100% - ${(tileColumns - 1) * 1}rem) / ${tileColumns})`}
            onMove={moveTile}
          />
        ))}
      </div>
    </main>
  );
}

function AgentTile({
  agent,
  height,
  width,
  defaultWidth,
  onMove
}: {
  agent: RunningAgent;
  height: number;
  width?: number;
  defaultWidth: string;
  onMove: (sourceId: string, targetId: string) => void;
}) {
  const transcript = useAppStore((state) => state.transcripts[agent.id] || EMPTY_TRANSCRIPT);
  const draft = useAppStore((state) => state.drafts[agent.id] || "");
  const setDraft = useAppStore((state) => state.setDraft);
  const queue = useAppStore((state) => state.messageQueues[agent.id] || EMPTY_QUEUE);
  const enqueueMessage = useAppStore((state) => state.enqueueMessage);
  const removeQueuedMessage = useAppStore((state) => state.removeQueuedMessage);
  const popNextQueuedMessage = useAppStore((state) => state.popNextQueuedMessage);
  const addError = useAppStore((state) => state.addError);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const setTileWidth = useAppStore((state) => state.setTileWidth);
  const focusedAgentId = useAppStore((state) => state.focusedAgentId);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const transcriptRootId = `tile-transcript-${agent.id}`;
  const selection = useTextSelection(`#${transcriptRootId}`);
  const tileRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const isBusy = isAgentBusy(agent);
  const canType = !agent.remoteControl && agentHasProcess(agent);
  const showActivityIndicator = isBusy && !hasStreamingAssistantText(transcript);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 180;
    if (nearBottom) root.scrollTop = root.scrollHeight;
  }, [transcript, agent.id]);

  useEffect(() => {
    if (focusedAgentId !== agent.id) return;
    tileRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (canType) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [agent.id, canType, focusedAgentId]);

  useEffect(() => {
    if (isBusy || !canType || queue.length === 0) return;
    const next = popNextQueuedMessage(agent.id);
    if (!next) return;
    sendCommand({ type: "userMessage", id: agent.id, text: next.text, attachments: next.attachments });
  }, [agent.id, canType, isBusy, popNextQueuedMessage, queue.length]);

  function send() {
    if ((!draft.trim() && attachments.length === 0) || agent.remoteControl) return;
    if (handleNativeSlashCommand(agent, draft)) {
      setDraft(agent.id, "");
      return;
    }
    if (isBusy) {
      enqueueMessage(agent.id, { text: draft, attachments });
      setDraft(agent.id, "");
      setAttachments([]);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    sendCommand({ type: "userMessage", id: agent.id, text: draft, attachments });
    setDraft(agent.id, "");
    setAttachments([]);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function stopCurrentResponse() {
    sendCommand({ type: "interrupt", id: agent.id });
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = pastedImageFiles(event);
    if (files.length === 0) return;
    event.preventDefault();
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) setDraft(agent.id, insertPastedText(event.currentTarget, draft, pastedText));
    try {
      const uploaded = await uploadPastedImages(files);
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = tileRef.current?.getBoundingClientRect().width || width || 420;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.min(1200, Math.max(320, startWidth + moveEvent.clientX - startX));
      setTileWidth(agent.id, Math.round(nextWidth));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  return (
    <section
      ref={tileRef}
      className={cn(
        "relative flex min-h-0 min-w-80 max-w-full flex-col rounded-md border border-border bg-card/70",
        focusedAgentId === agent.id && "ring-2 ring-primary/60"
      )}
      style={{ height, flex: `0 0 ${width ? `${width}px` : defaultWidth}` }}
      onDragOver={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        selection.clearSelection();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onMove(event.dataTransfer.getData("text/plain"), agent.id);
      }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <span
          className="cursor-grab text-muted-foreground"
          draggable
          onDragStart={(event) => event.dataTransfer.setData("text/plain", agent.id)}
          title="Drag to reorder"
        >
          <GripVertical className="h-4 w-4 shrink-0" />
        </span>
        <AgentDot color={agent.color} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate text-sm font-semibold">{agent.displayName}</span>
            {agent.remoteControl && <Badge className="px-1 py-0 text-[10px]">RC</Badge>}
          </div>
          <ModelMenu agent={agent} compact />
        </div>
        <StatusPill status={agent.status} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" title="Agent actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {agent.restorable && (
              <DropdownMenuItem onClick={() => sendCommand({ type: "resume", id: agent.id })}>Resume</DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => sendCommand({ type: "kill", id: agent.id })}>
              Exit
            </DropdownMenuItem>
            {isBusy && <DropdownMenuItem onClick={() => sendCommand({ type: "interrupt", id: agent.id })}>Stop response</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => exportAgentMarkdown(agent, transcript)}>Export Markdown</DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportAgentJson(agent, transcript)}>Export JSON</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportAgentRawStream(agent, addError)}>Export Raw Stream</DropdownMenuItem>
            <DropdownMenuItem onClick={() => sendCommand({ type: "clear", id: agent.id })}>Clear</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon" onClick={() => setSelectedAgent(agent.id)} title="Maximize">
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            id={transcriptRootId}
            ref={rootRef}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3"
            onMouseUp={() => selection.captureSelection()}
            onKeyUp={() => selection.captureSelection()}
            onContextMenuCapture={() => selection.captureSelection()}
          >
            {agent.statusMessage && (
              <p className="mb-3 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                {agent.statusMessage}
              </p>
            )}
            {agent.remoteControl ? (
              <div className="grid h-full place-items-center text-center">
                <div className="grid max-w-sm gap-3">
                  <p className="text-sm text-muted-foreground">
                    Remote Control is running in claude.ai/code. Use the maximized view for the QR code and connection link.
                  </p>
                  <Button variant="outline" disabled={!agent.rcUrl} onClick={() => agent.rcUrl && window.open(agent.rcUrl, "_blank", "noopener")}>
                    <ExternalLink className="h-4 w-4" />
                    Open
                  </Button>
                </div>
              </div>
            ) : transcript.length === 0 ? (
              showActivityIndicator ? (
                <AgentActivityIndicator agent={agent} compact />
              ) : (
                <p className="rounded-md border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">
                  No transcript yet.
                </p>
              )
            ) : (
              <div className="grid gap-2">
                {transcript.map((event) => (
                  <TranscriptPreview key={event.id} event={event} agent={agent} />
                ))}
                {showActivityIndicator && <AgentActivityIndicator agent={agent} compact />}
              </div>
            )}
          </div>
        </ContextMenuTrigger>
        <SendToMenu
          source={agent}
          selectedText={selection.selectedText}
          transcripts={transcript}
          rootSelector={`#${transcriptRootId}`}
          captureSelectedText={selection.captureSelection}
          getCachedSelectedText={selection.getCachedSelection}
        />
      </ContextMenu>
      {!agent.remoteControl && (
        <div className="shrink-0 border-t border-border p-3">
          <div className="flex gap-2">
            <div className="grid flex-1 gap-2">
              <AttachmentChips
                attachments={attachments}
                onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
              />
              <Textarea
                ref={inputRef}
                className="min-h-12 resize-none text-sm"
                value={draft}
                disabled={!canType}
                onChange={(event) => setDraft(agent.id, event.target.value)}
                onPaste={handlePaste}
                placeholder={isBusy ? "Queue a message..." : "Message this agent"}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
            </div>
            <Button
              className="self-end"
              size="icon"
              disabled={isBusy ? !agentHasProcess(agent) : !canType || (!draft.trim() && attachments.length === 0)}
              onClick={isBusy ? stopCurrentResponse : send}
              title={isBusy ? "Stop response" : "Send"}
            >
              {isBusy ? <X className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          {queue.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
              {queue.map((message, index) => (
                <button key={message.id} className="rounded-md border border-border px-2 py-1 hover:bg-accent" onClick={() => removeQueuedMessage(agent.id, message.id)} title="Cancel queued message">
                  queued {index + 1}: {message.text.slice(0, 36) || `${message.attachments.length} attachment(s)`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div
        className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize rounded-r-md hover:bg-primary/20"
        onPointerDown={startResize}
        title="Drag to resize chat width"
      />
    </section>
  );
}

function TranscriptPreview({ event, agent }: { event: TranscriptEvent; agent: RunningAgent }) {
  if (event.kind === "model_switch") {
    return <p className="text-center text-xs text-muted-foreground">switched to {event.to}</p>;
  }
  if (event.kind === "tool_use" || event.kind === "tool_result") {
    return <ToolCard event={event} agent={agent} compact />;
  }
  if (event.kind === "system") {
    return <p className="text-center text-xs text-muted-foreground">{event.text}</p>;
  }

  const isUser = event.kind === "user";
  return (
    <div className={cn("flex", isUser && "justify-end")}>
      <div
        className={cn(
          "max-w-[86%] whitespace-pre-wrap break-words rounded-md border border-border px-3 py-2 text-sm leading-5",
          isUser ? "bg-primary text-primary-foreground" : "bg-background/60"
        )}
        style={!isUser ? { borderLeftColor: agent.color, borderLeftWidth: 4 } : undefined}
      >
        <CollapsibleText text={event.text} compact />
        {event.kind === "user" && event.attachments && event.attachments.length > 0 && (
          <span className="mt-2 flex flex-wrap gap-2">
            {event.attachments.map((attachment) =>
              attachment.url ? (
                <img key={attachment.id} src={attachment.url} alt={attachment.name} className="h-16 w-16 rounded-md object-cover" />
              ) : null
            )}
          </span>
        )}
        {event.kind === "assistant_text" && event.streaming && (
          <span className="mt-2 block">
            <ThinkingText />
          </span>
        )}
      </div>
    </div>
  );
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
  const transcripts = useAppStore((state) => state.transcripts[agent.id] || EMPTY_TRANSCRIPT);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const addError = useAppStore((state) => state.addError);
  const isBusy = isAgentBusy(agent);

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
      <AgentDot color={agent.color} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">
          {agent.displayName} {agent.remoteControl && <Badge className="ml-1">RC</Badge>}
        </div>
        <ModelMenu agent={agent} />
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
          <DropdownMenuItem onClick={() => exportAgentMarkdown(agent, transcripts)}>Export Markdown</DropdownMenuItem>
          <DropdownMenuItem onClick={() => exportAgentJson(agent, transcripts)}>Export JSON</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void exportAgentRawStream(agent, addError)}>Export Raw Stream</DropdownMenuItem>
          <DropdownMenuItem onClick={() => sendCommand({ type: "clear", id: agent.id })}>Clear</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isBusy && (
        <Button variant="outline" onClick={() => sendCommand({ type: "interrupt", id: agent.id })}>
          <X className="h-4 w-4" />
          Stop
        </Button>
      )}
      <Button variant="outline" onClick={() => sendCommand({ type: "kill", id: agent.id })}>
        <X className="h-4 w-4" />
        Exit
      </Button>
      <Button variant="ghost" size="icon" onClick={() => setSelectedAgent(undefined)} title="Show tiles">
        <Minimize2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function StandardAgentPanel({ agent }: { agent: RunningAgent }) {
  const transcript = useAppStore((state) => state.transcripts[agent.id] || EMPTY_TRANSCRIPT);
  const draft = useAppStore((state) => state.drafts[agent.id] || "");
  const setDraft = useAppStore((state) => state.setDraft);
  const queue = useAppStore((state) => state.messageQueues[agent.id] || EMPTY_QUEUE);
  const enqueueMessage = useAppStore((state) => state.enqueueMessage);
  const removeQueuedMessage = useAppStore((state) => state.removeQueuedMessage);
  const popNextQueuedMessage = useAppStore((state) => state.popNextQueuedMessage);
  const addError = useAppStore((state) => state.addError);
  const scrollTop = useAppStore((state) => state.scrollPositions[agent.id] || 0);
  const setScrollPosition = useAppStore((state) => state.setScrollPosition);
  const searchOpen = useAppStore((state) => state.searchOpen);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptRootId = `transcript-root-${agent.id}`;
  const selection = useTextSelection(`#${transcriptRootId}`);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const isBusy = isAgentBusy(agent);
  const canType = agentHasProcess(agent);
  const showActivityIndicator = isBusy && !hasStreamingAssistantText(transcript);

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
  }, [transcript, agent.id]);

  useEffect(() => {
    if (isBusy || !canType || queue.length === 0) return;
    const next = popNextQueuedMessage(agent.id);
    if (!next) return;
    sendCommand({ type: "userMessage", id: agent.id, text: next.text, attachments: next.attachments });
  }, [agent.id, canType, isBusy, popNextQueuedMessage, queue.length]);

  function send() {
    if (!draft.trim() && attachments.length === 0) return;
    if (handleNativeSlashCommand(agent, draft)) {
      setDraft(agent.id, "");
      return;
    }
    if (isBusy) {
      enqueueMessage(agent.id, { text: draft, attachments });
      setDraft(agent.id, "");
      setAttachments([]);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    sendCommand({ type: "userMessage", id: agent.id, text: draft, attachments });
    setDraft(agent.id, "");
    setAttachments([]);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function stopCurrentResponse() {
    sendCommand({ type: "interrupt", id: agent.id });
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = pastedImageFiles(event);
    if (files.length === 0) return;
    event.preventDefault();
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) setDraft(agent.id, insertPastedText(event.currentTarget, draft, pastedText));
    try {
      const uploaded = await uploadPastedImages(files);
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
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
            id={transcriptRootId}
            ref={rootRef}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4"
            onScroll={(event) => setScrollPosition(agent.id, event.currentTarget.scrollTop)}
            onPointerDown={(event) => {
              selection.clearSelection();
            }}
            onMouseUp={() => selection.captureSelection()}
            onKeyUp={() => selection.captureSelection()}
            onContextMenuCapture={() => selection.captureSelection()}
          >
            <div className="mx-auto grid w-full min-w-0 max-w-4xl gap-3">
              {transcript.length === 0 ? (
                showActivityIndicator ? (
                  <AgentActivityIndicator agent={agent} />
                ) : (
                  <p className="rounded-md border border-dashed border-border px-3 py-12 text-center text-sm text-muted-foreground">
                    No transcript yet.
                  </p>
                )
              ) : (
                <>
                  {transcript.map((event) => (
                    <TranscriptItem key={event.id} event={event} agent={agent} query={searchQuery} />
                  ))}
                  {showActivityIndicator && <AgentActivityIndicator agent={agent} />}
                </>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <SendToMenu
          source={agent}
          selectedText={selection.selectedText}
          transcripts={transcript}
          rootSelector={`#${transcriptRootId}`}
          captureSelectedText={selection.captureSelection}
          getCachedSelectedText={selection.getCachedSelection}
        />
      </ContextMenu>
      <div className="border-t border-border p-3">
        <div className="mx-auto flex w-full min-w-0 max-w-4xl gap-2">
          <div className="grid flex-1 gap-2">
            <AttachmentChips
              attachments={attachments}
              onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
            />
            <Textarea
              ref={inputRef}
              className="min-h-16 resize-none"
              value={draft}
              disabled={!canType}
              onChange={(event) => setDraft(agent.id, event.target.value)}
              onPaste={handlePaste}
              placeholder={isBusy ? "Queue a message..." : "Message this agent"}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
          </div>
          <Button
            className="self-end"
            disabled={isBusy ? !agentHasProcess(agent) : !canType || (!draft.trim() && attachments.length === 0)}
            onClick={isBusy ? stopCurrentResponse : send}
          >
            {isBusy ? <X className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {isBusy ? "Stop" : "Send"}
          </Button>
        </div>
        {queue.length > 0 && (
          <div className="mx-auto mt-2 flex w-full max-w-4xl flex-wrap gap-2 text-xs text-muted-foreground">
            {queue.map((message, index) => (
              <button key={message.id} className="rounded-md border border-border px-2 py-1 hover:bg-accent" onClick={() => removeQueuedMessage(agent.id, message.id)} title="Cancel queued message">
                queued {index + 1}: {message.text.slice(0, 48) || `${message.attachments.length} attachment(s)`}
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function SendToMenu({
  source,
  selectedText,
  transcripts,
  rootSelector,
  captureSelectedText,
  getCachedSelectedText
}: {
  source: RunningAgent;
  selectedText: string;
  transcripts: TranscriptEvent[];
  rootSelector: string;
  captureSelectedText: () => string;
  getCachedSelectedText: () => string;
}) {
  const projects = useAppStore((state) => state.projects);
  const agentsById = useAppStore((state) => state.agents);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const openSendDialog = useAppStore((state) => state.openSendDialog);
  const addError = useAppStore((state) => state.addError);
  const project = projects.find((candidate) => candidate.id === source.projectId);
  const agents = useMemo(
    () => Object.values(agentsById).filter((agent) => agent.projectId === source.projectId),
    [agentsById, source.projectId]
  );
  const fallbackText = useMemo(() => transcriptToPlainText(source, transcripts), [source, transcripts]);
  const activeText = selectedText || getCachedSelectedText() || getSelectionInRoot(rootSelector) || fallbackText;

  function currentSelectedText() {
    return captureSelectedText() || selectedText || getCachedSelectedText() || getSelectionInRoot(rootSelector) || fallbackText;
  }

  return (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={!activeText}
        onClick={() => {
          const text = currentSelectedText();
          if (!text) return;
          void navigator.clipboard.writeText(text).catch((error: unknown) => {
            addError(error instanceof Error ? error.message : String(error));
          });
        }}
      >
        <Clipboard className="mr-2 h-4 w-4" />
        Copy
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-45" disabled={!activeText}>
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
                  onClick={() => {
                    const text = currentSelectedText();
                    if (!text) return;
                    openLaunchModal({
                      projectId: source.projectId,
                      defName: def.name,
                      initialPrompt: wrapForwardedText(source, text)
                    });
                  }}
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
                    onClick={() => {
                      const text = currentSelectedText();
                      if (!text) return;
                      openSendDialog({
                        sourceAgentId: source.id,
                        targetAgentId: agent.id,
                        selectedText: text,
                        framing: ""
                      });
                    }}
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
          "min-w-0 max-w-[78%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg border border-border px-3 py-2 text-sm leading-6",
          isUser ? "bg-primary text-primary-foreground" : "bg-card"
        )}
        style={!isUser ? { borderLeftColor: agent.color, borderLeftWidth: 4 } : undefined}
      >
        {event.sourceAgent && (
          <Badge className="mb-2" style={{ borderColor: event.sourceAgent.color, color: event.sourceAgent.color }}>
            from {event.sourceAgent.displayName}
          </Badge>
        )}
        <CollapsibleText text={event.text} query={query} />
        {event.kind === "assistant_text" && event.streaming && (
          <span className="mt-2 block">
            <ThinkingText />
          </span>
        )}
        {event.kind === "user" && event.attachments && event.attachments.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {event.attachments.map((attachment) =>
              attachment.url ? (
                <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" title={attachment.name}>
                  <img src={attachment.url} alt={attachment.name} className="h-20 w-20 rounded-md border border-border object-cover" />
                </a>
              ) : null
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CollapsibleText({ text, query = "", compact = false }: { text: string; query?: string; compact?: boolean }) {
  const shouldCollapse = text.length > (compact ? 420 : 900) || text.split(/\r?\n/).length > (compact ? 8 : 14);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (query.trim()) setExpanded(true);
  }, [query]);

  if (!shouldCollapse) return <HighlightedText text={text} query={query} />;

  return (
    <div className="grid gap-2">
      <div
        className={cn(
          "min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
          !expanded && (compact ? "max-h-32 overflow-hidden" : "max-h-48 overflow-hidden")
        )}
      >
        <HighlightedText text={text} query={query} />
      </div>
      <button
        type="button"
        className={cn(
          "inline-flex w-fit items-center gap-1 rounded-sm text-xs font-medium opacity-80 hover:opacity-100",
          compact ? "text-muted-foreground" : "text-current"
        )}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Show less" : "Show more"}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
      </button>
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

function ToolCard({
  event,
  agent,
  compact = false
}: {
  event: Extract<TranscriptEvent, { kind: "tool_use" | "tool_result" }>;
  agent: RunningAgent;
  compact?: boolean;
}) {
  const addError = useAppStore((state) => state.addError);
  const isUse = event.kind === "tool_use";
  const [open, setOpen] = useState((isUse && event.awaitingPermission) || (!isUse && event.isError));
  const summary = toolSummary(event);
  const detail = toolDetail(event);
  const pathText = isUse ? toolPath(event.input) : "";
  const commandText = isUse ? fieldText(event.input, ["command"]) : "";

  function copyText(text: string) {
    if (!text) return;
    void navigator.clipboard.writeText(text).catch((error: unknown) => {
      addError(error instanceof Error ? error.message : String(error));
    });
  }

  return (
    <div
      className={cn(
        "min-w-0 max-w-full rounded-md border bg-card",
        event.kind === "tool_use" && event.awaitingPermission ? "border-amber-400/50" : event.kind === "tool_result" && event.isError ? "border-red-400/50" : "border-border",
        compact ? "text-xs" : "text-sm"
      )}
    >
      <button className={cn("flex w-full min-w-0 items-center justify-between gap-3 text-left", compact ? "px-2 py-2" : "px-3 py-2")} onClick={() => setOpen((value) => !value)}>
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {isUse ? `Tool: ${event.name}` : `Tool result: ${event.toolUseId}`}
            {isUse && event.awaitingPermission && <Badge className="ml-2 border-amber-400/40 text-amber-200">awaiting permission</Badge>}
            {!isUse && event.isError && <Badge className="ml-2 border-red-400/40 text-red-200">error</Badge>}
          </span>
          {summary && <span className="mt-1 block truncate text-xs text-muted-foreground">{summary}</span>}
        </span>
        <Badge className="shrink-0 gap-1">
          {open ? "Hide" : "Show"}
          <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        </Badge>
      </button>
      {isUse && event.awaitingPermission && (
        <div className="grid gap-2 border-t border-border px-3 py-2">
          <p className="text-xs text-amber-100">
            Claude wants to run {event.name}
            {commandText ? `: ${commandText}` : pathText ? ` on ${pathText}` : ""}.
          </p>
          <div className="flex gap-2">
          <Button size="sm" disabled={!agentHasProcess(agent)} onClick={() => sendCommand({ type: "permission", id: agent.id, toolUseId: event.toolUseId, decision: "approve" })}>
            Approve
          </Button>
          <Button size="sm" variant="outline" disabled={!agentHasProcess(agent)} onClick={() => sendCommand({ type: "permission", id: agent.id, toolUseId: event.toolUseId, decision: "deny" })}>
            Deny
          </Button>
          </div>
        </div>
      )}
      {open && (
        <div className="border-t border-border">
          <div className="flex flex-wrap gap-2 px-3 py-2">
            {commandText && (
              <Button size="sm" variant="outline" onClick={() => copyText(commandText)}>
                <Clipboard className="h-3.5 w-3.5" />
                Command
              </Button>
            )}
            {pathText && (
              <Button size="sm" variant="outline" onClick={() => copyText(pathText)}>
                <Clipboard className="h-3.5 w-3.5" />
                Path
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => copyText(detail)}>
              <Clipboard className="h-3.5 w-3.5" />
              Output
            </Button>
          </div>
          <pre className="max-h-80 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-t border-border p-3 text-xs text-muted-foreground">{detail}</pre>
        </div>
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

function TerminalPane({
  session,
  output,
  active,
  onActivate,
  onClosePane
}: {
  session: TerminalSession;
  output: string[];
  active: boolean;
  onActivate: () => void;
  onClosePane?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);
  const sizeRef = useRef({ cols: session.cols, rows: session.rows });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      convertEol: true,
      fontFamily: "Cascadia Mono, Consolas, ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      theme: {
        background: "#09090b",
        foreground: "#f4f4f5",
        cursor: "#2dd4bf",
        selectionBackground: "#2dd4bf55"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const resize = () => {
      try {
        fit.fit();
        if (terminal.cols !== sizeRef.current.cols || terminal.rows !== sizeRef.current.rows) {
          sizeRef.current = { cols: terminal.cols, rows: terminal.rows };
          sendCommand({ type: "terminalResize", id: session.id, cols: terminal.cols, rows: terminal.rows });
        }
      } catch {
        // The fit addon can throw while the element is temporarily hidden during layout changes.
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    const dataDisposable = terminal.onData((input) => sendCommand({ type: "terminalInput", id: session.id, input }));
    const frame = window.requestAnimationFrame(() => {
      resize();
      terminal.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      dataDisposable.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      writtenRef.current = 0;
    };
  }, [session.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (output.length < writtenRef.current) {
      terminal.clear();
      writtenRef.current = 0;
    }
    output.slice(writtenRef.current).forEach((chunk) => terminal.write(chunk));
    writtenRef.current = output.length;
  }, [output]);

  useEffect(() => {
    if (!active) return;
    terminalRef.current?.focus();
  }, [active]);

  return (
    <div
      className={cn("relative min-h-0 min-w-0 overflow-hidden border border-border bg-zinc-950", active && "ring-1 ring-primary")}
      onMouseDown={onActivate}
    >
      {onClosePane && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 z-10 h-7 w-7 bg-zinc-950/80"
          onClick={(event) => {
            event.stopPropagation();
            onClosePane();
          }}
          title="Close split"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}

function TerminalPanel({ popout = false }: { popout?: boolean } = {}) {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const sessionsById = useAppStore((state) => state.terminalSessions);
  const outputById = useAppStore((state) => state.terminalOutput);
  const activeTerminalId = useAppStore((state) => state.activeTerminalId);
  const setActiveTerminal = useAppStore((state) => state.setActiveTerminal);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const addError = useAppStore((state) => state.addError);
  const [detached, setDetached] = useState(false);
  const [height, setHeight] = useState(320);
  const [detachedBounds, setDetachedBounds] = useState({ left: 96, top: 72, width: 960, height: 520 });
  const [visiblePaneIds, setVisiblePaneIds] = useState<string[]>([]);
  const sessions = useMemo(
    () =>
      terminalsForProject(sessionsById, selectedProjectId).sort(
        (left, right) => +new Date(left.startedAt) - +new Date(right.startedAt)
      ),
    [sessionsById, selectedProjectId]
  );
  const activeSession = activeTerminalId ? sessions.find((item) => item.id === activeTerminalId) : undefined;
  const session = activeSession || sessions[sessions.length - 1];

  useEffect(() => {
    const sessionIds = new Set(sessions.map((item) => item.id));
    setVisiblePaneIds((current) => {
      const filtered = current.filter((id) => sessionIds.has(id));
      const nextActive = activeTerminalId && sessionIds.has(activeTerminalId) ? activeTerminalId : sessions[sessions.length - 1]?.id;
      if (nextActive && !filtered.includes(nextActive)) return [...filtered.slice(-3), nextActive];
      return filtered;
    });
  }, [activeTerminalId, sessions]);

  useEffect(() => {
    if (!detached) return;
    const onResize = () => setDetachedBounds((bounds) => clampDetachedBounds(bounds));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [detached]);

  function clampDetachedBounds(bounds: { left: number; top: number; width: number; height: number }) {
    const margin = 8;
    const minWidth = 420;
    const minHeight = 260;
    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 720;
    const width = Math.min(Math.max(bounds.width, minWidth), Math.max(minWidth, viewportWidth - margin * 2));
    const height = Math.min(Math.max(bounds.height, minHeight), Math.max(minHeight, viewportHeight - margin * 2));
    return {
      width,
      height,
      left: Math.min(Math.max(bounds.left, margin), Math.max(margin, viewportWidth - width - margin)),
      top: Math.min(Math.max(bounds.top, margin), Math.max(margin, viewportHeight - height - margin))
    };
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;
    const onMove = (moveEvent: PointerEvent) => {
      setHeight(Math.min(760, Math.max(220, startHeight + startY - moveEvent.clientY)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startDetachedMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!detached) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startBounds = detachedBounds;
    const onMove = (moveEvent: PointerEvent) => {
      setDetachedBounds(
        clampDetachedBounds({
          ...startBounds,
          left: startBounds.left + moveEvent.clientX - startX,
          top: startBounds.top + moveEvent.clientY - startY
        })
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function startDetachedResize(
    event: ReactPointerEvent<HTMLDivElement>,
    horizontal?: "left" | "right",
    vertical?: "top" | "bottom"
  ) {
    if (!detached) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startBounds = detachedBounds;
    const onMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const next = { ...startBounds };

      if (horizontal === "right") next.width = startBounds.width + deltaX;
      if (horizontal === "left") {
        next.width = startBounds.width - deltaX;
        next.left = startBounds.left + deltaX;
      }
      if (vertical === "bottom") next.height = startBounds.height + deltaY;
      if (vertical === "top") {
        next.height = startBounds.height - deltaY;
        next.top = startBounds.top + deltaY;
      }

      if (next.width < 420 && horizontal === "left") next.left -= 420 - next.width;
      if (next.height < 260 && vertical === "top") next.top -= 260 - next.height;
      setDetachedBounds(clampDetachedBounds(next));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function toggleDetached() {
    if (popout) return;
    if (!detached) {
      setDetachedBounds((bounds) => clampDetachedBounds(bounds));
    }
    setDetached((value) => !value);
  }

  function openPopout() {
    const params = new URLSearchParams();
    if (selectedProjectId) params.set("projectId", selectedProjectId);
    const opened = window.open(
      `/terminal-popout${params.toString() ? `?${params.toString()}` : ""}`,
      `agent-control-terminal-${selectedProjectId || "global"}`,
      "popup,width=1120,height=720,left=120,top=80,resizable=yes,scrollbars=no"
    );
    if (!opened) {
      addError("Pop-out terminal was blocked by the browser.");
      return;
    }
    opened.focus();
  }

  function startTerminal() {
    sendCommand({ type: "terminalStart", projectId: selectedProjectId });
  }

  function splitTerminal() {
    startTerminal();
  }

  function renameTerminal(id: string, currentTitle: string) {
    const nextTitle = window.prompt("Rename terminal tab", currentTitle);
    if (nextTitle === null) return;
    sendCommand({ type: "terminalRename", id, title: nextTitle });
  }

  function showSession(id: string) {
    setActiveTerminal(id);
    setVisiblePaneIds((current) => {
      if (current.includes(id)) return current;
      return [...current.slice(-3), id];
    });
  }

  const visibleSessions = visiblePaneIds
    .map((id) => sessions.find((item) => item.id === id))
    .filter((item): item is TerminalSession => Boolean(item));

  return (
    <section
      className={cn(
        "flex shrink-0 flex-col border-border bg-card",
        popout ? "h-screen border-0" : detached ? "fixed z-40 rounded-md border shadow-2xl" : "relative border-t"
      )}
      style={popout ? undefined : detached ? detachedBounds : { height }}
    >
      {!popout && !detached && (
        <div className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize hover:bg-primary/25" onPointerDown={startResize} title="Drag to resize terminal" />
      )}
      {!popout && detached && (
        <>
          <div className="absolute -left-1 top-2 z-20 h-[calc(100%-1rem)] w-2 cursor-ew-resize" onPointerDown={(event) => startDetachedResize(event, "left")} />
          <div className="absolute -right-1 top-2 z-20 h-[calc(100%-1rem)] w-2 cursor-ew-resize" onPointerDown={(event) => startDetachedResize(event, "right")} />
          <div className="absolute -top-1 left-2 z-20 h-2 w-[calc(100%-1rem)] cursor-ns-resize" onPointerDown={(event) => startDetachedResize(event, undefined, "top")} />
          <div className="absolute -bottom-1 left-2 z-20 h-2 w-[calc(100%-1rem)] cursor-ns-resize" onPointerDown={(event) => startDetachedResize(event, undefined, "bottom")} />
          <div className="absolute -left-1 -top-1 z-30 h-4 w-4 cursor-nwse-resize" onPointerDown={(event) => startDetachedResize(event, "left", "top")} />
          <div className="absolute -right-1 -top-1 z-30 h-4 w-4 cursor-nesw-resize" onPointerDown={(event) => startDetachedResize(event, "right", "top")} />
          <div className="absolute -bottom-1 -left-1 z-30 h-4 w-4 cursor-nesw-resize" onPointerDown={(event) => startDetachedResize(event, "left", "bottom")} />
          <div className="absolute -bottom-1 -right-1 z-30 h-4 w-4 cursor-nwse-resize" onPointerDown={(event) => startDetachedResize(event, "right", "bottom")} />
        </>
      )}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <SquareTerminal className="h-4 w-4 text-primary" />
        <div
          className={cn("min-w-0 flex-1", detached && "cursor-move select-none")}
          onPointerDown={startDetachedMove}
          title={detached ? "Drag to move terminal" : undefined}
        >
          <div className="truncate text-sm font-medium">Terminal</div>
          <div className="truncate text-xs text-muted-foreground">{session?.cwd || "No terminal open"}</div>
        </div>
        <div className="flex max-w-[52vw] items-center gap-1 overflow-x-auto">
          {sessions.map((item, index) => (
            <div
              key={item.id}
              className={cn(
                "flex h-7 shrink-0 items-center overflow-hidden rounded-md border text-xs",
                item.id === session?.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"
              )}
              title={item.cwd}
            >
              <button
                className="h-full max-w-44 truncate px-2"
                onClick={() => showSession(item.id)}
                onDoubleClick={() => renameTerminal(item.id, item.title || item.projectName || `Shell ${index + 1}`)}
                title="Double-click to rename"
              >
                {item.title || item.projectName || `Shell ${index + 1}`}
              </button>
              <button
                className={cn(
                  "grid h-full w-7 place-items-center border-l",
                  item.id === session?.id ? "border-primary-foreground/25 hover:bg-primary-foreground/15" : "border-border hover:bg-accent"
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  sendCommand({ type: "terminalClose", id: item.id });
                }}
                title="Close terminal"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={startTerminal} disabled={!projects.length && !selectedProjectId}>
          <Plus className="h-4 w-4" />
          New
        </Button>
        <Button variant="outline" size="sm" onClick={splitTerminal} disabled={!projects.length && !selectedProjectId}>
          <GripVertical className="h-4 w-4" />
          Split
        </Button>
        {!popout && (
          <>
            <Button variant="outline" size="sm" onClick={toggleDetached}>
              {detached ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              {detached ? "Dock" : "Detach"}
            </Button>
            <Button variant="outline" size="sm" onClick={openPopout} title="Open terminal in a separate window">
              <ExternalLink className="h-4 w-4" />
              Pop Out
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon" onClick={() => (popout ? window.close() : setTerminalOpen(false))} title={popout ? "Close window" : "Close terminal"}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-2 bg-zinc-950 p-2",
          visibleSessions.length <= 1 ? "grid-cols-1" : visibleSessions.length === 2 ? "grid-cols-2" : "grid-cols-2"
        )}
      >
        {visibleSessions.length === 0 ? (
          <div className="grid place-items-center text-sm text-muted-foreground">No terminal session open.</div>
        ) : (
          visibleSessions.map((item) => (
            <TerminalPane
              key={item.id}
              session={item}
              output={outputById[item.id] || []}
              active={item.id === session?.id}
              onActivate={() => setActiveTerminal(item.id)}
              onClosePane={
                visibleSessions.length > 1
                  ? () => sendCommand({ type: "terminalClose", id: item.id })
                  : undefined
              }
            />
          ))
        )}
      </div>
    </section>
  );
}

function ErrorStack() {
  const errors = useAppStore((state) => state.errors);
  const dismissError = useAppStore((state) => state.dismissError);
  if (errors.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 grid max-w-md gap-2">
      {errors.map((error, index) => (
        <div key={`${error}-${index}`} className="flex items-start gap-2 rounded-md border border-red-400/40 bg-red-500/15 px-3 py-2 text-sm text-red-100 shadow-lg">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-red-100/80 hover:bg-red-500/20 hover:text-red-100"
            onClick={() => dismissError(index)}
            title="Dismiss error"
          >
            <X className="h-4 w-4" />
          </button>
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
  const terminalOpen = useAppStore((state) => state.terminalOpen);

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
        const agents = agentsForProject(useAppStore.getState().agents, selectedProjectId).sort(
          (left, right) => +new Date(right.launchedAt) - +new Date(left.launchedAt)
        );
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
      {terminalOpen && <TerminalPanel />}
      <LaunchDialog />
      <SendDialog />
      <ErrorStack />
    </div>
  );
}

export function TerminalPopoutApp() {
  const setProjects = useAppStore((state) => state.setProjects);
  const setCapabilities = useAppStore((state) => state.setCapabilities);
  const setSettings = useAppStore((state) => state.setSettings);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const addError = useAppStore((state) => state.addError);

  useEffect(() => {
    const requestedProjectId = new URLSearchParams(window.location.search).get("projectId") || undefined;
    void Promise.all([api.projects(), api.capabilities(), api.settings()])
      .then(([projects, capabilities, settings]) => {
        setProjects(projects);
        setCapabilities(capabilities);
        setSettings(settings);
        if (requestedProjectId && projects.some((project) => project.id === requestedProjectId)) {
          setSelectedProject(requestedProjectId);
        }
      })
      .catch((error: unknown) => addError(error instanceof Error ? error.message : String(error)));
    connectWebSocket();
    return () => disconnectWebSocket();
  }, [addError, setCapabilities, setProjects, setSelectedProject, setSettings]);

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <TerminalPanel popout />
      <ErrorStack />
    </div>
  );
}
