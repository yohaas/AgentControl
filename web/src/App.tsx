import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ComponentType,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import {
  ArrowDownAZ,
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clipboard,
  ClipboardList,
  Code2,
  Columns2,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GripVertical,
  HardDrive,
  Hand,
  Home,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pencil,
  PictureInPicture2,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  SquareSlash,
  SquareTerminal,
  Trash2,
  Upload,
  Waypoints,
  X
} from "lucide-react";
import type {
  AgentDef,
  AgentEffort,
  AgentPermissionMode,
  AgentProvider,
  ClaudePluginCatalog,
  DirectoryEntry,
  DirectoryListing,
  GitStatus,
  GitWorktreeList,
  MessageAttachment,
  ModelProfile,
  Project,
  ProjectFileEntry,
  RunningAgent,
  SlashCommandInfo,
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
import { useAppStore, type QueuedMessage, type ThemeMode } from "./store/app-store";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const EMPTY_TRANSCRIPT: TranscriptEvent[] = [];
const EMPTY_QUEUE: QueuedMessage[] = [];
const TERMINAL_DOCK_MESSAGE = "agent-control:dock-terminal";
const TERMINAL_DOCK_STORAGE_KEY = "agent-control-terminal-dock-request";
const TERMINAL_POPOUT_STORAGE_KEY = "agent-control-popped-out-terminals";
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

const GENERIC_AGENT_DEF: AgentDef = {
  name: "Generic",
  description: "General-purpose Claude agent",
  color: "#ffffff",
  provider: "claude",
  tools: [],
  systemPrompt: "",
  builtIn: true
};

interface SlashCommandSuggestion {
  value: string;
  label: string;
  description: string;
  argumentHint?: string;
  source?: SlashCommandInfo["source"];
  interactive?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

type ToolUseEvent = Extract<TranscriptEvent, { kind: "tool_use" }>;
type ToolResultEvent = Extract<TranscriptEvent, { kind: "tool_result" }>;
type ToolTranscriptItem =
  | { kind: "single"; event: TranscriptEvent }
  | { kind: "tool_pair"; event: ToolUseEvent; result?: ToolResultEvent };
type ContextCopyTarget = { scope: "block" | "chat"; text: string };

const BASE_SLASH_COMMANDS: SlashCommandSuggestion[] = [
  { value: "/clear", label: "/clear", description: "Clear this chat history", source: "agentcontrol" },
  { value: "/exit", label: "/exit", description: "Close this agent", source: "agentcontrol" },
  { value: "/stop", label: "/stop", description: "Stop the active response", source: "agentcontrol" },
  { value: "/interrupt", label: "/interrupt", description: "Stop the active response", source: "agentcontrol" },
  { value: "/compact", label: "/compact", description: "Compact conversation context", argumentHint: "[instructions]", source: "builtin" },
  { value: "/memory", label: "/memory", description: "Edit or inspect memory files", source: "builtin", interactive: true },
  { value: "/status", label: "/status", description: "Show AgentControl session status", source: "agentcontrol" },
  { value: "/resume", label: "/resume", description: "Resume a previous conversation", source: "builtin", interactive: true },
  { value: "/permissions", label: "/permissions", description: "Manage allow, ask, and deny rules", source: "builtin", interactive: true }
];

function compareSlashCommands(left: string, right: string) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareSlashCommands);
  const sortedRight = [...right].sort(compareSlashCommands);
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

function normalizeUiSlashCommand(command: SlashCommandInfo | string): SlashCommandInfo {
  if (typeof command === "string") {
    return { command: command.startsWith("/") ? command : `/${command}`, source: "session" };
  }
  return {
    ...command,
    command: command.command.startsWith("/") ? command.command : `/${command.command}`
  };
}

function slashCommandInsertValue(command: SlashCommandInfo) {
  return command.argumentHint ? `${command.command} ` : command.command;
}

function enabledSlashSuggestion(suggestion?: SlashCommandSuggestion): SlashCommandSuggestion | undefined {
  return suggestion && !suggestion.disabled ? suggestion : undefined;
}

const TERMINAL_DOCK_OPTIONS = [
  { value: "float", label: "Float", icon: PictureInPicture2 },
  { value: "left", label: "Dock left", icon: PanelLeft },
  { value: "bottom", label: "Dock bottom", icon: PanelBottom },
  { value: "right", label: "Dock right", icon: PanelRight }
] as const;

function applyThemeMode(themeMode: ThemeMode) {
  const root = document.documentElement;
  root.classList.toggle("light", themeMode === "light");
  root.classList.toggle("dark", themeMode === "dark");
  root.style.colorScheme = themeMode === "auto" ? "light dark" : themeMode;
}

function useThemeMode(themeMode: ThemeMode) {
  useEffect(() => {
    applyThemeMode(themeMode);
  }, [themeMode]);
}

function terminalThemeFromCss() {
  const style = window.getComputedStyle(document.documentElement);
  const color = (name: string, alpha?: number) => `hsl(${style.getPropertyValue(name).trim()}${alpha === undefined ? "" : ` / ${alpha}`})`;
  return {
    background: color("--background"),
    foreground: color("--foreground"),
    cursor: color("--primary"),
    selectionBackground: color("--primary", 0.35)
  };
}

function readPoppedOutTerminalIds() {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(TERMINAL_POPOUT_STORAGE_KEY) || "[]") as string[]);
  } catch {
    return new Set<string>();
  }
}

function writePoppedOutTerminalIds(ids: Set<string>) {
  window.localStorage.setItem(TERMINAL_POPOUT_STORAGE_KEY, JSON.stringify([...ids]));
}

function readTerminalDockRequest(value: string | null) {
  try {
    return JSON.parse(value || "{}") as { terminalId?: string };
  } catch {
    return {};
  }
}

function notifyTerminalDock(terminalId?: string, focusOpener = false) {
  try {
    window.opener?.postMessage({ type: TERMINAL_DOCK_MESSAGE, terminalId }, window.location.origin);
    if (focusOpener) window.opener?.focus();
  } catch {
    // Fall back to a storage event for browsers that block opener access.
  }
  window.localStorage.setItem(TERMINAL_DOCK_STORAGE_KEY, JSON.stringify({ terminalId, at: Date.now() }));
}

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

function latestUserMessage(transcript: TranscriptEvent[]) {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const event = transcript[index];
    if (event.kind === "user") return event;
  }
  return undefined;
}

function shouldShowPinnedUserMessage(root: HTMLDivElement, pinnedMessageId?: string) {
  if (!pinnedMessageId || root.scrollTop <= 24) return false;
  const original = root.querySelector<HTMLElement>('[data-latest-user-message="true"]');
  if (!original) return true;
  const rootRect = root.getBoundingClientRect();
  const originalRect = original.getBoundingClientRect();
  if (originalRect.bottom > rootRect.top && originalRect.top < rootRect.bottom) return false;
  return originalRect.bottom <= rootRect.top;
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
        <ThinkingText prefix="Working" />
      </div>
    </div>
  );
}

function AgentDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("h-3 w-3 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

function LastActivityText({
  agent,
  compact = false,
  timeOnly = false
}: {
  agent: RunningAgent;
  compact?: boolean;
  timeOnly?: boolean;
}) {
  const timestamp = agent.updatedAt || agent.launchedAt;
  return (
    <span
      className={cn("shrink-0 whitespace-nowrap text-muted-foreground", compact ? "text-[11px]" : "text-xs")}
      title={fullLastActivity(timestamp)}
    >
      {timeOnly ? formatLastActivityTime(timestamp) : formatLastActivity(timestamp)}
    </span>
  );
}

function StatusPill({ status }: { status: RunningAgent["status"] }) {
  const label =
    status === "running"
      ? "Active"
      : status === "starting"
        ? "Starting"
        : status === "switching-model"
          ? "Switching"
          : status === "awaiting-permission"
            ? "Needs approval"
            : status === "remote-controlled"
              ? "Remote"
              : status === "killed"
                ? "Exited"
                : status === "interrupted"
                  ? "Interrupted"
                  : status === "idle"
                    ? "Idle"
                    : status === "paused"
                      ? "Paused"
                      : status === "error"
                        ? "Error"
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

function remoteControlLabel(agent: RunningAgent) {
  if (agent.rcState === "waiting-for-browser") return "Waiting for browser/mobile";
  if (agent.rcState === "connected") return "Connected";
  if (agent.rcState === "closed") return "Closed";
  if (agent.rcState === "error") return "Error";
  return "Starting";
}

function SessionInfoPopover({ agent, compact = false }: { agent: RunningAgent; compact?: boolean }) {
  const tools = agent.sessionTools || [];
  const mcpServers = agent.mcpServers || [];
  const slashCommands = useMemo(
    () => [...(agent.slashCommands || [])].map(normalizeUiSlashCommand).sort((left, right) => compareSlashCommands(left.command, right.command)),
    [agent.slashCommands]
  );
  const plugins = agent.activePlugins || [];
  const hasInfo = tools.length > 0 || mcpServers.length > 0 || slashCommands.length > 0 || plugins.length > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className={cn(compact ? "h-7 w-7" : "h-8 w-8")} title="Session tools and MCP">
          <Puzzle className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="grid gap-3 text-sm">
          <div>
            <h3 className="font-medium">Session Capabilities</h3>
            <p className="text-xs text-muted-foreground">{hasInfo ? "Scanned locally and merged with Claude session metadata." : "No session capability metadata yet."}</p>
          </div>
          {plugins.length > 0 && <SessionInfoList label="Plugins" items={plugins} />}
          {mcpServers.length > 0 && (
            <SessionInfoList
              label="MCP servers"
              items={mcpServers.map((server) => `${server.name}${server.status ? ` (${server.status})` : ""}`)}
            />
          )}
          {tools.length > 0 && <SessionInfoList label="Tools" items={tools} max={18} />}
          {slashCommands.length > 0 && <SessionInfoList label="Slash commands" items={slashCommands.map((command) => command.command)} max={18} />}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SessionInfoList({ label, items, max = 12 }: { label: string; items: string[]; max?: number }) {
  const visible = items.slice(0, max);
  const hidden = Math.max(0, items.length - visible.length);
  return (
    <section className="grid gap-1.5">
      <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {visible.map((item) => (
          <Badge key={item} className="max-w-full truncate">
            {item}
          </Badge>
        ))}
        {hidden > 0 && <Badge>+{hidden}</Badge>}
      </div>
    </section>
  );
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

function transcriptEventToPlainText(agent: RunningAgent, event: TranscriptEvent, transcripts: TranscriptEvent[]) {
  if (event.kind === "assistant_text") return `Assistant (${event.model || agent.currentModel}):\n${event.text}`;
  if (event.kind === "user") return `User:\n${event.text}`;
  if (event.kind === "tool_use") {
    const result = transcripts.find((candidate): candidate is ToolResultEvent => candidate.kind === "tool_result" && candidate.toolUseId === event.toolUseId);
    return result ? toolPairDetail(event, result) : `Tool Use: ${event.name}\n${prettyJson(event.input)}`;
  }
  if (event.kind === "tool_result") return `Tool Result:\n${prettyJson(event.output)}`;
  if (event.kind === "model_switch") return `System: switched to ${event.to}`;
  return `System:\n${event.text}`;
}

function contextCopyTargetFromEvent(
  event: ReactMouseEvent<HTMLElement>,
  root: HTMLElement | null,
  agent: RunningAgent,
  transcripts: TranscriptEvent[]
): ContextCopyTarget | undefined {
  if (!root || !(event.target instanceof Element)) return undefined;
  const block = event.target.closest<HTMLElement>("[data-copy-block='true']");
  if (!block || !root.contains(block)) return undefined;
  const eventId = block.dataset.copyEventId;
  const transcriptEvent = eventId ? transcripts.find((item) => item.id === eventId) : undefined;
  const text = transcriptEvent ? transcriptEventToPlainText(agent, transcriptEvent, transcripts) : block.innerText.trim();
  return text ? { scope: "block", text } : undefined;
}

function pairedTranscriptItems(transcript: TranscriptEvent[]): ToolTranscriptItem[] {
  const usedResults = new Set<string>();
  return transcript
    .map((event, index): ToolTranscriptItem | undefined => {
      if (event.kind === "tool_use") {
        const result = transcript
          .slice(index + 1)
          .find(
            (candidate): candidate is ToolResultEvent =>
              candidate.kind === "tool_result" && candidate.toolUseId === event.toolUseId && !usedResults.has(candidate.id)
          );
        if (result) usedResults.add(result.id);
        return { kind: "tool_pair", event, result };
      }
      if (event.kind === "tool_result" && usedResults.has(event.id)) return undefined;
      return { kind: "single", event };
    })
    .filter((item): item is ToolTranscriptItem => Boolean(item));
}

function toolValueText(value: unknown): string {
  if (value === undefined || value === null) return "";
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

function toolPairDetail(toolUse: ToolUseEvent | ToolResultEvent, result: ToolResultEvent) {
  return [
    toolUse.kind === "tool_use" ? `Tool: ${toolUse.name}\n\n${toolDetail(toolUse)}` : toolDetail(toolUse),
    `Result${result.isError ? " (error)" : ""}\n\n${toolDetail(result)}`
  ].join("\n\n---\n\n");
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("Could not read attachment.")));
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

async function uploadFiles(files: File[]) {
  return Promise.all(
    files.map(async (file) =>
      api.uploadAttachment({
        name: file.name || `attachment.${file.type.split("/")[1] || "bin"}`,
        mimeType: file.type || "application/octet-stream",
        dataUrl: await readFileAsDataUrl(file)
      })
    )
  );
}

function cleanDroppedPath(text: string) {
  const trimmed = text.trim().replace(/^file:\/+/, "");
  if (!trimmed || /\r?\n/.test(trimmed)) return "";
  return trimmed.replace(/^["']|["']$/g, "");
}

function isAgentReorderDrag(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes("application/x-agent-id");
}

async function attachmentsFromDrop(agent: RunningAgent, dataTransfer: DataTransfer) {
  const files = Array.from(dataTransfer.files || []);
  if (files.length > 0) return uploadFiles(files);
  const pathText = cleanDroppedPath(dataTransfer.getData("text/plain") || dataTransfer.getData("text/uri-list") || "");
  if (!pathText) return [];
  return [await api.addProjectContext(agent.projectId, pathText)];
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

interface ContextTreeNode {
  name: string;
  path: string;
  folders: ContextTreeNode[];
  files: ProjectFileEntry[];
}

function buildContextTree(files: ProjectFileEntry[]): ContextTreeNode {
  const root: ContextTreeNode = { name: "", path: "", folders: [], files: [] };
  const foldersByPath = new Map<string, ContextTreeNode>([["", root]]);

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (const part of parts.slice(0, -1)) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let folder = foldersByPath.get(currentPath);
      if (!folder) {
        folder = { name: part, path: currentPath, folders: [], files: [] };
        foldersByPath.set(currentPath, folder);
        current.folders.push(folder);
      }
      current = folder;
    }
    current.files.push(file);
  }

  function sortNode(node: ContextTreeNode) {
    node.folders.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    node.files.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    node.folders.forEach(sortNode);
  }

  sortNode(root);
  return root;
}

function contextFolderPaths(node: ContextTreeNode): string[] {
  return node.folders.flatMap((folder) => [folder.path, ...contextFolderPaths(folder)]);
}

function selectedLineCount(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).length;
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
          {attachment.mimeType.startsWith("image/") ? (
            <ImageIcon className="h-3.5 w-3.5 text-primary" />
          ) : (
            <FileText className="h-3.5 w-3.5 text-primary" />
          )}
          {attachment.mimeType.startsWith("image/") && attachment.url && <img src={attachment.url} alt="" className="h-6 w-6 rounded object-cover" />}
          <span className="truncate">{attachment.relativePath || attachment.name}</span>
          <button className="text-muted-foreground hover:text-foreground" onClick={() => onRemove(attachment.id)} title="Remove attachment">
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}

function ComposerAddMenu({
  disabled,
  onUpload,
  onAddContext
}: {
  disabled: boolean;
  onUpload: () => void;
  onAddContext: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" title="Add attachment or context" disabled={disabled}>
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-52">
        <DropdownMenuItem onSelect={onUpload} className="gap-3">
          <Upload className="h-4 w-4 text-muted-foreground" />
          Upload from computer
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onAddContext} className="gap-3">
          <FileText className="h-4 w-4 text-muted-foreground" />
          Add context
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QueuedMessageList({
  agentId,
  queue,
  compact = false
}: {
  agentId: string;
  queue: QueuedMessage[];
  compact?: boolean;
}) {
  const updateQueuedMessage = useAppStore((state) => state.updateQueuedMessage);
  const removeQueuedMessage = useAppStore((state) => state.removeQueuedMessage);
  const reorderQueuedMessages = useAppStore((state) => state.reorderQueuedMessages);
  const [expanded, setExpanded] = useState(true);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [draggingId, setDraggingId] = useState<string | undefined>();

  if (queue.length === 0) return null;

  function moveMessage(dragId: string, targetId: string) {
    if (dragId === targetId) return;
    const currentIds = queue.map((message) => message.id);
    const from = currentIds.indexOf(dragId);
    const to = currentIds.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...currentIds];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorderQueuedMessages(agentId, next);
  }

  return (
    <div className="mb-2 rounded-md border border-border bg-background/60">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/50"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="font-medium text-foreground">
          Queued messages ({queue.length})
        </span>
        <ChevronDown className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div className="grid gap-1 border-t border-border p-1.5">
          {queue.map((message, index) => {
            const editing = editingId === message.id;
            const label = message.text.trim() || `${message.attachments.length} attachment(s)`;
            return (
              <div
                key={message.id}
                className={cn(
                  "grid gap-1 rounded-md border border-border bg-card/70 p-1.5",
                  draggingId === message.id && "opacity-50"
                )}
                onDragOver={(event) => {
                  if (!draggingId) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const dragId = event.dataTransfer.getData("application/x-queued-message-id") || draggingId;
                  if (dragId) moveMessage(dragId, message.id);
                  setDraggingId(undefined);
                }}
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <button
                    type="button"
                    className="cursor-grab rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    draggable
                    title="Drag to reorder"
                    onDragStart={(event) => {
                      event.stopPropagation();
                      setDraggingId(message.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-queued-message-id", message.id);
                    }}
                    onDragEnd={() => setDraggingId(undefined)}
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </button>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{index + 1}</span>
                  <span className={cn("min-w-0 flex-1 truncate text-xs", compact && "text-[11px]")} title={label}>
                    {label}
                  </span>
                  {message.attachments.length > 0 && <Badge className="shrink-0">{message.attachments.length}</Badge>}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title={editing ? "Done editing" : "Edit queued message"}
                    onClick={() => setEditingId((current) => (current === message.id ? undefined : message.id))}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    title="Delete queued message"
                    onClick={() => removeQueuedMessage(agentId, message.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {editing && (
                  <Textarea
                    className={cn("min-h-20 resize-y text-xs", compact && "min-h-16")}
                    value={message.text}
                    onChange={(event) => updateQueuedMessage(agentId, message.id, { text: event.target.value })}
                    placeholder={message.attachments.length > 0 ? "Optional message for attachments" : "Queued message"}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddContextDialog({
  agent,
  open,
  onOpenChange,
  onSelect,
  onDone
}: {
  agent: RunningAgent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (attachment: MessageAttachment) => void;
  onDone?: () => void;
}) {
  const addError = useAppStore((state) => state.addError);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<ProjectFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildContextTree(files), [files]);
  const visibleFolders = useMemo(
    () => (query.trim() ? new Set(contextFolderPaths(tree)) : expandedFolders),
    [expandedFolders, query, tree]
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void api
        .projectFiles(agent.projectId, query)
        .then((next) => {
          if (!cancelled) setFiles(next);
        })
        .catch((error) => {
          if (!cancelled) addError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [addError, agent.projectId, open, query]);

  async function addFile(file: ProjectFileEntry) {
    try {
      const attachment = await api.addProjectContext(agent.projectId, file.path);
      onSelect(attachment);
      onOpenChange(false);
      onDone?.();
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function toggleFolder(path: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function renderFile(file: ProjectFileEntry, depth: number) {
    return (
      <button
        key={file.path}
        type="button"
        className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
        style={{ paddingLeft: 12 + depth * 18 }}
        onClick={() => void addFile(file)}
      >
        <FileText className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">{file.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
      </button>
    );
  }

  function renderFolder(folder: ContextTreeNode, depth: number) {
    const expanded = visibleFolders.has(folder.path);
    return (
      <div key={folder.path}>
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
          style={{ paddingLeft: 12 + depth * 18 }}
          onClick={() => toggleFolder(folder.path)}
        >
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{folder.files.length + folder.folders.length}</span>
        </button>
        {expanded && (
          <>
            {folder.folders.map((child) => renderFolder(child, depth + 1))}
            {folder.files.map((file) => renderFile(file, depth + 1))}
          </>
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,720px)]">
        <DialogHeader>
          <DialogTitle>Add context</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files in this repo" />
          <div className="max-h-[52vh] overflow-auto rounded-md border border-border">
            {loading && files.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">Loading files...</div>
            ) : files.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No files found.</div>
            ) : (
              <div className="divide-y divide-border">
                {tree.folders.map((folder) => renderFolder(folder, 0))}
                {tree.files.map((file) => renderFile(file, 0))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
  if (command === "status") {
    sendCommand({ type: "nativeStatus", id: agent.id });
    return true;
  }
  if (command === "model" && arg) {
    sendCommand({ type: "setModel", id: agent.id, model: arg });
    return true;
  }
  return false;
}

function slashCommandSuggestions(draft: string, models: string[], sessionCommands: Array<SlashCommandInfo | string> = []): SlashCommandSuggestion[] {
  const trimmed = draft.trimStart();
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) return [];
  const query = trimmed.slice(1).toLowerCase();
  if (query.startsWith("model ")) {
    const modelQuery = query.slice("model ".length).trim();
    return models
      .filter((model) => model.toLowerCase().includes(modelQuery))
      .slice(0, 8)
      .map((model) => ({
        value: `/model ${model}`,
        label: `/model ${model}`,
        description: "Switch this agent to this model",
        source: "builtin"
      }));
  }

  const commands = [
    ...BASE_SLASH_COMMANDS,
    ...sessionCommands.map((command) => {
      const normalized = normalizeUiSlashCommand(command);
      return {
        value: slashCommandInsertValue(normalized),
        label: normalized.command,
        description: normalized.description || "Pass through to Claude",
        argumentHint: normalized.argumentHint,
        source: normalized.source,
        interactive: normalized.interactive,
        disabled: normalized.interactive,
        disabledReason: normalized.interactive ? "Requires Claude TUI" : undefined
      };
    }),
    { value: "/model ", label: "/model", description: "Switch this agent to another model", argumentHint: "[model]", source: "builtin" as const }
  ];
  const seen = new Set<string>();
  return commands
    .filter((command) => {
      const key = command.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return command.label.slice(1).toLowerCase().startsWith(query);
    })
    .sort((left, right) => compareSlashCommands(left.label, right.label))
    .slice(0, 60);
}

function SlashCommandAutocomplete({
  suggestions,
  activeIndex,
  compact = false,
  onSelect,
  onActiveIndexChange
}: {
  suggestions: SlashCommandSuggestion[];
  activeIndex: number;
  compact?: boolean;
  onSelect: (value: string) => void;
  onActiveIndexChange: (index: number) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="max-h-[min(60vh,520px)] overflow-y-auto overflow-x-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion.value}
          type="button"
          disabled={suggestion.disabled}
          title={suggestion.disabledReason}
          className={cn(
            "flex w-full min-w-0 items-start gap-3 px-3 py-2 text-left hover:bg-accent",
            compact ? "text-xs" : "text-sm",
            index === activeIndex && "bg-accent",
            suggestion.disabled && "cursor-not-allowed opacity-55 hover:bg-transparent"
          )}
          onMouseEnter={() => onActiveIndexChange(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            if (suggestion.disabled) return;
            onSelect(suggestion.value);
          }}
        >
          <span className="shrink-0 font-mono text-primary">
            {suggestion.label}
            {suggestion.argumentHint && <span className="ml-1 text-muted-foreground">{suggestion.argumentHint}</span>}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{suggestion.description}</span>
          {suggestion.source && <Badge className="shrink-0 text-[10px] uppercase">{suggestion.source}</Badge>}
          {suggestion.disabled && <Badge className="shrink-0 border-amber-400/40 text-[10px] uppercase text-amber-200">Requires TUI</Badge>}
        </button>
      ))}
    </div>
  );
}

function agentsForProject(agentsById: Record<string, RunningAgent>, projectId?: string) {
  return Object.values(agentsById).filter((agent) => !projectId || agent.projectId === projectId);
}

function agentDefsWithGeneric(project?: { agents: AgentDef[]; builtInAgents?: AgentDef[] }) {
  const agents = [...(project?.agents || []), ...(project?.builtInAgents || [])];
  return agents.some((agent) => agent.name.toLowerCase() === "generic") ? agents : [...agents, GENERIC_AGENT_DEF];
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

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function latestTerminalLine(output: string[]) {
  const text = stripAnsi(output.slice(-40).join(""));
  const lines = text
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) || "";
}

function timestampValue(value?: string) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatLastActivity(value?: string) {
  const timestamp = timestampValue(value);
  if (!timestamp) return "Last active n/a";
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Last active ${time}`;
  return `Last active ${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function formatLastActivityTime(value?: string) {
  const timestamp = timestampValue(value);
  if (!timestamp) return "n/a";
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function fullLastActivity(value?: string) {
  const timestamp = timestampValue(value);
  if (!timestamp) return "Last activity unavailable";
  return `Last activity: ${new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function agentHasProcess(agent: RunningAgent) {
  if (agent.provider === "openai" || agent.provider === "codex") return agent.status !== "killed" && agent.status !== "error";
  return (Boolean(agent.pid) || agent.status === "paused" || agent.restorable) && agent.status !== "killed" && agent.status !== "error";
}

function providerLabel(provider?: AgentProvider) {
  if (provider === "codex") return "Codex";
  if (provider === "openai") return "OpenAI";
  return "Claude";
}

function modelProfilesForSettings(settings: { models: string[]; modelProfiles?: ModelProfile[] }): ModelProfile[] {
  if (settings.modelProfiles?.length) return settings.modelProfiles;
  return settings.models.map((model, index) => ({ id: model, provider: "claude", default: index === 0 }));
}

function parseModelProfiles(text: string): ModelProfile[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [maybeProvider, ...modelParts] = line.split(":");
      const provider: AgentProvider = maybeProvider === "claude" || maybeProvider === "codex" || maybeProvider === "openai" ? maybeProvider : "claude";
      const id = modelParts.length ? modelParts.join(":").trim() : line;
      return { provider, id: id.trim() };
    })
    .filter((profile) => profile.id.length > 0);
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
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [connectionMenuOpen, setConnectionMenuOpen] = useState(false);
  const [supervised, setSupervised] = useState<boolean | undefined>();
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

  useEffect(() => {
    if (!connectionMenuOpen) return;
    void refreshAdminStatus();
  }, [connectionMenuOpen]);

  async function refreshAdminStatus() {
    try {
      const status = await api.adminStatus();
      setSupervised(status.supervised);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function restartAgentControl() {
    if (!window.confirm("Restart AgentControl? The dashboard will disconnect briefly.")) return;
    try {
      await api.restartApp();
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function shutdownAgentControl() {
    if (!window.confirm("Shutdown AgentControl? You will need to start it again from a terminal.")) return;
    try {
      await api.shutdownApp();
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

  function sortChatsByLastActivity() {
    const sorted = orderedAgentsForTiles(projectAgents, tileOrder)
      .map((agent, index) => ({ agent, index }))
      .sort(
        (left, right) =>
          timestampValue(right.agent.updatedAt || right.agent.launchedAt) -
            timestampValue(left.agent.updatedAt || left.agent.launchedAt) ||
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
        <DropdownMenu open={connectionMenuOpen} onOpenChange={setConnectionMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "grid h-5 w-5 shrink-0 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                wsConnected ? "text-emerald-400" : "text-red-400"
              )}
              title={
                wsConnected
                  ? "AgentControl is connected. Click for restart and shutdown options."
                  : "AgentControl is disconnected. The dashboard is not receiving live updates."
              }
              aria-label={wsConnected ? "AgentControl connected" : "AgentControl disconnected"}
            >
              <span className="h-2.5 w-2.5 rounded-full bg-current shadow-[0_0_0_3px_rgba(255,255,255,0.06)]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onClick={() => void restartAgentControl()} disabled={supervised === false}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Restart AgentControl
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void shutdownAgentControl()}>
              <X className="mr-2 h-4 w-4" />
              Shutdown AgentControl
            </DropdownMenuItem>
            {supervised === false && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                Restart is available after launching with npm run dev:supervised.
              </div>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-60 justify-between">
              <span className="truncate">{selectedProject?.name || "Select project"}</span>
              <ChevronDown className="h-4 w-4 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {projects.map((project) => (
              <DropdownMenuItem key={project.id} onClick={() => setSelectedProject(project.id)} className="justify-between gap-2">
                <span className="truncate">{project.name}</span>
                {project.id === selectedProjectId && <Check className="h-4 w-4" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem className="gap-2 border-t border-border" onClick={() => setAddProjectOpen(true)}>
              <FolderPlus className="h-4 w-4" />
              Add Project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center">
          <Button
            variant="outline"
            size="icon"
            className="rounded-r-none"
            disabled={!selectedProjectId}
            onClick={runProjectDev}
            title={`Run ${devCommand}`}
          >
            <Play className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="-ml-px w-7 rounded-l-none"
                disabled={!selectedProjectId}
                title={`Dev command options: ${devCommand}`}
              >
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={restartProjectDev}>Restart {devCommand}</DropdownMenuItem>
              <DropdownMenuItem disabled={projectDevTerminals.length === 0} onClick={stopProjectDev}>
                Stop dev command
              </DropdownMenuItem>
              <DropdownMenuItem onClick={customizeProjectDev}>Customize...</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <GitStatusMenu projectId={selectedProjectId} />
        <WorktreesDialog projectId={selectedProjectId} />
        <Button
          variant="outline"
          size="icon"
          disabled={!selectedProjectId}
          onClick={() => void closeSelectedProject()}
          title="Close project"
        >
          <X className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" disabled={agentCount < 2} title="Sort chats">
              <ArrowDownAZ className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={sortChatsByAgentType}>Sort by agent type</DropdownMenuItem>
            <DropdownMenuItem onClick={sortChatsByLastActivity}>Sort by last activity</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AddProjectDialog open={addProjectOpen} onOpenChange={setAddProjectOpen} showTrigger={false} />
        <Button variant={terminalOpen ? "default" : "outline"} size="icon" onClick={toggleTerminal} title="Terminal">
          <SquareTerminal className="h-4 w-4" />
        </Button>
        <PluginsDialog />
        <SettingsDialog />
      </div>
    </header>
  );
}

function GitStatusMenu({ projectId }: { projectId?: string }) {
  const addError = useAppStore((state) => state.addError);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GitStatus | undefined>();
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    if (!open || !projectId) return;
    void refresh();
  }, [open, projectId]);

  useEffect(() => {
    if (!projectId) {
      setStatus(undefined);
      return;
    }
    void refresh();
  }, [projectId]);

  async function refresh() {
    if (!projectId) return;
    setLoading(true);
    try {
      setStatus(await api.gitStatus(projectId));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function push() {
    if (!projectId || !status?.isRepo || status.ahead <= 0) return;
    setPushing(true);
    try {
      setStatus(await api.gitPush(projectId));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
      void refresh();
    } finally {
      setPushing(false);
    }
  }

  const changedCount = status?.files.length || 0;
  const aheadCount = status?.ahead || 0;
  const hasWork = changedCount > 0 || aheadCount > 0;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant={hasWork ? "default" : "outline"} size="icon" disabled={!projectId} title="Git status" className="relative">
          <GitBranch className="h-4 w-4" />
          {aheadCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 grid min-h-4 min-w-4 place-items-center rounded-full border border-background bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
              {aheadCount > 99 ? "99+" : aheadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="grid gap-3 p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium">Git</div>
              <div className="truncate text-xs text-muted-foreground">
                {loading ? "Checking..." : status?.isRepo ? status.branch || "Repository" : status?.message || "Not a Git repository"}
              </div>
            </div>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => void refresh()} disabled={!projectId || loading}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {status?.isRepo && (
            <>
              <div className="grid gap-1 rounded-md border border-border p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Pending pushes</span>
                  <span>{aheadCount > 0 ? `${aheadCount} commit${aheadCount === 1 ? "" : "s"}` : "None"}</span>
                </div>
                {status.behind > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Behind upstream</span>
                    <span>{status.behind} commit{status.behind === 1 ? "" : "s"}</span>
                  </div>
                )}
                {status.upstream && (
                  <div className="truncate text-muted-foreground" title={status.upstream}>
                    upstream: {status.upstream}
                  </div>
                )}
              </div>

              <div className="grid gap-1">
                <div className="text-xs font-medium text-muted-foreground">Uncommitted files</div>
                {status.files.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-muted-foreground">
                    None
                  </div>
                ) : (
                  <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                    {status.files.map((file) => (
                      <div key={`${file.status}-${file.path}`} className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-b-0">
                        <Badge className="shrink-0 px-1.5 py-0 text-[10px]">{file.status}</Badge>
                        <span className="min-w-0 truncate font-mono text-xs" title={file.path}>
                          {file.path}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Button onClick={() => void push()} disabled={pushing || aheadCount <= 0}>
                <GitBranch className="h-4 w-4" />
                {pushing ? "Pushing..." : "Push"}
              </Button>
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorktreesDialog({ projectId }: { projectId?: string }) {
  const projects = useAppStore((state) => state.projects);
  const setProjects = useAppStore((state) => state.setProjects);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const addError = useAppStore((state) => state.addError);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"worktrees" | "create">("worktrees");
  const [worktrees, setWorktrees] = useState<GitWorktreeList | undefined>();
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | undefined>();
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [pathText, setPathText] = useState("");
  const [createBranch, setCreateBranch] = useState(true);
  const [browserOpen, setBrowserOpen] = useState(false);
  const selectedProject = projects.find((project) => project.id === projectId);

  useEffect(() => {
    if (!open || !projectId) return;
    void refresh();
  }, [open, projectId]);

  async function refresh() {
    if (!projectId) return;
    setLoading(true);
    try {
      setWorktrees(await api.gitWorktrees(projectId));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  function selectProjectForPath(projectList: Project[], worktreePath: string) {
    const normalized = worktreePath.toLowerCase();
    const project = projectList.find((candidate) => candidate.path.toLowerCase() === normalized);
    if (project) setSelectedProject(project.id);
  }

  async function createWorktree() {
    if (!projectId || !branch.trim()) return;
    setLoading(true);
    try {
      const result = await api.createGitWorktree(projectId, {
        branch: branch.trim(),
        base: base.trim() || "HEAD",
        path: pathText.trim() || undefined,
        createBranch
      });
      setProjects(result.projects);
      setWorktrees(result.worktrees);
      const created =
        result.worktrees.worktrees.find((worktree) => pathText.trim() && worktree.path.toLowerCase() === pathText.trim().toLowerCase()) ||
        result.worktrees.worktrees.find((worktree) => worktree.branch === branch.trim());
      if (created) selectProjectForPath(result.projects, created.path);
      setBranch("");
      setPathText("");
      setBase("HEAD");
      setCreateBranch(true);
      setTab("worktrees");
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function mergeWorktree(worktreePath: string, branchName?: string) {
    if (!projectId) return;
    if (!window.confirm(`Merge ${branchName || worktreePath} into ${selectedProject?.name || "the current project"}?`)) return;
    setBusyPath(worktreePath);
    try {
      setWorktrees(await api.mergeGitWorktree(projectId, { sourcePath: worktreePath }));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPath(undefined);
    }
  }

  async function removeWorktree(worktreePath: string, force = false) {
    if (!projectId) return;
    if (!window.confirm(`Remove worktree at ${worktreePath}? This removes the worktree checkout from disk.`)) return;
    setBusyPath(worktreePath);
    try {
      const result = await api.removeGitWorktree(projectId, { path: worktreePath, force });
      setProjects(result.projects);
      setWorktrees(result.worktrees);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPath(undefined);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="icon" disabled={!projectId} onClick={() => setOpen(true)} title="Git worktrees">
        <Columns2 className="h-4 w-4" />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Git Worktrees</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex gap-2">
            <Button variant={tab === "worktrees" ? "default" : "outline"} size="sm" onClick={() => setTab("worktrees")}>
              Worktrees
            </Button>
            <Button variant={tab === "create" ? "default" : "outline"} size="sm" onClick={() => setTab("create")}>
              Create
            </Button>
            <Button variant="ghost" size="icon" className="ml-auto h-8 w-8" disabled={!projectId || loading} onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {!worktrees?.isRepo ? (
            <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              {loading ? "Loading worktrees..." : worktrees?.message || "Current project is not a Git repository."}
            </div>
          ) : tab === "create" ? (
            <div className="grid gap-3">
              <label className="grid gap-1.5 text-sm">
                Branch
                <Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="feature/my-worktree" />
              </label>
              <label className="grid gap-1.5 text-sm">
                Base
                <Input value={base} onChange={(event) => setBase(event.target.value)} placeholder="HEAD" />
              </label>
              <label className="grid gap-1.5 text-sm">
                Worktree path
                <div className="flex gap-2">
                  <Input value={pathText} onChange={(event) => setPathText(event.target.value)} placeholder="Default: sibling folder" />
                  <Button type="button" variant="outline" onClick={() => setBrowserOpen(true)}>
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </Button>
                </div>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={createBranch} onChange={(event) => setCreateBranch(event.target.checked)} />
                Create a new branch
              </label>
              <Button onClick={() => void createWorktree()} disabled={loading || !branch.trim()}>
                <Plus className="h-4 w-4" />
                {loading ? "Creating..." : "Create Worktree"}
              </Button>
            </div>
          ) : (
            <div className="grid max-h-[56vh] gap-2 overflow-auto">
              {worktrees.worktrees.map((worktree) => (
                <div key={worktree.path} className="grid gap-2 rounded-md border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{worktree.branch || "Detached"}</span>
                        {worktree.current && <Badge>Current</Badge>}
                        {worktree.projectId && <Badge>Open</Badge>}
                        {worktree.prunable && <Badge>Prunable</Badge>}
                      </div>
                      <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{worktree.path}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!worktree.projectId || worktree.current}
                      onClick={() => worktree.projectId && setSelectedProject(worktree.projectId)}
                    >
                      Switch
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={worktree.current || !worktree.branch || busyPath === worktree.path}
                      onClick={() => void mergeWorktree(worktree.path, worktree.branch)}
                    >
                      <GitBranch className="h-4 w-4" />
                      Merge
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={worktree.current || busyPath === worktree.path}
                      onClick={() => void removeWorktree(worktree.path)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
      <FolderBrowserDialog
        open={browserOpen}
        initialPath={pathText || selectedProject?.path || ""}
        onOpenChange={setBrowserOpen}
        onSelect={(selectedPath) => {
          setPathText(selectedPath);
          setBrowserOpen(false);
        }}
      />
    </Dialog>
  );
}

function AddProjectDialog({
  open: controlledOpen,
  onOpenChange,
  showTrigger = true
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}) {
  const setProjects = useAppStore((state) => state.setProjects);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const addError = useAppStore((state) => state.addError);
  const [internalOpen, setInternalOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [path, setPath] = useState("");
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

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
      {showTrigger && (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <FolderPlus className="h-4 w-4" />
          Add Project
        </Button>
      )}
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
  const setSettings = useAppStore((state) => state.setSettings);
  const setProjects = useAppStore((state) => state.setProjects);
  const addError = useAppStore((state) => state.addError);
  const [runningSort, setRunningSort] = useState<"lastActivity" | "type">("lastActivity");
  const [agentTab, setAgentTab] = useState<"project" | "builtIn">("builtIn");
  const [builtInEditor, setBuiltInEditor] = useState<{ open: boolean; agent?: AgentDef; originalName?: string }>({ open: false });

  const project = projects.find((candidate) => candidate.id === selectedProjectId);
  const projectAgentDefs = project?.agents || [];
  const builtInAgentDefs = project?.builtInAgents?.length ? project.builtInAgents : [GENERIC_AGENT_DEF];
  const availableAgentDefs = agentTab === "project" ? projectAgentDefs : builtInAgentDefs;
  const running = useMemo(
    () => {
      const agents = agentsForProject(agentsById, selectedProjectId);
      if (runningSort === "type") {
        return agents.sort(
          (left, right) =>
            left.defName.localeCompare(right.defName, undefined, { sensitivity: "base" }) ||
            left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" })
        );
      }
      return agents.sort(
        (left, right) =>
          timestampValue(right.updatedAt || right.launchedAt) - timestampValue(left.updatedAt || left.launchedAt) ||
          left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" })
      );
    },
    [agentsById, runningSort, selectedProjectId]
  );
  const activeAgentId = selectedAgentId || focusedAgentId;
  const sidebarWidth = settings.sidebarWidth || 280;

  useEffect(() => {
    if (!project) {
      setAgentTab("builtIn");
      return;
    }
    setAgentTab(project.agents.length > 0 ? "project" : "builtIn");
  }, [project?.id]);

  function focusRunningAgent(id: string) {
    setSelectedAgent(undefined);
    setFocusedAgent(id);
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let nextWidth = sidebarWidth;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      nextWidth = Math.min(420, Math.max(240, startWidth + moveEvent.clientX - startX));
      setSettings({ ...settings, sidebarWidth: Math.round(nextWidth) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const width = Math.round(nextWidth);
      void api
        .saveSettings({ ...settings, sidebarWidth: width })
        .then(setSettings)
        .catch((error: unknown) => addError(error instanceof Error ? error.message : String(error)));
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function launchAllDefinitions() {
    if (!project || availableAgentDefs.length === 0) return;
    availableAgentDefs.forEach((agent) => {
      sendCommand({
        type: "launch",
        request: {
          projectId: project.id,
          defName: agent.name,
          provider: agent.provider,
          model: agent.defaultModel || settings.models[0] || DEFAULT_MODEL,
          permissionMode: settings.defaultAgentMode,
          autoApprove: settings.autoApprove
        }
      });
    });
    setSelectedAgent(undefined);
  }

  async function deleteBuiltIn(agent: AgentDef) {
    if (!project || !agent.sourcePath) return;
    if (!window.confirm(`Remove built-in agent ${agent.name}?`)) return;
    try {
      setProjects(await api.deleteBuiltInAgent(project.id, agent.name));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  if (collapsed) {
    return (
      <aside className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-x-hidden border-r border-border bg-card/45 py-3">
        <Button variant="ghost" size="icon" onClick={() => setCollapsed(false)} title="Expand sidebar">
          <PanelLeftOpen className="h-4 w-4" />
        </Button>
        <div className="h-px w-8 bg-border" />
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden px-1">
          {running.map((agent) => (
            <div key={agent.id} className="relative h-9 w-9">
              <button
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-md hover:bg-accent",
                  activeAgentId === agent.id && "bg-accent"
                )}
                onClick={() => focusRunningAgent(agent.id)}
                title={`${agent.displayName}\n${fullLastActivity(agent.updatedAt || agent.launchedAt)}`}
              >
                <AgentDot color={agent.color} className={cn(isAgentBusy(agent) && "animate-pulse")} />
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-0 top-0 h-4 w-4 rounded-full bg-background/90 p-0 text-muted-foreground shadow-sm hover:text-foreground"
                title={`Close Chat ${agent.displayName}`}
                onClick={() => sendCommand({ type: "kill", id: agent.id })}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col overflow-x-hidden border-r border-border bg-card/45"
      style={{ width: sidebarWidth }}
    >
      <section className="flex min-h-0 flex-1 flex-col p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setCollapsed(true)} title="Collapse sidebar">
              <PanelLeftClose className="h-4 w-4" />
            </Button>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Running</h2>
            <Button
              size="icon"
              className="h-6 w-6"
              disabled={!selectedProjectId}
              onClick={() => selectedProjectId && openLaunchModal({ projectId: selectedProjectId })}
              title="Launch agent"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6" title="Sort running agents">
                  <ArrowDownAZ className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={() => setRunningSort("lastActivity")}>
                  Sort by last activity
                  <Check className={cn("ml-auto h-4 w-4", runningSort === "lastActivity" ? "opacity-100" : "opacity-0")} />
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRunningSort("type")}>
                  Sort by type
                  <Check className={cn("ml-auto h-4 w-4", runningSort === "type" ? "opacity-100" : "opacity-0")} />
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {running.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (window.confirm("Close all open agents in this project?")) {
                  sendCommand({ type: "clearAll", projectId: selectedProjectId });
                }
              }}
            >
              Close All
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overflow-x-hidden pr-1">
          {running.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
              No agents running.
            </p>
          ) : (
            running.map((agent) => (
              <div
                key={agent.id}
                className={cn(
                  "flex w-full items-center gap-1 rounded-md px-1 py-1 hover:bg-accent",
                  activeAgentId === agent.id && "bg-accent"
                )}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1 text-left"
                  onClick={() => focusRunningAgent(agent.id)}
                >
                  <AgentDot color={agent.color} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 truncate text-sm">
                      {agent.displayName}
                      {agent.remoteControl && <Badge className="px-1 py-0 text-[10px]">RC</Badge>}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <ModelText agent={agent} />
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <StatusPill status={agent.status} />
                    <LastActivityText agent={agent} compact timeOnly />
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                  title={`Close Chat ${agent.displayName}`}
                  onClick={() => sendCommand({ type: "kill", id: agent.id })}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>
      </section>
      <section className="mt-auto shrink-0 border-t border-border p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Available Agents</h2>
          <Button
            variant="ghost"
            size="sm"
            disabled={!project || availableAgentDefs.length === 0}
            onClick={launchAllDefinitions}
            title="Launch all definitions with defaults"
          >
            <Plus className="h-4 w-4" />
            Launch All
          </Button>
        </div>
        <div className="mb-2 grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
          <button
            className={cn("rounded px-2 py-1 text-xs font-medium", agentTab === "project" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
            onClick={() => setAgentTab("project")}
          >
            Project
          </button>
          <button
            className={cn("rounded px-2 py-1 text-xs font-medium", agentTab === "builtIn" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground")}
            onClick={() => setAgentTab("builtIn")}
          >
            Built-In
          </button>
        </div>
        {agentTab === "builtIn" && (
          <Button
            variant="outline"
            size="sm"
            className="mb-2 w-full"
            disabled={!project}
            onClick={() => setBuiltInEditor({ open: true })}
          >
            <Plus className="h-4 w-4" />
            Add Built-In Agent
          </Button>
        )}
        <div className="max-h-[38vh] space-y-1 overflow-y-auto overflow-x-hidden pr-1">
          {!project ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
              Add a project to get started.
            </p>
          ) : agentTab === "project" && projectAgentDefs.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
              Add agents to your project to show them here.
            </p>
          ) : availableAgentDefs.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
              Add a built-in agent to show it here.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {availableAgentDefs.map((agent) => (
                <button
                  key={agent.name}
                  className="group relative grid min-h-20 content-start gap-1 rounded-md border border-border bg-background/40 px-2 py-2 text-left hover:bg-accent"
                  onClick={() => openLaunchModal({ projectId: project.id, defName: agent.name })}
                >
                  {agentTab === "builtIn" && (
                    <span className="absolute right-1 top-1 hidden gap-1 group-hover:flex">
                      <span
                        role="button"
                        tabIndex={0}
                        className="grid h-5 w-5 place-items-center rounded bg-background/90 text-muted-foreground hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          setBuiltInEditor({ open: true, agent, originalName: agent.name });
                        }}
                        title="Edit built-in agent"
                      >
                        <Settings className="h-3 w-3" />
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        className={cn(
                          "grid h-5 w-5 place-items-center rounded bg-background/90 text-muted-foreground hover:text-foreground",
                          !agent.sourcePath && "cursor-not-allowed opacity-40"
                        )}
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteBuiltIn(agent);
                        }}
                        title={agent.sourcePath ? "Remove built-in agent" : "Default built-in agent cannot be removed"}
                      >
                        <X className="h-3 w-3" />
                      </span>
                    </span>
                  )}
                  <span className="flex min-w-0 items-center gap-1.5">
                    <AgentDot color={agent.color} />
                    <span className="truncate text-xs font-medium">{agent.name}</span>
                  </span>
                  {agent.defaultModel && (
                    <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">{agent.defaultModel}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      <div
        className="absolute bottom-0 right-0 top-0 z-20 w-2 cursor-ew-resize hover:bg-primary/20"
        onPointerDown={startSidebarResize}
        title="Drag to resize sidebar"
      />
      {project && (
        <BuiltInAgentDialog
          project={project}
          state={builtInEditor}
          onOpenChange={(open) => setBuiltInEditor((current) => ({ ...current, open }))}
          onSaved={(nextProjects) => {
            setProjects(nextProjects);
            setBuiltInEditor({ open: false });
            setAgentTab("builtIn");
          }}
        />
      )}
    </aside>
  );
}

function BuiltInAgentDialog({
  project,
  state,
  onOpenChange,
  onSaved
}: {
  project: Project;
  state: { open: boolean; agent?: AgentDef; originalName?: string };
  onOpenChange: (open: boolean) => void;
  onSaved: (projects: Project[]) => void;
}) {
  const settings = useAppStore((store) => store.settings);
  const addError = useAppStore((store) => store.addError);
  const modelProfiles = useMemo(() => modelProfilesForSettings(settings), [settings]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#ffffff");
  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [defaultModel, setDefaultModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!state.open) return;
    const agent = state.agent;
    const nextProvider = agent?.provider || "claude";
    setName(agent?.name || "");
    setDescription(agent?.description || "");
    setColor(agent?.color || "#ffffff");
    setProvider(nextProvider);
    setDefaultModel(agent?.defaultModel || modelProfiles.find((profile) => profile.provider === nextProvider && profile.default)?.id || "");
    setSystemPrompt(agent?.systemPrompt || "");
  }, [modelProfiles, state.agent, state.open]);

  async function save() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setSaving(true);
    try {
      const projects = await api.saveBuiltInAgent(project.id, {
        originalName: state.originalName,
        name: trimmedName,
        description: description.trim() || undefined,
        color: color.trim() || "#ffffff",
        provider,
        defaultModel: defaultModel.trim() || undefined,
        tools: [],
        plugins: [],
        systemPrompt
      });
      onSaved(projects);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  const providerModels = modelProfiles.filter((profile) => profile.provider === provider);

  return (
    <Dialog open={state.open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,680px)]">
        <DialogHeader>
          <DialogTitle>{state.agent ? "Edit Built-In Agent" : "Add Built-In Agent"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
            <label className="grid gap-1.5 text-sm">
              Name
              <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-sm">
              Color
              <Input value={color} onChange={(event) => setColor(event.target.value)} placeholder="#ffffff" />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm">
            Description
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm">
              Provider
              <Select
                value={provider}
                onValueChange={(value) => {
                  const nextProvider = value as AgentProvider;
                  setProvider(nextProvider);
                  setDefaultModel(modelProfiles.find((profile) => profile.provider === nextProvider && profile.default)?.id || "");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude">Claude Code</SelectItem>
                  <SelectItem value="codex">Codex CLI</SelectItem>
                  <SelectItem value="openai">OpenAI API</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm">
              Default model
              <Select value={defaultModel || "__none__"} onValueChange={(value) => setDefaultModel(value === "__none__" ? "" : value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Use app default</SelectItem>
                  {providerModels.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.label || profile.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <label className="grid gap-1.5 text-sm">
            Agent prompt
            <Textarea className="min-h-48" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} />
          </label>
          <Button onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving ? "Saving..." : "Save Built-In Agent"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
  const models = modelProfilesForSettings(settings).filter((profile) => profile.provider === (agent.provider || "claude"));

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
          {models.map((model) => (
            <Button key={model.id} variant="ghost" className="justify-start" onClick={() => sendCommand({ type: "setModel", id: agent.id, model: model.id })}>
              {model.label || model.id}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const COMPOSER_MODE_OPTIONS = [
  {
    mode: "default",
    label: "Ask before edits",
    compactLabel: "Ask",
    description: "Claude will ask for approval before making each edit.",
    icon: Hand
  },
  {
    mode: "acceptEdits",
    label: "Edit automatically",
    compactLabel: "Edit",
    description: "Claude will edit your selected text or the whole file.",
    icon: Code2
  },
  {
    mode: "plan",
    label: "Plan mode",
    compactLabel: "Plan",
    description: "Claude will explore the code and present a plan before editing.",
    icon: ClipboardList
  },
  {
    mode: "bypassPermissions",
    label: "Bypass permissions",
    compactLabel: "Bypass",
    description: "Claude will not ask for approval before running potentially dangerous commands.",
    icon: Waypoints
  }
] satisfies {
  mode: AgentPermissionMode;
  label: string;
  compactLabel: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}[];

const EFFORT_OPTIONS = [
  { effort: "low", label: "Low" },
  { effort: "medium", label: "Medium" },
  { effort: "high", label: "High" },
  { effort: "xhigh", label: "XHigh" },
  { effort: "max", label: "Max" }
] satisfies { effort: AgentEffort; label: string }[];

function currentPermissionMode(agent: RunningAgent): AgentPermissionMode {
  return agent.permissionMode || (agent.planMode ? "plan" : "default");
}

function nextPermissionMode(agent: RunningAgent): AgentPermissionMode {
  const activeMode = currentPermissionMode(agent);
  const activeIndex = COMPOSER_MODE_OPTIONS.findIndex((option) => option.mode === activeMode);
  return COMPOSER_MODE_OPTIONS[(activeIndex + 1) % COMPOSER_MODE_OPTIONS.length].mode;
}

function currentEffort(agent: RunningAgent): AgentEffort {
  return agent.effort || "medium";
}

function currentThinking(agent: RunningAgent): boolean {
  return agent.thinking !== false;
}

function ComposerModeMenu({
  agent,
  compact = false,
  inline = false
}: {
  agent: RunningAgent;
  compact?: boolean;
  inline?: boolean;
}) {
  const activeMode = currentPermissionMode(agent);
  const activeEffort = currentEffort(agent);
  const activeThinking = currentThinking(agent);
  const activeEffortLabel = EFFORT_OPTIONS.find((option) => option.effort === activeEffort)?.label || "Medium";
  const activeOption = COMPOSER_MODE_OPTIONS.find((option) => option.mode === activeMode) || COMPOSER_MODE_OPTIONS[0];
  const ActiveIcon = activeOption.icon;

  function setPermissionMode(permissionMode: AgentPermissionMode) {
    if (activeMode === permissionMode) return;
    sendCommand({ type: "setPermissionMode", id: agent.id, permissionMode });
  }

  function setEffort(effort: AgentEffort) {
    if (activeEffort === effort) return;
    sendCommand({ type: "setEffort", id: agent.id, effort });
  }

  function setThinking(thinking: boolean) {
    if (activeThinking === thinking) return;
    sendCommand({ type: "setThinking", id: agent.id, thinking });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={inline ? "ghost" : "outline"}
          size="sm"
          className={cn(
            "h-7 justify-between gap-1 px-2",
            compact ? "w-24 text-[11px]" : "w-full",
            inline && "h-8 w-auto rounded-md border-0 bg-transparent px-2 text-xs"
          )}
          title={activeOption.label}
          disabled={agent.remoteControl}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <ActiveIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{compact ? activeOption.compactLabel : activeOption.label}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-2">
        <div className="flex items-center justify-between px-2 pb-1 pt-1 text-xs text-muted-foreground">
          <span>Modes</span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border border-border px-1 font-mono text-[10px]">Shift</kbd>
            <span>+</span>
            <kbd className="rounded border border-border px-1 font-mono text-[10px]">Tab</kbd>
            <span>to switch</span>
          </span>
        </div>
        <div className="grid gap-1">
          {COMPOSER_MODE_OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = option.mode === activeMode;
            return (
              <DropdownMenuItem
                key={option.mode}
                onClick={() => setPermissionMode(option.mode)}
                className={cn(
                  "items-start gap-3 rounded-md px-2 py-2.5",
                  selected && "bg-primary/20 text-foreground focus:bg-primary/25"
                )}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-none">{option.label}</span>
                  <span className="mt-1 block text-xs leading-snug text-muted-foreground">{option.description}</span>
                </span>
                <Check className={cn("mt-1 h-4 w-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
              </DropdownMenuItem>
            );
          })}
        </div>
        <button
          type="button"
          className={cn(
            "mt-2 flex w-full items-start gap-3 rounded-md border-t border-border px-2 py-2.5 text-left",
            activeThinking && "bg-primary/20 text-foreground"
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setThinking(!activeThinking);
          }}
        >
          <Brain className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium leading-none">Thinking</span>
            <span className="mt-1 block text-xs leading-snug text-muted-foreground">
              {activeThinking ? "Claude can use extended thinking for new messages." : "Claude will skip extended thinking for new messages where supported."}
            </span>
          </span>
          <span
            className={cn(
              "mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border bg-muted p-0.5 transition-colors",
              activeThinking && "border-primary/50 bg-primary/30"
            )}
            aria-hidden="true"
          >
            <span
              className={cn(
                "h-3.5 w-3.5 rounded-full bg-muted-foreground transition-transform",
                activeThinking && "translate-x-4 bg-foreground"
              )}
            />
          </span>
        </button>
        <div className="mt-2 flex items-center gap-3 border-t border-border px-2 pt-2 text-xs text-muted-foreground">
          <Brain className="h-4 w-4" />
          <span className="flex-1">
            Effort <span className="text-foreground">({activeEffortLabel})</span>
          </span>
          <span className="inline-flex h-5 items-center gap-2 rounded-full bg-muted px-2">
            {EFFORT_OPTIONS.map((option) => (
              <button
                key={option.effort}
                type="button"
                className="grid h-4 w-4 place-items-center rounded-full"
                title={`Effort: ${option.label}`}
                aria-label={`Set effort to ${option.label}`}
                aria-pressed={activeEffort === option.effort}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setEffort(option.effort);
                }}
              >
                <span
                  className={cn(
                    "rounded-full bg-muted-foreground/45 transition-all",
                    activeEffort === option.effort ? "h-3.5 w-3.5 bg-foreground/80" : "h-1 w-1"
                  )}
                />
              </button>
            ))}
          </span>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LaunchDialog() {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const modal = useAppStore((state) => state.launchModal);
  const settings = useAppStore((state) => state.settings);
  const capabilities = useAppStore((state) => state.capabilities);
  const agents = useAppStore((state) => state.agents);
  const setProjects = useAppStore((state) => state.setProjects);
  const addError = useAppStore((state) => state.addError);
  const closeLaunchModal = useAppStore((state) => state.closeLaunchModal);
  const [defName, setDefName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [remoteControl, setRemoteControl] = useState(false);
  const [pluginIds, setPluginIds] = useState<string[]>([]);
  const [pluginCatalog, setPluginCatalog] = useState<ClaudePluginCatalog>({ installed: [], available: [], marketplaces: [] });
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginQuery, setPluginQuery] = useState("");
  const [pluginScope, setPluginScope] = useState("user");
  const [installingPlugin, setInstallingPlugin] = useState<string | undefined>();
  const [enablingPlugin, setEnablingPlugin] = useState<string | undefined>();
  const [pluginPickerExpanded, setPluginPickerExpanded] = useState(false);
  const [agentFileOpen, setAgentFileOpen] = useState(false);

  const projectId = selectedProjectId || "";
  const project = projects.find((candidate) => candidate.id === projectId);
  const agentOptions = useMemo(() => agentDefsWithGeneric(project), [project]);
  const def = agentOptions.find((candidate) => candidate.name === defName);
  const modelProfiles = useMemo(() => modelProfilesForSettings(settings), [settings]);
  const modelOptions = useMemo(
    () => {
      const options = modelProfiles.filter((item) => item.provider === provider);
      if (def?.defaultModel && !options.some((item) => item.id === def.defaultModel)) {
        return [{ id: def.defaultModel, provider }, ...options];
      }
      return options.length ? options : [{ id: def?.defaultModel || settings.models[0] || DEFAULT_MODEL, provider }];
    },
    [def?.defaultModel, modelProfiles, provider, settings.models]
  );
  const restorableSessions = useMemo(
    () =>
      Object.values(agents)
        .filter((agent) => agent.projectId === projectId && agent.defName === defName && agent.restorable)
        .sort((left, right) => +new Date(right.updatedAt) - +new Date(left.updatedAt)),
    [agents, defName, projectId]
  );

  useEffect(() => {
    if (!modal.open) return;
    const nextProject = projects.find((candidate) => candidate.id === projectId);
    const nextAgentOptions = agentDefsWithGeneric(nextProject);
    const nextDefName = modal.defName || nextAgentOptions[0]?.name || "";
    const nextDef = nextAgentOptions.find((candidate) => candidate.name === nextDefName);
    const nextProvider = nextDef?.provider || "claude";
    setDefName(nextDefName);
    setDisplayName("");
    setProvider(nextProvider);
    setModel(nextDef?.defaultModel || modelProfiles.find((item) => item.provider === nextProvider && item.default)?.id || modelProfiles.find((item) => item.provider === nextProvider)?.id || settings.models[0] || DEFAULT_MODEL);
    setInitialPrompt(modal.initialPrompt || "");
    setRemoteControl(false);
    setPluginIds(nextDef?.plugins || []);
    setPluginQuery("");
    setPluginCatalog({ installed: [], available: [], marketplaces: [] });
    setPluginPickerExpanded(false);
    setAgentFileOpen(false);
  }, [modal, modelProfiles, projectId, projects, settings.models]);

  useEffect(() => {
    if (!def) return;
    const nextProvider = def.provider || provider;
    setProvider(nextProvider);
    setModel(def.defaultModel || modelProfiles.find((item) => item.provider === nextProvider && item.default)?.id || modelProfiles.find((item) => item.provider === nextProvider)?.id || settings.models[0] || DEFAULT_MODEL);
    setPluginIds(def.plugins || []);
  }, [def, modelProfiles, settings.models]);

  function selectDef(nextDefName: string) {
    const nextDef = agentOptions.find((candidate) => candidate.name === nextDefName);
    const nextProvider = nextDef?.provider || provider;
    setDefName(nextDefName);
    setProvider(nextProvider);
    setModel(nextDef?.defaultModel || modelProfiles.find((item) => item.provider === nextProvider && item.default)?.id || modelProfiles.find((item) => item.provider === nextProvider)?.id || settings.models[0] || DEFAULT_MODEL);
    setPluginIds(nextDef?.plugins || []);
    setPluginQuery("");
    setPluginPickerExpanded(false);
    setAgentFileOpen(false);
  }

  async function loadPluginCatalog() {
    setPluginsLoading(true);
    try {
      setPluginCatalog(await api.pluginCatalog());
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setPluginsLoading(false);
    }
  }

  function togglePlugin(pluginId: string) {
    setPluginIds((current) =>
      current.includes(pluginId) ? current.filter((item) => item !== pluginId) : [...current, pluginId].sort(compareSlashCommands)
    );
  }

  async function installLaunchPlugin(pluginId: string) {
    const id = pluginId.trim();
    if (!id) return;
    setInstallingPlugin(id);
    try {
      setPluginCatalog(await api.installPlugin(id, pluginScope));
      setPluginIds((current) => (current.includes(id) ? current : [...current, id].sort(compareSlashCommands)));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingPlugin(undefined);
    }
  }

  async function enableLaunchPlugin(pluginId: string) {
    setEnablingPlugin(pluginId);
    try {
      await api.enablePlugin(pluginId);
      setPluginCatalog(await api.pluginCatalog());
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setEnablingPlugin(undefined);
    }
  }

  async function expandPluginPicker() {
    setPluginPickerExpanded(true);
    if (pluginCatalog.installed.length === 0 && pluginCatalog.available.length === 0) {
      await loadPluginCatalog();
    }
  }

  async function launch() {
    if (!projectId || !defName) return;
    if (def?.sourcePath && !arraysEqual(pluginIds, def.plugins || [])) {
      const saved = await saveAgentPlugins();
      if (!saved) return;
    }
    sendCommand({
      type: "launch",
      request: {
        projectId,
        defName,
        displayName,
        provider,
        model,
        initialPrompt: remoteControl ? undefined : initialPrompt,
        remoteControl,
        permissionMode: settings.defaultAgentMode,
        autoApprove: settings.autoApprove
      }
    });
    closeLaunchModal();
  }

  async function saveAgentPlugins(): Promise<boolean> {
    if (!projectId || !defName) return false;
    if (!def?.sourcePath) {
      addError("Generic agents do not have an agent file to save plugins to.");
      return false;
    }
    try {
      setProjects(await api.saveAgentPlugins(projectId, defName, pluginIds));
      return true;
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function openAgentFile(filePath?: string) {
    if (!filePath) return;
    try {
      await api.openFile(filePath);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  const rcDisabled = provider !== "claude" || !capabilities?.supportsRemoteControl;
  const installedPlugins = useMemo(() => new Map(pluginCatalog.installed.map((plugin) => [plugin.name, plugin])), [pluginCatalog.installed]);
  const selectedPluginRows = useMemo(
    () =>
      pluginIds.map((pluginId) => ({
        id: pluginId,
        name: installedPlugins.get(pluginId)?.name || pluginId,
        description: undefined as string | undefined,
        marketplaceName: undefined as string | undefined,
        selectedOnly: true
      })),
    [installedPlugins, pluginIds]
  );
  const pluginRows = useMemo(() => {
    const rowsById = new Map<
      string,
      { id: string; name: string; description?: string; marketplaceName?: string; selectedOnly?: boolean }
    >();
    for (const row of selectedPluginRows) rowsById.set(row.id, row);
    if (pluginPickerExpanded) {
      for (const plugin of pluginCatalog.installed) {
        rowsById.set(plugin.name, { id: plugin.name, name: plugin.name });
      }
      for (const plugin of pluginCatalog.available) {
        rowsById.set(plugin.pluginId, {
          id: plugin.pluginId,
          name: plugin.name,
          description: plugin.description,
          marketplaceName: plugin.marketplaceName
        });
      }
    }
    const query = pluginQuery.trim().toLowerCase();
    return [...rowsById.values()]
      .filter((plugin) => {
        if (!query) return true;
        return (
          plugin.id.toLowerCase().includes(query) ||
          plugin.name.toLowerCase().includes(query) ||
          plugin.marketplaceName?.toLowerCase().includes(query) ||
          plugin.description?.toLowerCase().includes(query)
        );
      })
      .sort((left, right) => compareSlashCommands(left.name, right.name))
      .slice(0, 120);
  }, [pluginCatalog.available, pluginCatalog.installed, pluginPickerExpanded, pluginQuery, selectedPluginRows]);
  const pluginsChanged = !arraysEqual(pluginIds, def?.plugins || []);

  return (
    <>
      <Dialog open={modal.open} onOpenChange={(open) => !open && closeLaunchModal()}>
        <DialogContent className="w-[min(94vw,760px)]">
          <DialogHeader>
            <DialogTitle>Launch Agent</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm">
            <span className="flex items-baseline justify-between gap-2">
              <span>Agent type</span>
              <button
                type="button"
                className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                disabled={!def?.sourceContent && !def?.systemPrompt}
                onClick={() => setAgentFileOpen(true)}
              >
                View agent file
              </button>
            </span>
            <Select value={defName} onValueChange={selectDef}>
              <SelectTrigger>
                <SelectValue placeholder="Agent type" />
              </SelectTrigger>
              <SelectContent>
                {agentOptions.map((agent) => (
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
            Provider
            <Select
              value={provider}
              onValueChange={(value) => {
                const nextProvider = value as AgentProvider;
                setProvider(nextProvider);
                setRemoteControl(false);
                setModel(
                  modelProfiles.find((item) => item.provider === nextProvider && item.default)?.id ||
                    modelProfiles.find((item) => item.provider === nextProvider)?.id ||
                    model
                );
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Code</SelectItem>
                <SelectItem value="codex">Codex CLI</SelectItem>
                <SelectItem value="openai">OpenAI API</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {restorableSessions.length > 0 && (
            <section className="grid gap-2 rounded-md border border-border p-3">
              <div>
                <h3 className="text-sm font-medium">Restorable sessions</h3>
                <p className="text-xs text-muted-foreground">Resume a paused session for this agent type.</p>
              </div>
              <div className="grid gap-2">
                {restorableSessions.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      sendCommand({ type: "resume", id: agent.id });
                      closeLaunchModal();
                    }}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{agent.displayName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {agent.currentModel} · {formatLastActivity(agent.updatedAt)}
                      </span>
                    </span>
                    <Badge>Resume</Badge>
                  </button>
                ))}
              </div>
            </section>
          )}
          <label className="grid gap-1.5 text-sm">
            Model
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label || item.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {provider !== "claude" && (
            <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
              {provider === "codex"
                ? "Codex sessions run through the configured Codex CLI. Claude plugins and Remote Control are disabled."
                : "OpenAI API sessions stream through the Responses API using OPENAI_API_KEY. Local shell tools are not bridged by default."}
            </div>
          )}
          {provider === "claude" && <section className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Agent plugins</h3>
                <p className="text-xs text-muted-foreground">Selections are saved to this agent definition.</p>
              </div>
              <div className="flex items-center gap-2">
                {pluginPickerExpanded ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => void loadPluginCatalog()} disabled={pluginsLoading}>
                    <RefreshCw className="h-4 w-4" />
                    Refresh
                  </Button>
                ) : (
                  <Button type="button" variant="outline" size="sm" onClick={() => void expandPluginPicker()} disabled={pluginsLoading}>
                    <Plus className="h-4 w-4" />
                    Add Plugins
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void saveAgentPlugins()}
                  disabled={!projectId || !defName || !def?.sourcePath || !pluginsChanged}
                >
                  Save
                </Button>
              </div>
            </div>
            {pluginPickerExpanded && (
              <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
                <Input value={pluginQuery} onChange={(event) => setPluginQuery(event.target.value)} placeholder="Search plugins" />
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
            )}
            <div className="grid max-h-56 gap-2 overflow-auto pr-1">
              {pluginsLoading ? (
                <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                  Loading plugins...
                </p>
              ) : pluginRows.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                  {pluginPickerExpanded ? "No plugins match." : "No plugins selected."}
                </p>
              ) : (
                pluginRows.map((plugin) => {
                  const installed = installedPlugins.get(plugin.id);
                  const selected = pluginIds.includes(plugin.id);
                  const enabled = Boolean(installed?.enabled);
                  const canSelect = Boolean(installed) || selected;
                  return (
                    <div key={plugin.id} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={selected}
                        disabled={!canSelect}
                        onChange={() => togglePlugin(plugin.id)}
                        aria-label={`Select ${plugin.name}`}
                      />
                      <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{plugin.name}</span>
                          {plugin.marketplaceName && <Badge>{plugin.marketplaceName}</Badge>}
                          {installed ? (
                            <Badge className={enabled ? "border-teal-400/40 text-teal-200" : "border-zinc-500/40 text-zinc-300"}>
                              {enabled ? "Enabled" : "Installed"}
                            </Badge>
                          ) : plugin.selectedOnly && !pluginPickerExpanded ? (
                            <Badge className="border-primary/40 text-primary">Selected</Badge>
                          ) : plugin.selectedOnly ? (
                            <Badge className="border-amber-400/40 text-amber-200">Missing</Badge>
                          ) : (
                            <Badge>Available</Badge>
                          )}
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{plugin.id}</p>
                        {plugin.description && (
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{plugin.description}</p>
                        )}
                      </div>
                      {installed ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={enabled || enablingPlugin === plugin.id}
                          onClick={() => void enableLaunchPlugin(plugin.id)}
                        >
                          {enabled ? "Enabled" : enablingPlugin === plugin.id ? "Enabling" : "Enable"}
                        </Button>
                      ) : plugin.selectedOnly && !pluginPickerExpanded ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => void expandPluginPicker()} disabled={pluginsLoading}>
                          Add Plugins
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={Boolean(installingPlugin)}
                          onClick={() => void installLaunchPlugin(plugin.id)}
                        >
                          {installingPlugin === plugin.id ? "Installing" : "Install"}
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            {!def?.sourcePath && (
              <p className="text-xs text-muted-foreground">Generic agents need an agent file before plugin selections can be saved.</p>
            )}
          </section>}
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
      <Dialog open={agentFileOpen} onOpenChange={setAgentFileOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{def?.name || "Generic"} agent</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            {def?.sourcePath ? (
              <button
                type="button"
                className="inline-flex min-w-0 items-center gap-1 text-xs text-primary hover:underline"
                title={def.sourcePath}
                onClick={() => void openAgentFile(def.sourcePath)}
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{def.sourcePath}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </button>
            ) : (
              <div className="text-xs text-muted-foreground">Generic agent definition</div>
            )}
            <p className="text-xs text-muted-foreground">To change this, edit the agents file.</p>
            <Textarea
              readOnly
              value={def?.sourceContent || def?.systemPrompt || ""}
              className="max-h-[60vh] min-h-80 resize-y overflow-y-auto font-mono text-xs leading-5"
              placeholder="No agent file content"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SettingsDialog() {
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const setProjects = useAppStore((state) => state.setProjects);
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const addError = useAppStore((state) => state.addError);
  const currentTileHeight = useAppStore((state) => state.currentTileHeight);
  const [open, setOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [projectPathsText, setProjectPathsText] = useState((settings.projectPaths || []).join("\n"));
  const [modelsText, setModelsText] = useState(settings.models.join("\n"));
  const [modelProfilesText, setModelProfilesText] = useState((settings.modelProfiles || []).map((profile) => `${profile.provider}:${profile.id}`).join("\n"));
  const [gitPath, setGitPath] = useState(settings.gitPath || "");
  const [claudePath, setClaudePath] = useState(settings.claudePath || "");
  const [codexPath, setCodexPath] = useState(settings.codexPath || "");
  const [claudeAgentDir, setClaudeAgentDir] = useState(settings.claudeAgentDir || ".claude/agents");
  const [codexAgentDir, setCodexAgentDir] = useState(settings.codexAgentDir || ".codex/agents");
  const [openaiAgentDir, setOpenaiAgentDir] = useState(settings.openaiAgentDir || ".agent-control/openai-agents");
  const [builtInAgentDir, setBuiltInAgentDir] = useState(settings.builtInAgentDir || ".agent-control/built-in-agents");
  const [agentDirBrowser, setAgentDirBrowser] = useState<undefined | "claude" | "codex" | "openai" | "builtIn">();
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [clearAnthropicApiKey, setClearAnthropicApiKey] = useState(false);
  const [clearOpenaiApiKey, setClearOpenaiApiKey] = useState(false);
  const [autoApprove, setAutoApprove] = useState(settings.autoApprove);
  const [defaultAgentMode, setDefaultAgentMode] = useState<AgentPermissionMode>(settings.defaultAgentMode);
  const [themeMode, setThemeMode] = useState<ThemeMode>(settings.themeMode);
  const [tileHeight, setTileHeight] = useState(settings.tileHeight);
  const [tileColumns, setTileColumns] = useState(settings.tileColumns);
  const [pinLastSentMessage, setPinLastSentMessage] = useState(settings.pinLastSentMessage);

  useEffect(() => {
    if (!open) return;
    setProjectPathsText((settings.projectPaths || []).join("\n"));
    setModelsText(settings.models.join("\n"));
    setModelProfilesText((settings.modelProfiles || []).map((profile) => `${profile.provider}:${profile.id}`).join("\n"));
    setGitPath(settings.gitPath || "");
    setClaudePath(settings.claudePath || "");
    setCodexPath(settings.codexPath || "");
    setClaudeAgentDir(settings.claudeAgentDir || ".claude/agents");
    setCodexAgentDir(settings.codexAgentDir || ".codex/agents");
    setOpenaiAgentDir(settings.openaiAgentDir || ".agent-control/openai-agents");
    setBuiltInAgentDir(settings.builtInAgentDir || ".agent-control/built-in-agents");
    setAnthropicApiKey("");
    setOpenaiApiKey("");
    setClearAnthropicApiKey(false);
    setClearOpenaiApiKey(false);
    setAutoApprove(settings.autoApprove);
    setDefaultAgentMode(settings.defaultAgentMode);
    setThemeMode(settings.themeMode);
    setTileHeight(settings.tileHeight);
    setTileColumns(settings.tileColumns);
    setPinLastSentMessage(settings.pinLastSentMessage);
  }, [open, settings]);

  async function save() {
    try {
      const next = await api.saveSettings({
        ...settings,
        projectPaths: projectPathsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        models: modelsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        modelProfiles: parseModelProfiles(modelProfilesText),
        gitPath,
        claudePath,
        codexPath,
        claudeAgentDir,
        codexAgentDir,
        openaiAgentDir,
        builtInAgentDir,
        anthropicApiKey: anthropicApiKey.trim() || undefined,
        openaiApiKey: openaiApiKey.trim() || undefined,
        clearAnthropicApiKey,
        clearOpenaiApiKey,
        autoApprove,
        defaultAgentMode,
        themeMode,
        tileHeight,
        tileColumns,
        pinLastSentMessage
      });
      setSettings(next);
      setProjects(await api.refresh());
      setOpen(false);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function exportConfig() {
    const payload = {
      app: "AgentControl",
      exportedAt: new Date().toISOString(),
      settings: {
        ...settings,
        projectPaths: projectPathsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        models: modelsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
        modelProfiles: parseModelProfiles(modelProfilesText),
        gitPath,
        claudePath,
        codexPath,
        claudeAgentDir,
        codexAgentDir,
        openaiAgentDir,
        builtInAgentDir,
        autoApprove,
        defaultAgentMode,
        themeMode,
        tileHeight,
        tileColumns,
        pinLastSentMessage
      }
    };
    downloadText("agent-control-config.json", JSON.stringify(payload, null, 2), "application/json");
  }

  async function importConfig(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as { settings?: unknown } | unknown;
      const imported = parsed && typeof parsed === "object" && "settings" in parsed ? (parsed as { settings: unknown }).settings : parsed;
      if (!imported || typeof imported !== "object") throw new Error("Config JSON must contain a settings object.");
      const next = await api.saveSettings(imported as typeof settings);
      setSettings(next);
      setProjects(await api.refresh());
      setProjectPathsText((next.projectPaths || []).join("\n"));
      setModelsText(next.models.join("\n"));
      setModelProfilesText((next.modelProfiles || []).map((profile) => `${profile.provider}:${profile.id}`).join("\n"));
      setGitPath(next.gitPath || "");
      setClaudePath(next.claudePath || "");
      setCodexPath(next.codexPath || "");
      setClaudeAgentDir(next.claudeAgentDir || ".claude/agents");
      setCodexAgentDir(next.codexAgentDir || ".codex/agents");
      setOpenaiAgentDir(next.openaiAgentDir || ".agent-control/openai-agents");
      setBuiltInAgentDir(next.builtInAgentDir || ".agent-control/built-in-agents");
      setAutoApprove(next.autoApprove);
      setDefaultAgentMode(next.defaultAgentMode);
      setThemeMode(next.themeMode);
      setTileHeight(next.tileHeight);
      setTileColumns(next.tileColumns);
      setPinLastSentMessage(next.pinLastSentMessage);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  function setAgentDir(kind: "claude" | "codex" | "openai" | "builtIn", value: string) {
    if (kind === "claude") setClaudeAgentDir(value);
    else if (kind === "codex") setCodexAgentDir(value);
    else if (kind === "openai") setOpenaiAgentDir(value);
    else setBuiltInAgentDir(value);
  }

  function currentAgentDir(kind: "claude" | "codex" | "openai" | "builtIn") {
    if (kind === "claude") return claudeAgentDir;
    if (kind === "codex") return codexAgentDir;
    if (kind === "openai") return openaiAgentDir;
    return builtInAgentDir;
  }

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const browserInitialPath = agentDirBrowser
    ? currentAgentDir(agentDirBrowser).startsWith(".") && selectedProject
      ? `${selectedProject.path}\\${currentAgentDir(agentDirBrowser)}`
      : currentAgentDir(agentDirBrowser)
    : "";

  return (
    <>
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
            Provider models
            <Textarea
              value={modelProfilesText}
              onChange={(event) => setModelProfilesText(event.target.value)}
              placeholder="claude:claude-sonnet-4-6&#10;codex:gpt-5.3-codex&#10;openai:gpt-5.4"
            />
          </label>
          <section className="grid gap-2 rounded-md border border-border p-3">
            <div>
              <h3 className="text-sm font-medium">Paths</h3>
              <p className="text-xs text-muted-foreground">Leave blank to auto-detect from PATH or environment variables.</p>
            </div>
            <label className="grid gap-1.5 text-sm">
              Git path
              <Input value={gitPath} onChange={(event) => setGitPath(event.target.value)} placeholder="git" />
            </label>
            <label className="grid gap-1.5 text-sm">
              Claude path
              <Input value={claudePath} onChange={(event) => setClaudePath(event.target.value)} placeholder="claude" />
            </label>
            <label className="grid gap-1.5 text-sm">
              Codex path
              <Input value={codexPath} onChange={(event) => setCodexPath(event.target.value)} placeholder="codex" />
            </label>
          </section>
          <section className="grid gap-2 rounded-md border border-border p-3">
            <div>
              <h3 className="text-sm font-medium">Agent directories</h3>
              <p className="text-xs text-muted-foreground">Relative paths are resolved inside each project.</p>
            </div>
            {([
              ["claude", "Claude agents", claudeAgentDir, setClaudeAgentDir, ".claude/agents"],
              ["codex", "Codex agents", codexAgentDir, setCodexAgentDir, ".codex/agents"],
              ["openai", "OpenAI agents", openaiAgentDir, setOpenaiAgentDir, ".agent-control/openai-agents"],
              ["builtIn", "Built-in agents", builtInAgentDir, setBuiltInAgentDir, ".agent-control/built-in-agents"]
            ] as const).map(([kind, label, value, setter, placeholder]) => (
              <label key={kind} className="grid gap-1.5 text-sm">
                {label}
                <div className="flex gap-2">
                  <Input value={value} onChange={(event) => setter(event.target.value)} placeholder={placeholder} />
                  <Button type="button" variant="outline" onClick={() => setAgentDirBrowser(kind)}>
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </Button>
                </div>
              </label>
            ))}
          </section>
          <section className="grid gap-2 rounded-md border border-border p-3">
            <div>
              <h3 className="text-sm font-medium">Provider keys</h3>
              <p className="text-xs text-muted-foreground">Environment variables win unless you save a local key here. Saved keys are not exported.</p>
            </div>
            <label className="grid gap-1.5 text-sm">
              Anthropic API key
              <Input
                type="password"
                value={anthropicApiKey}
                onChange={(event) => setAnthropicApiKey(event.target.value)}
                placeholder={`Current: ${settings.anthropicKeySource || "missing"}`}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={clearAnthropicApiKey} onChange={(event) => setClearAnthropicApiKey(event.target.checked)} />
              Clear saved Anthropic key{settings.anthropicKeySaved ? "" : " (none saved)"}
            </label>
            <label className="grid gap-1.5 text-sm">
              OpenAI API key
              <Input
                type="password"
                value={openaiApiKey}
                onChange={(event) => setOpenaiApiKey(event.target.value)}
                placeholder={`Current: ${settings.openaiKeySource || "missing"}`}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={clearOpenaiApiKey} onChange={(event) => setClearOpenaiApiKey(event.target.checked)} />
              Clear saved OpenAI key{settings.openaiKeySaved ? "" : " (none saved)"}
            </label>
          </section>
          <label className="grid gap-1.5 text-sm">
            Default mode for new agents
            <Select value={defaultAgentMode} onValueChange={(value) => setDefaultAgentMode(value as AgentPermissionMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPOSER_MODE_OPTIONS.map((option) => (
                  <SelectItem key={option.mode} value={option.mode}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm">
            Appearance
            <Select value={themeMode} onValueChange={(value) => setThemeMode(value as ThemeMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
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
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={320}
                  max={760}
                  step={20}
                  value={tileHeight}
                  onChange={(event) => setTileHeight(Number(event.target.value))}
                />
                <Button type="button" variant="outline" onClick={() => setTileHeight(currentTileHeight || settings.tileHeight)}>
                  Current
                </Button>
              </div>
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
          <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={pinLastSentMessage}
              onChange={(event) => setPinLastSentMessage(event.target.checked)}
            />
            <span>
              <span className="block font-medium">Pin last sent message while scrolling</span>
              <span className="block text-xs text-muted-foreground">
                Keep your most recent message visible at the top of a scrolled chat.
              </span>
            </span>
          </label>
          {autoApprove === "always" && (
            <p className="rounded-md border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-amber-100">
              Always passes --dangerously-skip-permissions when launching agents.
            </p>
          )}
          <section className="grid gap-2 rounded-md border border-border p-3">
            <div>
              <h3 className="text-sm font-medium">Configuration</h3>
              <p className="text-xs text-muted-foreground">Export or import this app's settings.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={exportConfig}>
                <Clipboard className="h-4 w-4" />
                Export Config
              </Button>
              <Button variant="outline" onClick={() => importInputRef.current?.click()}>
                <FolderOpen className="h-4 w-4" />
                Import Config
              </Button>
            </div>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importConfig(file);
              }}
            />
          </section>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save}>
              <Check className="h-4 w-4" />
              Save
            </Button>
          </div>
        </div>
        </DialogContent>
      </Dialog>
      <FolderBrowserDialog
        open={Boolean(agentDirBrowser)}
        initialPath={browserInitialPath}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setAgentDirBrowser(undefined);
        }}
        onSelect={(selectedPath) => {
          if (agentDirBrowser) setAgentDir(agentDirBrowser, selectedPath);
          setAgentDirBrowser(undefined);
        }}
      />
    </>
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
  const settings = useAppStore((state) => state.settings);
  const currentTileHeight = useAppStore((state) => state.currentTileHeight);
  const setCurrentTileHeight = useAppStore((state) => state.setCurrentTileHeight);
  const tileHeight = currentTileHeight || settings.tileHeight;
  const tileColumns = settings.tileColumns || 2;
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
            onHeightChange={setCurrentTileHeight}
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
  onMove,
  onHeightChange
}: {
  agent: RunningAgent;
  height: number;
  width?: number;
  defaultWidth: string;
  onMove: (sourceId: string, targetId: string) => void;
  onHeightChange: (height: number) => void;
}) {
  const transcript = useAppStore((state) => state.transcripts[agent.id] || EMPTY_TRANSCRIPT);
  const transcriptItems = useMemo(() => pairedTranscriptItems(transcript), [transcript]);
  const draft = useAppStore((state) => state.drafts[agent.id] || "");
  const setDraft = useAppStore((state) => state.setDraft);
  const queue = useAppStore((state) => state.messageQueues[agent.id] || EMPTY_QUEUE);
  const enqueueMessage = useAppStore((state) => state.enqueueMessage);
  const popNextQueuedMessage = useAppStore((state) => state.popNextQueuedMessage);
  const addError = useAppStore((state) => state.addError);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const setFocusedAgent = useAppStore((state) => state.setFocusedAgent);
  const setTileWidth = useAppStore((state) => state.setTileWidth);
  const focusedAgentId = useAppStore((state) => state.focusedAgentId);
  const settings = useAppStore((state) => state.settings);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const transcriptRootId = `tile-transcript-${agent.id}`;
  const selection = useTextSelection(`#${transcriptRootId}`);
  const tileRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const suppressAutoFocusRef = useRef(false);
  const [showPinnedMessage, setShowPinnedMessage] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextCopyTarget, setContextCopyTarget] = useState<ContextCopyTarget | undefined>();
  const [composerDropActive, setComposerDropActive] = useState(false);
  const [slashMenuSuppressed, setSlashMenuSuppressed] = useState(false);
  const [slashInsertedByButton, setSlashInsertedByButton] = useState(false);
  const composerDragDepthRef = useRef(0);
  const isBusy = isAgentBusy(agent);
  const canType = !agent.remoteControl && agentHasProcess(agent);
  const showActivityIndicator = isBusy && !hasStreamingAssistantText(transcript);
  const pinnedMessage = latestUserMessage(transcript);
  const pinLastSentMessage = settings.pinLastSentMessage;
  const rawSlashSuggestions = useMemo(
    () => slashCommandSuggestions(draft, settings.models, agent.slashCommands),
    [agent.slashCommands, draft, settings.models]
  );
  const slashSuggestions = slashMenuSuppressed ? [] : rawSlashSuggestions;
  const selectedLines = selectedLineCount(selection.selectedText);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 180;
    if (isBusy || nearBottom) root.scrollTop = root.scrollHeight;
    setShowPinnedMessage(shouldShowPinnedUserMessage(root, pinnedMessage?.id));
  }, [transcript, agent.id, isBusy, pinnedMessage?.id]);

  function handleTranscriptScroll(event: ReactUIEvent<HTMLDivElement>) {
    const nextVisible = shouldShowPinnedUserMessage(event.currentTarget, pinnedMessage?.id);
    setShowPinnedMessage((current) => (current === nextVisible ? current : nextVisible));
  }

  useEffect(() => {
    if (focusedAgentId !== agent.id) return;
    tileRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (suppressAutoFocusRef.current) {
      suppressAutoFocusRef.current = false;
      return;
    }
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

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashSuggestions.length, draft]);

  function activateTile(focusInput = false) {
    suppressAutoFocusRef.current = !focusInput;
    setSelectedAgent(undefined);
    setFocusedAgent(agent.id);
  }

  function prepareContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (getSelectionInRoot(`#${transcriptRootId}`)) {
      selection.captureSelection();
      setContextCopyTarget(undefined);
      return;
    }
    selection.clearSelection();
    setContextCopyTarget(
      contextCopyTargetFromEvent(event, rootRef.current, agent, transcript) || {
        scope: "chat",
        text: transcriptToPlainText(agent, transcript)
      }
    );
  }

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

  function selectSlashCommand(value: string) {
    setDraft(agent.id, value);
    setSlashMenuSuppressed(false);
    setSlashInsertedByButton(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function toggleSlashMenu() {
    if (rawSlashSuggestions.length > 0 && !slashMenuSuppressed) {
      setSlashMenuSuppressed(true);
      if (slashInsertedByButton || draft.trim() === "/") {
        setDraft(agent.id, draft.replace(/^\s*\//, ""));
        setSlashInsertedByButton(false);
      }
    } else {
      setSlashMenuSuppressed(false);
      if (draft.trimStart().startsWith("/")) {
        setSlashInsertedByButton(false);
      } else {
        setDraft(agent.id, `/${draft}`);
        setSlashInsertedByButton(true);
      }
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      sendCommand({ type: "setPermissionMode", id: agent.id, permissionMode: nextPermissionMode(agent) });
      return;
    }
    if (slashSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSlashIndex((index) => (index + 1) % slashSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSlashIndex((index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const selected = enabledSlashSuggestion(slashSuggestions[activeSlashIndex]) || slashSuggestions.find((suggestion) => !suggestion.disabled);
        if (selected) selectSlashCommand(selected.value);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const selected = enabledSlashSuggestion(slashSuggestions[activeSlashIndex]);
        if (selected && draft.trim() !== selected.value.trim()) {
          event.preventDefault();
          selectSlashCommand(selected.value);
          return;
        }
        if (slashSuggestions[activeSlashIndex]?.disabled) {
          event.preventDefault();
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = pastedImageFiles(event);
    if (files.length === 0) return;
    event.preventDefault();
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) setDraft(agent.id, insertPastedText(event.currentTarget, draft, pastedText));
    try {
      const uploaded = await uploadFiles(files);
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleFileAttachment(files: FileList | null) {
    const selectedFiles = Array.from(files || []);
    if (selectedFiles.length === 0) return;
    try {
      const uploaded = await uploadFiles(selectedFiles);
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    composerDragDepthRef.current = 0;
    setComposerDropActive(false);
    event.stopPropagation();
    if (!canType || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    try {
      const dropped = await attachmentsFromDrop(agent, event.dataTransfer);
      if (dropped.length > 0) setAttachments((current) => [...current, ...dropped]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleComposerDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    setComposerDropActive(true);
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setComposerDropActive(true);
  }

  function handleComposerDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) setComposerDropActive(false);
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

  function startHeightResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = height;
    let nextHeight = height;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      nextHeight = Math.min(760, Math.max(320, startHeight + moveEvent.clientY - startY));
      onHeightChange(Math.round(nextHeight));
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
        activateTile(false);
        if (event.button === 0) selection.clearSelection();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onMove(event.dataTransfer.getData("application/x-agent-id") || event.dataTransfer.getData("text/plain"), agent.id);
      }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <span
          className="cursor-grab text-muted-foreground"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData("application/x-agent-id", agent.id);
            event.dataTransfer.setData("text/plain", agent.id);
          }}
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
          <div className="flex min-w-0 items-center gap-2">
            <ModelMenu agent={agent} compact />
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <LastActivityText agent={agent} compact timeOnly />
          <StatusPill status={agent.status} />
        </span>
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
            {isBusy && <DropdownMenuItem onClick={() => sendCommand({ type: "interrupt", id: agent.id })}>Stop response</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => exportAgentMarkdown(agent, transcript)}>Export Markdown</DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportAgentJson(agent, transcript)}>Export JSON</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void exportAgentRawStream(agent, addError)}>Export Raw Stream</DropdownMenuItem>
            <DropdownMenuItem onClick={() => sendCommand({ type: "clear", id: agent.id })}>Clear Chat</DropdownMenuItem>
            <DropdownMenuItem onClick={() => sendCommand({ type: "kill", id: agent.id })}>Close Chat</DropdownMenuItem>
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
            onScroll={handleTranscriptScroll}
            onMouseUp={() => selection.captureSelection()}
            onKeyUp={() => selection.captureSelection()}
            onContextMenuCapture={prepareContextMenu}
          >
            {pinLastSentMessage && pinnedMessage && showPinnedMessage && <PinnedUserMessage event={pinnedMessage} compact />}
            {agent.statusMessage && (
              <p className="mb-3 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                {agent.statusMessage}
              </p>
            )}
            {agent.remoteControl ? (
              <div className="grid h-full place-items-center text-center">
                <div className="grid max-w-sm justify-items-center gap-3">
                  {agent.qr ? (
                    <img className="h-36 w-36 rounded-md bg-white p-2" src={agent.qr} alt="Remote Control QR code" />
                  ) : (
                    <div className="grid h-36 w-36 place-items-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
                      Waiting for QR
                    </div>
                  )}
                  <p className="text-sm text-muted-foreground">{remoteControlLabel(agent)}</p>
                  {agent.rcUrl && <p className="max-w-full break-all text-xs text-muted-foreground">{agent.rcUrl}</p>}
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
                {transcriptItems.map((item) => (
                  <TranscriptPreview
                    key={item.kind === "tool_pair" ? item.event.id : item.event.id}
                    item={item}
                    agent={agent}
                    latestUserMessageId={pinnedMessage?.id}
                  />
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
          contextTarget={contextCopyTarget}
          captureSelectedText={selection.captureSelection}
          getCachedSelectedText={selection.getCachedSelection}
        />
      </ContextMenu>
      {!agent.remoteControl && (
        <div className="shrink-0 border-t border-border p-3">
          <AddContextDialog
            agent={agent}
            open={contextOpen}
            onOpenChange={setContextOpen}
            onSelect={(attachment) => setAttachments((current) => [...current, attachment])}
            onDone={() => window.requestAnimationFrame(() => inputRef.current?.focus())}
          />
          <QueuedMessageList agentId={agent.id} queue={queue} compact />
          <div
            className={cn(
              "relative rounded-md border border-border bg-background/80",
              composerDropActive && "border-primary ring-1 ring-primary/60"
            )}
            onDragEnter={handleComposerDragEnter}
            onDragOver={handleComposerDragOver}
            onDragLeave={handleComposerDragLeave}
            onDrop={(event) => void handleDrop(event)}
          >
            {composerDropActive && (
              <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-md border border-dashed border-primary bg-background/85 text-sm font-medium text-foreground shadow-sm backdrop-blur-sm">
                Drop here
              </div>
            )}
            <div className="grid gap-2 px-2 pt-2">
              <AttachmentChips
                attachments={attachments}
                onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
              />
              <SlashCommandAutocomplete
                suggestions={slashSuggestions}
                activeIndex={activeSlashIndex}
                compact
                onSelect={selectSlashCommand}
                onActiveIndexChange={setActiveSlashIndex}
              />
            </div>
            <div className="relative">
              <Textarea
                ref={inputRef}
                className="h-9 min-h-9 resize-none overflow-y-auto border-0 bg-transparent py-2 text-sm leading-5 focus-visible:ring-0"
                value={draft}
                disabled={!canType}
                onFocus={() => activateTile(true)}
                onChange={(event) => {
                  activateTile(true);
                  setSlashMenuSuppressed(false);
                  setSlashInsertedByButton(false);
                  setDraft(agent.id, event.target.value);
                }}
                onPaste={handlePaste}
                placeholder={isBusy ? "Queue a message..." : `chat with ${providerLabel(agent.provider)}`}
                onKeyDown={handleComposerKeyDown}
              />
            </div>
            <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void handleFileAttachment(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
                <ComposerAddMenu disabled={!canType} onUpload={() => fileInputRef.current?.click()} onAddContext={() => setContextOpen(true)} />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="Slash commands"
                  onClick={toggleSlashMenu}
                >
                  <SquareSlash className="h-4 w-4" />
                </Button>
                {selectedLines > 0 && (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5" />
                    <span className="truncate">{selectedLines} {selectedLines === 1 ? "line" : "lines"} selected</span>
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <ComposerModeMenu agent={agent} compact inline />
                <Button
                  size="icon"
                  className="h-8 w-8"
                  disabled={isBusy ? !agentHasProcess(agent) : !canType || (!draft.trim() && attachments.length === 0)}
                  onClick={isBusy ? stopCurrentResponse : send}
                  title={isBusy ? "Stop response" : "Send"}
                >
                  {isBusy ? <X className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div
        className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize rounded-r-md hover:bg-primary/20"
        onPointerDown={startResize}
        title="Drag to resize chat width"
      />
      <div
        className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize rounded-b-md hover:bg-primary/20"
        onPointerDown={startHeightResize}
        title="Drag to resize tile height"
      />
    </section>
  );
}

function TranscriptPreview({
  item,
  agent,
  latestUserMessageId
}: {
  item: ToolTranscriptItem;
  agent: RunningAgent;
  latestUserMessageId?: string;
}) {
  if (item.kind === "tool_pair") {
    return <ToolCard event={item.event} result={item.result} agent={agent} compact />;
  }
  const event = item.event;
  if (event.kind === "model_switch") {
    return (
      <p className="text-center text-xs text-muted-foreground" data-copy-block="true" data-copy-event-id={event.id}>
        switched to {event.to}
      </p>
    );
  }
  if (event.kind === "tool_use" || event.kind === "tool_result") {
    return <ToolCard event={event} agent={agent} compact />;
  }
  if (event.kind === "system") {
    return (
      <p className="text-center text-xs text-muted-foreground" data-copy-block="true" data-copy-event-id={event.id}>
        {event.text}
      </p>
    );
  }

  const isUser = event.kind === "user";
  const showPopout = isLongTextBlock(event.text, true);
  return (
    <div
      className={cn("flex", isUser && "justify-end")}
      data-latest-user-message={event.id === latestUserMessageId ? "true" : undefined}
    >
      <div
        className={cn(
          "relative max-w-[86%] whitespace-pre-wrap break-words rounded-md border border-border px-3 py-2 text-sm leading-5",
          isUser ? "user-question bg-primary text-primary-foreground" : "bg-background/60",
          showPopout && "pr-10"
        )}
        data-copy-block="true"
        data-copy-event-id={event.id}
        style={!isUser ? { borderLeftColor: agent.color, borderLeftWidth: 4 } : undefined}
      >
        {showPopout && <ChatBlockPopoutButton source={agent} text={event.text} compact />}
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
            <ThinkingText prefix="Streaming" />
          </span>
        )}
      </div>
    </div>
  );
}

function PinnedUserMessage({
  event,
  compact = false
}: {
  event: Extract<TranscriptEvent, { kind: "user" }>;
  compact?: boolean;
}) {
  return (
    <div className="sticky top-0 z-20 mb-3 flex justify-end">
      <div
        className={cn(
          "max-w-full rounded-md border border-primary/40 bg-primary/95 px-3 py-2 text-primary-foreground shadow-lg backdrop-blur",
          "user-question",
          compact ? "text-xs leading-4" : "text-sm leading-5"
        )}
        data-copy-block="true"
        data-copy-event-id={event.id}
      >
        <div className="line-clamp-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{event.text || "Attachment"}</div>
        {event.attachments && event.attachments.length > 0 && (
          <div className="mt-1 text-[11px] opacity-80">{event.attachments.length} attachment(s)</div>
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
  useEffect(() => {
    if (agent.qr) setShowQr(true);
  }, [agent.qr]);

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
          {agent.rcUrl && <p className="break-all text-xs text-muted-foreground">{agent.rcUrl}</p>}
          <p className="text-sm text-muted-foreground">
            Status: {remoteControlLabel(agent)} · Uptime: {formatDuration(agent.launchedAt)} · PID: {agent.pid || "n/a"}
          </p>
          <div className="rounded-md border border-border bg-card text-left">
            <div className="border-b border-border px-3 py-2 text-sm font-medium">Diagnostics</div>
            <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words p-3 text-xs text-muted-foreground">
              {(agent.rcDiagnostics || []).length > 0 ? (agent.rcDiagnostics || []).join("\n") : "Waiting for Remote Control output..."}
            </pre>
          </div>
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
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{agent.displayName}</span>
          {agent.remoteControl && <Badge>RC</Badge>}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <ModelMenu agent={agent} />
        </div>
      </div>
      {agent.restorable && (
        <Button variant="outline" onClick={() => sendCommand({ type: "resume", id: agent.id })}>
          Resume
        </Button>
      )}
      <span className="flex shrink-0 items-center gap-2">
        <LastActivityText agent={agent} compact timeOnly />
        <StatusPill status={agent.status} />
      </span>
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
          <DropdownMenuItem onClick={() => sendCommand({ type: "clear", id: agent.id })}>Clear Chat</DropdownMenuItem>
          <DropdownMenuItem onClick={() => sendCommand({ type: "kill", id: agent.id })}>Close Chat</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isBusy && (
        <Button variant="outline" onClick={() => sendCommand({ type: "interrupt", id: agent.id })}>
          <X className="h-4 w-4" />
          Stop
        </Button>
      )}
      <Button variant="ghost" size="icon" onClick={() => setSelectedAgent(undefined)} title="Show tiles">
        <Minimize2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function StandardAgentPanel({ agent }: { agent: RunningAgent }) {
  const transcript = useAppStore((state) => state.transcripts[agent.id] || EMPTY_TRANSCRIPT);
  const transcriptItems = useMemo(() => pairedTranscriptItems(transcript), [transcript]);
  const draft = useAppStore((state) => state.drafts[agent.id] || "");
  const setDraft = useAppStore((state) => state.setDraft);
  const queue = useAppStore((state) => state.messageQueues[agent.id] || EMPTY_QUEUE);
  const enqueueMessage = useAppStore((state) => state.enqueueMessage);
  const popNextQueuedMessage = useAppStore((state) => state.popNextQueuedMessage);
  const addError = useAppStore((state) => state.addError);
  const settings = useAppStore((state) => state.settings);
  const scrollTop = useAppStore((state) => state.scrollPositions[agent.id] || 0);
  const setScrollPosition = useAppStore((state) => state.setScrollPosition);
  const searchOpen = useAppStore((state) => state.searchOpen);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRootId = `transcript-root-${agent.id}`;
  const selection = useTextSelection(`#${transcriptRootId}`);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [showPinnedMessage, setShowPinnedMessage] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextCopyTarget, setContextCopyTarget] = useState<ContextCopyTarget | undefined>();
  const [composerDropActive, setComposerDropActive] = useState(false);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [slashMenuSuppressed, setSlashMenuSuppressed] = useState(false);
  const [slashInsertedByButton, setSlashInsertedByButton] = useState(false);
  const composerDragDepthRef = useRef(0);
  const isBusy = isAgentBusy(agent);
  const canType = agentHasProcess(agent);
  const showActivityIndicator = isBusy && !hasStreamingAssistantText(transcript);
  const pinnedMessage = latestUserMessage(transcript);
  const pinLastSentMessage = settings.pinLastSentMessage;
  const rawSlashSuggestions = useMemo(
    () => slashCommandSuggestions(draft, settings.models, agent.slashCommands),
    [agent.slashCommands, draft, settings.models]
  );
  const slashSuggestions = slashMenuSuppressed ? [] : rawSlashSuggestions;
  const selectedLines = selectedLineCount(selection.selectedText);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.scrollTop = scrollTop;
    setShowPinnedMessage(shouldShowPinnedUserMessage(root, pinnedMessage?.id));
  }, [agent.id, pinnedMessage?.id, scrollTop]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 140;
    if (isBusy || nearBottom) {
      root.scrollTop = root.scrollHeight;
      setScrollPosition(agent.id, root.scrollTop);
    }
    setShowPinnedMessage(shouldShowPinnedUserMessage(root, pinnedMessage?.id));
  }, [transcript, agent.id, isBusy, pinnedMessage?.id, setScrollPosition]);

  useEffect(() => {
    if (isBusy || !canType || queue.length === 0) return;
    const next = popNextQueuedMessage(agent.id);
    if (!next) return;
    sendCommand({ type: "userMessage", id: agent.id, text: next.text, attachments: next.attachments });
  }, [agent.id, canType, isBusy, popNextQueuedMessage, queue.length]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashSuggestions.length, draft]);

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

  function selectSlashCommand(value: string) {
    setDraft(agent.id, value);
    setSlashMenuSuppressed(false);
    setSlashInsertedByButton(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function toggleSlashMenu() {
    if (rawSlashSuggestions.length > 0 && !slashMenuSuppressed) {
      setSlashMenuSuppressed(true);
      if (slashInsertedByButton || draft.trim() === "/") {
        setDraft(agent.id, draft.replace(/^\s*\//, ""));
        setSlashInsertedByButton(false);
      }
    } else {
      setSlashMenuSuppressed(false);
      if (draft.trimStart().startsWith("/")) {
        setSlashInsertedByButton(false);
      } else {
        setDraft(agent.id, `/${draft}`);
        setSlashInsertedByButton(true);
      }
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      sendCommand({ type: "setPermissionMode", id: agent.id, permissionMode: nextPermissionMode(agent) });
      return;
    }
    if (slashSuggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSlashIndex((index) => (index + 1) % slashSuggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSlashIndex((index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const selected = enabledSlashSuggestion(slashSuggestions[activeSlashIndex]) || slashSuggestions.find((suggestion) => !suggestion.disabled);
        if (selected) selectSlashCommand(selected.value);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const selected = enabledSlashSuggestion(slashSuggestions[activeSlashIndex]);
        if (selected && draft.trim() !== selected.value.trim()) {
          event.preventDefault();
          selectSlashCommand(selected.value);
          return;
        }
        if (slashSuggestions[activeSlashIndex]?.disabled) {
          event.preventDefault();
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  function handleTranscriptScroll(event: ReactUIEvent<HTMLDivElement>) {
    const top = event.currentTarget.scrollTop;
    setScrollPosition(agent.id, top);
    const nextVisible = shouldShowPinnedUserMessage(event.currentTarget, pinnedMessage?.id);
    setShowPinnedMessage((current) => (current === nextVisible ? current : nextVisible));
  }

  function prepareContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (getSelectionInRoot(`#${transcriptRootId}`)) {
      selection.captureSelection();
      setContextCopyTarget(undefined);
      return;
    }
    selection.clearSelection();
    setContextCopyTarget(
      contextCopyTargetFromEvent(event, rootRef.current, agent, transcript) || {
        scope: "chat",
        text: transcriptToPlainText(agent, transcript)
      }
    );
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = pastedImageFiles(event);
    if (files.length === 0) return;
    event.preventDefault();
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) setDraft(agent.id, insertPastedText(event.currentTarget, draft, pastedText));
    try {
      const uploaded = await uploadFiles(files);
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleFileAttachment(files: FileList | null) {
    const selectedFiles = Array.from(files || []);
    if (selectedFiles.length === 0) return;
    try {
      const uploaded = await uploadFiles(selectedFiles);
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    composerDragDepthRef.current = 0;
    setComposerDropActive(false);
    event.stopPropagation();
    if (!canType || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    try {
      const dropped = await attachmentsFromDrop(agent, event.dataTransfer);
      if (dropped.length > 0) setAttachments((current) => [...current, ...dropped]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleComposerDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    setComposerDropActive(true);
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setComposerDropActive(true);
  }

  function handleComposerDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) setComposerDropActive(false);
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
            onScroll={handleTranscriptScroll}
            onPointerDown={(event) => {
              if (event.button === 0) selection.clearSelection();
            }}
            onMouseUp={() => selection.captureSelection()}
            onKeyUp={() => selection.captureSelection()}
            onContextMenuCapture={prepareContextMenu}
          >
            <div className="mx-auto grid w-full min-w-0 max-w-4xl gap-3">
              {pinLastSentMessage && pinnedMessage && showPinnedMessage && <PinnedUserMessage event={pinnedMessage} />}
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
                  {transcriptItems.map((item) => (
                    <TranscriptItem
                      key={item.kind === "tool_pair" ? item.event.id : item.event.id}
                      item={item}
                      agent={agent}
                      query={searchQuery}
                      latestUserMessageId={pinnedMessage?.id}
                    />
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
          contextTarget={contextCopyTarget}
          captureSelectedText={selection.captureSelection}
          getCachedSelectedText={selection.getCachedSelection}
        />
      </ContextMenu>
      <div className="border-t border-border p-3">
        <AddContextDialog
          agent={agent}
          open={contextOpen}
          onOpenChange={setContextOpen}
          onSelect={(attachment) => setAttachments((current) => [...current, attachment])}
          onDone={() => window.requestAnimationFrame(() => inputRef.current?.focus())}
        />
        <QueuedMessageList agentId={agent.id} queue={queue} />
        <div
          className={cn(
            "relative mx-auto w-full min-w-0 max-w-4xl rounded-md border border-border bg-background/80",
            composerDropActive && "border-primary ring-1 ring-primary/60"
          )}
          onDragEnter={handleComposerDragEnter}
          onDragOver={handleComposerDragOver}
          onDragLeave={handleComposerDragLeave}
          onDrop={(event) => void handleDrop(event)}
        >
          {composerDropActive && (
            <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-md border border-dashed border-primary bg-background/85 text-sm font-medium text-foreground shadow-sm backdrop-blur-sm">
              Drop here
            </div>
          )}
          <div className="grid gap-2 px-2 pt-2">
            <AttachmentChips
              attachments={attachments}
              onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
            />
            <SlashCommandAutocomplete
              suggestions={slashSuggestions}
              activeIndex={activeSlashIndex}
              onSelect={selectSlashCommand}
              onActiveIndexChange={setActiveSlashIndex}
            />
          </div>
          <div className="relative">
            <Textarea
              ref={inputRef}
              className="h-9 min-h-9 resize-none overflow-y-auto border-0 bg-transparent py-2 leading-5 focus-visible:ring-0"
              value={draft}
              disabled={!canType}
              onChange={(event) => {
                setSlashMenuSuppressed(false);
                setSlashInsertedByButton(false);
                setDraft(agent.id, event.target.value);
              }}
              onPaste={handlePaste}
              placeholder={isBusy ? "Queue a message..." : `chat with ${providerLabel(agent.provider)}`}
              onKeyDown={handleComposerKeyDown}
            />
          </div>
          <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  void handleFileAttachment(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              <ComposerAddMenu disabled={!canType} onUpload={() => fileInputRef.current?.click()} onAddContext={() => setContextOpen(true)} />
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                title="Slash commands"
                onClick={toggleSlashMenu}
              >
                <SquareSlash className="h-4 w-4" />
              </Button>
              {selectedLines > 0 && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <FileText className="h-3.5 w-3.5" />
                  <span className="truncate">{selectedLines} {selectedLines === 1 ? "line" : "lines"} selected</span>
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <ComposerModeMenu agent={agent} inline />
              <Button
                size="icon"
                className="h-8 w-8"
                disabled={isBusy ? !agentHasProcess(agent) : !canType || (!draft.trim() && attachments.length === 0)}
                onClick={isBusy ? stopCurrentResponse : send}
                title={isBusy ? "Stop response" : "Send"}
              >
                {isBusy ? <X className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function SendToMenu({
  source,
  selectedText,
  transcripts,
  rootSelector,
  contextTarget,
  captureSelectedText,
  getCachedSelectedText
}: {
  source: RunningAgent;
  selectedText: string;
  transcripts: TranscriptEvent[];
  rootSelector: string;
  contextTarget?: ContextCopyTarget;
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
  const targetAgents = useMemo(() => agents.filter((agent) => agent.id !== source.id), [agents, source.id]);
  const fallbackText = useMemo(() => transcriptToPlainText(source, transcripts), [source, transcripts]);
  const liveSelectedText = getSelectionInRoot(rootSelector);
  const activeTarget = contextTarget?.text
    ? contextTarget
    : liveSelectedText || selectedText || getCachedSelectedText()
      ? { scope: "selection" as const, text: liveSelectedText || selectedText || getCachedSelectedText() }
      : { scope: "chat" as const, text: fallbackText };
  const activeText = activeTarget.text;
  const targetLabel = activeTarget.scope === "selection" ? "selected text" : activeTarget.scope === "block" ? "text block" : "whole chat";

  function currentCopyTarget() {
    if (contextTarget?.text) return contextTarget;
    const selected = captureSelectedText() || getSelectionInRoot(rootSelector) || selectedText || getCachedSelectedText();
    if (selected) return { scope: "selection" as const, text: selected };
    return { scope: "chat" as const, text: fallbackText };
  }

  return (
    <ContextMenuContent>
      <ContextMenuItem
        disabled={!activeText}
        onClick={() => {
          const target = currentCopyTarget();
          if (!target.text) return;
          void navigator.clipboard.writeText(target.text).catch((error: unknown) => {
            addError(error instanceof Error ? error.message : String(error));
          });
        }}
      >
        <Clipboard className="mr-2 h-4 w-4" />
        Copy {targetLabel}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-45" disabled={!activeText}>
          <span className="flex-1">Send {targetLabel} to</span>
          <ChevronRight className="ml-4 h-4 w-4 text-muted-foreground" />
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
                    const target = currentCopyTarget();
                    if (!target.text) return;
                    openLaunchModal({
                      projectId: source.projectId,
                      defName: def.name,
                      initialPrompt: wrapForwardedText(source, target.text)
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
            <ContextMenuSubTrigger
              className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-45"
              disabled={targetAgents.length === 0}
            >
              Existing agent
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {targetAgents.map((agent) => (
                <ContextMenuItem
                  key={agent.id}
                  disabled={agent.remoteControl}
                  onClick={() => {
                    const target = currentCopyTarget();
                    if (!target.text) return;
                    openSendDialog({
                      sourceAgentId: source.id,
                      targetAgentId: agent.id,
                      selectedText: target.text,
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

function TranscriptItem({
  item,
  agent,
  query,
  latestUserMessageId
}: {
  item: ToolTranscriptItem;
  agent: RunningAgent;
  query: string;
  latestUserMessageId?: string;
}) {
  if (item.kind === "tool_pair") {
    return <ToolCard event={item.event} result={item.result} agent={agent} />;
  }
  const event = item.event;
  if (event.kind === "model_switch") {
    return (
      <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground" data-copy-block="true" data-copy-event-id={event.id}>
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
    return (
      <p className="text-center text-xs text-muted-foreground" data-copy-block="true" data-copy-event-id={event.id}>
        {event.text}
      </p>
    );
  }

  const isUser = event.kind === "user";
  const showPopout = isLongTextBlock(event.text);
  return (
    <div
      className={cn("flex", isUser && "justify-end")}
      data-latest-user-message={event.id === latestUserMessageId ? "true" : undefined}
    >
      <div
        className={cn(
          "relative min-w-0 max-w-[78%] whitespace-pre-wrap break-words [overflow-wrap:anywhere] rounded-lg border border-border px-3 py-2 text-sm leading-6",
          isUser ? "user-question bg-primary text-primary-foreground" : "bg-card",
          showPopout && "pr-12"
        )}
        data-copy-block="true"
        data-copy-event-id={event.id}
        style={!isUser ? { borderLeftColor: agent.color, borderLeftWidth: 4 } : undefined}
      >
        {showPopout && <ChatBlockPopoutButton source={agent} text={event.text} />}
        {event.sourceAgent && (
          <Badge className="mb-2" style={{ borderColor: event.sourceAgent.color, color: event.sourceAgent.color }}>
            from {event.sourceAgent.displayName}
          </Badge>
        )}
        <CollapsibleText text={event.text} query={query} />
        {event.kind === "assistant_text" && event.streaming && (
          <span className="mt-2 block">
            <ThinkingText prefix="Streaming" />
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
  const shouldCollapse = isLongTextBlock(text, compact);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (query.trim()) setExpanded(true);
  }, [query]);

  if (!shouldCollapse) return <HighlightedText text={text} query={query} />;

  function toggleExpanded() {
    setExpanded((value) => !value);
  }

  function toggleFromText() {
    if (window.getSelection()?.toString()) return;
    toggleExpanded();
  }

  return (
    <div className="grid gap-2">
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "min-w-0 cursor-pointer rounded-sm whitespace-pre-wrap break-words outline-none [overflow-wrap:anywhere] hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
          !expanded && (compact ? "max-h-32 overflow-hidden" : "max-h-48 overflow-hidden")
        )}
        title={expanded ? "Collapse response" : "Expand response"}
        onClick={toggleFromText}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleExpanded();
          }
        }}
      >
        <HighlightedText text={text} query={query} />
      </div>
      <button
        type="button"
        className={cn(
          "inline-flex w-fit items-center gap-1 rounded-sm text-xs font-medium opacity-80 hover:opacity-100",
          compact ? "text-muted-foreground" : "text-current"
        )}
        onClick={toggleExpanded}
      >
        {expanded ? "Show less" : "Show more"}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} />
      </button>
    </div>
  );
}

function isLongTextBlock(text: string, compact = false) {
  return text.length > (compact ? 420 : 900) || text.split(/\r?\n/).length > (compact ? 8 : 14);
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

function ChatBlockPopoutButton({
  source,
  text,
  compact = false
}: {
  source: RunningAgent;
  text: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const projects = useAppStore((state) => state.projects);
  const agentsById = useAppStore((state) => state.agents);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const openSendDialog = useAppStore((state) => state.openSendDialog);
  const addError = useAppStore((state) => state.addError);
  const project = projects.find((candidate) => candidate.id === source.projectId);
  const newAgentDefs = useMemo(() => agentDefsWithGeneric(project), [project]);
  const targetAgents = useMemo(
    () => Object.values(agentsById).filter((agent) => agent.projectId === source.projectId && agent.id !== source.id),
    [agentsById, source.id, source.projectId]
  );

  function copyText() {
    void navigator.clipboard.writeText(text).catch((error: unknown) => {
      addError(error instanceof Error ? error.message : String(error));
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={cn("absolute right-1 top-1 opacity-70 hover:opacity-100", compact ? "h-6 w-6" : "h-7 w-7")}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        title="Open text block"
      >
        <Maximize2 className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(94vw,900px)]">
          <DialogHeader>
            <DialogTitle>Text block</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={copyText}>
              <Clipboard className="h-4 w-4" />
              Copy
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={!text.trim()}>
                  Send to new agent
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {newAgentDefs.map((def) => (
                  <DropdownMenuItem
                    key={`${def.provider || "claude"}:${def.name}`}
                    onClick={() => {
                      openLaunchModal({
                        projectId: source.projectId,
                        defName: def.name,
                        initialPrompt: wrapForwardedText(source, text)
                      });
                      setOpen(false);
                    }}
                  >
                    <AgentDot color={def.color} />
                    <span className="ml-2">{def.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={targetAgents.length === 0 || !text.trim()}>
                  Send to existing agent
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {targetAgents.map((agent) => (
                  <DropdownMenuItem
                    key={agent.id}
                    disabled={agent.remoteControl}
                    onClick={() => {
                      openSendDialog({
                        sourceAgentId: source.id,
                        targetAgentId: agent.id,
                        selectedText: text,
                        framing: ""
                      });
                      setOpen(false);
                    }}
                  >
                    <AgentDot color={agent.color} />
                    <span className="ml-2">{agent.displayName}</span>
                    {agent.remoteControl && <Badge className="ml-2">RC</Badge>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/70 p-3 text-sm leading-6 [overflow-wrap:anywhere]">
            {text}
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ToolCard({
  event,
  result,
  agent,
  compact = false
}: {
  event: Extract<TranscriptEvent, { kind: "tool_use" | "tool_result" }>;
  result?: ToolResultEvent;
  agent: RunningAgent;
  compact?: boolean;
}) {
  const addError = useAppStore((state) => state.addError);
  const isUse = event.kind === "tool_use";
  const [open, setOpen] = useState((isUse && event.awaitingPermission) || (!isUse && event.isError));
  const summary = result ? toolSummary(result) || toolSummary(event) : toolSummary(event);
  const detail = result ? toolPairDetail(event, result) : toolDetail(event);
  const pathText = isUse ? toolPath(event.input) : "";
  const commandText = isUse ? fieldText(event.input, ["command"]) : "";
  const awaitingPermission = isUse && event.awaitingPermission;
  const resultIsError = Boolean(result?.isError || (!isUse && event.isError));

  useEffect(() => {
    if (awaitingPermission || resultIsError) setOpen(true);
  }, [awaitingPermission, resultIsError]);

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
        awaitingPermission ? "border-amber-300/70 bg-amber-500/10 shadow-[0_0_0_1px_rgba(251,191,36,0.18)]" : resultIsError ? "border-red-400/50" : "border-border",
        compact ? "text-xs" : "text-sm"
      )}
      data-copy-block="true"
      data-copy-event-id={event.id}
    >
      <button className={cn("flex w-full min-w-0 items-center justify-between gap-3 text-left", compact ? "px-2 py-2" : "px-3 py-2")} onClick={() => setOpen((value) => !value)}>
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {isUse ? `Tool: ${event.name}` : `Tool result: ${event.toolUseId}`}
            {awaitingPermission && <Badge className="ml-2 border-amber-300/60 bg-amber-500/15 text-amber-100">permission required</Badge>}
            {result && <Badge className="ml-2 border-border text-muted-foreground">result paired</Badge>}
            {resultIsError && <Badge className="ml-2 border-red-400/40 text-red-200">error</Badge>}
          </span>
          {summary && <span className="mt-1 block truncate text-xs text-muted-foreground">{summary}</span>}
        </span>
        <Badge className="shrink-0 gap-1">
          {open ? "Hide" : "Show"}
          <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
        </Badge>
      </button>
      {awaitingPermission && (
        <div className="grid gap-3 border-t border-amber-300/30 bg-amber-500/10 px-3 py-3">
          <div className="grid gap-1">
            <p className="font-medium text-amber-50">Permission required</p>
            <p className="text-xs text-amber-100">
              Claude wants to run {event.name}
            {commandText ? `: ${commandText}` : pathText ? ` on ${pathText}` : ""}.
            </p>
          </div>
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
              {result ? "Tool + Result" : "Output"}
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
  const themeMode = useAppStore((state) => state.settings.themeMode);

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
      theme: terminalThemeFromCss()
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
    terminalRef.current?.options && (terminalRef.current.options.theme = terminalThemeFromCss());
  }, [themeMode]);

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

function TerminalPanel({
  popout = false,
  popoutTerminalId,
  poppedOutTerminalIds = new Set<string>()
}: {
  popout?: boolean;
  popoutTerminalId?: string;
  poppedOutTerminalIds?: Set<string>;
} = {}) {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const sessionsById = useAppStore((state) => state.terminalSessions);
  const outputById = useAppStore((state) => state.terminalOutput);
  const activeTerminalId = useAppStore((state) => state.activeTerminalId);
  const setActiveTerminal = useAppStore((state) => state.setActiveTerminal);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const addError = useAppStore((state) => state.addError);
  const terminalDock = settings.terminalDock;
  const [height, setHeight] = useState(320);
  const [width, setWidth] = useState(420);
  const [detachedBounds, setDetachedBounds] = useState({ left: 96, top: 72, width: 960, height: 520 });
  const [visiblePaneIds, setVisiblePaneIds] = useState<string[]>([]);
  const pendingSplitRef = useRef(false);
  const floating = !popout && terminalDock === "float";
  const sideDock = !popout && (terminalDock === "left" || terminalDock === "right");
  const poppedOutKey = useMemo(() => [...poppedOutTerminalIds].sort().join("|"), [poppedOutTerminalIds]);
  const sessions = useMemo(
    () => {
      const projectSessions = terminalsForProject(sessionsById, selectedProjectId).sort(
        (left, right) => +new Date(left.startedAt) - +new Date(right.startedAt)
      );
      if (popout && popoutTerminalId) return projectSessions.filter((item) => item.id === popoutTerminalId);
      if (popout) return projectSessions;
      return projectSessions.filter((item) => !poppedOutTerminalIds.has(item.id));
    },
    [poppedOutKey, poppedOutTerminalIds, popout, popoutTerminalId, sessionsById, selectedProjectId]
  );
  const activeSession = activeTerminalId ? sessions.find((item) => item.id === activeTerminalId) : undefined;
  const session = activeSession || sessions[sessions.length - 1];

  useEffect(() => {
    const sessionIds = new Set(sessions.map((item) => item.id));
    setVisiblePaneIds((current) => {
      const filtered = current.filter((id) => sessionIds.has(id));
      const nextActive = activeTerminalId && sessionIds.has(activeTerminalId) ? activeTerminalId : sessions[sessions.length - 1]?.id;
      if (nextActive && !filtered.includes(nextActive)) {
        if (pendingSplitRef.current) {
          pendingSplitRef.current = false;
          return [...filtered.slice(-3), nextActive];
        }
        return [nextActive];
      }
      return filtered;
    });
  }, [activeTerminalId, sessions]);

  useEffect(() => {
    if (!floating) return;
    setDetachedBounds((bounds) => clampDetachedBounds(bounds));
    const onResize = () => setDetachedBounds((bounds) => clampDetachedBounds(bounds));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [floating]);

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

  function startSideResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const direction = terminalDock === "left" ? 1 : -1;
    const onMove = (moveEvent: PointerEvent) => {
      setWidth(Math.min(760, Math.max(320, startWidth + direction * (moveEvent.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startDetachedMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!floating) return;
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
    if (!floating) return;
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

  function dockPopout() {
    if (!popout) return;
    notifyTerminalDock(popoutTerminalId || session?.id, true);
    window.close();
  }

  function startTerminal(split = false) {
    pendingSplitRef.current = split;
    sendCommand({ type: "terminalStart", projectId: selectedProjectId });
  }

  function splitTerminal() {
    startTerminal(true);
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
      return [id];
    });
  }

  async function changeTerminalDock(nextDock: typeof TERMINAL_DOCK_OPTIONS[number]["value"]) {
    if (nextDock === terminalDock) return;
    try {
      const next = await api.saveSettings({ ...settings, terminalDock: nextDock });
      setSettings(next);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  const visibleSessions = visiblePaneIds
    .map((id) => sessions.find((item) => item.id === id))
    .filter((item): item is TerminalSession => Boolean(item));
  const terminalDockOption = TERMINAL_DOCK_OPTIONS.find((option) => option.value === terminalDock) || TERMINAL_DOCK_OPTIONS[2];
  const CurrentDockIcon = terminalDockOption.icon;

  return (
    <section
      className={cn(
        "flex shrink-0 flex-col border-border bg-card",
        popout
          ? "h-screen border-0"
          : floating
            ? "fixed z-40 rounded-md border shadow-2xl"
            : terminalDock === "left"
              ? "relative h-full border-r"
              : terminalDock === "right"
                ? "relative h-full border-l"
                : "relative border-t"
      )}
      style={popout ? undefined : floating ? detachedBounds : sideDock ? { width } : { height }}
    >
      {!popout && terminalDock === "bottom" && (
        <div className="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize hover:bg-primary/25" onPointerDown={startResize} title="Drag to resize terminal" />
      )}
      {sideDock && (
        <div
          className={cn(
            "absolute top-0 z-20 h-full w-2 cursor-ew-resize hover:bg-primary/25",
            terminalDock === "left" ? "-right-1" : "-left-1"
          )}
          onPointerDown={startSideResize}
          title="Drag to resize terminal"
        />
      )}
      {!popout && floating && (
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
          className={cn("min-w-0 flex-1", floating && "cursor-move select-none")}
          onPointerDown={startDetachedMove}
          title={floating ? "Drag to move terminal" : undefined}
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
        <Button variant="outline" size="sm" onClick={() => startTerminal()} disabled={!projects.length && !selectedProjectId}>
          <Plus className="h-4 w-4" />
          New
        </Button>
        <Button variant="outline" size="sm" onClick={splitTerminal} disabled={!projects.length && !selectedProjectId}>
          <Columns2 className="h-4 w-4" />
          Split
        </Button>
        {!popout && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1 px-2" title={`Terminal: ${terminalDockOption.label}`}>
                <CurrentDockIcon className="h-4 w-4" />
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {TERMINAL_DOCK_OPTIONS.map((option) => {
                const DockIcon = option.icon;
                return (
                  <DropdownMenuItem key={option.value} onClick={() => void changeTerminalDock(option.value)}>
                    <DockIcon className="mr-2 h-4 w-4" />
                    <span className="min-w-24">{option.label}</span>
                    <Check className={cn("ml-auto h-4 w-4", option.value === terminalDock ? "opacity-100" : "opacity-0")} />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {popout && (
          <Button variant="outline" size="sm" onClick={dockPopout} title="Return terminal to the docked panel">
            <Minimize2 className="h-4 w-4" />
            Dock
          </Button>
        )}
        {popout ? (
          <Button variant="ghost" size="icon" onClick={() => window.close()} title="Close window">
            <X className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" onClick={() => setTerminalOpen(false)} title="Minimize terminal">
            <ChevronDown className="h-4 w-4" />
          </Button>
        )}
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

function TerminalMinimizedDock({ poppedOutTerminalIds }: { poppedOutTerminalIds: Set<string> }) {
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const sessionsById = useAppStore((state) => state.terminalSessions);
  const outputById = useAppStore((state) => state.terminalOutput);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const setActiveTerminal = useAppStore((state) => state.setActiveTerminal);
  const sessions = useMemo(
    () =>
      terminalsForProject(sessionsById, selectedProjectId)
        .filter((item) => !poppedOutTerminalIds.has(item.id))
        .sort(
          (left, right) =>
            timestampValue(left.updatedAt || left.startedAt) - timestampValue(right.updatedAt || right.startedAt) ||
            timestampValue(left.startedAt) - timestampValue(right.startedAt)
        ),
    [poppedOutTerminalIds, sessionsById, selectedProjectId]
  );
  const lastActive = sessions[sessions.length - 1];
  const line = lastActive ? latestTerminalLine(outputById[lastActive.id] || []) : "";
  if (!lastActive) return null;

  function restore() {
    setActiveTerminal(lastActive.id);
    setTerminalOpen(true);
  }

  return (
    <button
      className="flex h-10 shrink-0 items-center gap-2 border-t border-emerald-400/30 bg-zinc-950 px-3 text-left text-emerald-100 shadow-[0_-1px_0_rgba(52,211,153,0.18)] hover:bg-zinc-900"
      onClick={restore}
      title="Restore terminal"
    >
      <ChevronUp className="h-4 w-4 text-emerald-300" />
      <SquareTerminal className="h-4 w-4 text-emerald-300" />
      <span className="text-sm font-medium">Terminal</span>
      <Badge className="border-emerald-400/40 bg-emerald-500/15 text-emerald-100">{sessions.length}</Badge>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-200/85">
        {line ? `${lastActive.title || lastActive.projectName || "Shell"}: ${line}` : lastActive.cwd}
      </span>
    </button>
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
  const setActiveTerminal = useAppStore((state) => state.setActiveTerminal);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const terminalDock = useAppStore((state) => state.settings.terminalDock);
  const themeMode = useAppStore((state) => state.settings.themeMode);
  const [poppedOutTerminalIds, setPoppedOutTerminalIds] = useState(readPoppedOutTerminalIds);
  const terminalSideDocked = terminalOpen && (terminalDock === "left" || terminalDock === "right");
  const terminalBottomOrFloating = terminalOpen && !terminalSideDocked;
  useThemeMode(themeMode);

  const updatePoppedOutTerminalIds = useCallback((updater: (ids: Set<string>) => Set<string>) => {
    setPoppedOutTerminalIds((current) => {
      const next = updater(new Set(current));
      writePoppedOutTerminalIds(next);
      return next;
    });
  }, []);

  const dockTerminal = useCallback(
    (terminalId?: string) => {
      if (terminalId) {
        updatePoppedOutTerminalIds((ids) => {
          ids.delete(terminalId);
          return ids;
        });
        setActiveTerminal(terminalId);
      }
      setTerminalOpen(true);
      window.focus();
    },
    [setActiveTerminal, setTerminalOpen, updatePoppedOutTerminalIds]
  );

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
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; terminalId?: string } | undefined;
      if (data?.type === TERMINAL_DOCK_MESSAGE) dockTerminal(data.terminalId);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === TERMINAL_DOCK_STORAGE_KEY) dockTerminal(readTerminalDockRequest(event.newValue).terminalId);
      if (event.key === TERMINAL_POPOUT_STORAGE_KEY) setPoppedOutTerminalIds(readPoppedOutTerminalIds());
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
    };
  }, [dockTerminal]);

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
        {terminalSideDocked && terminalDock === "left" && (
          <TerminalPanel poppedOutTerminalIds={poppedOutTerminalIds} />
        )}
        <Sidebar />
        <AgentPanel />
        {terminalSideDocked && terminalDock === "right" && (
          <TerminalPanel poppedOutTerminalIds={poppedOutTerminalIds} />
        )}
      </div>
      {terminalBottomOrFloating && <TerminalPanel poppedOutTerminalIds={poppedOutTerminalIds} />}
      {!terminalOpen && <TerminalMinimizedDock poppedOutTerminalIds={poppedOutTerminalIds} />}
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
  const setActiveTerminal = useAppStore((state) => state.setActiveTerminal);
  const addError = useAppStore((state) => state.addError);
  const themeMode = useAppStore((state) => state.settings.themeMode);
  const params = new URLSearchParams(window.location.search);
  const requestedProjectId = params.get("projectId") || undefined;
  const requestedTerminalId = params.get("terminalId") || undefined;
  useThemeMode(themeMode);

  useEffect(() => {
    void Promise.all([api.projects(), api.capabilities(), api.settings()])
      .then(([projects, capabilities, settings]) => {
        setProjects(projects);
        setCapabilities(capabilities);
        setSettings(settings);
        if (requestedProjectId && projects.some((project) => project.id === requestedProjectId)) {
          setSelectedProject(requestedProjectId);
        }
        if (requestedTerminalId) setActiveTerminal(requestedTerminalId);
      })
      .catch((error: unknown) => addError(error instanceof Error ? error.message : String(error)));
    connectWebSocket();
    return () => disconnectWebSocket();
  }, [addError, requestedProjectId, requestedTerminalId, setActiveTerminal, setCapabilities, setProjects, setSelectedProject, setSettings]);

  useEffect(() => {
    if (!requestedTerminalId) return;
    const onBeforeUnload = () => notifyTerminalDock(requestedTerminalId);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [requestedTerminalId]);

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      <TerminalPanel popout popoutTerminalId={requestedTerminalId} />
      <ErrorStack />
    </div>
  );
}
