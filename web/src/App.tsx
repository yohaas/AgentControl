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
  type CSSProperties,
  type ReactNode,
  type UIEvent as ReactUIEvent
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diffLanguage from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Terminal as XTerm } from "@xterm/xterm";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDownAZ,
  ArrowUp,
  TriangleAlert,
  BellPlus,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleArrowDown,
  Clipboard,
  ClipboardList,
  Code2,
  CodeXml,
  Columns2,
  Copy,
  CornerDownRight,
  ExternalLink,
  Eye,
  File as FileIcon,
  FileCode2,
  FileStack,
  FileText,
  FolderDown,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Forward,
  GitBranch,
  GripVertical,
  Gauge,
  HardDrive,
  Hand,
  Home,
  Info,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Maximize2,
  MessageCircle,
  MessageSquare,
  Minimize2,
  EllipsisVertical,
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
  Save,
  Settings,
  Sparkles,
  Square,
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
  AppUpdateStatus,
  ClaudePluginCatalog,
  DirectoryEntry,
  DirectoryListing,
  GitStatus,
  GitWorktreeList,
  LaunchRequest,
  MessageAttachment,
  ModelProfile,
  PermissionAllowRule,
  Project,
  ProjectDiffResponse,
  ProjectFileEntry,
  ProjectFileResponse,
  ProjectTreeEntry,
  RunningAgent,
  SlashCommandInfo,
  TerminalSession,
  TokenUsage,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "./components/ui/dropdown-menu";
import { Input } from "./components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./components/ui/select";
import { Textarea } from "./components/ui/textarea";
import { getSelectionInRoot, useTextSelection } from "./hooks/use-text-selection";
import { api } from "./lib/api";
import { cn, downloadText, formatDuration, prettyJson } from "./lib/utils";
import { connectWebSocket, disconnectWebSocket, sendCommand } from "./lib/ws-client";
import {
  useAppStore,
  type ClaudeRuntime,
  type FileExplorerDockPosition,
  type MenuDisplayMode,
  type QueuedMessage,
  type SettingsState,
  type ThemeMode,
  type TileScrollingMode
} from "./store/app-store";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const EMPTY_TRANSCRIPT: TranscriptEvent[] = [];
const EMPTY_QUEUE: QueuedMessage[] = [];
const TERMINAL_DOCK_MESSAGE = "agent-control:dock-terminal";
const TERMINAL_DOCK_STORAGE_KEY = "agent-control-terminal-dock-request";
const TERMINAL_POPOUT_STORAGE_KEY = "agent-control-popped-out-terminals";
const TERMINAL_POPOUT_EXPLICIT_HIDE_STORAGE_KEY = "agent-control-terminal-popout-explicit-hide";
const FILE_EXPLORER_POPOUT_STORAGE_KEY = "agent-control-file-explorer-popout";
const DEFAULT_BUILT_IN_AGENT_DIR = ".agent-control/built-in-agents";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diffLanguage);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
const THINKING_PHRASES: Record<AgentProvider, string[]> = {
  claude: [
    "Discombobulating",
    "Cogitating",
    "Triangulating",
    "Untangling",
    "Percolating",
    "Recalibrating",
    "Synthesizing",
    "Mulling",
    "Connecting dots"
  ],
  codex: ["Inspecting", "Planning", "Patching", "Tracing", "Refactoring", "Testing", "Verifying", "Reviewing", "Applying changes"],
  openai: ["Reasoning", "Analyzing", "Researching", "Drafting", "Checking", "Synthesizing", "Evaluating", "Composing", "Reviewing"]
};

function isGitCredentialPromptError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Git push needs credentials|terminal prompts (have been )?disabled|could not read Username|Authentication failed/i.test(message);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function languageForPath(pathValue: string, mimeType?: string): string | undefined {
  const lower = pathValue.toLowerCase();
  if (mimeType?.includes("json") || lower.endsWith(".json")) return "json";
  if (mimeType?.includes("markdown") || /\.(md|markdown)$/.test(lower)) return "markdown";
  if (mimeType?.includes("typescript") || /\.(ts|tsx|mts|cts)$/.test(lower)) return "typescript";
  if (mimeType?.includes("javascript") || /\.(js|jsx|mjs|cjs)$/.test(lower)) return "javascript";
  if (mimeType?.includes("html") || /\.(html|htm|xml|svg)$/.test(lower)) return "xml";
  if (mimeType?.includes("css") || lower.endsWith(".css")) return "css";
  if (/\.(ya?ml)$/.test(lower)) return "yaml";
  if (/\.(sh|bash|zsh)$/.test(lower)) return "bash";
  if (/\.(ps1|psm1|psd1)$/.test(lower)) return "powershell";
  if (lower.endsWith(".diff") || lower.endsWith(".patch")) return "diff";
  return undefined;
}

function highlightedHtml(text = "", pathValue = "", mimeType?: string): string {
  const language = languageForPath(pathValue, mimeType);
  try {
    if (language && hljs.getLanguage(language)) return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    return hljs.highlightAuto(text).value;
  } catch {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

function HighlightedCodeBlock({ content = "", path, mimeType }: { content?: string; path: string; mimeType?: string }) {
  const lineCount = Math.max(1, content.split(/\r?\n/).length);
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] overflow-auto rounded-md bg-muted/40 font-mono text-xs leading-5">
      <pre className="select-none border-r border-border/70 px-3 py-3 text-right text-muted-foreground">
        {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
      </pre>
      <pre
        className="syntax-highlight min-w-0 whitespace-pre-wrap break-words p-3"
        dangerouslySetInnerHTML={{ __html: highlightedHtml(content, path, mimeType) }}
      />
    </div>
  );
}

interface SideBySideDiffRow {
  kind: "hunk" | "context" | "remove" | "add" | "change";
  oldLine?: number;
  newLine?: number;
  oldText?: string;
  newText?: string;
  header?: string;
}

function parseUnifiedDiff(diffText: string): SideBySideDiffRow[] {
  const rows: SideBySideDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let pendingRemovals: SideBySideDiffRow[] = [];

  function flushRemovals() {
    rows.push(...pendingRemovals);
    pendingRemovals = [];
  }

  for (const line of diffText.split(/\r?\n/)) {
    if (/^diff --git|^index |^--- |\+\+\+ /.test(line)) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      flushRemovals();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", header: line });
      continue;
    }
    if (line.startsWith("-")) {
      pendingRemovals.push({ kind: "remove", oldLine: oldLine++, oldText: line.slice(1) });
      continue;
    }
    if (line.startsWith("+")) {
      const removed = pendingRemovals.shift();
      if (removed) {
        rows.push({ kind: "change", oldLine: removed.oldLine, newLine: newLine++, oldText: removed.oldText, newText: line.slice(1) });
      } else {
        rows.push({ kind: "add", newLine: newLine++, newText: line.slice(1) });
      }
      continue;
    }
    flushRemovals();
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, oldText: text, newText: text });
  }
  flushRemovals();
  return rows;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

const GENERAL_AGENT_DEF: AgentDef = {
  name: "general",
  description: "General-purpose engineering assistant",
  color: "#ffffff",
  provider: "claude",
  tools: [],
  systemPrompt: "",
  builtIn: true
};

type AgentDefSource = "project" | "builtIn";

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
type QuestionsEvent = Extract<TranscriptEvent, { kind: "questions" }>;
type PlanEvent = Extract<TranscriptEvent, { kind: "plan" }>;
type ToolTranscriptItem =
  | { kind: "single"; event: TranscriptEvent }
  | { kind: "tool_pair"; event: ToolUseEvent; result?: ToolResultEvent };
type ContextCopyTarget = { scope: "block" | "chat"; text: string };
type TranscriptViewMode = "chat" | "raw";
type PlanNextStepRole = "qa" | "security" | "docs" | "performance" | "product";
type PlanNextStep = {
  id: string;
  role: PlanNextStepRole;
  title: string;
  description: string;
  prompt: string;
  source: AgentDefSource;
  def: AgentDef;
};
type PlanNextStepState = { dismissed: boolean; completed: string[] };

const COMMON_SLASH_COMMANDS: SlashCommandSuggestion[] = [
  { value: "/clear", label: "/clear", description: "Clear this chat history", source: "agentcontrol" },
  { value: "/exit", label: "/exit", description: "Close this agent", source: "agentcontrol" },
  { value: "/stop", label: "/stop", description: "Stop the active response", source: "agentcontrol" },
  { value: "/interrupt", label: "/interrupt", description: "Stop the active response", source: "agentcontrol" },
  { value: "/status", label: "/status", description: "Show AgentControl session status", source: "agentcontrol" }
];

const CLAUDE_SLASH_COMMANDS: SlashCommandSuggestion[] = [
  { value: "/btw ", label: "/btw", description: "Inject a note into the active Claude response", argumentHint: "[message]", source: "agentcontrol" },
  { value: "/compact", label: "/compact", description: "Compact conversation context", argumentHint: "[instructions]", source: "builtin" },
  { value: "/memory", label: "/memory", description: "Edit or inspect memory files", source: "builtin", interactive: true },
  { value: "/resume", label: "/resume", description: "Resume a previous conversation", source: "builtin", interactive: true },
  { value: "/permissions", label: "/permissions", description: "Manage allow, ask, and deny rules", source: "builtin", interactive: true }
];

const CODEX_SLASH_COMMANDS: SlashCommandSuggestion[] = [
  { value: "/intelligence", label: "/intelligence", description: "Use the most capable Codex model", source: "agentcontrol" },
  { value: "/speed", label: "/speed", description: "Use the fastest Codex model available", source: "agentcontrol" },
  { value: "/effort low", label: "/effort low", description: "Use low Codex reasoning effort", source: "agentcontrol" },
  { value: "/effort medium", label: "/effort medium", description: "Use medium Codex reasoning effort", source: "agentcontrol" },
  { value: "/effort high", label: "/effort high", description: "Use high Codex reasoning effort", source: "agentcontrol" },
  { value: "/effort xhigh", label: "/effort xhigh", description: "Use extra-high Codex reasoning effort", source: "agentcontrol" }
];

const OPENAI_SLASH_COMMANDS: SlashCommandSuggestion[] = [
  { value: "/chatgpt", label: "/chatgpt", description: "Use the standard ChatGPT/OpenAI model", source: "agentcontrol" },
  { value: "/fast", label: "/fast", description: "Use a lower-latency OpenAI model", source: "agentcontrol" },
  { value: "/deep-research", label: "/deep-research", description: "Use OpenAI deep research", source: "agentcontrol" },
  { value: "/research-fast", label: "/research-fast", description: "Use faster OpenAI deep research", source: "agentcontrol" },
  { value: "/effort low", label: "/effort low", description: "Use low OpenAI reasoning effort", source: "agentcontrol" },
  { value: "/effort medium", label: "/effort medium", description: "Use medium OpenAI reasoning effort", source: "agentcontrol" },
  { value: "/effort high", label: "/effort high", description: "Use high OpenAI reasoning effort", source: "agentcontrol" },
  { value: "/effort xhigh", label: "/effort xhigh", description: "Use extra-high OpenAI reasoning effort", source: "agentcontrol" }
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

function slashCommandMatchesProvider(command: SlashCommandInfo, provider: AgentProvider) {
  if (provider === "claude") return true;
  if (provider === "openai") return false;
  if (command.source === "session") return true;
  const sourcePath = command.sourcePath?.replace(/\\/g, "/").toLowerCase();
  return Boolean(sourcePath?.includes("/.codex/") || sourcePath?.includes("/.codex-plugin/"));
}

const TERMINAL_DOCK_OPTIONS = [
  { value: "float", label: "Pop out", icon: PictureInPicture2 },
  { value: "left", label: "Dock left", icon: PanelLeft },
  { value: "bottom", label: "Dock bottom", icon: PanelBottom },
  { value: "right", label: "Dock right", icon: PanelRight }
] as const;
const TILE_MIN_HEIGHT = 240;
const TILE_MAX_HEIGHT = 2000;

function applyThemeMode(themeMode: ThemeMode) {
  const root = document.documentElement;
  const autoDark = themeMode === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.classList.toggle("light", themeMode === "light");
  root.classList.toggle("dark", themeMode === "dark" || autoDark);
  root.style.colorScheme = themeMode === "auto" ? "light dark" : themeMode;
}

function useThemeMode(themeMode: ThemeMode) {
  useEffect(() => {
    applyThemeMode(themeMode);
    if (themeMode !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyAutoTheme = () => applyThemeMode("auto");
    media.addEventListener("change", applyAutoTheme);
    return () => media.removeEventListener("change", applyAutoTheme);
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
    return JSON.parse(value || "{}") as { terminalId?: string; dock?: boolean; hide?: boolean; nextDock?: "left" | "bottom" | "right" };
  } catch {
    return {};
  }
}

function notifyTerminalDock(terminalId?: string, focusOpener = false, dock = false, nextDock?: "left" | "bottom" | "right", hide = false) {
  const payload = { type: TERMINAL_DOCK_MESSAGE, terminalId, dock, hide, nextDock };
  try {
    window.opener?.postMessage(payload, window.location.origin);
    if (focusOpener) window.opener?.focus();
  } catch {
    // Fall back to a storage event for browsers that block opener access.
  }
  window.localStorage.setItem(TERMINAL_DOCK_STORAGE_KEY, JSON.stringify({ terminalId, dock, hide, nextDock, at: Date.now() }));
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number) {
  let value = seed || 1;
  return () => {
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledThinkingPhrases(provider: AgentProvider | undefined, agentId: string) {
  const phrases = [...THINKING_PHRASES[provider || "claude"]];
  const random = seededRandom(hashString(`${provider || "claude"}:${agentId}`));
  for (let index = phrases.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [phrases[index], phrases[swapIndex]] = [phrases[swapIndex], phrases[index]];
  }
  return phrases;
}

function useThinkingPhrase(agent: RunningAgent, active = true) {
  const phrases = useMemo(() => shuffledThinkingPhrases(agent.provider, agent.id), [agent.id, agent.provider]);
  const [index, setIndex] = useState(() => hashString(`${agent.id}:${agent.turnStartedAt || ""}`) % phrases.length);

  useEffect(() => {
    setIndex(hashString(`${agent.id}:${agent.turnStartedAt || ""}`) % phrases.length);
  }, [agent.id, agent.turnStartedAt, phrases.length]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      setIndex((value) => (value + 1) % phrases.length);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [active, phrases.length]);

  return phrases[index];
}

function useElapsedSeconds(startedAt?: string) {
  const fallbackStartedAt = useRef(Date.now());
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const startedMs = startedAt ? Date.parse(startedAt) : fallbackStartedAt.current;
  if (!Number.isFinite(startedMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startedMs) / 1000));
}

function formatElapsed(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatTokenCount(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(value);
}

function formatTokenUsage(usage?: TokenUsage) {
  if (!usage) return "";
  const parts = [
    usage.inputTokens !== undefined ? `in ${formatTokenCount(usage.inputTokens)}` : "",
    usage.outputTokens !== undefined ? `out ${formatTokenCount(usage.outputTokens)}` : "",
    usage.cacheReadInputTokens !== undefined ? `cache ${formatTokenCount(usage.cacheReadInputTokens)}` : "",
    usage.totalTokens !== undefined ? `total ${formatTokenCount(usage.totalTokens)}` : ""
  ].filter(Boolean);
  return parts.join(" / ");
}

function ThinkingText({ agent, prefix, startedAt, usage }: { agent: RunningAgent; prefix?: string; startedAt?: string; usage?: TokenUsage }) {
  const phrase = useThinkingPhrase(agent);
  const elapsed = useElapsedSeconds(startedAt);
  const tokenUsage = formatTokenUsage(usage);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-primary">
      {prefix && <span>{prefix}</span>}
      <span>{phrase}</span>
      <span className="inline-flex w-4 animate-pulse">...</span>
      <span className="font-mono text-[11px] text-muted-foreground">{formatElapsed(elapsed)}</span>
      {tokenUsage && <span className="text-[11px] text-muted-foreground">· {tokenUsage}</span>}
    </span>
  );
}

function isAgentBusy(agent: RunningAgent) {
  return (
    agent.status === "running" ||
    agent.status === "starting" ||
    agent.status === "switching-model" ||
    agent.status === "awaiting-permission" ||
    agent.status === "awaiting-input"
  );
}

function agentNeedsInput(agent: RunningAgent) {
  return agent.status === "awaiting-permission" || agent.status === "awaiting-input";
}

function hasStreamingAssistantText(transcript: TranscriptEvent[]) {
  return transcript.some((event) => event.kind === "assistant_text" && event.streaming);
}

function executingPlanPhase(transcript: TranscriptEvent[]) {
  let planIndex = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const event = transcript[index];
    if (event.kind === "plan" && event.answered && event.decision === "approve") {
      planIndex = index;
      break;
    }
  }
  if (planIndex < 0) return undefined;
  let phase = 1;
  for (const event of transcript.slice(planIndex + 1)) {
    const text =
      event.kind === "assistant_text"
        ? event.text
        : event.kind === "tool_use"
          ? `${event.name}\n${compactToolText(event.input, 1200)}`
          : event.kind === "tool_result"
            ? compactToolText(event.output, 1200)
            : "";
    for (const match of text.matchAll(/\bphase\s+(\d{1,2})\b/gi)) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) phase = parsed;
    }
  }
  return `Executing Phase ${phase}`;
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

function scrollToLatestUserMessage(root: HTMLDivElement | null) {
  root?.querySelector<HTMLElement>('[data-latest-user-message="true"]')?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function isNearScrollBottom(root: HTMLDivElement, threshold = 48) {
  return root.scrollHeight - root.scrollTop - root.clientHeight <= threshold;
}

function scrollTranscriptToBottom(root: HTMLDivElement | null) {
  root?.scrollTo({ top: root.scrollHeight, behavior: "smooth" });
}

function AgentActivityIndicator({ agent, compact = false, phaseLabel }: { agent: RunningAgent; compact?: boolean; phaseLabel?: string }) {
  return (
    <div className="flex">
      <div
        className={cn(
          "inline-flex min-w-0 flex-col items-start gap-1 rounded-md border border-border bg-background/70 px-3 py-2",
          compact ? "text-xs" : "text-sm"
        )}
        style={{ borderLeftColor: agentAccentColor(agent.color), borderLeftWidth: 4 }}
      >
        {phaseLabel && <span className="text-[11px] font-medium uppercase tracking-normal text-muted-foreground">{phaseLabel}</span>}
        <ThinkingText agent={agent} startedAt={agent.turnStartedAt} usage={agent.lastTokenUsage} />
      </div>
    </div>
  );
}

function isLightAgentColor(color: string) {
  const value = color.trim().toLowerCase();
  if (value === "white") return true;
  const hex = value.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) return false;
  const expanded = hex.length === 3 ? hex.split("").map((char) => char + char).join("") : hex;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 235;
}

function agentAccentColor(color: string) {
  return isLightAgentColor(color) ? "hsl(var(--foreground))" : color;
}

function AgentDot({ color, className }: { color: string; className?: string }) {
  const needsContrast = isLightAgentColor(color);
  return (
    <span
      className={cn(
        "h-3 w-3 shrink-0 rounded-full",
        className,
        needsContrast && "border border-neutral-950 dark:border-border"
      )}
      style={{ background: color }}
    />
  );
}

function ActiveAgentDot({ agent, className }: { agent: RunningAgent; className?: string }) {
  const busy = isAgentBusy(agent);
  const needsContrast = isLightAgentColor(agent.color);
  const needsInput = agentNeedsInput(agent);
  return (
    <span
      className={cn(
        "relative h-3 w-3 shrink-0 rounded-full",
        busy && "animate-pulse",
        className,
        needsContrast && "border border-neutral-950 dark:border-border"
      )}
      style={{ background: agent.color }}
    >
      {busy && (
        <span
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 w-1/2 animate-agent-dot-wave bg-gradient-to-r from-transparent to-transparent",
            needsContrast ? "via-neutral-950/80" : "via-white/80"
          )}
        />
      )}
      {needsInput && (
        <TriangleAlert
          className="pointer-events-none absolute -left-1.5 -top-1.5 z-10 h-3.5 w-3.5 fill-background text-amber-500 drop-shadow-sm"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

function CodexLogo({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" fillRule="evenodd" viewBox="0 0 24 24" aria-hidden="true">
      <path
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  );
}

function OpenAiLogo({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" fillRule="evenodd" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  );
}

function ProviderIcon({
  provider,
  className,
  iconClassName
}: {
  provider?: AgentProvider;
  className?: string;
  iconClassName?: string;
}) {
  const resolvedProvider = provider || "claude";
  const Icon = resolvedProvider === "openai" ? OpenAiLogo : resolvedProvider === "codex" ? CodexLogo : Sparkles;
  const label = providerLabel(resolvedProvider);
  return (
    <span
      className={cn(
        "inline-grid h-4 w-4 shrink-0 place-items-center rounded-sm border",
        resolvedProvider === "openai" && "border-neutral-400/40 bg-neutral-500/10 text-neutral-950 dark:text-white",
        resolvedProvider === "codex" && "border-sky-400/40 bg-sky-500/10 text-sky-500",
        resolvedProvider === "claude" && "border-orange-400/40 bg-orange-500/10 text-orange-500",
        className
      )}
      title={label}
      aria-label={label}
    >
      <Icon className={cn("h-3 w-3", iconClassName)} />
    </span>
  );
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

function StatusPill({
  status,
  done = false,
  onResume,
  onRestart
}: {
  status: RunningAgent["status"];
  done?: boolean;
  onResume?: () => void;
  onRestart?: () => void;
}) {
  const label =
    status === "idle" && done
      ? "Done"
      : status === "running"
      ? "Active"
      : status === "starting"
        ? "Starting"
        : status === "switching-model"
          ? "Switching"
          : status === "awaiting-permission"
            ? "Needs approval"
            : status === "awaiting-input"
              ? "Needs answer"
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
    status === "idle" && done
      ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400/40 dark:text-emerald-200"
      : status === "running"
      ? "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:border-blue-400/40 dark:bg-blue-500/15 dark:text-blue-200 animate-pulse"
      : status === "idle"
        ? "border-zinc-500/40 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300"
        : status === "awaiting-permission" || status === "awaiting-input"
          ? "border-amber-500/50 bg-amber-500/15 text-amber-800 dark:border-amber-400/40 dark:text-amber-200"
          : status === "error"
            ? "border-red-500/50 bg-red-500/15 text-red-700 dark:border-red-400/40 dark:text-red-200"
            : status === "killed"
              ? "border-zinc-400 bg-zinc-500/10 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500"
              : status === "interrupted"
                ? "border-amber-500/50 bg-amber-500/15 text-amber-800 dark:border-amber-400/40 dark:text-amber-200"
              : status === "paused"
                ? "border-purple-500/50 bg-purple-500/15 text-purple-700 dark:border-purple-400/40 dark:text-purple-200"
                : "border-teal-500/50 bg-teal-500/15 text-teal-700 dark:border-teal-400/40 dark:text-teal-200";
  const canResume = status === "paused" && Boolean(onResume);
  const canRestart = status === "error" && Boolean(onRestart);
  const interactive = canResume || canRestart;
  const action = canResume ? onResume : canRestart ? onRestart : undefined;
  const title = canResume ? "Resume chat" : canRestart ? "Restart chat" : undefined;
  return (
    <Badge
      className={cn(
        "inline-flex items-center gap-1 capitalize",
        className,
        canResume && "cursor-pointer hover:bg-purple-500/25",
        canRestart && "cursor-pointer hover:bg-red-500/25"
      )}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      title={title}
      onClick={(event) => {
        if (!interactive) return;
        event.preventDefault();
        event.stopPropagation();
        action?.();
      }}
      onKeyDown={(event) => {
        if (!interactive || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        action?.();
      }}
    >
      {canResume && <Play className="h-3 w-3" />}
      {canRestart && <RefreshCw className="h-3 w-3" />}
      {label}
    </Badge>
  );
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

  const questionToolUseIds = questionToolUseIdSet(transcripts);
  const planToolUseIds = planToolUseIdSet(transcripts);
  return transcripts
    .filter((event) => event.kind !== "tool_result" || (!questionToolUseIds.has(event.toolUseId) && !planToolUseIds.has(event.toolUseId)))
    .map((event) => {
      if (event.kind === "assistant_text") return `Assistant (${event.model || agent.currentModel}):\n${event.text}`;
      if (event.kind === "user") return `User:\n${event.text}`;
      if (event.kind === "tool_use") return `Tool Use: ${event.name}\n${prettyJson(event.input)}`;
      if (event.kind === "tool_result") return `Tool Result:\n${prettyJson(event.output)}`;
      if (event.kind === "questions") return questionEventPlainText(event);
      if (event.kind === "plan") return planEventPlainText(event);
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
  if (event.kind === "questions") return questionEventPlainText(event);
  if (event.kind === "plan") return planEventPlainText(event);
  if (event.kind === "model_switch") return `System: switched to ${event.to}`;
  return `System:\n${event.text}`;
}

function questionEventPlainText(event: QuestionsEvent) {
  return [
    "Questions:",
    ...event.questions.map((question, index) => {
      const answer = event.answers?.find((item) => item.questionIndex === index);
      return [
        `${index + 1}. ${question.header || question.question}`,
        question.question,
        ...question.options.map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`),
        answer?.labels.length ? `Selected: ${answer.labels.join(", ")}` : undefined,
        answer?.otherText ? `Other: ${answer.otherText}` : undefined
      ]
        .filter(Boolean)
        .join("\n");
    })
  ].join("\n\n");
}

function planEventPlainText(event: PlanEvent) {
  return [
    "Plan:",
    event.plan,
    event.decision ? `Decision: ${event.decision}` : undefined,
    event.response ? `Response: ${event.response}` : undefined
  ]
    .filter(Boolean)
    .join("\n\n");
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
  const questionToolUseIds = questionToolUseIdSet(transcript);
  const planToolUseIds = planToolUseIdSet(transcript);
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
      if (event.kind === "tool_result" && (usedResults.has(event.id) || questionToolUseIds.has(event.toolUseId) || planToolUseIds.has(event.toolUseId))) return undefined;
      return { kind: "single", event };
    })
    .filter((item): item is ToolTranscriptItem => Boolean(item));
}

function shouldExpandTranscriptItemByDefault(item: ToolTranscriptItem, index: number, items: ToolTranscriptItem[]) {
  return index === items.length - 1 && item.kind === "single" && item.event.kind === "assistant_text" && !item.event.streaming;
}

function questionToolUseIdSet(transcript: TranscriptEvent[]) {
  return new Set(
    transcript
      .filter((event): event is QuestionsEvent => event.kind === "questions" && Boolean(event.toolUseId))
      .map((event) => event.toolUseId as string)
  );
}

function planToolUseIdSet(transcript: TranscriptEvent[]) {
  return new Set(
    transcript
      .filter((event): event is PlanEvent => event.kind === "plan" && Boolean(event.toolUseId))
      .map((event) => event.toolUseId as string)
  );
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

function displayPathName(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function toolActivityText(event: ToolUseEvent, result?: ToolResultEvent) {
  const name = event.name.toLowerCase();
  const pathText = toolPath(event.input);
  const commandText = fieldText(event.input, ["command"]);
  const target = pathText ? displayPathName(pathText) : "";
  if (name.includes("edit")) return target ? `Edited ${target}` : "Edited a file";
  if (name.includes("write")) return target ? `Wrote ${target}` : "Wrote a file";
  if (name.includes("read")) return target ? `Read ${target}` : "Read a file";
  if (name.includes("bash")) return commandText ? `Ran ${commandText}` : "Ran a shell command";
  if (name.includes("grep") || name.includes("search")) return fieldText(event.input, ["pattern", "query"]) || "Searched files";
  if (name.includes("glob")) return fieldText(event.input, ["pattern"]) || "Matched files";
  const summary = result ? toolSummary(result) : toolUseSummary(event);
  return summary || `Used ${event.name}`;
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

function draftLineCount(text: string) {
  return text.length === 0 ? 1 : text.split(/\r?\n/).length;
}

function composerNeedsExpansion(textarea: HTMLTextAreaElement | null, collapsedHeight: number) {
  if (!textarea) return false;
  return textarea.scrollHeight > collapsedHeight + 4;
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
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
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
                    aria-label="Steer"
                    title="Steer this queued message into the active response"
                    onClick={() => {
                      sendCommand({ type: "injectMessage", id: agentId, text: message.text, attachments: message.attachments });
                      removeQueuedMessage(agentId, message.id);
                    }}
                  >
                    <CornerDownRight className="h-3.5 w-3.5" />
                  </Button>
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

function useQueuedMessageSender(agent: RunningAgent, queue: QueuedMessage[], canType?: boolean) {
  const popNextQueuedMessage = useAppStore((state) => state.popNextQueuedMessage);
  const isBusy = isAgentBusy(agent);
  const queuedTurnInFlightRef = useRef(false);
  const wasBusyRef = useRef(isBusy);

  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    if (!isBusy && wasBusy && queuedTurnInFlightRef.current) {
      queuedTurnInFlightRef.current = false;
    }
    wasBusyRef.current = isBusy;

    if (isBusy || !canType || queue.length === 0 || queuedTurnInFlightRef.current) return;
    const next = popNextQueuedMessage(agent.id);
    if (!next) return;
    queuedTurnInFlightRef.current = true;
    sendCommand({ type: "userMessage", id: agent.id, text: next.text, attachments: next.attachments });
  }, [agent.id, canType, isBusy, popNextQueuedMessage, queue.length]);
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
          if (event.kind === "questions") return `### Questions · ${time}\n\n${questionEventPlainText(event)}`;
          if (event.kind === "plan") return `### Plan · ${time}\n\n${planEventPlainText(event)}`;
          if (event.kind === "model_switch") return `---\n\nswitched to ${event.to}`;
          return `### System · ${time}\n\n${event.text}`;
        })
      ];
  downloadText(`${agent.displayName}.md`, lines.join("\n\n"), "text/markdown");
}

function ExportChatMenu({
  agent,
  transcripts,
  addError
}: {
  agent: RunningAgent;
  transcripts: TranscriptEvent[];
  addError: (message: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="justify-between gap-3">
        <span className="flex items-center">
          <FolderDown className="mr-2 h-4 w-4" />
          Export Chat
        </span>
        <ChevronRight className="h-4 w-4" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem onClick={() => exportAgentJson(agent, transcripts)}>JSON</DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportAgentMarkdown(agent, transcripts)}>Markdown</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void exportAgentRawStream(agent, addError)}>Raw Stream</DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function duplicateAgentRequest(agent: RunningAgent, settings: SettingsState): LaunchRequest {
  return {
    projectId: agent.projectId,
    defName: agent.defName,
    displayName: agent.displayName,
    provider: agent.provider,
    model: agent.currentModel,
    remoteControl: false,
    permissionMode: agent.permissionMode || settings.defaultAgentMode,
    effort: agent.effort,
    thinking: agent.thinking,
    autoApprove: settings.autoApprove
  };
}

function AgentActionsMenu({
  agent,
  transcripts,
  viewMode,
  onToggleViewMode
}: {
  agent: RunningAgent;
  transcripts: TranscriptEvent[];
  viewMode: TranscriptViewMode;
  onToggleViewMode: () => void;
}) {
  const addError = useAppStore((state) => state.addError);
  const settings = useAppStore((state) => state.settings);
  const isBusy = isAgentBusy(agent);

  function duplicateAgent() {
    sendCommand({ type: "launch", request: duplicateAgentRequest(agent, settings) });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" title="Agent actions">
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {agent.restorable && (
          <DropdownMenuItem onClick={() => sendCommand({ type: "resume", id: agent.id })}>
            <Play className="mr-2 h-4 w-4" />
            Resume
          </DropdownMenuItem>
        )}
        {isBusy && (
          <DropdownMenuItem onClick={() => sendCommand({ type: "interrupt", id: agent.id })}>
            <Square className="mr-2 h-4 w-4" />
            Stop response
          </DropdownMenuItem>
        )}
        {!agent.remoteControl && (
          <DropdownMenuItem onClick={onToggleViewMode}>
            {viewMode === "chat" ? <CodeXml className="mr-2 h-4 w-4" /> : <MessageCircle className="mr-2 h-4 w-4" />}
            {viewMode === "chat" ? "View Raw Stream" : "View Chat"}
          </DropdownMenuItem>
        )}
        <ExportChatMenu agent={agent} transcripts={transcripts} addError={addError} />
        <DropdownMenuItem onClick={duplicateAgent}>
          <Copy className="mr-2 h-4 w-4" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => sendCommand({ type: "clear", id: agent.id })}>
          <Trash2 className="mr-2 h-4 w-4" />
          Clear Chat
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => sendCommand({ type: "kill", id: agent.id })}>
          <X className="mr-2 h-4 w-4" />
          Close Chat
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function handleNativeSlashCommand(agent: RunningAgent, text: string) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const [command, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  const provider = agent.provider || "claude";
  const settings = useAppStore.getState().settings;

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
  if (command === "effort" && isAgentEffort(arg)) {
    sendCommand({ type: "setEffort", id: agent.id, effort: arg });
    return true;
  }
  if (provider === "codex" && (command === "speed" || command === "fast")) {
    sendCommand({ type: "setModel", id: agent.id, model: preferredProviderModeModel(settings, "codex", "speed") });
    return true;
  }
  if (provider === "codex" && (command === "intelligence" || command === "smart")) {
    sendCommand({ type: "setModel", id: agent.id, model: preferredProviderModeModel(settings, "codex", "intelligence") });
    return true;
  }
  if (provider === "openai" && (command === "chatgpt" || command === "standard")) {
    sendCommand({ type: "setModel", id: agent.id, model: preferredProviderModeModel(settings, "openai", "standard") });
    return true;
  }
  if (provider === "openai" && command === "fast") {
    sendCommand({ type: "setModel", id: agent.id, model: preferredProviderModeModel(settings, "openai", "fast") });
    return true;
  }
  if (provider === "openai" && (command === "deep-research" || command === "research")) {
    sendCommand({ type: "setModel", id: agent.id, model: preferredProviderModeModel(settings, "openai", "deepResearch") });
    return true;
  }
  if (provider === "openai" && (command === "research-fast" || command === "fast-research")) {
    sendCommand({ type: "setModel", id: agent.id, model: preferredProviderModeModel(settings, "openai", "fastResearch") });
    return true;
  }
  return false;
}

function injectedMessageText(agent: RunningAgent, text: string): string | undefined {
  const trimmed = text.trim();
  const provider = agent.provider || "claude";
  if (provider === "claude") {
    const match = trimmed.match(/^\/btw(?:\s+([\s\S]+))?$/i);
    return match?.[1]?.trim() || undefined;
  }
  return undefined;
}

function slashCommandSuggestions(
  draft: string,
  models: string[],
  sessionCommands: Array<SlashCommandInfo | string> = [],
  provider: AgentProvider = "claude",
  forceOpen = false
): SlashCommandSuggestion[] {
  const trimmed = draft.trimStart();
  if (!forceOpen && trimmed.includes("\n")) return [];
  if (!forceOpen && !trimmed.startsWith("/")) return [];
  const query = forceOpen ? "" : trimmed.startsWith("/") ? trimmed.slice(1).toLowerCase() : trimmed.toLowerCase();
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

  const modelCommands: SlashCommandSuggestion[] = models.slice(0, 20).map((model) => ({
    value: `/model ${model}`,
    label: `/model ${model}`,
    description: "Switch this agent to this model",
    source: "builtin"
  }));
  const providerSessionCommands = sessionCommands.map(normalizeUiSlashCommand).filter((command) => slashCommandMatchesProvider(command, provider));
  const commands = [
    ...baseSlashCommandsForProvider(provider),
    ...providerSessionCommands.map((normalized) => {
      return {
        value: slashCommandInsertValue(normalized),
        label: normalized.command,
        description: normalized.description || `Pass through to ${providerLabel(provider)}`,
        argumentHint: normalized.argumentHint,
        source: normalized.source,
        interactive: normalized.interactive,
        disabled: normalized.interactive,
        disabledReason: normalized.interactive ? `Requires ${providerLabel(provider)} TUI` : undefined
      };
    }),
    ...(forceOpen ? modelCommands : [{ value: "/model ", label: "/model", description: "Switch this agent to another model", argumentHint: "[model]", source: "builtin" as const }])
  ];
  const seen = new Set<string>();
  return commands
    .filter((command) => {
      const key = command.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      const label = command.label.startsWith("/") ? command.label.slice(1) : command.label;
      return label.toLowerCase().startsWith(query);
    })
    .sort((left, right) => compareSlashCommands(left.label, right.label))
    .slice(0, 60);
}

function baseSlashCommandsForProvider(provider: AgentProvider): SlashCommandSuggestion[] {
  if (provider === "codex") return [...COMMON_SLASH_COMMANDS, ...CODEX_SLASH_COMMANDS];
  if (provider === "openai") return [...COMMON_SLASH_COMMANDS, ...OPENAI_SLASH_COMMANDS];
  return [...COMMON_SLASH_COMMANDS, ...CLAUDE_SLASH_COMMANDS];
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
    <div className="relative z-[100] max-h-[min(44vh,360px)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
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
          {suggestion.disabled && (
            <Badge className="shrink-0 border-amber-500/50 bg-amber-500/10 text-[10px] uppercase text-amber-800 dark:border-amber-400/40 dark:text-amber-200">
              Requires TUI
            </Badge>
          )}
        </button>
      ))}
    </div>
  );
}

function agentsForProject(agentsById: Record<string, RunningAgent>, projectId?: string) {
  return Object.values(agentsById).filter((agent) => !projectId || agent.projectId === projectId);
}

function agentDefsWithBuiltIns(project?: { agents: AgentDef[]; builtInAgents?: AgentDef[] }) {
  const agents = [...(project?.agents || []), ...(project?.builtInAgents || [])];
  return agents.length > 0 ? agents : [GENERAL_AGENT_DEF];
}

function groupedAgentDefsWithBuiltIns(project?: { agents: AgentDef[]; builtInAgents?: AgentDef[] }) {
  const projectAgents = project?.agents || [];
  const builtInAgents = project?.builtInAgents?.length ? project.builtInAgents : [GENERAL_AGENT_DEF];
  return {
    projectAgents,
    builtInAgents
  };
}

function agentOptionKey(source: AgentDefSource, name: string) {
  return `${source}:${name}`;
}

function parseAgentOptionKey(value: string): { source: AgentDefSource; name: string } {
  const separatorIndex = value.indexOf(":");
  const source = value.slice(0, separatorIndex) === "builtIn" ? "builtIn" : "project";
  return { source, name: separatorIndex >= 0 ? value.slice(separatorIndex + 1) : value };
}

function findAgentOption(
  groups: { projectAgents: AgentDef[]; builtInAgents: AgentDef[] },
  source: AgentDefSource,
  name: string
) {
  return (source === "project" ? groups.projectAgents : groups.builtInAgents).find((candidate) => candidate.name === name);
}

function defaultLaunchAgentOption(groups: { projectAgents: AgentDef[]; builtInAgents: AgentDef[] }) {
  const builtInGeneral = groups.builtInAgents.find((agent) => agent.name.toLowerCase() === "general");
  if (builtInGeneral) return { source: "builtIn" as const, def: builtInGeneral };
  const projectGeneral = groups.projectAgents.find((agent) => agent.name.toLowerCase() === "general");
  if (projectGeneral) return { source: "project" as const, def: projectGeneral };
  if (groups.projectAgents[0]) return { source: "project" as const, def: groups.projectAgents[0] };
  return { source: "builtIn" as const, def: groups.builtInAgents[0] };
}

const PLAN_NEXT_STEP_ROLES: Array<{
  role: PlanNextStepRole;
  matches: RegExp[];
  title: string;
  description: string;
  prompt: string;
}> = [
  {
    role: "qa",
    matches: [/\bqa\b/i, /\bquality\b/i, /\btest/i],
    title: "Check with QA",
    description: "Look for test gaps, broken flows, and verification work.",
    prompt: "Please review this approved plan and the resulting implementation for QA risk. Focus on test coverage, regression cases, and what should be manually verified."
  },
  {
    role: "security",
    matches: [/\bsecurity\b/i, /\bsec\b/i, /\baudit\b/i, /\bauth\b/i],
    title: "Review security",
    description: "Check permissions, data handling, and risky edge cases.",
    prompt: "Please review this approved plan and the resulting implementation for security risk. Focus on authorization, secrets, data exposure, command execution, and unsafe defaults."
  },
  {
    role: "docs",
    matches: [/\bdocs?\b/i, /\bdocument/i, /\breadme\b/i],
    title: "Update docs",
    description: "Capture behavior changes in the right user-facing docs.",
    prompt: "Please review this approved plan and update any relevant docs or README sections. Keep the documentation concise and focused on behavior users need to know."
  },
  {
    role: "performance",
    matches: [/\bperformance\b/i, /\bperf\b/i, /\bspeed\b/i, /\blatency\b/i],
    title: "Check performance",
    description: "Look for slow paths, unnecessary work, and scaling risk.",
    prompt: "Please review this approved plan and the resulting implementation for performance risk. Focus on latency, repeated work, scaling behavior, and simple measurements worth running."
  },
  {
    role: "product",
    matches: [/\bproduct\b/i, /\bux\b/i, /\bui\b/i, /\bdesign\b/i],
    title: "Product pass",
    description: "Check user flow, copy, and expected edge cases.",
    prompt: "Please review this approved plan from a product and UX angle. Focus on whether the flow is clear, complete, and aligned with what users will expect."
  }
];

function planNextStepStorageKey(planId: string) {
  return `agent-control-plan-next-steps:${planId}`;
}

function usePlanNextStepState(planId: string): [PlanNextStepState, (next: PlanNextStepState) => void] {
  const storageKey = planNextStepStorageKey(planId);
  const [state, setState] = useState<PlanNextStepState>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return { dismissed: false, completed: [] };
      const parsed = JSON.parse(raw) as Partial<PlanNextStepState>;
      return {
        dismissed: Boolean(parsed.dismissed),
        completed: Array.isArray(parsed.completed) ? parsed.completed.filter((item): item is string => typeof item === "string") : []
      };
    } catch {
      return { dismissed: false, completed: [] };
    }
  });

  function update(next: PlanNextStepState) {
    setState(next);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  }

  return [state, update];
}

function agentMatchesRole(def: AgentDef, role: typeof PLAN_NEXT_STEP_ROLES[number]) {
  const text = [def.name, def.description || "", def.systemPrompt || ""].join("\n");
  return role.matches.some((pattern) => pattern.test(text));
}

function buildPlanNextSteps(groups: { projectAgents: AgentDef[]; builtInAgents: AgentDef[] }, currentAgent: RunningAgent): PlanNextStep[] {
  const orderedAgents = [
    ...groups.projectAgents.map((def) => ({ source: "project" as const, def })),
    ...groups.builtInAgents.map((def) => ({ source: "builtIn" as const, def }))
  ].filter((candidate) => candidate.def.name.toLowerCase() !== currentAgent.defName.toLowerCase());

  const steps: PlanNextStep[] = [];
  const usedAgents = new Set<string>();
  for (const role of PLAN_NEXT_STEP_ROLES) {
    const match = orderedAgents.find((candidate) => {
      const key = `${candidate.source}:${candidate.def.name.toLowerCase()}`;
      return !usedAgents.has(key) && agentMatchesRole(candidate.def, role);
    });
    if (!match) continue;
    usedAgents.add(`${match.source}:${match.def.name.toLowerCase()}`);
    steps.push({
      id: `${role.role}:${match.source}:${match.def.name}`,
      role: role.role,
      title: role.title,
      description: `${role.description} Use ${match.def.name}.`,
      prompt: role.prompt,
      source: match.source,
      def: match.def
    });
    if (steps.length >= 3) break;
  }
  return steps;
}

function planWasApproved(event: PlanEvent) {
  return event.answered && (event.decision === "approve" || /^approved\b/i.test(event.response || ""));
}

function planNextStepPrompt(event: PlanEvent, step: PlanNextStep) {
  return [step.prompt, "", "Approved plan:", "", event.plan].join("\n");
}

function terminalsForProject(sessionsById: Record<string, TerminalSession>, projectId?: string) {
  return Object.values(sessionsById).filter((session) => !projectId || session.projectId === projectId);
}

function devCommandStorageKey(projectId: string) {
  return `agent-control-dev-command:${projectId}`;
}

function isLikelyWindowsPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\");
}

function comparablePath(value: string, windowsPath: boolean) {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  return windowsPath ? normalized.toLowerCase() : normalized;
}

function pathsEqual(left: string, right: string) {
  const windowsPath = isLikelyWindowsPath(left) || isLikelyWindowsPath(right);
  return comparablePath(left, windowsPath) === comparablePath(right, windowsPath);
}

function pathIsDescendant(child: string, parent: string) {
  const windowsPath = isLikelyWindowsPath(child) || isLikelyWindowsPath(parent);
  const normalizedChild = comparablePath(child, windowsPath);
  const normalizedParent = comparablePath(parent, windowsPath);
  return normalizedChild !== normalizedParent && normalizedChild.startsWith(`${normalizedParent}/`);
}

function nearestParentProject(project: Project, projects: Project[]) {
  return projects
    .filter((candidate) => candidate.id !== project.id && pathIsDescendant(project.path, candidate.path))
    .sort((left, right) => comparablePath(right.path, isLikelyWindowsPath(right.path)).length - comparablePath(left.path, isLikelyWindowsPath(left.path)).length)[0];
}

function projectRelativePath(project: Project, parent: Project) {
  const childPath = project.path.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  const parentPath = parent.path.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  const windowsPath = isLikelyWindowsPath(project.path) || isLikelyWindowsPath(parent.path);
  const childComparable = comparablePath(project.path, windowsPath);
  const parentComparable = comparablePath(parent.path, windowsPath);
  return childComparable.startsWith(`${parentComparable}/`) ? childPath.slice(parentPath.length + 1) : childPath;
}

function projectSelectorRows(projects: Project[]) {
  const parentById = new Map<string, Project>();
  const childrenByParentId = new Map<string, Project[]>();
  for (const project of projects) {
    const parent = nearestParentProject(project, projects);
    if (!parent) continue;
    parentById.set(project.id, parent);
    childrenByParentId.set(parent.id, [...(childrenByParentId.get(parent.id) || []), project]);
  }

  const rows: Array<{ project: Project; parent?: Project; depth: number }> = [];
  const addProject = (project: Project, depth: number) => {
    const parent = parentById.get(project.id);
    rows.push({ project, parent, depth });
    for (const child of childrenByParentId.get(project.id) || []) addProject(child, depth + 1);
  };

  for (const project of projects) {
    if (!parentById.has(project.id)) addProject(project, 0);
  }
  return rows;
}

function ProjectRuntimeBadge({ project }: { project?: Pick<Project, "runtime"> }) {
  if (project?.runtime !== "wsl") return null;
  return <Badge className="shrink-0 px-1.5 py-0 text-[10px] uppercase">WSL</Badge>;
}

function pathSeparatorFor(projectPath: string) {
  return isLikelyWindowsPath(projectPath) ? "\\" : "/";
}

function joinUiPath(basePath: string, ...parts: string[]) {
  const separator = pathSeparatorFor(basePath);
  const trimmedBase = basePath.replace(/[\\/]+$/g, "");
  const trimmedParts = parts.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, "")).filter(Boolean);
  return [trimmedBase, ...trimmedParts].join(separator);
}

function safeWorktreePathName(branchName: string) {
  return branchName.trim().replace(/^refs\/heads\//, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

function siblingWorktreeRoot(projectPath: string) {
  const separator = pathSeparatorFor(projectPath);
  const trimmed = projectPath.replace(/[\\/]+$/g, "");
  const lastSlash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = lastSlash === 0 ? separator : lastSlash > 0 ? trimmed.slice(0, lastSlash) : "";
  const projectName = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return parent ? joinUiPath(parent, `${projectName}-worktrees`) : `${projectName}-worktrees`;
}

function siblingWorktreePath(projectPath: string, branchName: string) {
  return joinUiPath(siblingWorktreeRoot(projectPath), safeWorktreePathName(branchName));
}

function isDevTerminal(session: TerminalSession) {
  return session.title?.startsWith("Dev: ") || session.title === "npm run dev";
}

function isShellPermissionTool(toolName: string) {
  return /^(bash|shell|sh|cmd|powershell)$/i.test(toolName.trim());
}

function permissionCommandSignature(command?: string) {
  const normalized = command?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  const commandSegments = normalized.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  const segment = commandSegments.find((item) => /\b(?:npm|pnpm|yarn|bun)(?:\.(?:cmd|exe))?\b/i.test(item)) || commandSegments[0];
  const tokens = segment
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  const packageManagerIndex = tokens.findIndex((token) => /^(npm|pnpm|yarn|bun)(?:\.(?:cmd|exe))?$/i.test(token));
  if (packageManagerIndex >= 0) {
    const packageManager = tokens[packageManagerIndex].replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
    const args = tokens.slice(packageManagerIndex + 1);
    const commandIndex = args.findIndex((token) => !token.startsWith("-"));
    const packageCommand = commandIndex >= 0 ? args[commandIndex].toLowerCase() : "";
    if (!packageCommand) return packageManager;
    if (packageCommand === "run") {
      const script = args.slice(commandIndex + 1).find((token) => !token.startsWith("-"));
      return script ? `${packageManager} run ${script}` : `${packageManager} run`;
    }
    return `${packageManager} ${packageCommand}`;
  }
  return segment.toLowerCase();
}

function permissionAllowRuleKey(rule: Pick<PermissionAllowRule, "provider" | "model" | "toolName" | "command">) {
  return `${rule.provider || ""}:${rule.model.trim().toLowerCase()}:${rule.toolName.trim().toLowerCase()}:${rule.command?.trim().toLowerCase() || ""}`;
}

function createPermissionAllowRule(agent: RunningAgent, toolName: string, input?: unknown): PermissionAllowRule | undefined {
  const cryptoId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const shellTool = isShellPermissionTool(toolName);
  const command = shellTool ? permissionCommandSignature(fieldText(input, ["command"])) : undefined;
  if (shellTool && !command) return undefined;
  return {
    id: cryptoId,
    provider: agent.provider || "claude",
    model: agent.currentModel,
    toolName,
    ...(command ? { command } : {}),
    createdAt: new Date().toISOString()
  };
}

const ANSI_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#e5e5e5"
];

interface TerminalLineSegment {
  text: string;
  style?: CSSProperties;
}

interface TerminalLinePreview {
  text: string;
  segments: TerminalLineSegment[];
}

function terminalAnsiColorFrom256(index: number) {
  if (index >= 0 && index < ANSI_COLORS.length) return ANSI_COLORS[index];
  if (index >= 16 && index <= 231) {
    const value = index - 16;
    const r = Math.floor(value / 36);
    const g = Math.floor((value % 36) / 6);
    const b = value % 6;
    const channel = (item: number) => (item === 0 ? 0 : 55 + item * 40);
    return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
  }
  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  return undefined;
}

function latestTerminalLine(output: string[]): TerminalLinePreview {
  const text = output.slice(-40).join("");
  let segments: TerminalLineSegment[] = [];
  let lastNonEmptySegments: TerminalLineSegment[] = [];
  let index = 0;
  const style: CSSProperties = {};

  const appendText = (value: string) => {
    if (!value) return;
    const previous = segments.at(-1);
    const nextStyle = Object.keys(style).length > 0 ? { ...style } : undefined;
    if (previous && JSON.stringify(previous.style || {}) === JSON.stringify(nextStyle || {})) {
      previous.text += value;
      return;
    }
    segments.push({ text: value, style: nextStyle });
  };
  const rememberLine = () => {
    const lineText = segments.map((segment) => segment.text).join("");
    if (lineText.trim()) lastNonEmptySegments = segments.map((segment) => ({ ...segment, style: segment.style ? { ...segment.style } : undefined }));
  };
  const resetLine = () => {
    rememberLine();
    segments = [];
  };
  const applySgr = (codes: number[]) => {
    const values = codes.length > 0 ? codes : [0];
    for (let offset = 0; offset < values.length; offset += 1) {
      const code = values[offset];
      if (code === 0) {
        for (const key of Object.keys(style) as Array<keyof CSSProperties>) delete style[key];
      } else if (code === 1) {
        style.fontWeight = 700;
      } else if (code === 3) {
        style.fontStyle = "italic";
      } else if (code === 4) {
        style.textDecoration = "underline";
      } else if (code === 22) {
        delete style.fontWeight;
      } else if (code === 23) {
        delete style.fontStyle;
      } else if (code === 24) {
        delete style.textDecoration;
      } else if (code === 39) {
        delete style.color;
      } else if (code >= 30 && code <= 37) {
        style.color = ANSI_COLORS[code - 30];
      } else if (code >= 90 && code <= 97) {
        style.color = ANSI_COLORS[8 + code - 90];
      } else if (code === 38 && values[offset + 1] === 5) {
        const color = terminalAnsiColorFrom256(values[offset + 2]);
        if (color) style.color = color;
        offset += 2;
      } else if (code === 38 && values[offset + 1] === 2) {
        const [red, green, blue] = values.slice(offset + 2, offset + 5);
        if ([red, green, blue].every((value) => Number.isFinite(value))) style.color = `rgb(${red}, ${green}, ${blue})`;
        offset += 4;
      }
    }
  };

  while (index < text.length) {
    const rest = text.slice(index);
    const sgr = rest.match(/^\u001b\[([0-9;]*)m/);
    if (sgr) {
      applySgr(sgr[1].split(";").filter(Boolean).map(Number));
      index += sgr[0].length;
      continue;
    }
    const csi = rest.match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
    if (csi) {
      index += csi[0].length;
      continue;
    }
    const char = text[index];
    if (char === "\n" || char === "\r") {
      resetLine();
    } else if (char === "\b") {
      const last = segments.at(-1);
      if (last) last.text = last.text.slice(0, -1);
      if (last && !last.text) segments.pop();
    } else {
      appendText(char);
    }
    index += 1;
  }
  rememberLine();

  const selectedSegments = segments.map((segment) => segment.text).join("").trim() ? segments : lastNonEmptySegments;
  return {
    text: selectedSegments.map((segment) => segment.text).join("").trim(),
    segments: selectedSegments
  };
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

const CURRENT_OPENAI_MODEL_PROFILES = [
  { id: "gpt-5.5", provider: "openai", default: true, supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-nano", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "o3-deep-research", provider: "openai", supportedEfforts: ["low", "medium", "high"] },
  { id: "o4-mini-deep-research", provider: "openai", supportedEfforts: ["low", "medium", "high"] }
] satisfies ModelProfile[];

const CURRENT_CODEX_MODEL_PROFILES = [
  { id: "gpt-5.3-codex", provider: "codex", default: true, supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.3-codex-spark", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.2-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.1-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.1-codex-max", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.1-codex-mini", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] }
] satisfies ModelProfile[];

const CURRENT_CLAUDE_MODEL_PROFILES = [
  { id: "claude-opus-4-7", provider: "claude", supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-4-6", provider: "claude", supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-4-6", provider: "claude", default: true, supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-4-5", provider: "claude", supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] }
] satisfies ModelProfile[];

function currentModelProfilesForProvider(provider: AgentProvider) {
  if (provider === "openai") return CURRENT_OPENAI_MODEL_PROFILES;
  if (provider === "codex") return CURRENT_CODEX_MODEL_PROFILES;
  return CURRENT_CLAUDE_MODEL_PROFILES;
}

function currentModelText(provider: AgentProvider) {
  return currentModelProfilesForProvider(provider)
    .map((profile) => profile.id)
    .join("\n");
}

function modelProfilesForSettings(settings: { models: string[]; modelProfiles?: ModelProfile[] }): ModelProfile[] {
  if (settings.modelProfiles?.length) return settings.modelProfiles;
  return settings.models.map((model, index) => ({ id: model, provider: "claude", default: index === 0 }));
}

function defaultModelForAgentDef(settings: { models: string[]; modelProfiles?: ModelProfile[] }, def: AgentDef): string {
  const provider = def.provider || "claude";
  const profiles = modelProfilesForSettings(settings);
  if (def.defaultModel && profiles.some((profile) => profile.provider === provider && profile.id === def.defaultModel)) return def.defaultModel;
  return (
    profiles.find((profile) => profile.provider === provider && profile.default)?.id ||
    profiles.find((profile) => profile.provider === provider)?.id ||
    (provider === "claude" ? settings.models[0] : undefined) ||
    DEFAULT_MODEL
  );
}

function providerModelsText(settings: { models: string[]; modelProfiles?: ModelProfile[] }, provider: AgentProvider) {
  return modelProfilesForSettings(settings)
    .filter((profile) => profile.provider === provider)
    .map((profile) => profile.id)
    .join("\n");
}

function modelIdsForProvider(settings: { models: string[]; modelProfiles?: ModelProfile[] }, provider: AgentProvider) {
  const models = modelProfilesForSettings(settings)
    .filter((profile) => profile.provider === provider)
    .map((profile) => profile.id);
  return models.length ? models : settings.models;
}

function isAgentEffort(value: string): value is AgentEffort {
  return ["low", "medium", "high", "xhigh", "max"].includes(value);
}

function firstModelMatching(models: string[], fallback: string, predicate: (model: string) => boolean) {
  return models.find(predicate) || fallback;
}

function preferredProviderModeModel(
  settings: { models: string[]; modelProfiles?: ModelProfile[] },
  provider: "codex",
  mode: "intelligence" | "speed"
): string;
function preferredProviderModeModel(
  settings: { models: string[]; modelProfiles?: ModelProfile[] },
  provider: "openai",
  mode: "standard" | "fast" | "deepResearch" | "fastResearch"
): string;
function preferredProviderModeModel(
  settings: { models: string[]; modelProfiles?: ModelProfile[] },
  provider: "codex" | "openai",
  mode: "intelligence" | "speed" | "standard" | "fast" | "deepResearch" | "fastResearch"
) {
  const models = modelIdsForProvider(settings, provider);
  const fallback = models[0] || (provider === "codex" ? "gpt-5.3-codex" : "gpt-5.5");
  if (provider === "codex") {
    if (mode === "speed") {
      return firstModelMatching(models, "gpt-5.3-codex-spark", (model) => /spark|mini|codex-mini/i.test(model));
    }
    return models[0] || "gpt-5.3-codex";
  }
  if (mode === "deepResearch") {
    return firstModelMatching(models, "o3-deep-research", (model) => /deep-research/i.test(model) && !/mini/i.test(model));
  }
  if (mode === "fastResearch") {
    return firstModelMatching(models, "o4-mini-deep-research", (model) => /deep-research/i.test(model) && /mini/i.test(model));
  }
  if (mode === "fast") {
    return firstModelMatching(models, "gpt-5.4-mini", (model) => /mini|nano/i.test(model) && !/deep-research/i.test(model));
  }
  return firstModelMatching(models, fallback, (model) => !/mini|nano|deep-research/i.test(model));
}

function parseProviderModels(text: string, provider: AgentProvider): ModelProfile[] {
  const currentModels = currentModelProfilesForProvider(provider);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((id, index) => {
      const current = currentModels.find((profile) => profile.id === id);
      return { ...current, id, provider, default: index === 0 };
    });
}

function ProviderModelsField({
  label,
  value,
  onChange,
  placeholder,
  onGetCurrentModels,
  gettingCurrentModels,
  updateNote
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onGetCurrentModels?: () => void;
  gettingCurrentModels?: boolean;
  updateNote?: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="flex items-start justify-between gap-3">
        <span>
          <span className="block">{label}</span>
          <span className="block text-xs text-muted-foreground">One model id per line. The first model is the provider default.</span>
        </span>
        {onGetCurrentModels && (
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onGetCurrentModels} disabled={gettingCurrentModels}>
            <RefreshCw className={cn("h-4 w-4", gettingCurrentModels && "animate-spin")} />
            {gettingCurrentModels ? "Getting..." : "Get Current Models"}
          </Button>
        )}
      </span>
      <Textarea className="min-h-48 w-full resize-y" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      {updateNote && <span className="text-xs text-muted-foreground">{updateNote}</span>}
    </label>
  );
}

function orderedAgentsForTiles(agents: RunningAgent[], tileOrder: string[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return [
    ...tileOrder.map((id) => byId.get(id)).filter((agent): agent is RunningAgent => Boolean(agent)),
    ...agents.filter((agent) => !tileOrder.includes(agent.id))
  ];
}

function Header({
  docked = false,
  onDock,
  onUndock
}: {
  docked?: boolean;
  onDock?: () => void;
  onUndock?: () => void;
}) {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const agentsById = useAppStore((state) => state.agents);
  const tileOrder = useAppStore((state) => state.tileOrder);
  const setTileOrder = useAppStore((state) => state.setTileOrder);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const setFocusedAgent = useAppStore((state) => state.setFocusedAgent);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const fileExplorerOpen = useAppStore((state) => state.fileExplorerOpen);
  const terminalInFileExplorer = useAppStore((state) => state.terminalInFileExplorer);
  const terminalSessions = useAppStore((state) => state.terminalSessions);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const setFileExplorerOpen = useAppStore((state) => state.setFileExplorerOpen);
  const setTerminalInFileExplorer = useAppStore((state) => state.setTerminalInFileExplorer);
  const wsConnected = useAppStore((state) => state.wsConnected);
  const setProjects = useAppStore((state) => state.setProjects);
  const setSettings = useAppStore((state) => state.setSettings);
  const currentTileHeight = useAppStore((state) => state.currentTileHeight);
  const setCurrentTileHeight = useAppStore((state) => state.setCurrentTileHeight);
  const addError = useAppStore((state) => state.addError);
  const settings = useAppStore((state) => state.settings);
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const [devCommand, setDevCommand] = useState("npm run dev");
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [connectionMenuOpen, setConnectionMenuOpen] = useState(false);
  const [supervised, setSupervised] = useState<boolean | undefined>();
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [layoutHeightDraft, setLayoutHeightDraft] = useState(String(settings.tileHeight));
  const [layoutColumnsDraft, setLayoutColumnsDraft] = useState(String(settings.tileColumns));
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const projectRows = useMemo(() => projectSelectorRows(projects), [projects]);
  const inputNeededProjectIds = useMemo(
    () => new Set(Object.values(agentsById).filter(agentNeedsInput).map((agent) => agent.projectId)),
    [agentsById]
  );
  const offProjectInputAlerts = useMemo(
    () =>
      Object.values(agentsById)
        .filter((agent) => agentNeedsInput(agent) && agent.projectId !== selectedProjectId)
        .map((agent) => {
          const projectName = projects.find((candidate) => candidate.id === agent.projectId)?.name || agent.projectName;
          const need = agent.status === "awaiting-permission" ? "needs approval" : "needs an answer";
          return {
            agentId: agent.id,
            projectId: agent.projectId,
            label: `${projectName}: ${agent.displayName} ${need}`
          };
        }),
    [agentsById, projects, selectedProjectId]
  );
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

  useEffect(() => {
    void refreshAdminStatus();
  }, []);

  useEffect(() => {
    setLayoutHeightDraft(String(settings.tileHeight));
    setLayoutColumnsDraft(String(settings.tileColumns));
  }, [settings.tileColumns, settings.tileHeight]);

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
    if (terminalInFileExplorer) {
      setTerminalInFileExplorer(false);
      setTerminalOpen(true);
      return;
    }
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

  function openFileExplorerPopoutFromHeader() {
    if (!selectedProjectId) return false;
    const popup = window.open(`/file-explorer-popout?projectId=${encodeURIComponent(selectedProjectId)}`, "agent-control-file-explorer", "popup,width=1100,height=760");
    if (!popup) return false;
    window.localStorage.setItem(FILE_EXPLORER_POPOUT_STORAGE_KEY, "true");
    setFileExplorerOpen(false);
    return true;
  }

  function toggleFileExplorer() {
    if (fileExplorerOpen) {
      setFileExplorerOpen(false);
      return;
    }
    if (window.localStorage.getItem(FILE_EXPLORER_POPOUT_STORAGE_KEY) === "true" && openFileExplorerPopoutFromHeader()) return;
    window.localStorage.setItem(FILE_EXPLORER_POPOUT_STORAGE_KEY, "false");
    setFileExplorerOpen(true);
  }

  async function saveDisplaySettings(patch: Partial<Pick<typeof settings, "tileHeight" | "tileColumns">>) {
    try {
      const next = await api.saveSettings({ ...settings, ...patch });
      setSettings(next);
      setCurrentTileHeight(undefined);
      return true;
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  async function saveLayoutSettings() {
    const tileHeight = Number(layoutHeightDraft);
    const tileColumns = Number(layoutColumnsDraft);
    if (!Number.isFinite(tileHeight) || !Number.isFinite(tileColumns)) return;
    if (await saveDisplaySettings({ tileHeight, tileColumns })) setLayoutMenuOpen(false);
  }

  function useFullHeight() {
    setCurrentTileHeight(0);
  }

  function resetLayout() {
    setCurrentTileHeight(undefined);
  }

  const layoutHeightValue = Number(layoutHeightDraft);
  const layoutColumnsValue = Number(layoutColumnsDraft);
  const layoutSettingsDirty =
    Number.isFinite(layoutHeightValue) &&
    Number.isFinite(layoutColumnsValue) &&
    (Math.round(layoutHeightValue) !== settings.tileHeight || Math.round(layoutColumnsValue) !== settings.tileColumns);
  const showMenuText = settings.menuDisplay === "iconText";
  const menuButtonClass = showMenuText ? "gap-2 px-3" : undefined;
  const layoutMenu = (
    <DropdownMenu open={layoutMenuOpen} onOpenChange={setLayoutMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={showMenuText ? undefined : "icon"} className={menuButtonClass} title="Layout options">
          <LayoutGrid className="h-4 w-4" />
          {showMenuText && (
            <>
              <span>Layout</span>
              <ChevronDown className="h-4 w-4" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onClick={useFullHeight}>
          <Maximize2 className="mr-2 h-4 w-4" />
          Full Height
          {currentTileHeight === 0 && <Check className="ml-auto h-4 w-4" />}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={resetLayout}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Use Settings
          {currentTileHeight === undefined && <Check className="ml-auto h-4 w-4" />}
        </DropdownMenuItem>
        <div className="mt-1 grid gap-2 border-t border-border px-2 py-2" onClick={(event) => event.stopPropagation()}>
          <div className="grid grid-cols-[1fr_0.8fr_auto] items-end gap-2">
            <label className="grid gap-1 text-xs text-muted-foreground">
              Height (0 = full)
              <Input
                type="number"
                min={0}
                max={TILE_MAX_HEIGHT}
                value={layoutHeightDraft}
                onKeyDown={(event) => event.stopPropagation()}
                onChange={(event) => setLayoutHeightDraft(event.target.value)}
              />
            </label>
            <label className="grid gap-1 text-xs text-muted-foreground">
              Columns
              <Input
                type="number"
                min={1}
                max={6}
                value={layoutColumnsDraft}
                onKeyDown={(event) => event.stopPropagation()}
                onChange={(event) => setLayoutColumnsDraft(event.target.value)}
              />
            </label>
            <Button
              type="button"
              size="icon"
              disabled={!layoutSettingsDirty}
              title="Save layout settings"
              onClick={() => void saveLayoutSettings()}
            >
              <Save className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );

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

  if (docked) {
    return (
      <header
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-border bg-background",
          sidebarCollapsed ? "justify-center px-2" : "gap-2 px-3"
        )}
      >
        {!sidebarCollapsed && (
          <>
            <Bot className="h-5 w-5 shrink-0 text-primary" />
            <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Agent Control</h1>
          </>
        )}
        <button
          type="button"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onUndock}
          title="Expand top bar"
          aria-label="Expand top bar"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </header>
    );
  }

  return (
    <header
      className={cn(
        "relative flex h-14 shrink-0 items-center gap-3 border-b border-border pr-4",
        sidebarCollapsed ? "pl-16" : "pl-4"
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Bot className="h-5 w-5 text-primary" />
        <h1 className="truncate text-base font-semibold">Agent Control</h1>
        {supervised ? (
          <DropdownMenu open={connectionMenuOpen} onOpenChange={setConnectionMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "grid h-5 w-5 shrink-0 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  wsConnected ? "text-emerald-400" : "text-red-400"
                )}
                title={
                  wsConnected
                    ? "AgentControl is connected and running in supervised mode. Click for restart and shutdown options."
                    : "AgentControl is disconnected. The dashboard is not receiving live updates."
                }
                aria-label={wsConnected ? "AgentControl connected" : "AgentControl disconnected"}
              >
                <span className="h-2.5 w-2.5 rounded-full bg-current shadow-[0_0_0_3px_rgba(255,255,255,0.06)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem onClick={() => void restartAgentControl()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Restart AgentControl
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void shutdownAgentControl()}>
                <X className="mr-2 h-4 w-4" />
                Shutdown AgentControl
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span
            className={cn(
              "grid h-5 w-5 shrink-0 place-items-center rounded-full",
              wsConnected ? "text-emerald-400" : "text-red-400"
            )}
            title={
              wsConnected
                ? "AgentControl is connected. Restart controls are available when launched with npm run dev:supervised."
                : "AgentControl is disconnected. The dashboard is not receiving live updates."
            }
            aria-label={wsConnected ? "AgentControl connected" : "AgentControl disconnected"}
          >
            <span className="h-2.5 w-2.5 rounded-full bg-current shadow-[0_0_0_3px_rgba(255,255,255,0.06)]" />
          </span>
        )}
        <AppUpdateNotice />
      </div>
      <button
        type="button"
        className="absolute top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ left: Math.max(16, (sidebarCollapsed ? 56 : settings.sidebarWidth || 280) - 40) }}
        onClick={onDock}
        title="Dock top bar to left nav"
        aria-label="Dock top bar to left nav"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="ml-auto flex items-center gap-2">
        {offProjectInputAlerts.length > 0 && (
          <button
            type="button"
            className="grid h-5 w-5 shrink-0 place-items-center text-amber-500"
            title={[...offProjectInputAlerts.map((alert) => alert.label), "Click to open"].join("\n")}
            aria-label={offProjectInputAlerts.map((alert) => alert.label).join("; ")}
            onClick={() => {
              const alert = offProjectInputAlerts[0];
              if (!alert) return;
              setSelectedAgent(undefined);
              setSelectedProject(alert.projectId);
              setFocusedAgent(alert.agentId);
            }}
          >
            <TriangleAlert className="h-5 w-5" />
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "w-60 justify-between",
                selectedProjectId && inputNeededProjectIds.has(selectedProjectId) && "border-amber-500/70 bg-amber-500/10"
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{selectedProject?.name || "Select project"}</span>
                <ProjectRuntimeBadge project={selectedProject} />
              </span>
              <ChevronDown className="h-4 w-4 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            {projectRows.map(({ project, parent, depth }) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => setSelectedProject(project.id)}
                className={cn(
                  "justify-between gap-2",
                  depth > 0 && "pl-7",
                  inputNeededProjectIds.has(project.id) && "bg-amber-500/10 text-amber-900 focus:bg-amber-500/15 dark:text-amber-100"
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {depth > 0 && <FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{project.name}</span>
                      <ProjectRuntimeBadge project={project} />
                    </span>
                    {parent && <span className="block truncate text-xs text-muted-foreground">{projectRelativePath(project, parent)}</span>}
                  </span>
                </span>
                {project.id === selectedProjectId && <Check className="h-4 w-4 shrink-0" />}
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
            size={showMenuText ? undefined : "icon"}
            className={cn("rounded-r-none", showMenuText && "gap-2 px-3")}
            disabled={!selectedProjectId}
            onClick={runProjectDev}
            title={`Run ${devCommand}`}
          >
            <Play className="h-4 w-4" />
            {showMenuText && <span>Run</span>}
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
          size={showMenuText ? undefined : "icon"}
          className={showMenuText ? "gap-2 px-3" : undefined}
          disabled={!selectedProjectId}
          onClick={() => void closeSelectedProject()}
          title="Close project"
        >
          <X className="h-4 w-4" />
          {showMenuText && <span>Close</span>}
        </Button>
        {layoutMenu}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size={showMenuText ? undefined : "icon"}
              className={showMenuText ? "gap-2 px-3" : undefined}
              disabled={agentCount < 2}
              title="Sort chats"
            >
              <ArrowDownAZ className="h-4 w-4" />
              {showMenuText && <span>Sort</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={sortChatsByAgentType}>Sort by agent type</DropdownMenuItem>
            <DropdownMenuItem onClick={sortChatsByLastActivity}>Sort by last activity</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <AddProjectDialog open={addProjectOpen} onOpenChange={setAddProjectOpen} showTrigger={false} />
        <Button
          variant={fileExplorerOpen ? "default" : "outline"}
          size={showMenuText ? undefined : "icon"}
          className={showMenuText ? "gap-2 px-3" : undefined}
          disabled={!selectedProjectId}
          onClick={toggleFileExplorer}
          title={fileExplorerOpen ? "Close File Explorer" : "Open File Explorer"}
        >
          <FileStack className="h-4 w-4" />
          {showMenuText && <span>Files</span>}
        </Button>
        <Button
          variant={terminalOpen && !terminalInFileExplorer ? "default" : "outline"}
          size={showMenuText ? undefined : "icon"}
          className={showMenuText ? "gap-2 px-3" : undefined}
          onClick={toggleTerminal}
          title="Terminal"
        >
          <SquareTerminal className="h-4 w-4" />
          {showMenuText && <span>Terminal</span>}
        </Button>
        <SettingsDialog />
      </div>
    </header>
  );
}

function WorktreeTabs() {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const setProjects = useAppStore((state) => state.setProjects);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const addError = useAppStore((state) => state.addError);
  const [worktrees, setWorktrees] = useState<GitWorktreeList | undefined>();

  useEffect(() => {
    if (!selectedProjectId) {
      setWorktrees(undefined);
      return;
    }
    let cancelled = false;
    api
      .gitWorktrees(selectedProjectId)
      .then((result) => {
        if (!cancelled) setWorktrees(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setWorktrees(undefined);
          addError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [addError, projects, selectedProjectId]);

  const openWorktrees = useMemo(() => {
    const byProjectId = new Map(projects.map((project) => [project.id, project]));
    return (worktrees?.worktrees || [])
      .filter((worktree) => worktree.projectId && byProjectId.has(worktree.projectId))
      .map((worktree) => {
        const project = byProjectId.get(worktree.projectId!);
        return {
          ...worktree,
          projectName: project?.name || worktree.branch || "Worktree"
        };
      });
  }, [projects, worktrees]);

  if (openWorktrees.length <= 1) return null;

  async function closeWorktreeProject(projectIdToClose: string) {
    try {
      setProjects(await api.closeProject(projectIdToClose));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="flex h-11 shrink-0 items-end gap-2 overflow-x-auto border-b border-border bg-muted/25 px-4 pt-1">
      <FolderTree className="mb-2.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 items-end gap-0.5">
        {openWorktrees.map((worktree) => {
          const active = worktree.projectId === selectedProjectId;
          const projectIdForTab = worktree.projectId!;
          return (
            <div
              key={projectIdForTab}
              className={cn(
                "flex h-9 max-w-64 items-center gap-2 rounded-t-md border px-3 text-xs transition-colors",
                active
                  ? "border-border border-b-background bg-background text-foreground shadow-sm"
                  : "border-border/70 bg-muted/45 text-muted-foreground hover:bg-background/70 hover:text-foreground"
              )}
              title={worktree.path}
            >
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedProject(projectIdForTab)}>
                <span className="block truncate font-medium leading-4">{worktree.projectName}</span>
                <span className="block truncate font-mono text-[11px] leading-3 opacity-80">{worktree.branch || "detached"}</span>
              </button>
              <button
                type="button"
                className="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                title={`Close ${worktree.projectName}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeWorktreeProject(projectIdForTab);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GitStatusMenu({ projectId }: { projectId?: string }) {
  const addError = useAppStore((state) => state.addError);
  const showMenuText = useAppStore((state) => state.settings.menuDisplay === "iconText");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GitStatus | undefined>();
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [credentialPromptOpen, setCredentialPromptOpen] = useState(false);

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
      setOpen(false);
    } catch (error) {
      if (isGitCredentialPromptError(error)) {
        setOpen(false);
        setCredentialPromptOpen(true);
      } else {
        addError(error instanceof Error ? error.message : String(error));
      }
      void refresh();
    } finally {
      setPushing(false);
    }
  }

  function openPushTerminal() {
    if (!projectId) return;
    sendCommand({ type: "terminalStart", projectId, command: "git push", title: "Git push" });
    setCredentialPromptOpen(false);
  }

  const changedCount = status?.files.length || 0;
  const aheadCount = status?.ahead || 0;
  const unpushedCommits = status?.unpushedCommits || [];
  const hasWork = changedCount > 0 || aheadCount > 0;

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={showMenuText ? undefined : "icon"}
            disabled={!projectId}
            title="Git status"
            className={cn("relative", showMenuText && "gap-2 px-3")}
          >
            <GitBranch className="h-4 w-4" />
            {showMenuText && <span>Git</span>}
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

                {aheadCount > 0 && (
                  <div className="grid gap-1">
                    <div className="text-xs font-medium text-muted-foreground">Commits not pushed</div>
                    {unpushedCommits.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-muted-foreground">
                        Commit details unavailable
                      </div>
                    ) : (
                      <div className="max-h-44 overflow-y-auto rounded-md border border-border">
                        {unpushedCommits.map((commit) => (
                          <div key={commit.hash} className="grid gap-0.5 border-b border-border px-2 py-1.5 last:border-b-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <Badge className="shrink-0 px-1.5 py-0 font-mono text-[10px]">{commit.hash}</Badge>
                              <span className="min-w-0 truncate text-xs" title={commit.subject}>
                                {commit.subject}
                              </span>
                            </div>
                            {commit.authorName && (
                              <div className="truncate pl-[3.25rem] text-[11px] text-muted-foreground" title={commit.authorName}>
                                {commit.authorName}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

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
      <Dialog open={credentialPromptOpen} onOpenChange={setCredentialPromptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Git Credentials Needed</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">
              Git needs an interactive credential prompt before AgentControl can push from this repo.
            </p>
            <div className="rounded-md border border-border bg-muted p-3 font-mono text-xs">git push</div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCredentialPromptOpen(false)}>
                Cancel
              </Button>
              <Button onClick={openPushTerminal} disabled={!projectId}>
                <SquareTerminal className="h-4 w-4" />
                Open Terminal
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AppUpdateNotice() {
  const settings = useAppStore((state) => state.settings);
  const addError = useAppStore((state) => state.addError);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [status, setStatus] = useState<AppUpdateStatus | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (settings.updateChecksEnabled === false) return;
    void refresh(false);
    const timer = window.setInterval(() => void refresh(false), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [settings.updateChecksEnabled]);

  async function refresh(reportErrors = true) {
    if (settings.updateChecksEnabled === false) return;
    setLoading(true);
    try {
      setStatus(await api.appUpdates());
    } catch (error) {
      if (reportErrors) addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  function runUpdate() {
    const commands = (settings.updateCommands || []).map((command) => command.trim()).filter(Boolean);
    if (commands.length === 0) return;
    sendCommand({ type: "terminalStart", command: commands.join("; "), title: "Update AgentControl" });
    setDetailsOpen(false);
  }

  const commits = status?.commits || [];
  const updateAvailable = Boolean(status?.updateAvailable);
  if (settings.updateChecksEnabled === false || !updateAvailable) return null;

  return (
    <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-amber-700 hover:text-amber-800 dark:text-amber-200 dark:hover:text-amber-100"
        title="AgentControl update available"
        aria-label="AgentControl update available"
        onClick={() => setDetailsOpen(true)}
      >
        <BellPlus className="h-4 w-4" />
      </Button>
      <DialogContent className="w-[min(94vw,520px)]">
        <DialogHeader>
          <DialogTitle>AgentControl Update</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 text-sm text-muted-foreground">
              {loading ? "Checking GitHub..." : status?.checkedAt ? `Checked ${new Date(status.checkedAt).toLocaleString()}` : "Update available"}
            </div>
            <Button variant="outline" size="sm" onClick={() => void refresh(true)} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>

          {status?.isRepo && (
            <>
              <div className="grid gap-1 rounded-md border border-border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Branch</span>
                  <span className="min-w-0 truncate font-mono">{status.branch || "detached"}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Remote</span>
                  <span className="min-w-0 truncate font-mono" title={status.upstream || status.remoteUrl}>
                    {status.upstream || status.githubRepo || "origin"}
                  </span>
                </div>
                {status.latestRelease && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Latest release</span>
                    <span className="min-w-0 truncate font-mono" title={status.latestRelease.name || status.latestRelease.tagName}>
                      {status.latestRelease.tagName}
                    </span>
                  </div>
                )}
              </div>

              <div className="grid gap-1">
                <div className="text-xs font-medium text-muted-foreground">Incoming commits</div>
                {commits.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-2 py-3 text-center text-xs text-muted-foreground">
                    No incoming commits found
                  </div>
                ) : (
                  <div className="max-h-52 overflow-y-auto rounded-md border border-border">
                    {commits.map((commit) => (
                      <div key={commit.hash} className="grid gap-0.5 border-b border-border px-2 py-1.5 last:border-b-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <Badge className="shrink-0 px-1.5 py-0 font-mono text-[10px]">{commit.hash}</Badge>
                          <span className="min-w-0 truncate text-xs" title={commit.subject}>
                            {commit.subject}
                          </span>
                        </div>
                        {commit.authorName && (
                          <div className="truncate pl-[3.25rem] text-[11px] text-muted-foreground" title={commit.authorName}>
                            {commit.authorName}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid gap-1">
                <div className="text-xs font-medium text-muted-foreground">Commands</div>
                <div className="rounded-md border border-border bg-muted p-2 font-mono text-xs">
                  {(settings.updateCommands || []).map((command) => (
                    <div key={command}>{command}</div>
                  ))}
                </div>
              </div>
            </>
          )}

          {!status?.isRepo && status?.message && (
            <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">{status.message}</div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDetailsOpen(false)}>
              Close
            </Button>
            <Button onClick={runUpdate} disabled={(settings.updateCommands || []).length === 0}>
              <SquareTerminal className="h-4 w-4" />
              Run Update
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WorktreesDialog({ projectId }: { projectId?: string }) {
  const projects = useAppStore((state) => state.projects);
  const setProjects = useAppStore((state) => state.setProjects);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const addError = useAppStore((state) => state.addError);
  const showMenuText = useAppStore((state) => state.settings.menuDisplay === "iconText");
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"worktrees" | "create">("worktrees");
  const [worktrees, setWorktrees] = useState<GitWorktreeList | undefined>();
  const [loading, setLoading] = useState(false);
  const [busyPath, setBusyPath] = useState<string | undefined>();
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("HEAD");
  const [pathText, setPathText] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [createBranch, setCreateBranch] = useState(true);
  const [copyLocalAgentFiles, setCopyLocalAgentFiles] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const selectedProject = projects.find((project) => project.id === projectId);
  const suggestedWorktreePath = selectedProject?.path
    ? siblingWorktreePath(selectedProject.path, branch)
    : "";
  const effectiveWorktreePath = pathText.trim() || suggestedWorktreePath;

  useEffect(() => {
    if (!open || !projectId) return;
    void refresh();
  }, [open, projectId]);

  useEffect(() => {
    if (!open || pathEdited || !suggestedWorktreePath) return;
    setPathText(suggestedWorktreePath);
  }, [open, pathEdited, suggestedWorktreePath]);

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
    const project = projectList.find((candidate) => pathsEqual(candidate.path, worktreePath));
    if (!project) return false;
    setSelectedProject(project.id);
    return true;
  }

  function canOpenWorktree(worktreePath: string) {
    return Boolean(
      selectedProject?.path &&
        (pathIsDescendant(worktreePath, selectedProject.path) || pathIsDescendant(worktreePath, siblingWorktreeRoot(selectedProject.path)))
    );
  }

  async function openWorktreeProject(worktreePath: string) {
    if (!canOpenWorktree(worktreePath)) return;
    setBusyPath(worktreePath);
    try {
      const nextProjects = await api.addProject(worktreePath);
      setProjects(nextProjects);
      if (selectProjectForPath(nextProjects, worktreePath)) setOpen(false);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPath(undefined);
    }
  }

  async function createWorktree() {
    if (!projectId || !branch.trim()) return;
    setLoading(true);
    try {
      const result = await api.createGitWorktree(projectId, {
        branch: branch.trim(),
        base: base.trim() || "HEAD",
        path: pathText.trim() || suggestedWorktreePath || undefined,
        createBranch,
        copyLocalAgentFiles
      });
      setProjects(result.projects);
      setWorktrees(result.worktrees);
      const created =
        result.worktrees.worktrees.find((worktree) => pathsEqual(worktree.path, pathText.trim() || suggestedWorktreePath)) ||
        result.worktrees.worktrees.find((worktree) => worktree.branch === branch.trim());
      if (created) selectProjectForPath(result.projects, created.path);
      setBranch("");
      setPathEdited(false);
      setBase("HEAD");
      setCreateBranch(true);
      setCopyLocalAgentFiles(false);
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
      <Button
        variant="outline"
        size={showMenuText ? undefined : "icon"}
        className={showMenuText ? "gap-2 px-3" : undefined}
        disabled={!projectId}
        onClick={() => setOpen(true)}
        title="Git worktrees"
      >
        <FolderTree className="h-4 w-4" />
        {showMenuText && <span>Worktrees</span>}
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
                  <Input
                    value={pathText}
                    onChange={(event) => {
                      setPathEdited(true);
                      setPathText(event.target.value);
                    }}
                    placeholder={suggestedWorktreePath || "Choose a worktree folder"}
                  />
                  <Button type="button" variant="outline" onClick={() => setBrowserOpen(true)}>
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </Button>
                </div>
                {effectiveWorktreePath && (
                  <span className="break-all font-mono text-xs text-muted-foreground" title={effectiveWorktreePath}>
                    {effectiveWorktreePath}
                  </span>
                )}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={createBranch} onChange={(event) => setCreateBranch(event.target.checked)} />
                Create a new branch
              </label>
              <label
                className="flex items-start gap-2 text-sm"
                title="Select this if your project agent files are local and untracked by Git."
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={copyLocalAgentFiles}
                  onChange={(event) => setCopyLocalAgentFiles(event.target.checked)}
                />
                <span>
                  <span className="block">Copy local agent files into worktree</span>
                  <span className="block text-xs text-muted-foreground">
                    Use this if your project agent files are local and untracked by Git.
                  </span>
                </span>
              </label>
              <Button onClick={() => void createWorktree()} disabled={loading || !branch.trim()}>
                <Plus className="h-4 w-4" />
                {loading ? "Creating..." : "Create Worktree"}
              </Button>
            </div>
          ) : (
            <div className="grid max-h-[56vh] gap-2 overflow-auto">
              {worktrees.worktrees.map((worktree) => {
                const descendantWorktree = canOpenWorktree(worktree.path);
                const canSwitch = Boolean(worktree.projectId) && !worktree.current;
                const canOpenAndSwitch = !worktree.projectId && !worktree.current && descendantWorktree;
                return (
                  <div key={worktree.path} className="grid gap-2 rounded-md border border-border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium">{worktree.branch || "Detached"}</span>
                          {worktree.current && <Badge>Current</Badge>}
                          {worktree.projectId && <Badge>Open</Badge>}
                          {!worktree.projectId && descendantWorktree && <Badge>Inside project</Badge>}
                          {worktree.prunable && <Badge>Prunable</Badge>}
                        </div>
                        <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{worktree.path}</div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyPath === worktree.path || (!canSwitch && !canOpenAndSwitch)}
                        onClick={() => {
                          if (canSwitch && worktree.projectId) {
                            setSelectedProject(worktree.projectId);
                            setOpen(false);
                          }
                          else if (canOpenAndSwitch) void openWorktreeProject(worktree.path);
                        }}
                      >
                        {canOpenAndSwitch ? "Open & Switch" : "Switch"}
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
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
      <FolderBrowserDialog
        open={browserOpen}
        initialPath={effectiveWorktreePath || selectedProject?.path || ""}
        onOpenChange={setBrowserOpen}
        onSelect={(selectedPath) => {
          setPathEdited(true);
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
  const [runtime, setRuntime] = useState<"local" | "wsl">("local");
  const [wslDistro, setWslDistro] = useState("Ubuntu");
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [wslPath, setWslPath] = useState("");
  const [path, setPath] = useState("");
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const wslDistroOptions = [...new Set([wslDistro, ...wslDistros].filter(Boolean))];

  useEffect(() => {
    if (!open || runtime !== "wsl") return;
    let cancelled = false;
    api
      .wslDistros()
      .then((result) => {
        if (cancelled) return;
        setWslDistros(result.distros);
        if (!wslDistro.trim() || (result.distros.length > 0 && !result.distros.includes(wslDistro))) {
          setWslDistro(result.defaultDistro || result.distros[0] || "Ubuntu");
        }
      })
      .catch((error: unknown) => addError(error instanceof Error ? error.message : String(error)));
    return () => {
      cancelled = true;
    };
  }, [addError, open, runtime, wslDistro]);

  async function addProject() {
    const trimmed = runtime === "wsl" ? wslPath.trim() : path.trim();
    if (!trimmed) return;
    try {
      const projects = await api.addProject(trimmed, runtime === "wsl" ? { runtime, wslDistro: wslDistro.trim() || "Ubuntu", wslPath: trimmed } : undefined);
      setProjects(projects);
      const added =
        runtime === "wsl"
          ? projects.find((project) => project.runtime === "wsl" && project.wslDistro === (wslDistro.trim() || "Ubuntu") && project.wslPath === trimmed) || projects[projects.length - 1]
          : projects.find((project) => project.path.toLowerCase() === trimmed.toLowerCase()) || projects[projects.length - 1];
      setSelectedProject(added?.id);
      setPath("");
      setWslPath("");
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
            Runtime
            <Select value={runtime} onValueChange={(value) => setRuntime(value as "local" | "wsl")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local</SelectItem>
                <SelectItem value="wsl">WSL</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {runtime === "wsl" ? (
            <>
              <div className="grid grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] gap-2">
                <label className="grid gap-1.5 text-sm">
                  Distro
                  <Select value={wslDistro} onValueChange={setWslDistro}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select distro" />
                    </SelectTrigger>
                    <SelectContent>
                      {(wslDistroOptions.length ? wslDistroOptions : ["Ubuntu"]).map((distro) => (
                        <SelectItem key={distro} value={distro}>
                          {distro}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  Linux path
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      value={wslPath}
                      onChange={(event) => setWslPath(event.target.value)}
                      placeholder="/home/you/projects/app"
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
              </div>
            </>
          ) : (
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
          )}
          <Button onClick={addProject} disabled={runtime === "wsl" ? !wslPath.trim() : !path.trim()}>
            <FolderPlus className="h-4 w-4" />
            Add
          </Button>
        </div>
      </DialogContent>
      <FolderBrowserDialog
        open={browserOpen}
        initialPath={runtime === "wsl" ? wslPath || "/home" : path}
        runtime={runtime}
        wslDistro={wslDistro.trim() || "Ubuntu"}
        onOpenChange={setBrowserOpen}
        onSelect={(selectedPath) => {
          if (runtime === "wsl") {
            setWslPath(selectedPath);
            setPath("");
          } else {
            setPath(selectedPath);
          }
          setBrowserOpen(false);
        }}
      />
    </Dialog>
  );
}

function FolderBrowserDialog({
  open,
  initialPath,
  runtime = "local",
  wslDistro,
  onOpenChange,
  onSelect
}: {
  open: boolean;
  initialPath: string;
  runtime?: "local" | "wsl";
  wslDistro?: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const addError = useAppStore((state) => state.addError);
  const [listing, setListing] = useState<DirectoryListing | undefined>();
  const [loading, setLoading] = useState(false);

  async function load(path?: string) {
    setLoading(true);
    try {
      setListing(await api.directories(path, runtime === "wsl" ? { runtime, distro: wslDistro || "Ubuntu" } : undefined));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void load(initialPath.trim() || undefined);
  }, [open, initialPath, runtime, wslDistro]);

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

function PluginManagementPanel({ provider }: { provider: Extract<AgentProvider, "claude" | "codex"> }) {
  const addError = useAppStore((state) => state.addError);
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
      setCatalog(await api.pluginCatalog(provider));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function enable(plugin: string) {
    try {
      await api.enablePlugin(plugin, provider);
      setCatalog(await api.pluginCatalog(provider));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function install(plugin: string) {
    const id = plugin.trim();
    if (!id) return;
    setInstallingPlugin(id);
    try {
      setCatalog(await api.installPlugin(id, pluginScope, provider));
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
      setCatalog(await api.addPluginMarketplace(source, provider));
      setMarketplaceSource("");
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddingMarketplace(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
  }, [provider]);

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
      <section className="grid gap-4 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">{provider === "codex" ? "Codex plugins" : "Claude plugins"}</h3>
            <p className="text-xs text-muted-foreground">
              {provider === "codex"
                ? "Manage cached Codex plugins and marketplaces from your Codex config."
                : "Manage installed plugins, marketplaces, and install scope for Claude sessions."}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={loadCatalog} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
        <section className="grid gap-2">
          <h4 className="text-sm font-semibold">Installed</h4>
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
          <h4 className="text-sm font-semibold">Add marketplace</h4>
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
            <Input
              value={manualPlugin}
              onChange={(event) => setManualPlugin(event.target.value)}
              placeholder="Install by plugin id"
            />
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
      </section>
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

function Sidebar({ topSlot }: { topSlot?: ReactNode }) {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const agentsById = useAppStore((state) => state.agents);
  const selectedAgentId = useAppStore((state) => state.selectedAgentId);
  const focusedAgentId = useAppStore((state) => state.focusedAgentId);
  const doneAgentIds = useAppStore((state) => state.doneAgentIds);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const setFocusedAgent = useAppStore((state) => state.setFocusedAgent);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const setCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const addError = useAppStore((state) => state.addError);
  const [runningSort, setRunningSort] = useState<"lastActivity" | "type">("lastActivity");
  const [agentTab, setAgentTab] = useState<"project" | "builtIn">("builtIn");
  const [availableOpen, setAvailableOpen] = useState(true);

  const project = projects.find((candidate) => candidate.id === selectedProjectId);
  const projectAgentDefs = project?.agents || [];
  const builtInAgentDefs = project?.builtInAgents?.length ? project.builtInAgents : [GENERAL_AGENT_DEF];
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
          agentSource: agentTab,
          provider: agent.provider,
          model: agent.defaultModel || settings.models[0] || DEFAULT_MODEL,
          permissionMode: settings.defaultAgentMode,
          autoApprove: settings.autoApprove
        }
      });
    });
    setSelectedAgent(undefined);
  }

  if (collapsed) {
    return (
      <aside className="relative flex w-14 shrink-0 flex-col overflow-x-hidden border-r border-border bg-card/45">
        {topSlot}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 py-3">
          <Button variant="ghost" size="icon" onClick={() => setCollapsed(false)} title="Expand sidebar">
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            className="h-9 w-9"
            disabled={!selectedProjectId}
            onClick={() => selectedProjectId && openLaunchModal({ projectId: selectedProjectId })}
            title="Launch agent"
          >
            <Plus className="h-4 w-4" />
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
                  title={`${agent.displayName}\n${agent.currentModel}\n${fullLastActivity(agent.updatedAt || agent.launchedAt)}`}
                >
                  <ActiveAgentDot agent={agent} />
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
        </div>
      </aside>
    );
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col overflow-x-hidden border-r border-border bg-card/45"
      style={{ width: sidebarWidth }}
    >
      {topSlot}
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
              size="icon"
              className="h-6 w-6"
              title="Close all agents"
              aria-label="Close all agents"
              onClick={() => {
                if (window.confirm("Close all open agents in this project?")) {
                  sendCommand({ type: "clearAll", projectId: selectedProjectId });
                }
              }}
            >
              <X className="h-3.5 w-3.5" />
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
                  <ActiveAgentDot agent={agent} />
                  <ProviderIcon provider={agent.provider} className="h-5 w-5 border-0 bg-transparent" iconClassName="h-4 w-4" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1 truncate text-sm">
                      {agent.displayName}
                      {agent.remoteControl && <Badge className="px-1 py-0 text-[10px]">RC</Badge>}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <ModelText agent={agent} showProviderIcon={false} />
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <StatusPill
                      status={agent.status}
                      done={Boolean(doneAgentIds[agent.id])}
                      onResume={() => sendCommand({ type: "resume", id: agent.id })}
                      onRestart={() => sendCommand({ type: "restart", id: agent.id })}
                    />
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
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
            onClick={() => setAvailableOpen((open) => !open)}
            aria-expanded={availableOpen}
          >
            {availableOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span>Available Agents</span>
          </button>
          {availableOpen && (
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
          )}
        </div>
        {availableOpen && (
          <>
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
                      className="grid min-h-20 content-start gap-1 rounded-md border border-border bg-background/40 px-2 py-2 text-left hover:bg-accent"
                      onClick={() => openLaunchModal({ projectId: project.id, defName: agent.name, agentSource: agentTab })}
                    >
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
          </>
        )}
      </section>
      <div
        className="absolute bottom-0 right-0 top-0 z-20 w-2 cursor-ew-resize hover:bg-primary/20"
        onPointerDown={startSidebarResize}
        title="Drag to resize sidebar"
      />
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
              <div className="flex items-center gap-2">
                <AgentDot color={color || "#ffffff"} className="h-4 w-4 border border-border" />
                <Input value={color} onChange={(event) => setColor(event.target.value)} placeholder="#ffffff" />
              </div>
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

function ModelText({ agent, showProviderIcon = true }: { agent: RunningAgent; showProviderIcon?: boolean }) {
  const flash = useAppStore((state) => state.flashModels[agent.id]);
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1 rounded-sm text-xs text-muted-foreground", flash && "animate-model-flash text-primary")}
      title={agent.remoteControl ? "Last known model. May have changed in claude.ai/code." : agent.currentModel}
    >
      {showProviderIcon && <ProviderIcon provider={agent.provider} />}
      <span className="truncate">{agent.currentModel}</span>
    </span>
  );
}

function ModelMenu({
  agent,
  compact = false,
  showProviderIcon = true
}: {
  agent: RunningAgent;
  compact?: boolean;
  showProviderIcon?: boolean;
}) {
  const settings = useAppStore((state) => state.settings);
  const canSwitch = !agent.remoteControl && agent.status !== "switching-model" && agentHasProcess(agent);
  const models = modelProfilesForSettings(settings).filter((profile) => profile.provider === (agent.provider || "claude"));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          disabled={!canSwitch}
          className={cn(
            "flex min-w-0 items-center gap-1 rounded-sm text-left text-xs text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground",
            compact ? "max-w-40" : "max-w-full"
          )}
          title={agent.remoteControl ? "Last known model. May have changed in claude.ai/code." : canSwitch ? "Switch model" : "Agent process is not running."}
        >
          {showProviderIcon && <ProviderIcon provider={agent.provider} />}
          <span className="truncate">
            {agent.status === "switching-model" ? agent.statusMessage || "Switching model..." : agent.currentModel}
          </span>
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

interface ProviderComposerModeOption {
  id: string;
  label: string;
  compactLabel: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  model?: string;
  permissionMode?: AgentPermissionMode;
}

function providerComposerModeOptions(
  agent: RunningAgent,
  settings: { models: string[]; modelProfiles?: ModelProfile[] }
): ProviderComposerModeOption[] {
  if (agent.provider === "codex") {
    return [
      {
        id: "intelligence",
        label: "Intelligence",
        compactLabel: "Smart",
        description: "Use the most capable Codex model for agentic coding.",
        icon: Brain,
        model: preferredProviderModeModel(settings, "codex", "intelligence")
      },
      {
        id: "speed",
        label: "Speed",
        compactLabel: "Speed",
        description: "Use the fastest Codex model for focused iteration.",
        icon: Gauge,
        model: preferredProviderModeModel(settings, "codex", "speed")
      },
      {
        id: "plan",
        label: "Plan mode",
        compactLabel: "Plan",
        description: "Codex will explore the code and present a plan before editing.",
        icon: ClipboardList,
        permissionMode: "plan"
      }
    ];
  }
  if (agent.provider === "openai") {
    return [
      {
        id: "standard",
        label: "ChatGPT",
        compactLabel: "ChatGPT",
        description: "Use the standard OpenAI model for general chat, coding, and analysis.",
        icon: OpenAiLogo,
        model: preferredProviderModeModel(settings, "openai", "standard")
      },
      {
        id: "fast",
        label: "Fast",
        compactLabel: "Fast",
        description: "Use a lower-latency OpenAI model.",
        icon: Gauge,
        model: preferredProviderModeModel(settings, "openai", "fast")
      },
      {
        id: "deepResearch",
        label: "Deep research",
        compactLabel: "Research",
        description: "Use OpenAI's deeper multi-step research model.",
        icon: Search,
        model: preferredProviderModeModel(settings, "openai", "deepResearch")
      },
      {
        id: "fastResearch",
        label: "Fast research",
        compactLabel: "Fast R.",
        description: "Use the faster, lower-cost deep research model.",
        icon: Search,
        model: preferredProviderModeModel(settings, "openai", "fastResearch")
      }
    ];
  }
  return [];
}

function activeProviderMode(agent: RunningAgent, options: ProviderComposerModeOption[]) {
  if (agent.provider === "codex") {
    if (currentPermissionMode(agent) === "plan") return options.find((option) => option.id === "plan") || options[0];
    const speedSelected = /spark|mini|codex-mini/i.test(agent.currentModel);
    return options.find((option) => option.id === (speedSelected ? "speed" : "intelligence")) || options[0];
  }
  if (agent.provider === "openai") {
    const model = agent.currentModel.toLowerCase();
    const id = model.includes("deep-research")
      ? model.includes("mini")
        ? "fastResearch"
        : "deepResearch"
      : /mini|nano/.test(model)
        ? "fast"
        : "standard";
    return options.find((option) => option.id === id) || options[0];
  }
  return options[0];
}

function effortOptionsForAgent(agent: RunningAgent) {
  return agent.provider === "claude" || !agent.provider
    ? EFFORT_OPTIONS
    : EFFORT_OPTIONS.filter((option) => option.effort !== "max");
}

function sendNextComposerMode(agent: RunningAgent, settings: { models: string[]; modelProfiles?: ModelProfile[] }) {
  if (agent.provider === "codex" || agent.provider === "openai") {
    const options = providerComposerModeOptions(agent, settings);
    const active = activeProviderMode(agent, options);
    const activeIndex = Math.max(0, options.findIndex((option) => option.id === active?.id));
    const next = options[(activeIndex + 1) % options.length];
    if (!next) return;
    if (next.permissionMode) {
      sendCommand({ type: "setPermissionMode", id: agent.id, permissionMode: next.permissionMode });
      return;
    }
    if (agent.provider === "codex" && currentPermissionMode(agent) === "plan") {
      sendCommand({ type: "setPermissionMode", id: agent.id, permissionMode: "default" });
    }
    if (next.model) sendCommand({ type: "setModel", id: agent.id, model: next.model });
    return;
  }
  sendCommand({ type: "setPermissionMode", id: agent.id, permissionMode: nextPermissionMode(agent) });
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
  const settings = useAppStore((state) => state.settings);
  const provider = agent.provider || "claude";
  const providerModeOptions = providerComposerModeOptions(agent, settings);
  const activeProviderOption = activeProviderMode(agent, providerModeOptions);
  const activeMode = currentPermissionMode(agent);
  const activeEffort = currentEffort(agent);
  const activeThinking = currentThinking(agent);
  const availableEffortOptions = effortOptionsForAgent(agent);
  const activeEffortLabel = availableEffortOptions.find((option) => option.effort === activeEffort)?.label || "Medium";
  const activeOption = COMPOSER_MODE_OPTIONS.find((option) => option.mode === activeMode) || COMPOSER_MODE_OPTIONS[0];
  const ActiveIcon = provider === "claude" ? activeOption.icon : activeProviderOption?.icon || Sparkles;

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

  function setProviderMode(option: ProviderComposerModeOption) {
    if (option.permissionMode) {
      setPermissionMode(option.permissionMode);
      return;
    }
    if (provider === "codex" && activeMode === "plan") {
      sendCommand({ type: "setPermissionMode", id: agent.id, permissionMode: "default" });
    }
    if (option.model && agent.currentModel !== option.model) {
      sendCommand({ type: "setModel", id: agent.id, model: option.model });
    }
  }

  if (provider !== "claude") {
    const buttonLabel = activeProviderOption || providerModeOptions[0];
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
            title={buttonLabel?.label}
            disabled={agent.remoteControl}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <ActiveIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{compact ? buttonLabel?.compactLabel : buttonLabel?.label}</span>
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80 p-2">
          <div className="flex items-center justify-between px-2 pb-1 pt-1 text-xs text-muted-foreground">
            <span>{provider === "codex" ? "Codex modes" : "ChatGPT modes"}</span>
            <span className="inline-flex items-center gap-1">
              <kbd className="rounded border border-border px-1 font-mono text-[10px]">Shift</kbd>
              <span>+</span>
              <kbd className="rounded border border-border px-1 font-mono text-[10px]">Tab</kbd>
              <span>to switch</span>
            </span>
          </div>
          <div className="grid gap-1">
            {providerModeOptions.map((option) => {
              const Icon = option.icon;
              const selected = option.id === activeProviderOption?.id;
              return (
                <DropdownMenuItem
                  key={option.id}
                  onClick={() => setProviderMode(option)}
                  className={cn(
                    "items-start gap-3 rounded-md px-2 py-2.5",
                    selected && "bg-primary/20 text-foreground focus:bg-primary/25"
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium leading-none">{option.label}</span>
                    <span className="mt-1 block text-xs leading-snug text-muted-foreground">{option.description}</span>
                    {option.model && <span className="mt-1 block truncate text-[11px] text-muted-foreground">{option.model}</span>}
                  </span>
                  <Check className={cn("mt-1 h-4 w-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
                </DropdownMenuItem>
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-3 border-t border-border px-2 pt-2 text-xs text-muted-foreground">
            <Brain className="h-4 w-4" />
            <span className="flex-1">
              Reasoning <span className="text-foreground">({activeEffortLabel})</span>
            </span>
            <span className="inline-flex h-5 items-center gap-2 rounded-full bg-muted px-2">
              {availableEffortOptions.map((option) => (
                <button
                  key={option.effort}
                  type="button"
                  className="grid h-4 w-4 place-items-center rounded-full"
                  title={`Reasoning: ${option.label}`}
                  aria-label={`Set reasoning to ${option.label}`}
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
            {availableEffortOptions.map((option) => (
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
  const agents = useAppStore((state) => state.agents);
  const setProjects = useAppStore((state) => state.setProjects);
  const addError = useAppStore((state) => state.addError);
  const closeLaunchModal = useAppStore((state) => state.closeLaunchModal);
  const [defName, setDefName] = useState("");
  const [agentSource, setAgentSource] = useState<AgentDefSource>("builtIn");
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [initialPrompt, setInitialPrompt] = useState("");
  const [pluginIds, setPluginIds] = useState<string[]>([]);
  const [pluginCatalog, setPluginCatalog] = useState<ClaudePluginCatalog>({ installed: [], available: [], marketplaces: [] });
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginQuery, setPluginQuery] = useState("");
  const [pluginScope, setPluginScope] = useState("user");
  const [installingPlugin, setInstallingPlugin] = useState<string | undefined>();
  const [enablingPlugin, setEnablingPlugin] = useState<string | undefined>();
  const [pluginPickerExpanded, setPluginPickerExpanded] = useState(false);
  const [agentFileOpen, setAgentFileOpen] = useState(false);
  const [launching, setLaunching] = useState(false);

  const projectId = selectedProjectId || "";
  const project = projects.find((candidate) => candidate.id === projectId);
  const agentOptionGroups = useMemo(() => groupedAgentDefsWithBuiltIns(project), [project]);
  const agentOptions = useMemo(
    () => [...agentOptionGroups.projectAgents, ...agentOptionGroups.builtInAgents],
    [agentOptionGroups.builtInAgents, agentOptionGroups.projectAgents]
  );
  const def = findAgentOption(agentOptionGroups, agentSource, defName) || agentOptions.find((candidate) => candidate.name === defName);
  const duplicateAgentNames = useMemo(() => {
    const projectNames = new Set(agentOptionGroups.projectAgents.map((agent) => agent.name.toLowerCase()));
    return new Set(agentOptionGroups.builtInAgents.map((agent) => agent.name.toLowerCase()).filter((name) => projectNames.has(name)));
  }, [agentOptionGroups.builtInAgents, agentOptionGroups.projectAgents]);
  const selectedAgentOptionKey = defName ? agentOptionKey(agentSource, defName) : "";
  const modelProfiles = useMemo(() => modelProfilesForSettings(settings), [settings]);
  function modelBelongsToProvider(modelId: string | undefined, targetProvider: AgentProvider) {
    if (!modelId) return false;
    return modelProfiles.some((item) => item.provider === targetProvider && item.id === modelId);
  }

  function agentDefaultModelForProvider(agentDef: AgentDef | undefined, targetProvider: AgentProvider) {
    if (!agentDef?.defaultModel) return undefined;
    const agentProvider = agentDef.provider || "claude";
    if (agentProvider === targetProvider || modelBelongsToProvider(agentDef.defaultModel, targetProvider)) return agentDef.defaultModel;
    return undefined;
  }

  function defaultModelForProvider(targetProvider: AgentProvider, agentDef: AgentDef | undefined = def) {
    return (
      agentDefaultModelForProvider(agentDef, targetProvider) ||
      modelProfiles.find((item) => item.provider === targetProvider && item.default)?.id ||
      modelProfiles.find((item) => item.provider === targetProvider)?.id ||
      (targetProvider === "claude" ? settings.models[0] : undefined) ||
      DEFAULT_MODEL
    );
  }

  const modelOptions = useMemo(
    () => {
      const options = modelProfiles.filter((item) => item.provider === provider);
      const agentDefaultModel = agentDefaultModelForProvider(def, provider);
      if (agentDefaultModel && !options.some((item) => item.id === agentDefaultModel)) {
        return [{ id: agentDefaultModel, provider }, ...options];
      }
      return options.length ? options : [{ id: agentDefaultModel || defaultModelForProvider(provider), provider }];
    },
    [def, modelProfiles, provider, settings.models]
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
    const nextGroups = groupedAgentDefsWithBuiltIns(nextProject);
    let nextSource = modal.agentSource;
    let nextDef = nextSource && modal.defName ? findAgentOption(nextGroups, nextSource, modal.defName) : undefined;
    if (!nextDef && modal.defName) {
      nextDef = findAgentOption(nextGroups, "project", modal.defName);
      nextSource = nextDef ? "project" : nextSource;
    }
    if (!nextDef && modal.defName) {
      nextDef = findAgentOption(nextGroups, "builtIn", modal.defName);
      nextSource = nextDef ? "builtIn" : nextSource;
    }
    if (!nextDef) {
      const fallback = defaultLaunchAgentOption(nextGroups);
      nextDef = fallback.def;
      nextSource = fallback.source;
    }
    const nextDefName = nextDef?.name || "";
    const nextProvider = nextDef?.provider || "claude";
    setDefName(nextDefName);
    setAgentSource(nextSource || "builtIn");
    setDisplayName("");
    setProvider(nextProvider);
    setModel(defaultModelForProvider(nextProvider, nextDef));
    setInitialPrompt(modal.initialPrompt || "");
    setPluginIds(nextDef?.plugins || []);
    setPluginQuery("");
    setPluginCatalog({ installed: [], available: [], marketplaces: [] });
    setPluginPickerExpanded(false);
    setAgentFileOpen(false);
    setLaunching(false);
  }, [modal, modelProfiles, projectId, projects, settings.models]);

  useEffect(() => {
    if (!def) return;
    const nextProvider = def.provider || provider;
    setProvider(nextProvider);
    setModel(defaultModelForProvider(nextProvider, def));
    setPluginIds(def.plugins || []);
    setPluginCatalog({ installed: [], available: [], marketplaces: [] });
    setPluginPickerExpanded(false);
  }, [def, modelProfiles, settings.models]);

  function selectDef(nextValue: string) {
    const { source: nextSource, name: nextDefName } = parseAgentOptionKey(nextValue);
    const nextDef = findAgentOption(agentOptionGroups, nextSource, nextDefName);
    const nextProvider = nextDef?.provider || provider;
    setDefName(nextDefName);
    setAgentSource(nextSource);
    setProvider(nextProvider);
    setModel(defaultModelForProvider(nextProvider, nextDef));
    setPluginIds(nextDef?.plugins || []);
    setPluginQuery("");
    setPluginCatalog({ installed: [], available: [], marketplaces: [] });
    setPluginPickerExpanded(false);
    setAgentFileOpen(false);
  }

  async function loadPluginCatalog() {
    setPluginsLoading(true);
    try {
      setPluginCatalog(await api.pluginCatalog(provider));
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
      setPluginCatalog(await api.installPlugin(id, pluginScope, provider));
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
      await api.enablePlugin(pluginId, provider);
      setPluginCatalog(await api.pluginCatalog(provider));
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
    if (!projectId || !defName || launching) return;
    setLaunching(true);
    try {
      if (def?.sourcePath && !arraysEqual(pluginIds, def.plugins || [])) {
        const saved = await saveAgentPlugins();
        if (!saved) {
          setLaunching(false);
          return;
        }
      }
      sendCommand({
        type: "launch",
        request: {
          projectId,
          defName,
          agentSource,
          displayName,
          provider,
          model,
          initialPrompt,
          remoteControl: false,
          permissionMode: settings.defaultAgentMode,
          autoApprove: settings.autoApprove
        }
      });
      closeLaunchModal();
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
      setLaunching(false);
    }
  }

  async function saveAgentPlugins(): Promise<boolean> {
    if (!projectId || !defName) return false;
    if (!def?.sourcePath) {
      addError("This agent does not have an agent file to save plugins to.");
      return false;
    }
    try {
      setProjects(
        agentSource === "builtIn"
          ? await api.saveBuiltInAgent(projectId, { ...def, plugins: pluginIds, originalName: def.name })
          : await api.saveAgentPlugins(projectId, defName, pluginIds)
      );
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
  const providerSupportsPlugins = provider === "claude" || provider === "codex";

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
            <Select value={selectedAgentOptionKey} onValueChange={selectDef}>
              <SelectTrigger>
                <SelectValue placeholder="Agent type" />
              </SelectTrigger>
              <SelectContent>
                {agentOptionGroups.projectAgents.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Project Agents</SelectLabel>
                    {agentOptionGroups.projectAgents.map((agent) => (
                      <SelectItem key={`project:${agent.name}`} value={agentOptionKey("project", agent.name)}>
                        <span className="inline-flex items-center gap-2">
                          <AgentDot color={agent.color} />
                          <span>{agent.name}</span>
                          {duplicateAgentNames.has(agent.name.toLowerCase()) && <Badge className="px-1 py-0 text-[10px]">Project</Badge>}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                <SelectGroup>
                  <SelectLabel>Built-In Agents</SelectLabel>
                  {agentOptionGroups.builtInAgents.map((agent) => (
                    <SelectItem key={`built-in:${agent.name}`} value={agentOptionKey("builtIn", agent.name)}>
                      <span className="inline-flex items-center gap-2">
                        <AgentDot color={agent.color} />
                        <span>{agent.name}</span>
                        {duplicateAgentNames.has(agent.name.toLowerCase()) && <Badge className="px-1 py-0 text-[10px]">Built-In</Badge>}
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
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
                setModel(defaultModelForProvider(nextProvider));
                setPluginCatalog({ installed: [], available: [], marketplaces: [] });
                setPluginPickerExpanded(false);
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
                ? "Codex sessions run through the configured Codex CLI. Codex plugins are available when the CLI plugin cache is present."
                : "OpenAI API sessions stream through the Responses API using OPENAI_API_KEY. Local CLI plugins and shell tools are not bridged by default."}
            </div>
          )}
          {providerSupportsPlugins && <section className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Agent plugins</h3>
                <p className="text-xs text-muted-foreground">
                  Selections are saved to this agent definition{provider === "codex" ? " and enabled for Codex runs." : "."}
                </p>
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
              <p className="text-xs text-muted-foreground">This agent needs an agent file before plugin selections can be saved.</p>
            )}
          </section>}
          <label className="grid gap-1.5 text-sm">
            Initial prompt
            <Textarea
              value={initialPrompt}
              onChange={(event) => setInitialPrompt(event.target.value)}
              placeholder="Optional"
            />
          </label>
          <Button onClick={launch} disabled={!projectId || !defName || !model || launching}>
            {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {launching ? "Launching..." : "Launch"}
          </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={agentFileOpen} onOpenChange={setAgentFileOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{def?.name || "general"} agent</DialogTitle>
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
              <div className="text-xs text-muted-foreground">Built-in agent definition</div>
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
  const [open, setOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [projectPaths, setProjectPaths] = useState(settings.projectPaths || []);
  const [settingsTab, setSettingsTab] = useState<"general" | "builtIn" | "claude" | "codex" | "openai">("general");
  const [claudeModelsText, setClaudeModelsText] = useState(providerModelsText(settings, "claude"));
  const [codexModelsText, setCodexModelsText] = useState(providerModelsText(settings, "codex"));
  const [openaiModelsText, setOpenaiModelsText] = useState(providerModelsText(settings, "openai"));
  const [gitPath, setGitPath] = useState(settings.gitPath || "");
  const [claudePath, setClaudePath] = useState(settings.claudePath || "");
  const [codexPath, setCodexPath] = useState(settings.codexPath || "");
  const [claudeAgentDir, setClaudeAgentDir] = useState(settings.claudeAgentDir || ".claude/agents");
  const [codexAgentDir, setCodexAgentDir] = useState(settings.codexAgentDir || ".codex/agents");
  const [openaiAgentDir, setOpenaiAgentDir] = useState(settings.openaiAgentDir || ".agent-control/openai-agents");
  const [builtInAgentDir, setBuiltInAgentDir] = useState(settings.builtInAgentDir || DEFAULT_BUILT_IN_AGENT_DIR);
  const [agentDirBrowser, setAgentDirBrowser] = useState<undefined | "claude" | "codex" | "openai" | "builtIn">();
  const [projectFolderBrowserOpen, setProjectFolderBrowserOpen] = useState(false);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [clearAnthropicApiKey, setClearAnthropicApiKey] = useState(false);
  const [clearOpenaiApiKey, setClearOpenaiApiKey] = useState(false);
  const [updatingModelsProvider, setUpdatingModelsProvider] = useState<AgentProvider | undefined>();
  const [modelUpdateNote, setModelUpdateNote] = useState("");
  const [modelUpdateNoteProvider, setModelUpdateNoteProvider] = useState<AgentProvider | undefined>();
  const [autoApprove, setAutoApprove] = useState(settings.autoApprove);
  const [defaultAgentMode, setDefaultAgentMode] = useState<AgentPermissionMode>(settings.defaultAgentMode);
  const [themeMode, setThemeMode] = useState<ThemeMode>(settings.themeMode);
  const [menuDisplay, setMenuDisplay] = useState<MenuDisplayMode>(settings.menuDisplay);
  const [tileScrolling, setTileScrolling] = useState<TileScrollingMode>(settings.tileScrolling);
  const [claudeRuntime, setClaudeRuntime] = useState<ClaudeRuntime>(settings.claudeRuntime || "cli");
  const [tileHeight, setTileHeight] = useState(settings.tileHeight);
  const [tileColumns, setTileColumns] = useState(settings.tileColumns);
  const [pinLastSentMessage, setPinLastSentMessage] = useState(settings.pinLastSentMessage);
  const [inputNotificationsEnabled, setInputNotificationsEnabled] = useState(settings.inputNotificationsEnabled === true);
  const [notificationPermission, setNotificationPermission] = useState(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );
  const [permissionAllowRules, setPermissionAllowRules] = useState<PermissionAllowRule[]>(settings.permissionAllowRules || []);
  const [updateChecksEnabled, setUpdateChecksEnabled] = useState(settings.updateChecksEnabled !== false);
  const [updateCommandsText, setUpdateCommandsText] = useState((settings.updateCommands || []).join("\n"));
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [settingsUpdateStatus, setSettingsUpdateStatus] = useState<AppUpdateStatus | undefined>();
  const [builtInEditor, setBuiltInEditor] = useState<{ open: boolean; agent?: AgentDef; originalName?: string }>({ open: false });

  useEffect(() => {
    if (!open) return;
    setProjectPaths(settings.projectPaths || []);
    setClaudeModelsText(providerModelsText(settings, "claude"));
    setCodexModelsText(providerModelsText(settings, "codex"));
    setOpenaiModelsText(providerModelsText(settings, "openai"));
    setGitPath(settings.gitPath || "");
    setClaudePath(settings.claudePath || "");
    setCodexPath(settings.codexPath || "");
    setClaudeAgentDir(settings.claudeAgentDir || ".claude/agents");
    setCodexAgentDir(settings.codexAgentDir || ".codex/agents");
    setOpenaiAgentDir(settings.openaiAgentDir || ".agent-control/openai-agents");
    setBuiltInAgentDir(settings.builtInAgentDir || DEFAULT_BUILT_IN_AGENT_DIR);
    setAnthropicApiKey("");
    setOpenaiApiKey("");
    setClearAnthropicApiKey(false);
    setClearOpenaiApiKey(false);
    setModelUpdateNote("");
    setModelUpdateNoteProvider(undefined);
    setAutoApprove(settings.autoApprove);
    setDefaultAgentMode(settings.defaultAgentMode);
    setThemeMode(settings.themeMode);
    setMenuDisplay(settings.menuDisplay);
    setTileScrolling(settings.tileScrolling);
    setClaudeRuntime(settings.claudeRuntime || "cli");
    setTileHeight(settings.tileHeight);
    setTileColumns(settings.tileColumns);
    setPinLastSentMessage(settings.pinLastSentMessage);
    setInputNotificationsEnabled(settings.inputNotificationsEnabled === true);
    setNotificationPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    setPermissionAllowRules(settings.permissionAllowRules || []);
    setUpdateChecksEnabled(settings.updateChecksEnabled !== false);
    setUpdateCommandsText((settings.updateCommands || []).join("\n"));
    setSettingsUpdateStatus(undefined);
  }, [open, settings]);

  async function save() {
    try {
      const next = await api.saveSettings({
        ...settings,
        projectPaths,
        modelProfiles: [
          ...parseProviderModels(claudeModelsText, "claude"),
          ...parseProviderModels(codexModelsText, "codex"),
          ...parseProviderModels(openaiModelsText, "openai")
        ],
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
        menuDisplay,
        tileScrolling,
        claudeRuntime,
        tileHeight,
        tileColumns,
        pinLastSentMessage,
        inputNotificationsEnabled,
        permissionAllowRules,
        updateChecksEnabled,
        updateCommands: updateCommandsText.split(/\r?\n/).map((command) => command.trim()).filter(Boolean)
      });
      setSettings(next);
      setProjects(await api.refresh());
      setOpen(false);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function getCurrentModels(provider: AgentProvider) {
    setUpdatingModelsProvider(provider);
    setModelUpdateNote("");
    setModelUpdateNoteProvider(undefined);
    try {
      const latest = await api.latestModels(provider);
      const profiles = latest.providers[provider] || [];
      const nextText = profiles.length > 0 ? profiles.map((profile) => profile.id).join("\n") : currentModelText(provider);
      if (provider === "claude") setClaudeModelsText(nextText);
      else if (provider === "codex") setCodexModelsText(nextText);
      else setOpenaiModelsText(nextText);
      const source = provider === "claude" ? "Anthropic" : "OpenAI docs";
      setModelUpdateNote(`Updated ${providerLabel(provider)} models from ${source} at ${new Date(latest.fetchedAt).toLocaleString()}. Save settings to keep this list.`);
      setModelUpdateNoteProvider(provider);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingModelsProvider(undefined);
    }
  }

  async function checkAppUpdatesNow() {
    setCheckingUpdates(true);
    try {
      setSettingsUpdateStatus(await api.appUpdates());
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingUpdates(false);
    }
  }

  function exportConfig() {
    const payload = {
      app: "AgentControl",
      exportedAt: new Date().toISOString(),
      settings: {
        ...settings,
        projectPaths,
        modelProfiles: [
          ...parseProviderModels(claudeModelsText, "claude"),
          ...parseProviderModels(codexModelsText, "codex"),
          ...parseProviderModels(openaiModelsText, "openai")
        ],
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
        menuDisplay,
        tileScrolling,
        claudeRuntime,
        tileHeight,
        tileColumns,
        pinLastSentMessage,
        inputNotificationsEnabled,
        permissionAllowRules,
        updateChecksEnabled,
        updateCommands: updateCommandsText.split(/\r?\n/).map((command) => command.trim()).filter(Boolean)
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
      setProjectPaths(next.projectPaths || []);
      setClaudeModelsText(providerModelsText(next, "claude"));
      setCodexModelsText(providerModelsText(next, "codex"));
      setOpenaiModelsText(providerModelsText(next, "openai"));
      setGitPath(next.gitPath || "");
      setClaudePath(next.claudePath || "");
      setCodexPath(next.codexPath || "");
      setClaudeAgentDir(next.claudeAgentDir || ".claude/agents");
      setCodexAgentDir(next.codexAgentDir || ".codex/agents");
      setOpenaiAgentDir(next.openaiAgentDir || ".agent-control/openai-agents");
      setBuiltInAgentDir(next.builtInAgentDir || DEFAULT_BUILT_IN_AGENT_DIR);
      setAutoApprove(next.autoApprove);
      setDefaultAgentMode(next.defaultAgentMode);
      setThemeMode(next.themeMode);
      setMenuDisplay(next.menuDisplay);
      setTileScrolling(next.tileScrolling);
      setClaudeRuntime(next.claudeRuntime || "cli");
      setTileHeight(next.tileHeight);
      setTileColumns(next.tileColumns);
      setPinLastSentMessage(next.pinLastSentMessage);
      setInputNotificationsEnabled(next.inputNotificationsEnabled === true);
      setNotificationPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
      setPermissionAllowRules(next.permissionAllowRules || []);
      setUpdateChecksEnabled(next.updateChecksEnabled !== false);
      setUpdateCommandsText((next.updateCommands || []).join("\n"));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      if (importInputRef.current) importInputRef.current.value = "";
    }
  }

  async function toggleInputNotifications(enabled: boolean) {
    if (!enabled) {
      setInputNotificationsEnabled(false);
      return;
    }
    if (typeof Notification === "undefined") {
      addError("This browser does not support notifications.");
      setNotificationPermission("unsupported");
      setInputNotificationsEnabled(false);
      return;
    }
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setNotificationPermission(permission);
    if (permission !== "granted") {
      addError("Browser notifications are not allowed for AgentControl.");
      setInputNotificationsEnabled(false);
      return;
    }
    setInputNotificationsEnabled(true);
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

  function addProjectPath(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    setProjectPaths((current) => (current.some((item) => item.toLowerCase() === trimmed.toLowerCase()) ? current : [...current, trimmed]));
  }

  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const builtInProject = selectedProject || projects[0];
  const builtInAgentDefs = builtInProject?.builtInAgents?.length ? builtInProject.builtInAgents : [GENERAL_AGENT_DEF];
  const builtInDirectoryDirty = builtInAgentDir !== (settings.builtInAgentDir || DEFAULT_BUILT_IN_AGENT_DIR);
  const browserInitialPath = agentDirBrowser
    ? agentDirBrowser !== "builtIn" && currentAgentDir(agentDirBrowser).startsWith(".") && selectedProject
      ? `${selectedProject.path}\\${currentAgentDir(agentDirBrowser)}`
      : currentAgentDir(agentDirBrowser)
    : "";
  const settingsDirty = useMemo(
    () =>
      projectPaths.join("\n") !== (settings.projectPaths || []).join("\n") ||
      claudeModelsText !== providerModelsText(settings, "claude") ||
      codexModelsText !== providerModelsText(settings, "codex") ||
      openaiModelsText !== providerModelsText(settings, "openai") ||
      gitPath !== (settings.gitPath || "") ||
      claudePath !== (settings.claudePath || "") ||
      codexPath !== (settings.codexPath || "") ||
      claudeAgentDir !== (settings.claudeAgentDir || ".claude/agents") ||
      codexAgentDir !== (settings.codexAgentDir || ".codex/agents") ||
      openaiAgentDir !== (settings.openaiAgentDir || ".agent-control/openai-agents") ||
      builtInAgentDir !== (settings.builtInAgentDir || DEFAULT_BUILT_IN_AGENT_DIR) ||
      Boolean(anthropicApiKey.trim()) ||
      Boolean(openaiApiKey.trim()) ||
      clearAnthropicApiKey ||
      clearOpenaiApiKey ||
      autoApprove !== settings.autoApprove ||
      defaultAgentMode !== settings.defaultAgentMode ||
      themeMode !== settings.themeMode ||
      menuDisplay !== settings.menuDisplay ||
      tileScrolling !== settings.tileScrolling ||
      claudeRuntime !== (settings.claudeRuntime || "cli") ||
      tileHeight !== settings.tileHeight ||
      tileColumns !== settings.tileColumns ||
      pinLastSentMessage !== settings.pinLastSentMessage ||
      inputNotificationsEnabled !== (settings.inputNotificationsEnabled === true) ||
      permissionAllowRules.map(permissionAllowRuleKey).join("\n") !== (settings.permissionAllowRules || []).map(permissionAllowRuleKey).join("\n") ||
      updateChecksEnabled !== (settings.updateChecksEnabled !== false) ||
      updateCommandsText !== (settings.updateCommands || []).join("\n"),
    [
      anthropicApiKey,
      autoApprove,
      builtInAgentDir,
      claudeAgentDir,
      claudeModelsText,
      claudePath,
      claudeRuntime,
      clearAnthropicApiKey,
      clearOpenaiApiKey,
      codexAgentDir,
      codexModelsText,
      codexPath,
      defaultAgentMode,
      gitPath,
      inputNotificationsEnabled,
      menuDisplay,
      openaiAgentDir,
      openaiApiKey,
      openaiModelsText,
      pinLastSentMessage,
      permissionAllowRules,
      projectPaths,
      settings,
      themeMode,
      tileScrolling,
      tileColumns,
      tileHeight,
      updateChecksEnabled,
      updateCommandsText
    ]
  );
  const settingsTabs = [
    ["general", "General"],
    ["builtIn", "Built-In Agents"],
    ["claude", "Claude"],
    ["codex", "Codex"],
    ["openai", "OpenAI"]
  ] as const;

  async function deleteBuiltIn(agent: AgentDef) {
    if (!builtInProject || !agent.sourcePath) return;
    if (!window.confirm(`Remove built-in agent ${agent.name}?`)) return;
    try {
      setProjects(await api.deleteBuiltInAgent(builtInProject.id, agent.name));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button
          variant="outline"
          size={settings.menuDisplay === "iconText" ? undefined : "icon"}
          className={settings.menuDisplay === "iconText" ? "gap-2 px-3" : undefined}
          onClick={() => setOpen(true)}
          title="Settings"
        >
          <Settings className="h-4 w-4" />
          {settings.menuDisplay === "iconText" && <span>Settings</span>}
        </Button>
        <DialogContent className="w-[min(96vw,1080px)] max-w-none">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="grid h-[72vh] min-h-0 grid-cols-[180px_minmax(0,1fr)] gap-4">
          <nav className="flex min-h-0 flex-col gap-1 rounded-md border border-border bg-muted/30 p-2 text-sm">
            {settingsTabs.map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                className={cn(
                  "rounded px-3 py-2 text-left text-muted-foreground hover:bg-accent hover:text-foreground",
                  settingsTab === tab && "bg-background text-foreground shadow-sm"
                )}
                onClick={() => setSettingsTab(tab)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="flex min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {settingsTab === "general" && (
            <>
          <section className="grid gap-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Project folders</h3>
                <p className="text-xs text-muted-foreground">Choose folders to load into AgentControl.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setProjectFolderBrowserOpen(true)}>
                <FolderOpen className="h-4 w-4" />
                Add Folder
              </Button>
            </div>
            <div className="grid gap-1.5">
              {projectPaths.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                  No project folders selected.
                </p>
              ) : (
                projectPaths.map((projectPath) => (
                  <div key={projectPath} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/50 px-2 py-2">
                    <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={projectPath}>
                      {projectPath}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      title="Remove project folder"
                      onClick={() => setProjectPaths((current) => current.filter((item) => item !== projectPath))}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </section>
          <section className="grid gap-2 rounded-md border border-border p-3">
            <div>
              <h3 className="text-sm font-medium">Paths</h3>
              <p className="text-xs text-muted-foreground">Leave blank to auto-detect from PATH or environment variables.</p>
            </div>
            <label className="grid gap-1.5 text-sm">
              Git path
              <Input value={gitPath} onChange={(event) => setGitPath(event.target.value)} placeholder="git" />
            </label>
          </section>
          <section className="grid gap-3 rounded-md border border-border p-3">
            <div>
              <h3 className="text-sm font-medium">Appearance</h3>
              <p className="text-xs text-muted-foreground">Control the app theme and chat layout.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-5">
              <label className="grid min-w-0 gap-1.5 text-sm">
                Color mode
                <Select value={themeMode} onValueChange={(value) => setThemeMode(value as ThemeMode)}>
                  <SelectTrigger className="px-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm">
                Menu display
                <Select value={menuDisplay} onValueChange={(value) => setMenuDisplay(value as MenuDisplayMode)}>
                  <SelectTrigger className="px-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="iconOnly">Icon Only</SelectItem>
                    <SelectItem value="iconText">Icon + Text</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm">
                Scrolling
                <Select value={tileScrolling} onValueChange={(value) => setTileScrolling(value as TileScrollingMode)}>
                  <SelectTrigger className="px-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vertical">Vertical</SelectItem>
                    <SelectItem value="horizontal">Horizontal</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm">
                <span>
                  Tile height <span className="text-xs text-muted-foreground">(0 = full height)</span>
                </span>
                <Input
                  type="number"
                  min={0}
                  max={TILE_MAX_HEIGHT}
                  value={tileHeight}
                  className="px-2"
                  onChange={(event) => setTileHeight(Number(event.target.value))}
                />
              </label>
              <label className="grid min-w-0 gap-1.5 text-sm">
                Columns
                <Input
                  type="number"
                  min={1}
                  max={6}
                  step={1}
                  value={tileColumns}
                  className="px-2"
                  onChange={(event) => setTileColumns(Number(event.target.value))}
                />
              </label>
            </div>
            <label className="flex items-start gap-2 rounded-md border border-border bg-background/50 p-3 text-sm">
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
            <label className="flex items-start gap-2 rounded-md border border-border bg-background/50 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={inputNotificationsEnabled}
                onChange={(event) => void toggleInputNotifications(event.target.checked)}
              />
              <span>
                <span className="block font-medium">Notify when agents need input</span>
                <span className="block text-xs text-muted-foreground">
                  Show a browser notification for permission prompts or questions.
                  {notificationPermission === "denied" && " Notifications are blocked in this browser."}
                </span>
              </span>
            </label>
          </section>
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
          <section className="grid gap-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">App updates</h3>
                <p className="text-xs text-muted-foreground">Check GitHub on startup and run your preferred update commands from a terminal.</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void checkAppUpdatesNow()} disabled={checkingUpdates}>
                {checkingUpdates ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Check Now
              </Button>
            </div>
            {settingsUpdateStatus && (
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                {settingsUpdateStatus.isRepo
                  ? `${settingsUpdateStatus.updateAvailable ? "Updates available" : "No updates found"} at ${new Date(settingsUpdateStatus.checkedAt).toLocaleString()}.`
                  : settingsUpdateStatus.message || "Update status unavailable."}
              </div>
            )}
            <label className="flex items-start gap-2 rounded-md border border-border bg-background/50 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={updateChecksEnabled}
                onChange={(event) => setUpdateChecksEnabled(event.target.checked)}
              />
              <span>
                <span className="block font-medium">Check for updates on startup</span>
              </span>
            </label>
            <label className="grid gap-1.5 text-sm">
              Update commands
            <Textarea
              value={updateCommandsText}
              onChange={(event) => setUpdateCommandsText(event.target.value)}
              rows={5}
              className="font-mono text-xs"
              placeholder="git pull&#10;npm ci&#10;npm run build&#10;Restart-Service AgentControl"
            />
            </label>
          </section>
          </>
          )}
          {settingsTab === "builtIn" && (
            <>
              <section className="grid gap-2 rounded-md border border-border p-3">
                <div>
                  <h3 className="text-sm font-medium">Built-in agents directory</h3>
                  <p className="text-xs text-muted-foreground">Global AgentControl agents available to every project.</p>
                </div>
                <div className="flex gap-2">
                  <Input value={builtInAgentDir} onChange={(event) => setBuiltInAgentDir(event.target.value)} placeholder={DEFAULT_BUILT_IN_AGENT_DIR} />
                  <Button type="button" variant="outline" onClick={() => setAgentDirBrowser("builtIn")}>
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </Button>
                </div>
                {builtInDirectoryDirty && (
                  <p className="rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                    Save settings to load and manage agents from this directory.
                  </p>
                )}
              </section>
              <section className="grid gap-3 rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-medium">Manage built-in agents</h3>
                    <p className="text-xs text-muted-foreground">
                      Add, edit, or remove app-level agent definitions.
                    </p>
                  </div>
                  <Button type="button" size="sm" disabled={!builtInProject || builtInDirectoryDirty} onClick={() => setBuiltInEditor({ open: true })}>
                    <Plus className="h-4 w-4" />
                    Add Agent
                  </Button>
                </div>
                {!builtInProject ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                    Add a project before managing built-in agents.
                  </p>
                ) : builtInAgentDefs.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
                    No built-in agents found.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {builtInAgentDefs.map((agent) => (
                      <div key={agent.name} className="grid min-h-24 gap-2 rounded-md border border-border bg-background/50 p-3">
                        <div className="flex min-w-0 items-start gap-2">
                          <AgentDot color={agent.color} className="mt-1" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{agent.name}</div>
                            <div className="line-clamp-2 text-xs text-muted-foreground">
                              {agent.description || "No description"}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            title="Edit built-in agent"
                            disabled={builtInDirectoryDirty}
                            onClick={() => setBuiltInEditor({ open: true, agent, originalName: agent.name })}
                          >
                            <Settings className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            disabled={!agent.sourcePath || builtInDirectoryDirty}
                            title={agent.sourcePath ? "Remove built-in agent" : "Default built-in agent cannot be removed"}
                            onClick={() => void deleteBuiltIn(agent)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
          {settingsTab === "claude" && (
            <>
              <label className="grid gap-1.5 text-sm">
                Claude runtime
                <Select value={claudeRuntime} onValueChange={(value) => setClaudeRuntime(value as ClaudeRuntime)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cli">Claude CLI</SelectItem>
                    <SelectItem value="api">Anthropic API</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                  CLI uses the local Claude Code process. API uses ANTHROPIC_API_KEY or the saved Anthropic key for new non-Remote Control Claude chats.
                </span>
              </label>
              <label className="grid gap-1.5 text-sm">
                Claude path
                <Input value={claudePath} onChange={(event) => setClaudePath(event.target.value)} placeholder="claude" disabled={claudeRuntime === "api"} />
              </label>
              <ProviderModelsField
                label="Claude provider models"
                value={claudeModelsText}
                onChange={setClaudeModelsText}
                placeholder="One Claude model id per line"
                onGetCurrentModels={() => void getCurrentModels("claude")}
                gettingCurrentModels={updatingModelsProvider === "claude"}
                updateNote={modelUpdateNoteProvider === "claude" ? modelUpdateNote : undefined}
              />
              <label className="grid gap-1.5 text-sm">
                Claude agents directory
                <div className="flex gap-2">
                  <Input value={claudeAgentDir} onChange={(event) => setClaudeAgentDir(event.target.value)} placeholder=".claude/agents" />
                  <Button type="button" variant="outline" onClick={() => setAgentDirBrowser("claude")}>
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </Button>
                </div>
              </label>
              <section className="grid gap-2 rounded-md border border-border p-3">
                <div>
                  <h3 className="text-sm font-medium">Anthropic key</h3>
                  <p className="text-xs text-muted-foreground">Environment variables win unless you save a local key here.</p>
                </div>
                <Input type="password" value={anthropicApiKey} onChange={(event) => setAnthropicApiKey(event.target.value)} placeholder={`Current: ${settings.anthropicKeySource || "missing"}`} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={clearAnthropicApiKey} onChange={(event) => setClearAnthropicApiKey(event.target.checked)} />
                  Clear saved Anthropic key{settings.anthropicKeySaved ? "" : " (none saved)"}
                </label>
              </section>
              <label className="grid gap-1.5 text-sm">
                Default mode for new Claude agents
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
                  Always passes --dangerously-skip-permissions when launching Claude agents.
                </p>
              )}
              <section className="grid gap-2 rounded-md border border-border p-3">
                <div>
                  <h3 className="text-sm font-medium">Always-allowed tools</h3>
                  <p className="text-xs text-muted-foreground">Rules are matched by provider, model, tool name, and command for shell tools.</p>
                </div>
                {permissionAllowRules.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">
                    No remembered tool approvals.
                  </p>
                ) : (
                  <div className="grid gap-1.5">
                    {permissionAllowRules.map((rule) => (
                      <div key={rule.id} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/50 px-2 py-2 text-sm">
                        <Badge className="shrink-0">{rule.toolName}</Badge>
                        <span
                          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                          title={`${rule.provider || "any"} / ${rule.model}${rule.command ? ` / ${rule.command}` : ""}`}
                        >
                          {rule.provider || "any"} / {rule.model}
                          {rule.command ? ` / ${rule.command}` : ""}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          title="Remove always-allow rule"
                          onClick={() => setPermissionAllowRules((current) => current.filter((candidate) => candidate.id !== rule.id))}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <PluginManagementPanel provider="claude" />
            </>
          )}
          {settingsTab === "codex" && (
            <>
              <label className="grid gap-1.5 text-sm">
                Codex path
                <Input value={codexPath} onChange={(event) => setCodexPath(event.target.value)} placeholder="codex" />
              </label>
              <ProviderModelsField
                label="Codex provider models"
                value={codexModelsText}
                onChange={setCodexModelsText}
                placeholder="One Codex model id per line"
                onGetCurrentModels={() => void getCurrentModels("codex")}
                gettingCurrentModels={updatingModelsProvider === "codex"}
                updateNote={modelUpdateNoteProvider === "codex" ? modelUpdateNote : undefined}
              />
              <label className="grid gap-1.5 text-sm">
                Codex agents directory
                <div className="flex gap-2">
                  <Input value={codexAgentDir} onChange={(event) => setCodexAgentDir(event.target.value)} placeholder=".codex/agents" />
                  <Button type="button" variant="outline" onClick={() => setAgentDirBrowser("codex")}>
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </Button>
                </div>
              </label>
              <PluginManagementPanel provider="codex" />
            </>
          )}
          {settingsTab === "openai" && (
            <>
              <ProviderModelsField
                label="OpenAI provider models"
                value={openaiModelsText}
                onChange={setOpenaiModelsText}
                placeholder="One OpenAI model id per line"
                onGetCurrentModels={() => void getCurrentModels("openai")}
                gettingCurrentModels={updatingModelsProvider === "openai"}
                updateNote={modelUpdateNoteProvider === "openai" ? modelUpdateNote : undefined}
              />
              <label className="grid gap-1.5 text-sm">
                OpenAI agents directory
                <div className="flex gap-2">
                  <Input value={openaiAgentDir} onChange={(event) => setOpenaiAgentDir(event.target.value)} placeholder=".agent-control/openai-agents" />
                  <Button type="button" variant="outline" onClick={() => setAgentDirBrowser("openai")}>
                    <FolderOpen className="h-4 w-4" />
                    Browse
                  </Button>
                </div>
              </label>
              <section className="grid gap-2 rounded-md border border-border p-3">
                <div>
                  <h3 className="text-sm font-medium">OpenAI key</h3>
                  <p className="text-xs text-muted-foreground">Environment variables win unless you save a local key here.</p>
                </div>
                <Input type="password" value={openaiApiKey} onChange={(event) => setOpenaiApiKey(event.target.value)} placeholder={`Current: ${settings.openaiKeySource || "missing"}`} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={clearOpenaiApiKey} onChange={(event) => setClearOpenaiApiKey(event.target.checked)} />
                  Clear saved OpenAI key{settings.openaiKeySaved ? "" : " (none saved)"}
                </label>
              </section>
              <section className="grid gap-1 rounded-md border border-border p-3 text-sm">
                <h3 className="text-sm font-medium">OpenAI plugins</h3>
                <p className="text-xs text-muted-foreground">
                  OpenAI API sessions do not expose a local plugin catalog to AgentControl. Use Codex or Claude CLI sessions for local plugins.
                </p>
              </section>
            </>
          )}
            </div>
          <div className="mt-3 flex shrink-0 justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={!settingsDirty}>
              Save
            </Button>
          </div>
          </div>
        </div>
        </DialogContent>
      </Dialog>
      {builtInProject && (
        <BuiltInAgentDialog
          project={builtInProject}
          state={builtInEditor}
          onOpenChange={(nextOpen) => setBuiltInEditor((current) => ({ ...current, open: nextOpen }))}
          onSaved={(nextProjects) => {
            setProjects(nextProjects);
            setBuiltInEditor({ open: false });
          }}
        />
      )}
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
      <FolderBrowserDialog
        open={projectFolderBrowserOpen}
        initialPath={selectedProject?.path || projectPaths[projectPaths.length - 1] || ""}
        onOpenChange={setProjectFolderBrowserOpen}
        onSelect={(selectedPath) => {
          addProjectPath(selectedPath);
          setProjectFolderBrowserOpen(false);
        }}
      />
    </>
  );
}

function ProjectInspectorTile({
  project,
  agents,
  height = 520,
  width,
  defaultWidth = "min(720px, 100%)",
  fill = false,
  tile = false,
  dock = "tile",
  poppedOutTerminalIds = new Set<string>(),
  onMove,
  onHeightChange,
  onClose
}: {
  project: Project;
  agents: RunningAgent[];
  height?: number;
  width?: number;
  defaultWidth?: string;
  fill?: boolean;
  tile?: boolean;
  dock?: FileExplorerDockPosition;
  poppedOutTerminalIds?: Set<string>;
  onMove?: (sourceId: string, targetId: string) => void;
  onHeightChange?: (height: number) => void;
  onClose?: () => void;
}) {
  const addError = useAppStore((state) => state.addError);
  const enqueueMessage = useAppStore((state) => state.enqueueMessage);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const setTileWidth = useAppStore((state) => state.setTileWidth);
  const setFileExplorerDock = useAppStore((state) => state.setFileExplorerDock);
  const setFileExplorerMaximized = useAppStore((state) => state.setFileExplorerMaximized);
  const setFileExplorerOpen = useAppStore((state) => state.setFileExplorerOpen);
  const setTerminalInFileExplorer = useAppStore((state) => state.setTerminalInFileExplorer);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const terminalInFileExplorer = useAppStore((state) => state.terminalInFileExplorer);
  const showMenuText = settings.menuDisplay === "iconText";
  const [collapsed, setCollapsed] = useState(false);
  const [tree, setTree] = useState<Record<string, ProjectTreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "": true });
  const [filter, setFilter] = useState("");
  const [searchResults, setSearchResults] = useState<ProjectFileEntry[]>([]);
  const [mode, setMode] = useState<"preview" | "diff" | "details">("preview");
  const [previewView, setPreviewView] = useState<"raw" | "formatted">("raw");
  const [diffView, setDiffView] = useState<"sideBySide" | "unified">("sideBySide");
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(260);
  const [selectedPath, setSelectedPath] = useState("");
  const [preview, setPreview] = useState<ProjectFileResponse | undefined>();
  const [diff, setDiff] = useState<ProjectDiffResponse | undefined>();
  const [status, setStatus] = useState<GitStatus | undefined>();
  const [loading, setLoading] = useState(false);
  const previewRootId = `project-inspector-preview-${project.id}`;
  const explorerSelection = useTextSelection(`#${previewRootId}`);
  const normalizedFilter = filter.trim().toLowerCase();
  const canFormatPreview = Boolean(
    preview &&
      !preview.binary &&
      (/\.(md|markdown)$/i.test(preview.relativePath) || /markdown/i.test(preview.mimeType))
  );
  const diffRows = useMemo(() => parseUnifiedDiff(diff?.diff || ""), [diff?.diff]);

  async function loadTree(pathValue = "") {
    const listing = await api.projectTree(project.id, pathValue);
    setTree((current) => ({ ...current, [listing.relativePath]: listing.entries }));
    setExpanded((current) => ({ ...current, [listing.relativePath]: true }));
  }

  async function refresh() {
    setLoading(true);
    try {
      const [root, nextStatus] = await Promise.all([api.projectTree(project.id), api.gitStatus(project.id)]);
      setTree({ [root.relativePath]: root.entries });
      setExpanded({ "": true });
      setStatus(nextStatus);
      if (selectedPath) {
        await openPreview(selectedPath, false);
        if (mode === "diff") setDiff(await api.projectDiff(project.id, selectedPath));
      }
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [project.id]);

  useEffect(() => {
    if (!normalizedFilter) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    api
      .projectFiles(project.id, normalizedFilter)
      .then((files) => {
        if (!cancelled) setSearchResults(files);
      })
      .catch((error: unknown) => {
        if (!cancelled) addError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [addError, normalizedFilter, project.id]);

  async function toggleDirectory(entry: ProjectTreeEntry) {
    if (expanded[entry.relativePath]) {
      setExpanded((current) => ({ ...current, [entry.relativePath]: false }));
      return;
    }
    try {
      if (!tree[entry.relativePath]) await loadTree(entry.relativePath);
      else setExpanded((current) => ({ ...current, [entry.relativePath]: true }));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openPreview(pathValue: string, switchMode = true) {
    setSelectedPath(pathValue);
    if (switchMode) setMode("preview");
    setPreviewView("raw");
    setLoading(true);
    try {
      setPreview(await api.projectFile(project.id, pathValue));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function openDiff(pathValue: string) {
    setSelectedPath(pathValue);
    setMode("diff");
    setLoading(true);
    try {
      setDiff(await api.projectDiff(project.id, pathValue));
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  function renderEntries(pathValue = "", depth = 0): ReactNode {
    const entries = tree[pathValue] || [];
    return entries
      .filter((entry) => !normalizedFilter || entry.type === "directory" || entry.relativePath.toLowerCase().includes(normalizedFilter))
      .map((entry) => {
        const changed = status?.files.find((file) => file.path === entry.relativePath || file.path.endsWith(` -> ${entry.relativePath}`));
        return (
          <div key={entry.relativePath}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-sm px-2 text-left text-xs hover:bg-accent",
                    selectedPath === entry.relativePath && "bg-accent text-accent-foreground"
                  )}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  onClick={() => (entry.type === "directory" ? void toggleDirectory(entry) : void openPreview(entry.relativePath))}
                  title={entry.runtimePath}
                >
                  {entry.type === "directory" ? (
                    expanded[entry.relativePath] ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <span className="w-3.5 shrink-0" />
                  )}
                  {entry.type === "directory" ? <FolderOpen className="h-3.5 w-3.5 shrink-0" /> : <FileIcon className="h-3.5 w-3.5 shrink-0" />}
                  <span className="truncate">{entry.name}</span>
                  {changed && <Badge className="ml-auto h-5 px-1 text-[10px]">{changed.status}</Badge>}
                </button>
              </ContextMenuTrigger>
              {fileBrowserContextMenu(entry.relativePath, entry.hostOpenPath, entry.type)}
            </ContextMenu>
            {entry.type === "directory" && expanded[entry.relativePath] && renderEntries(entry.relativePath, depth + 1)}
          </div>
        );
      });
  }

  function renderSearchResults(): ReactNode {
    if (!normalizedFilter) return renderEntries();
    if (searchResults.length === 0) {
      return <div className="px-2 py-3 text-xs text-muted-foreground">No matching files.</div>;
    }
    return searchResults.map((file) => {
      const changed = status?.files.find((item) => item.path === file.path || item.path.endsWith(` -> ${file.path}`));
      return (
        <ContextMenu key={file.path}>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent",
                selectedPath === file.path && "bg-accent text-accent-foreground"
              )}
              onClick={() => void openPreview(file.path)}
              title={file.path}
            >
              <FileIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              {changed && <Badge className="ml-auto h-5 px-1 text-[10px]">{changed.status}</Badge>}
            </button>
          </ContextMenuTrigger>
          {fileBrowserContextMenu(file.path, file.hostOpenPath, "file")}
        </ContextMenu>
      );
    });
  }

  function dockTerminalHere() {
    setTerminalInFileExplorer(true);
    setTerminalOpen(true);
  }

  function undockTerminalFromFileExplorer() {
    setTerminalInFileExplorer(false);
    setTerminalOpen(true);
  }

  function openFileExplorerPopout() {
    const popup = window.open(`/file-explorer-popout?projectId=${encodeURIComponent(project.id)}`, "agent-control-file-explorer", "popup,width=1100,height=760");
    if (popup) {
      window.localStorage.setItem(FILE_EXPLORER_POPOUT_STORAGE_KEY, "true");
      setFileExplorerOpen(false);
      setFileExplorerMaximized(false);
    }
  }

  async function changeFileExplorerDock(nextDock: FileExplorerDockPosition) {
    window.localStorage.setItem(FILE_EXPLORER_POPOUT_STORAGE_KEY, "false");
    setFileExplorerDock(nextDock);
    setFileExplorerMaximized(false);
    try {
      const next = await api.saveSettings({ ...settings, fileExplorerDock: nextDock });
      setSettings(next);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function minimizeFileExplorer() {
    void changeFileExplorerDock("tile");
  }

  function currentExplorerText() {
    const selected = getSelectionInRoot(`#${previewRootId}`) || explorerSelection.selectedText || explorerSelection.getCachedSelection();
    if (selected) return { scope: "selection" as const, label: "selected text", text: selected };
    if (mode === "diff" && diff) {
      const text = diff.diff || diff.content || "";
      return { scope: "file" as const, label: `diff for ${diff.relativePath}`, text };
    }
    if (preview && !preview.binary) return { scope: "file" as const, label: preview.relativePath, text: preview.content || "" };
    return { scope: "file" as const, label: selectedPath || "file", text: "" };
  }

  function sendExplorerTextToAgent(agent: RunningAgent, text: string, label: string) {
    if (!text.trim() || agent.remoteControl) return;
    const body = `Context from ${project.name}: ${label}\n\n${text}`;
    if (isAgentBusy(agent)) enqueueMessage(agent.id, { text: body, attachments: [] });
    else sendCommand({ type: "userMessage", id: agent.id, text: body, attachments: [] });
  }

  function copyText(text: string) {
    void navigator.clipboard.writeText(text).catch((error: unknown) => addError(error instanceof Error ? error.message : String(error)));
  }

  async function sendFileToAgent(pathValue: string, agent: RunningAgent) {
    if (agent.remoteControl) return;
    try {
      const attachment = await api.addProjectContext(project.id, pathValue);
      enqueueMessage(agent.id, { text: `Review ${pathValue}`, attachments: [attachment] });
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function fileBrowserContextMenu(pathValue: string, hostOpenPath: string | undefined, type: "file" | "directory") {
    const canSend = type === "file" && agents.length > 0;
    return (
      <ContextMenuContent>
        <ContextMenuItem onClick={() => copyText(pathValue)}>
          <Clipboard className="mr-2 h-4 w-4" />
          Copy relative path
        </ContextMenuItem>
        <ContextMenuItem disabled={!hostOpenPath} onClick={() => hostOpenPath && copyText(hostOpenPath)}>
          <Copy className="mr-2 h-4 w-4" />
          Copy full path
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-45" disabled={!canSend}>
            <Forward className="mr-2 h-4 w-4" />
            <span className="flex-1">Send file to</span>
            <ChevronRight className="ml-4 h-4 w-4 text-muted-foreground" />
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuSub>
              <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent">
                New agent
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {project.agents.map((def) => (
                  <ContextMenuItem
                    key={def.name}
                    onClick={() =>
                      openLaunchModal({
                        projectId: project.id,
                        defName: def.name,
                        initialPrompt: `Review ${pathValue}.`
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
                {agents.map((agent) => (
                  <ContextMenuItem
                    key={agent.id}
                    disabled={agent.remoteControl}
                    onClick={() => void sendFileToAgent(pathValue, agent)}
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

  function startBrowserResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = browserWidth;
    const onMove = (moveEvent: PointerEvent) => {
      setBrowserWidth(Math.min(520, Math.max(180, startWidth + moveEvent.clientX - startX)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function startTileWidthResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!tile) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width || width || 420;
    const onMove = (moveEvent: PointerEvent) => {
      setTileWidth("file-explorer", Math.round(Math.min(1200, Math.max(320, startWidth + moveEvent.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function startTileHeightResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!tile || !onHeightChange) return;
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = height;
    const onMove = (moveEvent: PointerEvent) => {
      onHeightChange(Math.round(Math.min(TILE_MAX_HEIGHT, Math.max(TILE_MIN_HEIGHT, startHeight + moveEvent.clientY - startY))));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  const changedFiles = status?.files || [];
  const selectedChanged = changedFiles.find((file) => file.path === selectedPath || file.path.endsWith(` -> ${selectedPath}`));

  return (
    <section
      className="relative flex min-h-0 min-w-80 max-w-full flex-col overflow-hidden rounded-md border border-border bg-card/70"
      style={{ height: collapsed ? undefined : fill ? "100%" : height, flex: fill ? "1 1 auto" : `0 0 ${width ? `${width}px` : defaultWidth}` }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        if (!onMove) return;
        event.preventDefault();
        onMove(event.dataTransfer.getData("application/x-agent-id") || event.dataTransfer.getData("text/plain"), "file-explorer");
      }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        {tile && (
          <span
            className="cursor-grab text-muted-foreground"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("application/x-agent-id", "file-explorer");
              event.dataTransfer.setData("text/plain", "file-explorer");
            }}
            title="Drag to reorder File Explorer"
          >
            <GripVertical className="h-4 w-4 shrink-0" />
          </span>
        )}
        <FileStack className="h-5 w-5 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">File Explorer</div>
          <div className="truncate text-xs text-muted-foreground">{project.name}</div>
        </div>
        <Button variant="ghost" size={showMenuText ? "sm" : "icon"} className={showMenuText ? "gap-1 px-2" : undefined} title="Refresh File Explorer" onClick={() => void refresh()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {showMenuText && "Refresh"}
        </Button>
        <Button variant={terminalInFileExplorer ? "default" : "ghost"} size={showMenuText ? "sm" : "icon"} className={showMenuText ? "gap-1 px-2" : undefined} onClick={terminalInFileExplorer ? undockTerminalFromFileExplorer : dockTerminalHere} title={terminalInFileExplorer ? "Move terminal back to main window" : "Dock terminal to File Explorer"}>
          <SquareTerminal className="h-4 w-4" />
          {showMenuText && "Terminal"}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size={showMenuText ? "sm" : "icon"} className={showMenuText ? "gap-1 px-2" : undefined} title={`File Explorer location: ${dock}`}>
              <PanelBottom className="h-4 w-4" />
              {showMenuText && "Dock"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={openFileExplorerPopout}>
              <PictureInPicture2 className="mr-2 h-4 w-4" />
              <span className="min-w-24">Pop out</span>
            </DropdownMenuItem>
            {([
              ["left", PanelLeft, "Dock left"],
              ["bottom", PanelBottom, "Dock bottom"],
              ["right", PanelRight, "Dock right"],
              ["tile", LayoutGrid, "Tile"]
            ] as const).map(([value, Icon, label]) => (
              <DropdownMenuItem key={value} onClick={() => void changeFileExplorerDock(value)}>
                <Icon className="mr-2 h-4 w-4" />
                <span className="min-w-24">{label}</span>
                <Check className={cn("ml-auto h-4 w-4", value === dock ? "opacity-100" : "opacity-0")} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size={showMenuText ? "sm" : "icon"}
          className={showMenuText ? "gap-1 px-2" : undefined}
          onClick={() => (fill || dock !== "tile" ? minimizeFileExplorer() : setCollapsed((value) => !value))}
          title={fill || dock !== "tile" ? "Minimize File Explorer to tile" : collapsed ? "Restore File Explorer" : "Collapse File Explorer"}
        >
          {collapsed && !fill && dock === "tile" ? <ChevronDown className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
          {showMenuText && "Min"}
        </Button>
        {tile && (
          <Button variant="ghost" size={showMenuText ? "sm" : "icon"} className={showMenuText ? "gap-1 px-2" : undefined} onClick={() => setFileExplorerMaximized(true)} title="Maximize File Explorer">
            <Maximize2 className="h-4 w-4" />
            {showMenuText && "Max"}
          </Button>
        )}
        {!tile && !fill && (
          <Button variant="ghost" size={showMenuText ? "sm" : "icon"} className={showMenuText ? "gap-1 px-2" : undefined} onClick={() => setFileExplorerMaximized(true)} title="Maximize File Explorer">
            <Maximize2 className="h-4 w-4" />
            {showMenuText && "Max"}
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" size={showMenuText ? "sm" : "icon"} className={showMenuText ? "gap-1 px-2" : undefined} onClick={onClose} title="Close File Explorer">
            <X className="h-4 w-4" />
            {showMenuText && "Close"}
          </Button>
        )}
      </div>
      {!collapsed && (
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: browserCollapsed ? "40px minmax(0,1fr)" : `${browserWidth}px minmax(0,1fr)` }}>
          <aside className="relative flex min-h-0 flex-col border-r border-border">
            <div className="border-b border-border p-2">
              {browserCollapsed ? (
                <Button variant="ghost" size="icon" className="h-8 w-8" title="Expand file browser" onClick={() => setBrowserCollapsed(false)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              ) : (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" title="Collapse file browser" onClick={() => setBrowserCollapsed(true)}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input className="h-8 pl-7 text-xs" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search files" title="Search files and subfolders" />
                  </div>
                </div>
              )}
            </div>
            {!browserCollapsed && <div className="min-h-0 flex-1 overflow-auto p-1">{renderSearchResults()}</div>}
            {!browserCollapsed && (
              <div
                className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize hover:bg-primary/20"
                onPointerDown={startBrowserResize}
                title="Drag to resize file browser"
              />
            )}
          </aside>
          <div className="flex min-w-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-2">
              <Button variant={mode === "preview" ? "secondary" : "ghost"} size="sm" className="h-7 gap-1 px-2" title="Show file preview" onClick={() => selectedPath && void openPreview(selectedPath)}>
                <Eye className="h-3.5 w-3.5" /> Preview
              </Button>
              <Button variant={mode === "diff" ? "secondary" : "ghost"} size="sm" className="h-7 gap-1 px-2" disabled={!selectedPath} title="Show Git diff for selected file" onClick={() => selectedPath && void openDiff(selectedPath)}>
                <GitBranch className="h-3.5 w-3.5" /> Diff
              </Button>
              {mode === "diff" && (
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2" title="Toggle side-by-side and unified diff" onClick={() => setDiffView((view) => (view === "sideBySide" ? "unified" : "sideBySide"))}>
                  <Columns2 className="h-3.5 w-3.5" /> {diffView === "sideBySide" ? "Unified" : "Side by Side"}
                </Button>
              )}
              <Button variant={mode === "details" ? "secondary" : "ghost"} size="sm" className="h-7 gap-1 px-2" disabled={!selectedPath} title="Show file details" onClick={() => setMode("details")}>
                <Info className="h-3.5 w-3.5" /> Details
              </Button>
              {mode === "preview" && canFormatPreview && (
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2" title="Toggle raw and formatted markup view" onClick={() => setPreviewView((view) => (view === "raw" ? "formatted" : "raw"))}>
                  <CodeXml className="h-3.5 w-3.5" /> {previewView === "raw" ? "Formatted" : "Raw"}
                </Button>
              )}
              <div className="min-w-0 flex-1 truncate px-2 text-xs text-muted-foreground">{selectedPath || project.path}</div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!selectedPath} title="File actions">
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => selectedPath && void navigator.clipboard.writeText(selectedPath)}>
                    <Clipboard className="mr-2 h-4 w-4" /> Copy relative path
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => copyText(preview?.hostOpenPath || diff?.hostOpenPath || selectedPath)}>
                    <Copy className="mr-2 h-4 w-4" /> Copy full path
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  id={previewRootId}
                  className="min-h-0 flex-1 overflow-auto p-3"
                  onMouseUp={() => explorerSelection.captureSelection()}
                  onKeyUp={() => explorerSelection.captureSelection()}
                  onContextMenuCapture={() => explorerSelection.captureSelection()}
                >
                  {mode === "preview" ? (
                preview ? preview.binary ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
                    Binary file. Size {formatBytes(preview.size)}.
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <FileCode2 className="h-3.5 w-3.5" />
                      <span>{preview.mimeType}</span>
                      <span>{formatBytes(preview.size)}</span>
                      <span>{formatDateTime(preview.modifiedAt)}</span>
                      {preview.truncated && <Badge>truncated</Badge>}
                    </div>
                    {canFormatPreview && previewView === "formatted" ? (
                      <div className="prose prose-sm max-w-none rounded-md bg-muted/40 p-3 text-foreground dark:prose-invert">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content || ""}</ReactMarkdown>
                      </div>
                    ) : (
                      <HighlightedCodeBlock content={preview.content || ""} path={preview.relativePath} mimeType={preview.mimeType} />
                    )}
                    {preview.truncated && (
                      <Button variant="outline" size="sm" onClick={() => void api.projectFile(project.id, preview.relativePath, true).then(setPreview).catch((error) => addError(error instanceof Error ? error.message : String(error)))}>
                        Load full file
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted-foreground">Select a file to preview.</div>
                )
              ) : mode === "diff" ? (
                diff ? diff.binary ? (
                  <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">Binary diff is not shown.</div>
                ) : (
                  <div className="grid gap-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge>{diff.status || selectedChanged?.status || "changed"}</Badge>
                      <span>Right-click to copy or send this diff.</span>
                    </div>
                    {diff.diff && diffView === "sideBySide" ? (
                      <div className="overflow-auto rounded-md border border-border bg-muted/25 font-mono text-xs">
                        <div className="grid min-w-[760px] grid-cols-[4rem_minmax(0,1fr)_4rem_minmax(0,1fr)] border-b border-border bg-muted/60 text-muted-foreground">
                          <div className="px-2 py-1 text-right">Old</div>
                          <div className="border-l border-border px-2 py-1">Before</div>
                          <div className="border-l border-border px-2 py-1 text-right">New</div>
                          <div className="border-l border-border px-2 py-1">After</div>
                        </div>
                        {diffRows.map((row, index) =>
                          row.kind === "hunk" ? (
                            <div key={`${index}-${row.header}`} className="border-y border-border bg-primary/10 px-2 py-1 text-[11px] text-primary">
                              {row.header}
                            </div>
                          ) : (
                            <div
                              key={`${index}-${row.oldLine}-${row.newLine}`}
                              className={cn(
                                "grid min-w-[760px] grid-cols-[4rem_minmax(0,1fr)_4rem_minmax(0,1fr)]",
                                row.kind === "change" && "bg-amber-500/10",
                                row.kind === "remove" && "bg-red-500/10",
                                row.kind === "add" && "bg-emerald-500/10"
                              )}
                            >
                              <div className="select-none px-2 py-0.5 text-right text-muted-foreground">{row.oldLine || ""}</div>
                              <pre className={cn("min-w-0 whitespace-pre-wrap break-words border-l border-border px-2 py-0.5", (row.kind === "remove" || row.kind === "change") && "text-red-700 dark:text-red-300")}>{row.oldText ?? ""}</pre>
                              <div className="select-none border-l border-border px-2 py-0.5 text-right text-muted-foreground">{row.newLine || ""}</div>
                              <pre className={cn("min-w-0 whitespace-pre-wrap break-words border-l border-border px-2 py-0.5", (row.kind === "add" || row.kind === "change") && "text-emerald-700 dark:text-emerald-300")}>{row.newText ?? ""}</pre>
                            </div>
                          )
                        )}
                      </div>
                    ) : (
                      <pre
                        className="syntax-highlight overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-5"
                        dangerouslySetInnerHTML={{ __html: highlightedHtml(diff.diff || diff.content || "No unstaged diff for this file.", diff.relativePath.endsWith(".diff") ? diff.relativePath : `${diff.relativePath}.diff`, "text/x-diff") }}
                      />
                    )}
                  </div>
                ) : (
                  <div className="grid h-full place-items-center text-sm text-muted-foreground">Open a changed file diff.</div>
                )
              ) : (
                <div className="grid gap-2 text-sm">
                  <div><span className="text-muted-foreground">Display path:</span> {preview?.displayPath || diff?.displayPath || selectedPath}</div>
                  <div><span className="text-muted-foreground">Runtime path:</span> {preview?.runtimePath || diff?.runtimePath}</div>
                  <div><span className="text-muted-foreground">Host open path:</span> {preview?.hostOpenPath || diff?.hostOpenPath}</div>
                  {preview && <div><span className="text-muted-foreground">Size:</span> {formatBytes(preview.size)}</div>}
                  {preview && <div><span className="text-muted-foreground">Modified:</span> {formatDateTime(preview.modifiedAt)}</div>}
                </div>
              )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                {(() => {
                  const target = currentExplorerText();
                  const fullPath = preview?.hostOpenPath || diff?.hostOpenPath || selectedPath;
                  return (
                    <>
                      <ContextMenuItem disabled={!target.text} onClick={() => copyText(target.text)}>
                        <Clipboard className="mr-2 h-4 w-4" />
                        Copy {target.label}
                      </ContextMenuItem>
                      <ContextMenuItem disabled={!selectedPath} onClick={() => copyText(selectedPath)}>
                        <ClipboardList className="mr-2 h-4 w-4" />
                        Copy relative path
                      </ContextMenuItem>
                      <ContextMenuItem disabled={!fullPath} onClick={() => copyText(fullPath)}>
                        <Copy className="mr-2 h-4 w-4" />
                        Copy full path
                      </ContextMenuItem>
                      <ContextMenuSub>
                        <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-45" disabled={!target.text}>
                          <Forward className="mr-2 h-4 w-4" />
                          <span className="flex-1">Send {target.scope === "selection" ? "selected text" : "file content"} to</span>
                          <ChevronRight className="ml-4 h-4 w-4 text-muted-foreground" />
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          <ContextMenuSub>
                            <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent">
                              New agent
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                              {project.agents.map((def) => (
                                <ContextMenuItem
                                  key={def.name}
                                  onClick={() => {
                                    if (!target.text) return;
                                    openLaunchModal({
                                      projectId: project.id,
                                      defName: def.name,
                                      initialPrompt: `Context from ${project.name}: ${target.label}\n\n${target.text}`
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
                              disabled={agents.length === 0}
                            >
                              Existing agent
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent>
                              {agents.map((agent) => (
                                <ContextMenuItem
                                  key={agent.id}
                                  disabled={agent.remoteControl}
                                  onClick={() => sendExplorerTextToAgent(agent, target.text, target.label)}
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
                    </>
                  );
                })()}
              </ContextMenuContent>
            </ContextMenu>
            {changedFiles.length > 0 && (
              <div className="max-h-28 shrink-0 overflow-auto border-t border-border p-2">
                <div className="mb-1 text-xs font-medium text-muted-foreground">Changed files</div>
                <div className="flex flex-wrap gap-1">
                  {changedFiles.map((file) => (
                    <button key={`${file.status}-${file.path}`} className="rounded-sm border border-border px-2 py-1 text-xs hover:bg-accent" onClick={() => void openDiff(file.path.includes(" -> ") ? file.path.split(" -> ").at(-1) || file.path : file.path)}>
                      {file.status}: {file.path}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {!collapsed && terminalInFileExplorer && <TerminalPanel embedded poppedOutTerminalIds={poppedOutTerminalIds} />}
      {tile && !collapsed && (
        <>
          <div
            className="absolute bottom-0 right-0 top-0 w-2 cursor-ew-resize rounded-r-md hover:bg-primary/20"
            onPointerDown={startTileWidthResize}
            title="Drag to resize File Explorer width"
          />
          <div
            className="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize rounded-b-md hover:bg-primary/20"
            onPointerDown={startTileHeightResize}
            title="Drag to resize File Explorer height"
          />
        </>
      )}
    </section>
  );
}

function AgentPanel() {
  const selectedAgentId = useAppStore((state) => state.selectedAgentId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const projects = useAppStore((state) => state.projects);
  const agentsById = useAppStore((state) => state.agents);
  const fileExplorerMaximized = useAppStore((state) => state.fileExplorerMaximized);
  const fileExplorerDock = useAppStore((state) => state.settings.fileExplorerDock);
  const setFileExplorerMaximized = useAppStore((state) => state.setFileExplorerMaximized);
  const selectedAgent = selectedAgentId ? agentsById[selectedAgentId] : undefined;
  const agent = selectedAgent && (!selectedProjectId || selectedAgent.projectId === selectedProjectId) ? selectedAgent : undefined;
  const project = projects.find((candidate) => candidate.id === selectedProjectId) || projects[0];
  const agents = useMemo(
    () =>
      agentsForProject(agentsById, selectedProjectId).sort(
        (left, right) => +new Date(right.launchedAt) - +new Date(left.launchedAt)
      ),
    [agentsById, selectedProjectId]
  );

  if (fileExplorerMaximized && project) {
    return (
      <main className="min-w-0 flex-1 overflow-hidden p-4">
        <ProjectInspectorTile
          project={project}
          agents={agents}
          height={undefined}
          defaultWidth="100%"
          fill
          dock={fileExplorerDock}
          onClose={() => setFileExplorerMaximized(false)}
        />
      </main>
    );
  }

  if (agent) {
    return agent.remoteControl ? <RemoteControlPanel agent={agent} /> : <StandardAgentPanel agent={agent} />;
  }
  return <AgentTileGrid agents={agents} project={project} />;
}

function AgentTileGrid({ agents, project }: { agents: RunningAgent[]; project?: Project }) {
  const tileOrder = useAppStore((state) => state.tileOrder);
  const setTileOrder = useAppStore((state) => state.setTileOrder);
  const settings = useAppStore((state) => state.settings);
  const currentTileHeight = useAppStore((state) => state.currentTileHeight);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const fileExplorerOpen = useAppStore((state) => state.fileExplorerOpen);
  const fileExplorerDock = useAppStore((state) => state.settings.fileExplorerDock);
  const setFileExplorerOpen = useAppStore((state) => state.setFileExplorerOpen);
  const poppedOutTerminalIds = useMemo(readPoppedOutTerminalIds, []);
  const configuredTileHeight = currentTileHeight ?? settings.tileHeight;
  const tileColumns = settings.tileColumns || 2;
  const horizontalScrolling = settings.tileScrolling === "horizontal";
  const tileWidths = useAppStore((state) => state.tileWidths);
  const mainRef = useRef<HTMLElement | null>(null);
  const [fullTileHeight, setFullTileHeight] = useState(TILE_MIN_HEIGHT);
  const [rowHeights, setRowHeights] = useState<number[]>([]);
  const tileHeight = configuredTileHeight === 0 ? fullTileHeight : configuredTileHeight;
  const fileExplorerTileOpen = Boolean(project && fileExplorerOpen && fileExplorerDock === "tile");
  const tileItems = useMemo(() => {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const ids = [
      ...tileOrder.filter((id) => id === "file-explorer" ? fileExplorerTileOpen : byId.has(id)),
      ...(fileExplorerTileOpen && !tileOrder.includes("file-explorer") ? ["file-explorer"] : []),
      ...agents.filter((agent) => !tileOrder.includes(agent.id)).map((agent) => agent.id)
    ];
    return ids.map((id) => (id === "file-explorer" ? ({ kind: "fileExplorer" as const, id }) : ({ kind: "agent" as const, id, agent: byId.get(id)! }))).filter((item) => item.kind === "fileExplorer" || Boolean(item.agent));
  }, [agents, fileExplorerTileOpen, tileOrder]);
  const totalTiles = tileItems.length;
  const rowCount = horizontalScrolling ? 1 : Math.max(1, Math.ceil(totalTiles / tileColumns));

  useEffect(() => {
    if (configuredTileHeight !== 0) return;
    const updateFullTileHeight = () => {
      const main = mainRef.current;
      const availableHeight = main instanceof HTMLElement ? main.clientHeight - 32 : window.innerHeight - 120;
      setFullTileHeight(Math.min(TILE_MAX_HEIGHT, Math.max(TILE_MIN_HEIGHT, Math.round(availableHeight))));
    };
    updateFullTileHeight();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateFullTileHeight) : undefined;
    if (mainRef.current) observer?.observe(mainRef.current);
    window.addEventListener("resize", updateFullTileHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateFullTileHeight);
    };
  }, [configuredTileHeight, fileExplorerDock, fileExplorerOpen, settings.terminalDock, terminalOpen]);

  useEffect(() => {
    const clamped = Math.min(TILE_MAX_HEIGHT, Math.max(TILE_MIN_HEIGHT, tileHeight));
    setRowHeights(Array.from({ length: rowCount }, () => clamped));
  }, [rowCount, tileHeight]);

  function moveTile(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const ids = tileItems.map((item) => item.id);
    const sourceIndex = ids.indexOf(sourceId);
    const targetIndex = ids.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = ids.splice(sourceIndex, 1);
    ids.splice(targetIndex, 0, moved);
    setTileOrder(ids);
  }

  function setRowHeight(rowIndex: number, nextHeight: number) {
    const clamped = Math.min(TILE_MAX_HEIGHT, Math.max(TILE_MIN_HEIGHT, nextHeight));
    setRowHeights((current) => {
      const next = [...current];
      next[rowIndex] = Math.round(clamped);
      return next;
    });
  }

  function setRowBoundary(currentRowIndex: number, nextCurrentHeight: number, totalHeight: number) {
    if (currentRowIndex <= 0) return;
    const maxCurrent = Math.min(TILE_MAX_HEIGHT, totalHeight - TILE_MIN_HEIGHT);
    const minCurrent = Math.max(TILE_MIN_HEIGHT, totalHeight - TILE_MAX_HEIGHT);
    const currentHeight = Math.round(Math.min(maxCurrent, Math.max(minCurrent, nextCurrentHeight)));
    const previousHeight = Math.round(totalHeight - currentHeight);
    setRowHeights((current) => {
      const next = [...current];
      next[currentRowIndex - 1] = previousHeight;
      next[currentRowIndex] = currentHeight;
      return next;
    });
  }

  if (agents.length === 0 && !fileExplorerTileOpen) {
    return <div className="grid flex-1 place-items-center text-sm text-muted-foreground">No agents open.</div>;
  }

  return (
    <main ref={mainRef} className="min-w-0 flex-1 overflow-auto">
      <div className={cn("flex items-start gap-4 p-4", horizontalScrolling ? "flex-nowrap" : "flex-wrap")}>
        {tileItems.map((item, index) => {
          const rowIndex = horizontalScrolling ? 0 : Math.floor(index / tileColumns);
          const rowHeight = rowHeights[rowIndex] ?? tileHeight;
          const defaultWidth = `calc((100% - ${(tileColumns - 1) * 1}rem) / ${tileColumns})`;
          if (item.kind === "fileExplorer") {
            return project ? (
              <ProjectInspectorTile
                key={item.id}
                project={project}
                agents={agents}
                height={rowHeight}
                width={tileWidths["file-explorer"]}
                defaultWidth={defaultWidth}
                tile
                dock={fileExplorerDock}
                poppedOutTerminalIds={poppedOutTerminalIds}
                onMove={moveTile}
                onHeightChange={(nextHeight) => setRowHeight(rowIndex, nextHeight)}
                onClose={() => setFileExplorerOpen(false)}
              />
            ) : null;
          }
          return (
            <AgentTile
              key={item.agent.id}
              agent={item.agent}
              height={rowHeight}
              previousRowHeight={rowIndex > 0 ? rowHeights[rowIndex - 1] ?? tileHeight : undefined}
              rowIndex={rowIndex}
              width={tileWidths[item.agent.id]}
              defaultWidth={defaultWidth}
              onMove={moveTile}
              onHeightChange={(nextHeight) => setRowHeight(rowIndex, nextHeight)}
              onHeightChangeFromTop={
                rowIndex > 0 ? (nextHeight, totalHeight) => setRowBoundary(rowIndex, nextHeight, totalHeight) : undefined
              }
            />
          );
        })}
      </div>
    </main>
  );
}

function FileExplorerDockPanel({
  project,
  agents,
  dock,
  poppedOutTerminalIds
}: {
  project?: Project;
  agents: RunningAgent[];
  dock: FileExplorerDockPosition;
  poppedOutTerminalIds: Set<string>;
}) {
  const setFileExplorerOpen = useAppStore((state) => state.setFileExplorerOpen);
  const [width, setWidth] = useState(420);
  const [height, setHeight] = useState(320);
  if (!project) return null;
  const sideDock = dock === "left" || dock === "right";
  const bottomDock = dock === "bottom";
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!bottomDock) return;
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
    window.addEventListener("pointerup", onUp, { once: true });
  }
  function startSideResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!sideDock) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const direction = dock === "left" ? 1 : -1;
    const onMove = (moveEvent: PointerEvent) => {
      setWidth(Math.min(760, Math.max(320, startWidth + direction * (moveEvent.clientX - startX))));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }
  const panelStyle: CSSProperties | undefined = sideDock
    ? { width, minWidth: width, maxWidth: width, flex: `0 0 ${width}px` }
    : bottomDock
      ? { height, minHeight: height, maxHeight: height, flex: `0 0 ${height}px` }
      : undefined;
  return (
    <section
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col overflow-hidden bg-card",
        dock === "left" ? "h-full border-r border-border" : dock === "right" ? "h-full border-l border-border" : "border-t border-border"
      )}
      style={panelStyle}
    >
      {bottomDock && (
        <div className="absolute -top-1 left-0 right-0 z-20 h-2 cursor-ns-resize hover:bg-primary/25" onPointerDown={startResize} title="Drag to resize File Explorer" />
      )}
      {sideDock && (
        <div
          className={cn("absolute top-0 z-20 h-full w-2 cursor-ew-resize hover:bg-primary/25", dock === "left" ? "-right-1" : "-left-1")}
          onPointerDown={startSideResize}
          title="Drag to resize File Explorer"
        />
      )}
      <ProjectInspectorTile
        project={project}
        agents={agents}
        fill
        defaultWidth="100%"
        dock={dock}
        poppedOutTerminalIds={poppedOutTerminalIds}
        onClose={() => setFileExplorerOpen(false)}
      />
    </section>
  );
}

function AgentTile({
  agent,
  height,
  previousRowHeight,
  rowIndex,
  width,
  defaultWidth,
  onMove,
  onHeightChange,
  onHeightChangeFromTop
}: {
  agent: RunningAgent;
  height: number;
  previousRowHeight?: number;
  rowIndex: number;
  width?: number;
  defaultWidth: string;
  onMove: (sourceId: string, targetId: string) => void;
  onHeightChange: (height: number) => void;
  onHeightChangeFromTop?: (height: number, totalHeight: number) => void;
}) {
  const transcript = useAppStore((state) => state.transcripts[agent.id] || EMPTY_TRANSCRIPT);
  const transcriptItems = useMemo(() => pairedTranscriptItems(transcript), [transcript]);
  const draft = useAppStore((state) => state.drafts[agent.id] || "");
  const setDraft = useAppStore((state) => state.setDraft);
  const queue = useAppStore((state) => state.messageQueues[agent.id] || EMPTY_QUEUE);
  const enqueueMessage = useAppStore((state) => state.enqueueMessage);
  const addError = useAppStore((state) => state.addError);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const setFocusedAgent = useAppStore((state) => state.setFocusedAgent);
  const setChatFocusedAgent = useAppStore((state) => state.setChatFocusedAgent);
  const setTileWidth = useAppStore((state) => state.setTileWidth);
  const tileMinimized = useAppStore((state) => Boolean(state.minimizedTiles[agent.id]));
  const setTileMinimized = useAppStore((state) => state.setTileMinimized);
  const focusedAgentId = useAppStore((state) => state.focusedAgentId);
  const done = useAppStore((state) => Boolean(state.doneAgentIds[agent.id]));
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
  const suppressScrollIntoViewRef = useRef(false);
  const [showPinnedMessage, setShowPinnedMessage] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextCopyTarget, setContextCopyTarget] = useState<ContextCopyTarget | undefined>();
  const [composerDropActive, setComposerDropActive] = useState(false);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const [transcriptViewMode, setTranscriptViewMode] = useState<TranscriptViewMode>("chat");
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuSuppressed, setSlashMenuSuppressed] = useState(false);
  const composerDragDepthRef = useRef(0);
  const isBusy = isAgentBusy(agent);
  const canType = agentHasProcess(agent);
  const canAttach = !agent.remoteControl;
  const showActivityIndicator = isBusy && agent.status !== "awaiting-input" && !hasStreamingAssistantText(transcript);
  const phaseLabel = isBusy ? executingPlanPhase(transcript) : undefined;
  const pinnedMessage = latestUserMessage(transcript);
  const pinLastSentMessage = settings.pinLastSentMessage;
  const rawSlashSuggestions = useMemo(
    () => slashCommandSuggestions(draft, modelIdsForProvider(settings, agent.provider || "claude"), agent.slashCommands, agent.provider || "claude"),
    [agent.provider, agent.slashCommands, draft, settings]
  );
  const pickerSlashSuggestions = useMemo(
    () => slashCommandSuggestions("", modelIdsForProvider(settings, agent.provider || "claude"), agent.slashCommands, agent.provider || "claude", true),
    [agent.provider, agent.slashCommands, settings]
  );
  const slashSuggestions = slashMenuOpen ? pickerSlashSuggestions : slashMenuSuppressed ? [] : rawSlashSuggestions;
  const selectedLines = selectedLineCount(selection.selectedText);
  const draftLines = draftLineCount(draft);
  const [composerWrapped, setComposerWrapped] = useState(false);

  const hasMultilineDraft = draftLines > 1 || composerWrapped;
  const composerExpanded = hasMultilineDraft && !composerCollapsed;
  useQueuedMessageSender(agent, queue, canType);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 180;
    if (isBusy || nearBottom) root.scrollTop = root.scrollHeight;
    setShowPinnedMessage(shouldShowPinnedUserMessage(root, pinnedMessage?.id));
    setShowJumpToBottom(!isNearScrollBottom(root));
  }, [transcript, agent.id, isBusy, pinnedMessage?.id]);

  function handleTranscriptScroll(event: ReactUIEvent<HTMLDivElement>) {
    const nextVisible = shouldShowPinnedUserMessage(event.currentTarget, pinnedMessage?.id);
    setShowPinnedMessage((current) => (current === nextVisible ? current : nextVisible));
    setShowJumpToBottom(!isNearScrollBottom(event.currentTarget));
  }

  useEffect(() => {
    if (focusedAgentId !== agent.id) return;
    if (suppressScrollIntoViewRef.current) {
      suppressScrollIntoViewRef.current = false;
    } else {
      tileRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    if (suppressAutoFocusRef.current) {
      suppressAutoFocusRef.current = false;
      return;
    }
    if (canType) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [agent.id, canType, focusedAgentId]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashSuggestions.length, draft]);

  useEffect(() => {
    if (!hasMultilineDraft && composerCollapsed) setComposerCollapsed(false);
  }, [composerCollapsed, hasMultilineDraft]);

  useEffect(() => {
    const measure = () => setComposerWrapped(composerNeedsExpansion(inputRef.current, 36));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [draft]);

  function activateTile(focusInput = false, scrollIntoView = true) {
    suppressAutoFocusRef.current = !focusInput;
    suppressScrollIntoViewRef.current = !scrollIntoView;
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
    if (!draft.trim() && attachments.length === 0) return;
    if (agent.remoteControl && attachments.length > 0) {
      addError("Remote Control stdin bridge does not support attachments yet.");
      return;
    }
    const injectedText = injectedMessageText(agent, draft);
    if (injectedText) {
      if (isBusy) sendCommand({ type: "injectMessage", id: agent.id, text: injectedText, attachments });
      else sendCommand({ type: "userMessage", id: agent.id, text: injectedText, attachments });
      setDraft(agent.id, "");
      setComposerCollapsed(false);
      setAttachments([]);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (handleNativeSlashCommand(agent, draft)) {
      setDraft(agent.id, "");
      return;
    }
    if (isBusy) {
      enqueueMessage(agent.id, { text: draft, attachments });
      setDraft(agent.id, "");
      setComposerCollapsed(false);
      setAttachments([]);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    sendCommand({ type: "userMessage", id: agent.id, text: draft, attachments });
    setDraft(agent.id, "");
    setComposerCollapsed(false);
    setAttachments([]);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function stopCurrentResponse() {
    sendCommand({ type: "interrupt", id: agent.id });
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function selectTypedSlashCommand(value: string) {
    setDraft(agent.id, value);
    setSlashMenuOpen(false);
    setSlashMenuSuppressed(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function runSlashCommand(value: string) {
    const commandText = value.trim();
    setSlashMenuOpen(false);
    setSlashMenuSuppressed(false);
    setActiveSlashIndex(0);
    if (!commandText) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (handleNativeSlashCommand(agent, commandText)) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (!canType) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const injectedText = injectedMessageText(agent, commandText);
    if (injectedText) {
      if (isBusy) sendCommand({ type: "injectMessage", id: agent.id, text: injectedText });
      else sendCommand({ type: "userMessage", id: agent.id, text: injectedText, attachments: [] });
    } else if (isBusy) {
      enqueueMessage(agent.id, { text: commandText, attachments: [] });
    } else {
      sendCommand({ type: "userMessage", id: agent.id, text: commandText, attachments: [] });
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function toggleSlashMenu() {
    setSlashMenuOpen((open) => !open);
    setSlashMenuSuppressed(false);
    setActiveSlashIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      sendNextComposerMode(agent, settings);
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
        if (selected) {
          if (slashMenuOpen) runSlashCommand(selected.value);
          else selectTypedSlashCommand(selected.value);
        }
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const selected = enabledSlashSuggestion(slashSuggestions[activeSlashIndex]);
        if (selected && slashMenuOpen) {
          event.preventDefault();
          runSlashCommand(selected.value);
          return;
        }
        if (selected && draft.trim() !== selected.value.trim()) {
          event.preventDefault();
          selectTypedSlashCommand(selected.value);
          return;
        }
        if (slashSuggestions[activeSlashIndex]?.disabled) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenuOpen(false);
        setSlashMenuSuppressed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  async function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = pastedImageFiles(event);
    const pastedText = event.clipboardData.getData("text/plain");
    const pastedMultilineText = /\r|\n/.test(pastedText);
    if (files.length === 0 && !pastedMultilineText) return;
    event.preventDefault();
    if (pastedMultilineText) setComposerCollapsed(false);
    if (pastedText) {
      const selectionStart = event.currentTarget.selectionStart ?? draft.length;
      const nextDraft = insertPastedText(event.currentTarget, draft, pastedText);
      const nextCursor = selectionStart + pastedText.length;
      setDraft(agent.id, nextDraft);
      window.requestAnimationFrame(() => inputRef.current?.setSelectionRange(nextCursor, nextCursor));
    }
    if (files.length === 0) return;
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
    if (!canType || !canAttach || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    try {
      const dropped = await attachmentsFromDrop(agent, event.dataTransfer);
      if (dropped.length > 0) setAttachments((current) => [...current, ...dropped]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleComposerDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || !canAttach || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    setComposerDropActive(true);
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || !canAttach || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setComposerDropActive(true);
  }

  function handleComposerDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || !canAttach || isAgentReorderDrag(event.dataTransfer)) return;
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
      nextHeight = Math.min(TILE_MAX_HEIGHT, Math.max(TILE_MIN_HEIGHT, startHeight + moveEvent.clientY - startY));
      onHeightChange(Math.round(nextHeight));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  function startTopHeightResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!onHeightChangeFromTop || previousRowHeight === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const startHeight = height;
    const totalHeight = previousRowHeight + height;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const nextHeight = startHeight + startY - moveEvent.clientY;
      onHeightChangeFromTop(Math.round(nextHeight), totalHeight);
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
      style={{ height: tileMinimized ? undefined : height, flex: `0 0 ${width ? `${width}px` : defaultWidth}` }}
      onDragOver={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        activateTile(false, false);
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
        <ActiveAgentDot agent={agent} />
        <ProviderIcon provider={agent.provider} className="h-5 w-5 border-0 bg-transparent" iconClassName="h-4 w-4" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate text-sm font-semibold">{agent.displayName}</span>
            {agent.remoteControl && <Badge className="px-1 py-0 text-[10px]">RC</Badge>}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <ModelMenu agent={agent} compact showProviderIcon={false} />
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <LastActivityText agent={agent} compact timeOnly />
          <StatusPill
            status={agent.status}
            done={done}
            onResume={() => sendCommand({ type: "resume", id: agent.id })}
            onRestart={() => sendCommand({ type: "restart", id: agent.id })}
          />
        </span>
        <AgentActionsMenu
          agent={agent}
          transcripts={transcript}
          viewMode={transcriptViewMode}
          onToggleViewMode={() => setTranscriptViewMode((mode) => (mode === "chat" ? "raw" : "chat"))}
        />
        <Button
          variant="ghost"
          size="icon"
          onClick={(event) => {
            event.stopPropagation();
            setTileMinimized(agent.id, !tileMinimized);
          }}
          title={tileMinimized ? "Restore tile" : "Minimize tile"}
        >
          {tileMinimized ? <ChevronDown className="h-4 w-4" /> : <Minimize2 className="h-4 w-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={() => setSelectedAgent(agent.id)} title="Maximize">
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
      {!tileMinimized && (
        <>
          {rowIndex > 0 && (
            <div
              className="absolute left-0 right-0 top-0 z-20 h-2 cursor-ns-resize rounded-t-md hover:bg-primary/20"
              onPointerDown={startTopHeightResize}
              title="Drag up to expand this row and shrink the row above"
            />
          )}
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
                {transcriptViewMode === "chat" && pinLastSentMessage && pinnedMessage && showPinnedMessage && (
                  <PinnedUserMessage event={pinnedMessage} compact onJump={() => scrollToLatestUserMessage(rootRef.current)} />
                )}
                {agent.statusMessage && (
                  <p className="mb-3 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                    {agent.statusMessage}
                  </p>
                )}
                {agent.remoteControl ? (
                  <div className="grid gap-3">
                    <div className="grid justify-items-center gap-3 rounded-md border border-dashed border-border p-3 text-center">
                      {agent.qr ? (
                        <img className="h-36 w-36 rounded-md bg-white p-2" src={agent.qr} alt="Remote Control QR code" />
                      ) : (
                        <div className="grid h-36 w-36 place-items-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
                          Waiting for QR
                        </div>
                      )}
                      <p className="text-sm text-muted-foreground">{remoteControlLabel(agent)}</p>
                      <p className="text-xs text-muted-foreground">
                        Experimental bridge: stdout is mirrored below, and messages typed here are sent to Remote Control stdin.
                      </p>
                      {agent.rcUrl && <p className="max-w-full break-all text-xs text-muted-foreground">{agent.rcUrl}</p>}
                      <Button
                        variant="outline"
                        disabled={!agent.rcUrl}
                        onClick={() => agent.rcUrl && window.open(agent.rcUrl, "_blank", "noopener")}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open
                      </Button>
                      <pre className="max-h-24 w-full overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2 text-left text-[11px] text-muted-foreground">
                        {(agent.rcDiagnostics || []).length > 0
                          ? (agent.rcDiagnostics || []).slice(-6).join("\n")
                          : "Waiting for Remote Control diagnostics..."}
                        </pre>
                      </div>
                    {transcript.length === 0 ? (
                      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                        No mirrored Remote Control transcript yet.
                      </p>
                    ) : (
                      <div className="grid gap-2">
                        {transcriptItems.map((item, index) => (
                          <TranscriptPreview
                            key={item.kind === "tool_pair" ? item.event.id : item.event.id}
                            item={item}
                            agent={agent}
                            phaseLabel={phaseLabel}
                            latestUserMessageId={pinnedMessage?.id}
                            defaultExpanded={shouldExpandTranscriptItemByDefault(item, index, transcriptItems)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ) : transcriptViewMode === "raw" ? (
                  <RawStreamView agent={agent} transcript={transcript} compact />
                ) : transcript.length === 0 ? (
                  showActivityIndicator ? (
                    <AgentActivityIndicator agent={agent} compact phaseLabel={phaseLabel} />
                  ) : (
                    <p className="rounded-md border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground">
                      No transcript yet.
                    </p>
                  )
                ) : (
                  <div className="grid gap-2">
                    {transcriptItems.map((item, index) => (
                      <TranscriptPreview
                        key={item.kind === "tool_pair" ? item.event.id : item.event.id}
                        item={item}
                        agent={agent}
                        phaseLabel={phaseLabel}
                        latestUserMessageId={pinnedMessage?.id}
                        defaultExpanded={shouldExpandTranscriptItemByDefault(item, index, transcriptItems)}
                      />
                    ))}
                    {showActivityIndicator && <AgentActivityIndicator agent={agent} compact phaseLabel={phaseLabel} />}
                  </div>
                )}
                {transcriptViewMode === "chat" && showJumpToBottom && (
                  <div className="pointer-events-none sticky bottom-2 z-30 flex justify-end">
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="pointer-events-auto h-8 w-8 rounded-full border border-border shadow-md"
                      title="Jump to bottom"
                      aria-label="Jump to bottom"
                      onClick={() => scrollTranscriptToBottom(rootRef.current)}
                    >
                      <CircleArrowDown className="h-4 w-4" />
                    </Button>
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
            <div className="absolute bottom-full left-0 right-0 z-[220] mb-2 px-2">
              <SlashCommandAutocomplete
                suggestions={slashSuggestions}
                activeIndex={activeSlashIndex}
                compact
                onSelect={slashMenuOpen ? runSlashCommand : selectTypedSlashCommand}
                onActiveIndexChange={setActiveSlashIndex}
              />
            </div>
            <div className="grid gap-2 px-2 pt-2">
              <AttachmentChips
                attachments={attachments}
                onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
              />
            </div>
            <div className="relative">
              <Textarea
                ref={inputRef}
                className={cn(
                  "min-h-9 resize-none border-0 bg-transparent py-2 text-sm leading-5 focus-visible:ring-0",
                  composerExpanded && "pr-10",
                  hasMultilineDraft && "pr-16",
                  composerExpanded ? "h-24 max-h-40 overflow-y-auto" : "h-9 overflow-hidden"
                )}
                value={draft}
                disabled={!canType}
                onFocus={() => {
                  activateTile(true);
                  setChatFocusedAgent(agent.id);
                }}
                onBlur={() => setChatFocusedAgent(undefined)}
                onChange={(event) => {
                  activateTile(true);
                  setSlashMenuOpen(false);
                  setSlashMenuSuppressed(false);
                  setDraft(agent.id, event.target.value);
                  setComposerWrapped(composerNeedsExpansion(event.currentTarget, 36));
                }}
                onPaste={handlePaste}
                placeholder={isBusy ? "Queue a message..." : `chat with ${providerLabel(agent.provider)}`}
                onKeyDown={handleComposerKeyDown}
              />
              {hasMultilineDraft && (
                <button
                  type="button"
                  className="absolute right-6 top-2 grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  title={composerExpanded ? "Collapse message" : `Expand ${draftLines}-line message`}
                  onClick={() => {
                    setComposerCollapsed(!composerCollapsed);
                    window.requestAnimationFrame(() => inputRef.current?.focus());
                  }}
                >
                  {composerExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </button>
              )}
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
                <ComposerAddMenu disabled={!canType || !canAttach} onUpload={() => fileInputRef.current?.click()} onAddContext={() => setContextOpen(true)} />
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
                  {isBusy ? <Square className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
            </div>
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
        </>
      )}
    </section>
  );
}

function TranscriptPreview({
  item,
  agent,
  phaseLabel,
  latestUserMessageId,
  defaultExpanded = false
}: {
  item: ToolTranscriptItem;
  agent: RunningAgent;
  phaseLabel?: string;
  latestUserMessageId?: string;
  defaultExpanded?: boolean;
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
  if (event.kind === "questions") {
    return <QuestionCard event={event} agent={agent} compact />;
  }
  if (event.kind === "plan") {
    return <PlanCard event={event} agent={agent} compact />;
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
          showPopout && "pr-16"
        )}
        data-copy-block="true"
        data-copy-event-id={event.id}
        style={!isUser ? { borderLeftColor: agentAccentColor(agent.color), borderLeftWidth: 4 } : undefined}
      >
        {showPopout && <ChatBlockPopoutButton source={agent} text={event.text} compact />}
        <CollapsibleText text={event.text} compact inlineToggle={showPopout} defaultExpanded={defaultExpanded} />
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
          <span className="mt-2 grid gap-1">
            {phaseLabel && <span className="text-[11px] font-medium uppercase tracking-normal text-muted-foreground">{phaseLabel}</span>}
            <ThinkingText agent={agent} prefix="Streaming" startedAt={agent.turnStartedAt} usage={agent.lastTokenUsage} />
          </span>
        )}
      </div>
    </div>
  );
}

function PinnedUserMessage({
  event,
  compact = false,
  onJump
}: {
  event: Extract<TranscriptEvent, { kind: "user" }>;
  compact?: boolean;
  onJump?: () => void;
}) {
  const minimizedMaxHeight = compact ? 16 : 20;

  return (
    <div className="group sticky top-0 z-20 mb-3 flex justify-end">
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "relative max-w-full cursor-pointer rounded-md border border-primary/40 bg-primary/95 px-3 py-2 text-primary-foreground shadow-lg outline-none backdrop-blur focus-visible:ring-2 focus-visible:ring-ring",
          "user-question",
          compact ? "text-xs leading-4" : "text-sm leading-5"
        )}
        data-copy-block="true"
        data-copy-event-id={event.id}
        title="Jump to message"
        onClick={onJump}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === "Enter" || keyEvent.key === " ") {
            keyEvent.preventDefault();
            onJump?.();
          }
        }}
      >
        <div className="flex min-w-0 items-start gap-2">
          <div
            className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            style={{ maxHeight: minimizedMaxHeight, overflow: "hidden" }}
          >
            {event.text || "Attachment"}
          </div>
        </div>
        {event.attachments && event.attachments.length > 0 && (
          <div className="mt-1 text-[11px] opacity-80">{event.attachments.length} attachment(s)</div>
        )}
      </div>
      <div
        className={cn(
          "pointer-events-none absolute left-0 right-0 top-full mt-2 hidden rounded-md border border-primary/35 bg-popover px-3 py-2 text-left text-sm leading-5 text-popover-foreground shadow-2xl ring-1 ring-black/10",
          "before:absolute before:right-6 before:top-[-6px] before:h-3 before:w-3 before:rotate-45 before:border-l before:border-t before:border-primary/35 before:bg-popover",
          "group-hover:block group-focus-within:block"
        )}
        role="tooltip"
      >
        <div className="mb-1 text-[11px] font-medium uppercase tracking-normal text-muted-foreground">Pinned message</div>
        <div className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{event.text || "Attachment"}</div>
      </div>
    </div>
  );
}

function QuestionCard({ event, agent, compact = false }: { event: QuestionsEvent; agent: RunningAgent; compact?: boolean }) {
  const initialSelections = useMemo(
    () =>
      event.questions.map((question, questionIndex) => {
        const answered = event.answers?.find((answer) => answer.questionIndex === questionIndex);
        if (answered) return answered.labels;
        const recommended = question.options.find((option) => /\brecommended\b/i.test(option.label));
        return recommended ? [recommended.label] : [];
      }),
    [event]
  );
  const initialOtherTexts = useMemo(
    () => event.questions.map((_, questionIndex) => event.answers?.find((answer) => answer.questionIndex === questionIndex)?.otherText || ""),
    [event]
  );
  const [selections, setSelections] = useState<string[][]>(initialSelections);
  const [otherSelected, setOtherSelected] = useState<boolean[]>(initialOtherTexts.map((text) => Boolean(text)));
  const [otherTexts, setOtherTexts] = useState<string[]>(initialOtherTexts);
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);

  useEffect(() => {
    setSelections(initialSelections);
    setOtherSelected(initialOtherTexts.map((text) => Boolean(text)));
    setOtherTexts(initialOtherTexts);
    setActiveQuestionIndex(0);
  }, [initialOtherTexts, initialSelections]);

  const activeQuestion = event.questions[activeQuestionIndex] || event.questions[0];
  const allAnswered = event.questions.every((question, index) =>
    question.multiSelect ? selections[index].length > 0 || Boolean(otherSelected[index] && otherTexts[index].trim()) : selections[index].length > 0 || Boolean(otherSelected[index] && otherTexts[index].trim())
  );

  function questionAnswered(questionIndex: number) {
    return selections[questionIndex].length > 0 || Boolean(otherSelected[questionIndex] && otherTexts[questionIndex].trim());
  }

  function goNext(questionIndex: number) {
    if (questionIndex < event.questions.length - 1) {
      setActiveQuestionIndex(questionIndex + 1);
    }
  }

  function toggle(questionIndex: number, label: string, multiSelect?: boolean) {
    if (event.answered) return;
    setSelections((current) =>
      current.map((labels, index) => {
        if (index !== questionIndex) return labels;
        if (!multiSelect) return [label];
        return labels.includes(label) ? labels.filter((item) => item !== label) : [...labels, label];
      })
    );
    if (!multiSelect) goNext(questionIndex);
  }

  function toggleOther(questionIndex: number, multiSelect?: boolean) {
    if (event.answered) return;
    setOtherSelected((current) => current.map((selected, index) => (index === questionIndex ? !selected : selected)));
    if (!multiSelect) {
      setSelections((current) => current.map((labels, index) => (index === questionIndex ? [] : labels)));
    }
  }

  function submit() {
    sendCommand({
      type: "answerQuestions",
      id: agent.id,
      eventId: event.id,
      answers: selections.map((labels, questionIndex) => ({
        questionIndex,
        labels,
        otherText: otherSelected[questionIndex] ? otherTexts[questionIndex].trim() : undefined
      }))
    });
  }

  return (
    <div
      className="rounded-md border border-cyan-500/40 bg-cyan-500/10 p-3 text-sm"
      data-copy-block="true"
      data-copy-event-id={event.id}
      style={{ borderLeftColor: agentAccentColor(agent.color), borderLeftWidth: 4 }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className={cn("font-semibold", compact ? "text-sm" : "text-base")}>Claude has questions</h3>
          <p className="text-xs text-muted-foreground">
            {event.answered ? "Answered" : `Question ${activeQuestionIndex + 1} of ${event.questions.length}`}
          </p>
        </div>
        {event.answered && <Badge>Answered</Badge>}
      </div>
      <div className="mb-3 flex gap-1 overflow-x-auto border-b border-cyan-400/25">
        {event.questions.map((question, questionIndex) => (
          <button
            key={`${event.id}:tab:${questionIndex}`}
            type="button"
            className={cn(
              "min-w-0 rounded-t-md border border-b-0 px-3 py-2 text-left text-xs",
              questionIndex === activeQuestionIndex
                ? "border-cyan-400/50 bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:bg-cyan-500/10 hover:text-foreground"
            )}
            onClick={() => setActiveQuestionIndex(questionIndex)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-cyan-400/40 text-[11px]">{questionIndex + 1}</span>
              <span className="truncate">{question.header || question.question}</span>
              {questionAnswered(questionIndex) && <Check className="h-3.5 w-3.5 shrink-0 text-cyan-300" />}
            </span>
          </button>
        ))}
      </div>
      {activeQuestion && (
        <section className="grid gap-2 rounded-md border border-cyan-400/25 bg-background/60 p-3">
          <div>
            {activeQuestion.header && <div className="text-xs font-medium uppercase text-cyan-300">{activeQuestion.header}</div>}
            <div className="font-medium">{activeQuestion.question}</div>
          </div>
          <div className="grid gap-2">
            {activeQuestion.options.map((option) => {
              const selected = selections[activeQuestionIndex]?.includes(option.label);
              return (
                <label
                  key={option.label}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2",
                    selected && "border-cyan-400/60 bg-cyan-500/10",
                    event.answered && "cursor-default opacity-80"
                  )}
                >
                  <input
                    className="mt-1"
                    type={activeQuestion.multiSelect ? "checkbox" : "radio"}
                    name={`${event.id}:${activeQuestionIndex}`}
                    checked={selected}
                    disabled={event.answered}
                    onChange={() => {
                      toggle(activeQuestionIndex, option.label, activeQuestion.multiSelect);
                      if (!activeQuestion.multiSelect) setOtherSelected((current) => current.map((selected, index) => (index === activeQuestionIndex ? false : selected)));
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{option.label}</span>
                    {option.description && <span className="mt-1 block text-xs leading-5 text-muted-foreground">{option.description}</span>}
                  </span>
                </label>
              );
            })}
            <label
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2",
                otherSelected[activeQuestionIndex] && "border-cyan-400/60 bg-cyan-500/10",
                event.answered && "cursor-default opacity-80"
              )}
            >
              <input
                className="mt-1"
                type={activeQuestion.multiSelect ? "checkbox" : "radio"}
                name={`${event.id}:${activeQuestionIndex}`}
                checked={Boolean(otherSelected[activeQuestionIndex])}
                disabled={event.answered}
                onChange={() => toggleOther(activeQuestionIndex, activeQuestion.multiSelect)}
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">Other</span>
                <Input
                  className="mt-2"
                  value={otherTexts[activeQuestionIndex] || ""}
                  disabled={event.answered || !otherSelected[activeQuestionIndex]}
                  placeholder="Type your answer"
                  onChange={(inputEvent) =>
                    setOtherTexts((current) => current.map((text, index) => (index === activeQuestionIndex ? inputEvent.target.value : text)))
                  }
                  onBlur={() => {
                    if (otherSelected[activeQuestionIndex] && otherTexts[activeQuestionIndex]?.trim()) goNext(activeQuestionIndex);
                  }}
                />
              </span>
            </label>
          </div>
        </section>
      )}
      {!event.answered && (
        <div className="mt-3 flex justify-between gap-2">
          <Button size="sm" variant="outline" disabled={activeQuestionIndex === 0} onClick={() => setActiveQuestionIndex((index) => Math.max(0, index - 1))}>
            Previous
          </Button>
          {activeQuestionIndex < event.questions.length - 1 ? (
            <Button size="sm" variant="outline" disabled={!questionAnswered(activeQuestionIndex)} onClick={() => goNext(activeQuestionIndex)}>
              Next
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={!allAnswered}>
              <Check className="h-4 w-4" />
              Send Answers
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function PlanNextSteps({ event, agent, steps }: { event: PlanEvent; agent: RunningAgent; steps: PlanNextStep[] }) {
  const agentsById = useAppStore((state) => state.agents);
  const settings = useAppStore((state) => state.settings);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const setFocusedAgent = useAppStore((state) => state.setFocusedAgent);
  const [state, setState] = usePlanNextStepState(event.id);
  if (state.dismissed || steps.length === 0) return null;

  function setCompleted(step: PlanNextStep, completed: boolean) {
    const completedSet = new Set(state.completed);
    if (completed) completedSet.add(step.id);
    else completedSet.delete(step.id);
    setState({ ...state, completed: [...completedSet] });
  }

  function sendToExisting(target: RunningAgent, step: PlanNextStep) {
    sendCommand({ type: "userMessage", id: target.id, text: planNextStepPrompt(event, step), attachments: [] });
    setSelectedAgent(target.id);
    setFocusedAgent(target.id);
  }

  function launchNew(step: PlanNextStep) {
    const provider = step.def.provider || "claude";
    sendCommand({
      type: "launch",
      request: {
        projectId: agent.projectId,
        defName: step.def.name,
        agentSource: step.source,
        displayName: "",
        provider,
        model: defaultModelForAgentDef(settings, step.def),
        initialPrompt: planNextStepPrompt(event, step),
        remoteControl: false,
        permissionMode: settings.defaultAgentMode,
        autoApprove: settings.autoApprove
      }
    });
  }

  return (
    <section className="mt-3 rounded-md border border-border bg-background/55 p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium">Next steps</h4>
          <p className="text-xs text-muted-foreground">Optional follow-ups based on your available agents.</p>
        </div>
        <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" title="Dismiss next steps" onClick={() => setState({ ...state, dismissed: true })}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid gap-2">
        {steps.map((step) => {
          const completed = state.completed.includes(step.id);
          const matchingAgents = Object.values(agentsById).filter(
            (candidate) => candidate.projectId === agent.projectId && candidate.defName.toLowerCase() === step.def.name.toLowerCase()
          );
          return (
            <div
              key={step.id}
              className={cn("grid gap-2 rounded-md border border-border bg-card/70 p-2 sm:grid-cols-[1fr_auto] sm:items-center", completed && "opacity-60")}
            >
              <label className="flex min-w-0 items-start gap-2">
                <input className="mt-1" type="checkbox" checked={completed} onChange={(inputEvent) => setCompleted(step, inputEvent.target.checked)} />
                <span className="min-w-0">
                  <span className={cn("block text-sm font-medium", completed && "line-through")}>{step.title}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{step.description}</span>
                </span>
              </label>
              {matchingAgents.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="sm">
                      <Bot className="h-4 w-4" />
                      Launch
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-56">
                    {matchingAgents.map((target) => (
                      <DropdownMenuItem key={target.id} onClick={() => sendToExisting(target, step)}>
                        Use {target.displayName}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem onClick={() => launchNew(step)}>Launch new {step.def.name}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => launchNew(step)}>
                  <Bot className="h-4 w-4" />
                  Launch
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PlanCard({ event, agent, compact = false }: { event: PlanEvent; agent: RunningAgent; compact?: boolean }) {
  const projects = useAppStore((state) => state.projects);
  const settings = useAppStore((state) => state.settings);
  const addError = useAppStore((state) => state.addError);
  const [otherText, setOtherText] = useState(event.response || "");
  const [activeDecision, setActiveDecision] = useState<PlanEvent["decision"] | "">("");
  const [showOther, setShowOther] = useState(event.decision === "other");
  const project = projects.find((candidate) => candidate.id === agent.projectId);
  const agentOptionGroups = useMemo(() => groupedAgentDefsWithBuiltIns(project), [project]);
  const launchAgentOptions = useMemo(
    () => [
      ...agentOptionGroups.projectAgents.map((def) => ({ source: "project" as const, def })),
      ...agentOptionGroups.builtInAgents.map((def) => ({ source: "builtIn" as const, def }))
    ],
    [agentOptionGroups.builtInAgents, agentOptionGroups.projectAgents]
  );
  const nextSteps = useMemo(() => buildPlanNextSteps(agentOptionGroups, agent), [agent, agentOptionGroups]);

  useEffect(() => {
    setOtherText(event.response || "");
    setActiveDecision(event.decision || "");
    setShowOther(event.decision === "other");
  }, [event]);

  function answer(decision: NonNullable<PlanEvent["decision"]>) {
    setActiveDecision(decision);
    sendCommand({
      type: "answerPlan",
      id: agent.id,
      eventId: event.id,
      decision,
      response: decision === "approve" ? undefined : otherText.trim() || undefined
    });
  }

  function launchApprovedPlan(target: { source: AgentDefSource; def: AgentDef }) {
    if (!project) {
      addError("Project not found for this plan.");
      return;
    }
    const provider = target.def.provider || "claude";
    const prompt = [
      "This plan was approved. Please implement it.",
      "",
      "Plan:",
      "",
      event.plan
    ].join("\n");
    setActiveDecision("other");
    sendCommand({
      type: "launch",
      request: {
        projectId: project.id,
        defName: target.def.name,
        agentSource: target.source,
        displayName: "",
        provider,
        model: defaultModelForAgentDef(settings, target.def),
        initialPrompt: prompt,
        remoteControl: false,
        permissionMode: settings.defaultAgentMode,
        autoApprove: settings.autoApprove
      }
    });
    sendCommand({
      type: "answerPlan",
      id: agent.id,
      eventId: event.id,
      decision: "other",
      response: `Approved. Implementation has been handed off to a new ${target.def.name} agent; do not build it in this chat.`
    });
  }

  const options: Array<{
    decision: NonNullable<PlanEvent["decision"]>;
    label: string;
    description: string;
    icon: ComponentType<{ className?: string }>;
  }> = [
    {
      decision: "approve",
      label: "Approve and build here",
      description: "Let this Claude chat implement the plan.",
      icon: Check
    },
    {
      decision: "deny",
      label: "Deny",
      description: "Reject the plan and stop this planning request.",
      icon: X
    },
    {
      decision: "keepPlanning",
      label: "Keep planning",
      description: "Ask Claude to revise the plan before implementing.",
      icon: Pencil
    },
    {
      decision: "other",
      label: "Other",
      description: "Send your own response.",
      icon: MessageSquare
    }
  ];

  return (
    <div
      className="relative rounded-md border border-border bg-card p-3 pr-11 text-sm"
      data-copy-block="true"
      data-copy-event-id={event.id}
      style={{ borderLeftColor: agentAccentColor(agent.color), borderLeftWidth: 4 }}
    >
      <ChatBlockPopoutButton source={agent} text={event.plan} compact={compact} />
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className={cn("font-semibold", compact ? "text-sm" : "text-base")}>Plan</h3>
          <p className="text-xs text-muted-foreground">{event.answered ? "Plan response sent." : "Choose how Claude should continue."}</p>
        </div>
        {event.answered && <Badge>Answered</Badge>}
      </div>
      <div className="max-w-none rounded-md border border-border bg-background/70 p-3 text-sm leading-6">
        <ChatMarkdown text={event.plan} query="" />
      </div>
      {event.response && (
        <div className="mt-3 rounded-md border border-border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
          Response: {event.response}
        </div>
      )}
      {!event.answered && (
        <div className="mt-3 grid gap-2">
          <div className="grid gap-2">
            {options.map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.decision}
                  type="button"
                  className="flex min-w-0 items-start gap-3 rounded-md border border-border bg-background/55 px-3 py-2 text-left hover:border-primary/60 hover:bg-primary/10"
                  onClick={() => {
                    if (option.decision === "other") {
                      setShowOther(true);
                      setActiveDecision("other");
                      return;
                    }
                    answer(option.decision);
                  }}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.description}</span>
                  </span>
                </button>
              );
            })}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex min-w-0 items-start gap-3 rounded-md border border-border bg-background/55 px-3 py-2 text-left hover:border-primary/60 hover:bg-primary/10"
                  disabled={launchAgentOptions.length === 0}
                >
                  <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">Approve and launch agent</span>
                    <span className="block text-xs text-muted-foreground">Start another agent with this plan.</span>
                  </span>
                  <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 min-w-56 overflow-y-auto">
                {launchAgentOptions.map((option) => (
                  <DropdownMenuItem
                    key={`${option.source}:${option.def.name}`}
                    onClick={() => launchApprovedPlan(option)}
                  >
                    <AgentDot color={option.def.color} />
                    <span className="ml-2">{option.def.name}</span>
                    <Badge className="ml-2 text-[10px]">{option.source === "builtIn" ? "Built-in" : "Project"}</Badge>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {showOther && (
            <div className="grid gap-2 rounded-md border border-border bg-background/50 p-2">
              <Textarea
                value={otherText}
                onChange={(inputEvent) => setOtherText(inputEvent.target.value)}
                placeholder="Type your response to Claude"
                className="min-h-20 text-sm"
              />
              <Button size="sm" className="justify-self-end" onClick={() => answer("other")} disabled={!otherText.trim()}>
                Send Other
              </Button>
            </div>
          )}
        </div>
      )}
      {activeDecision && event.answered && <div className="mt-2 text-xs text-muted-foreground">Decision: {activeDecision}</div>}
      {planWasApproved(event) && <PlanNextSteps event={event} agent={agent} steps={nextSteps} />}
    </div>
  );
}

function RawStreamView({ agent, transcript, compact = false }: { agent: RunningAgent; transcript: TranscriptEvent[]; compact?: boolean }) {
  const addError = useAppStore((state) => state.addError);
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.rawAgentStream(agent.id)
      .then((text) => {
        if (!cancelled) setRaw(text);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRaw("");
          addError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [addError, agent.id, transcript.length]);

  const fallback = transcript.map((event) => JSON.stringify(event)).join("\n");
  const text = raw.trim() ? raw : fallback;

  return (
    <div className="min-w-0 rounded-md border border-border bg-background/70" data-copy-block="true">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <span className={cn("font-medium", compact ? "text-xs" : "text-sm")}>Raw stream</span>
        {loading && <span className="text-xs text-muted-foreground">Loading...</span>}
      </div>
      <pre className={cn("max-h-[60vh] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-muted-foreground [overflow-wrap:anywhere]", compact ? "text-[11px]" : "text-xs")}>
        {text || "No raw stream yet."}
      </pre>
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
      <AgentPanelHeader agent={agent} viewMode="chat" onToggleViewMode={() => undefined} />
      <div className="grid flex-1 place-items-center p-6">
        <div className="grid max-w-xl gap-4 text-center">
          <div className="mx-auto flex items-center gap-2 text-lg font-semibold">
            <ActiveAgentDot agent={agent} />
            {agent.displayName} <Badge>RC</Badge> <span className="text-muted-foreground">({agent.currentModel})</span>
          </div>
          <p className="text-muted-foreground">
            This agent runs in Remote Control mode. Live transcript and interaction happen in claude.ai/code or the Claude
            mobile app.
          </p>
          <p className="text-sm text-muted-foreground">
            AgentControl can show connection state, URL/QR, PID, and Claude CLI diagnostics. Claude does not expose the live
            remote conversation back through this local process.
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

function AgentPanelHeader({
  agent,
  viewMode,
  onToggleViewMode
}: {
  agent: RunningAgent;
  viewMode: TranscriptViewMode;
  onToggleViewMode: () => void;
}) {
  const transcripts = useAppStore((state) => state.transcripts[agent.id] || EMPTY_TRANSCRIPT);
  const done = useAppStore((state) => Boolean(state.doneAgentIds[agent.id]));
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
      <ActiveAgentDot agent={agent} />
      <ProviderIcon provider={agent.provider} className="h-5 w-5 border-0 bg-transparent" iconClassName="h-4 w-4" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{agent.displayName}</span>
          {agent.remoteControl && <Badge>RC</Badge>}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <ModelMenu agent={agent} showProviderIcon={false} />
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        <LastActivityText agent={agent} compact timeOnly />
        <StatusPill
          status={agent.status}
          done={done}
          onResume={() => sendCommand({ type: "resume", id: agent.id })}
          onRestart={() => sendCommand({ type: "restart", id: agent.id })}
        />
      </span>
      <AgentActionsMenu agent={agent} transcripts={transcripts} viewMode={viewMode} onToggleViewMode={onToggleViewMode} />
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
  const addError = useAppStore((state) => state.addError);
  const settings = useAppStore((state) => state.settings);
  const scrollTop = useAppStore((state) => state.scrollPositions[agent.id] || 0);
  const setScrollPosition = useAppStore((state) => state.setScrollPosition);
  const setChatFocusedAgent = useAppStore((state) => state.setChatFocusedAgent);
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
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const [transcriptViewMode, setTranscriptViewMode] = useState<TranscriptViewMode>("chat");
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashMenuSuppressed, setSlashMenuSuppressed] = useState(false);
  const composerDragDepthRef = useRef(0);
  const isBusy = isAgentBusy(agent);
  const canType = agentHasProcess(agent);
  const canAttach = !agent.remoteControl;
  const showActivityIndicator = isBusy && !hasStreamingAssistantText(transcript);
  const phaseLabel = isBusy ? executingPlanPhase(transcript) : undefined;
  const pinnedMessage = latestUserMessage(transcript);
  const pinLastSentMessage = settings.pinLastSentMessage;
  const rawSlashSuggestions = useMemo(
    () => slashCommandSuggestions(draft, modelIdsForProvider(settings, agent.provider || "claude"), agent.slashCommands, agent.provider || "claude"),
    [agent.provider, agent.slashCommands, draft, settings]
  );
  const pickerSlashSuggestions = useMemo(
    () => slashCommandSuggestions("", modelIdsForProvider(settings, agent.provider || "claude"), agent.slashCommands, agent.provider || "claude", true),
    [agent.provider, agent.slashCommands, settings]
  );
  const slashSuggestions = slashMenuOpen ? pickerSlashSuggestions : slashMenuSuppressed ? [] : rawSlashSuggestions;
  const selectedLines = selectedLineCount(selection.selectedText);
  const draftLines = draftLineCount(draft);
  const [composerWrapped, setComposerWrapped] = useState(false);
  const hasMultilineDraft = draftLines > 1 || composerWrapped;
  const composerExpanded = hasMultilineDraft && !composerCollapsed;
  useQueuedMessageSender(agent, queue, canType);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.scrollTop = scrollTop;
    setShowPinnedMessage(shouldShowPinnedUserMessage(root, pinnedMessage?.id));
    setShowJumpToBottom(!isNearScrollBottom(root));
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
    setShowJumpToBottom(!isNearScrollBottom(root));
  }, [transcript, agent.id, isBusy, pinnedMessage?.id, setScrollPosition]);

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashSuggestions.length, draft]);

  useEffect(() => {
    if (!hasMultilineDraft && composerCollapsed) setComposerCollapsed(false);
  }, [composerCollapsed, hasMultilineDraft]);

  useEffect(() => {
    const measure = () => setComposerWrapped(composerNeedsExpansion(inputRef.current, 76));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [draft]);

  function send() {
    if (!draft.trim() && attachments.length === 0) return;
    if (agent.remoteControl && attachments.length > 0) {
      addError("Remote Control stdin bridge does not support attachments yet.");
      return;
    }
    const injectedText = injectedMessageText(agent, draft);
    if (injectedText) {
      if (isBusy) sendCommand({ type: "injectMessage", id: agent.id, text: injectedText, attachments });
      else sendCommand({ type: "userMessage", id: agent.id, text: injectedText, attachments });
      setDraft(agent.id, "");
      setComposerCollapsed(false);
      setAttachments([]);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (handleNativeSlashCommand(agent, draft)) {
      setDraft(agent.id, "");
      return;
    }
    if (isBusy) {
      enqueueMessage(agent.id, { text: draft, attachments });
      setDraft(agent.id, "");
      setComposerCollapsed(false);
      setAttachments([]);
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    sendCommand({ type: "userMessage", id: agent.id, text: draft, attachments });
    setDraft(agent.id, "");
    setComposerCollapsed(false);
    setAttachments([]);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function stopCurrentResponse() {
    sendCommand({ type: "interrupt", id: agent.id });
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function selectTypedSlashCommand(value: string) {
    setDraft(agent.id, value);
    setSlashMenuOpen(false);
    setSlashMenuSuppressed(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function runSlashCommand(value: string) {
    const commandText = value.trim();
    setSlashMenuOpen(false);
    setSlashMenuSuppressed(false);
    setActiveSlashIndex(0);
    if (!commandText) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (handleNativeSlashCommand(agent, commandText)) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (!canType) {
      window.requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const injectedText = injectedMessageText(agent, commandText);
    if (injectedText) {
      if (isBusy) sendCommand({ type: "injectMessage", id: agent.id, text: injectedText });
      else sendCommand({ type: "userMessage", id: agent.id, text: injectedText, attachments: [] });
    } else if (isBusy) {
      enqueueMessage(agent.id, { text: commandText, attachments: [] });
    } else {
      sendCommand({ type: "userMessage", id: agent.id, text: commandText, attachments: [] });
    }
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function toggleSlashMenu() {
    setSlashMenuOpen((open) => !open);
    setSlashMenuSuppressed(false);
    setActiveSlashIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      sendNextComposerMode(agent, settings);
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
        if (selected) {
          if (slashMenuOpen) runSlashCommand(selected.value);
          else selectTypedSlashCommand(selected.value);
        }
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        const selected = enabledSlashSuggestion(slashSuggestions[activeSlashIndex]);
        if (selected && slashMenuOpen) {
          event.preventDefault();
          runSlashCommand(selected.value);
          return;
        }
        if (selected && draft.trim() !== selected.value.trim()) {
          event.preventDefault();
          selectTypedSlashCommand(selected.value);
          return;
        }
        if (slashSuggestions[activeSlashIndex]?.disabled) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenuOpen(false);
        setSlashMenuSuppressed(true);
        return;
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
    setShowJumpToBottom(!isNearScrollBottom(event.currentTarget));
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
    const pastedText = event.clipboardData.getData("text/plain");
    const pastedMultilineText = /\r|\n/.test(pastedText);
    if (files.length === 0 && !pastedMultilineText) return;
    event.preventDefault();
    if (pastedMultilineText) setComposerCollapsed(false);
    if (pastedText) {
      const selectionStart = event.currentTarget.selectionStart ?? draft.length;
      const nextDraft = insertPastedText(event.currentTarget, draft, pastedText);
      const nextCursor = selectionStart + pastedText.length;
      setDraft(agent.id, nextDraft);
      window.requestAnimationFrame(() => inputRef.current?.setSelectionRange(nextCursor, nextCursor));
    }
    if (files.length === 0) return;
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
    if (!canType || !canAttach || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    try {
      const dropped = await attachmentsFromDrop(agent, event.dataTransfer);
      if (dropped.length > 0) setAttachments((current) => [...current, ...dropped]);
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleComposerDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || !canAttach || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current += 1;
    setComposerDropActive(true);
  }

  function handleComposerDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || !canAttach || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setComposerDropActive(true);
  }

  function handleComposerDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!canType || !canAttach || isAgentReorderDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    composerDragDepthRef.current = Math.max(0, composerDragDepthRef.current - 1);
    if (composerDragDepthRef.current === 0) setComposerDropActive(false);
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <AgentPanelHeader
        agent={agent}
        viewMode={transcriptViewMode}
        onToggleViewMode={() => setTranscriptViewMode((mode) => (mode === "chat" ? "raw" : "chat"))}
      />
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
              {transcriptViewMode === "chat" && pinLastSentMessage && pinnedMessage && showPinnedMessage && (
                <PinnedUserMessage event={pinnedMessage} onJump={() => scrollToLatestUserMessage(rootRef.current)} />
              )}
              {transcriptViewMode === "raw" ? (
                <RawStreamView agent={agent} transcript={transcript} />
              ) : transcript.length === 0 ? (
                showActivityIndicator ? (
                  <AgentActivityIndicator agent={agent} phaseLabel={phaseLabel} />
                ) : (
                  <p className="rounded-md border border-dashed border-border px-3 py-12 text-center text-sm text-muted-foreground">
                    No transcript yet.
                  </p>
                )
              ) : (
                <>
                  {transcriptItems.map((item, index) => (
                    <TranscriptItem
                      key={item.kind === "tool_pair" ? item.event.id : item.event.id}
                      item={item}
                      agent={agent}
                      phaseLabel={phaseLabel}
                      query={searchQuery}
                      latestUserMessageId={pinnedMessage?.id}
                      defaultExpanded={shouldExpandTranscriptItemByDefault(item, index, transcriptItems)}
                    />
                  ))}
                  {showActivityIndicator && <AgentActivityIndicator agent={agent} phaseLabel={phaseLabel} />}
                </>
              )}
            </div>
            {transcriptViewMode === "chat" && showJumpToBottom && (
              <div className="pointer-events-none sticky bottom-3 z-30 mx-auto flex w-full max-w-4xl justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="pointer-events-auto h-9 w-9 rounded-full border border-border shadow-md"
                  title="Jump to bottom"
                  aria-label="Jump to bottom"
                  onClick={() => scrollTranscriptToBottom(rootRef.current)}
                >
                  <CircleArrowDown className="h-5 w-5" />
                </Button>
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
          <div className="absolute bottom-full left-0 right-0 z-[220] mb-2 px-2">
            <SlashCommandAutocomplete
              suggestions={slashSuggestions}
              activeIndex={activeSlashIndex}
              onSelect={slashMenuOpen ? runSlashCommand : selectTypedSlashCommand}
              onActiveIndexChange={setActiveSlashIndex}
            />
          </div>
          <div className="grid gap-2 px-2 pt-2">
            <AttachmentChips
              attachments={attachments}
              onRemove={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
            />
          </div>
          <div className="relative">
            <Textarea
              ref={inputRef}
              className={cn(
                "min-h-[76px] resize-none border-0 bg-transparent py-2 leading-5 focus-visible:ring-0",
                composerExpanded && "pr-10",
                hasMultilineDraft && "pr-16",
                composerExpanded ? "h-28 max-h-48 overflow-y-auto" : "h-[76px] overflow-hidden"
              )}
              rows={3}
              value={draft}
              disabled={!canType}
              onFocus={() => setChatFocusedAgent(agent.id)}
              onBlur={() => setChatFocusedAgent(undefined)}
              onChange={(event) => {
                setSlashMenuOpen(false);
                setSlashMenuSuppressed(false);
                setDraft(agent.id, event.target.value);
                setComposerWrapped(composerNeedsExpansion(event.currentTarget, 76));
              }}
              onPaste={handlePaste}
              placeholder={isBusy ? "Queue a message..." : `chat with ${providerLabel(agent.provider)}`}
              onKeyDown={handleComposerKeyDown}
            />
            {hasMultilineDraft && (
              <button
                type="button"
                className="absolute right-6 top-2 grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                title={composerExpanded ? "Collapse message" : `Expand ${draftLines}-line message`}
                onClick={() => {
                  setComposerCollapsed(!composerCollapsed);
                  window.requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                {composerExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </button>
            )}
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
              <ComposerAddMenu disabled={!canType || !canAttach} onUpload={() => fileInputRef.current?.click()} onAddContext={() => setContextOpen(true)} />
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
                {isBusy ? <Square className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
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
          <Forward className="mr-2 h-4 w-4" />
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
  phaseLabel,
  query,
  latestUserMessageId,
  defaultExpanded = false
}: {
  item: ToolTranscriptItem;
  agent: RunningAgent;
  phaseLabel?: string;
  query: string;
  latestUserMessageId?: string;
  defaultExpanded?: boolean;
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
  if (event.kind === "questions") {
    return <QuestionCard event={event} agent={agent} />;
  }
  if (event.kind === "plan") {
    return <PlanCard event={event} agent={agent} />;
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
          showPopout && "pr-16"
        )}
        data-copy-block="true"
        data-copy-event-id={event.id}
        style={!isUser ? { borderLeftColor: agentAccentColor(agent.color), borderLeftWidth: 4 } : undefined}
      >
        {showPopout && <ChatBlockPopoutButton source={agent} text={event.text} />}
        {event.sourceAgent && (
          <Badge className="mb-2" style={{ borderColor: event.sourceAgent.color, color: event.sourceAgent.color }}>
            from {event.sourceAgent.displayName}
          </Badge>
        )}
        <CollapsibleText text={event.text} query={query} inlineToggle={showPopout} defaultExpanded={defaultExpanded} />
        {event.kind === "assistant_text" && event.streaming && (
          <span className="mt-2 grid gap-1">
            {phaseLabel && <span className="text-[11px] font-medium uppercase tracking-normal text-muted-foreground">{phaseLabel}</span>}
            <ThinkingText agent={agent} prefix="Streaming" startedAt={agent.turnStartedAt} usage={agent.lastTokenUsage} />
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

function CollapsibleText({
  text,
  query = "",
  compact = false,
  inlineToggle = false,
  defaultExpanded = false
}: {
  text: string;
  query?: string;
  compact?: boolean;
  inlineToggle?: boolean;
  defaultExpanded?: boolean;
}) {
  const shouldCollapse = isLongTextBlock(text, compact);
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    if (query.trim()) setExpanded(true);
  }, [query]);

  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);

  if (!shouldCollapse) return <ChatMarkdown text={text} query={query} />;

  function toggleExpanded() {
    setExpanded((value) => !value);
  }

  function toggleFromText() {
    if (window.getSelection()?.toString()) return;
    toggleExpanded();
  }

  return (
    <div className="relative grid gap-2">
      {inlineToggle && (
        <button
          type="button"
          className={cn(
            "absolute top-0 z-10 grid place-items-center rounded-md text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground hover:opacity-100",
            compact ? "-right-8 h-6 w-6" : "-right-9 h-7 w-7"
          )}
          title={expanded ? "Collapse response" : "Expand response"}
          onClick={toggleExpanded}
        >
          <ChevronDown className={cn(compact ? "h-3.5 w-3.5" : "h-4 w-4", "transition-transform", expanded && "rotate-180")} />
        </button>
      )}
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "min-w-0 cursor-pointer rounded-sm break-words outline-none [overflow-wrap:anywhere] hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
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
        <ChatMarkdown text={text} query={query} />
      </div>
      {!inlineToggle && (
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
      )}
    </div>
  );
}

function isLongTextBlock(text: string, compact = false) {
  return text.length > (compact ? 420 : 900) || text.split(/\r?\n/).length > (compact ? 8 : 14);
}

function ChatMarkdown({ text, query }: { text: string; query: string }) {
  if (query.trim()) {
    return (
      <span className="whitespace-pre-wrap">
        <HighlightedText text={text} query={query} />
      </span>
    );
  }

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          code: ({ className, children, ...props }) => {
            const multiline = String(children).includes("\n");
            return multiline ? (
              <code className={className} {...props}>
                {children}
              </code>
            ) : (
              <code className={cn("markdown-inline-code", className)} {...props}>
                {children}
              </code>
            );
          }
        }}
      >
        {text}
      </ReactMarkdown>
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
  const [rawView, setRawView] = useState(false);
  const selectionRootId = useRef(`text-block-popout-${Math.random().toString(36).slice(2)}`).current;
  const {
    selectedText: popoutSelectedText,
    captureSelection: capturePopoutSelection,
    clearSelection: clearPopoutSelection,
    getCachedSelection: getCachedPopoutSelection
  } = useTextSelection(`#${selectionRootId}`);
  const project = projects.find((candidate) => candidate.id === source.projectId);
  const newAgentDefs = useMemo(() => agentDefsWithBuiltIns(project), [project]);
  const targetAgents = useMemo(
    () => Object.values(agentsById).filter((agent) => agent.projectId === source.projectId && agent.id !== source.id),
    [agentsById, source.id, source.projectId]
  );
  const selectedText = popoutSelectedText.trim();
  const actionScope = selectedText ? "selection" : "block";
  const contextLabel = selectedText ? "selected text" : "text block";

  useEffect(() => {
    if (!open) clearPopoutSelection();
  }, [clearPopoutSelection, open]);

  function actionText() {
    return capturePopoutSelection().trim() || getCachedPopoutSelection().trim() || text;
  }

  function preparePopoutContextMenu() {
    if (getSelectionInRoot(`#${selectionRootId}`)) {
      capturePopoutSelection();
      return;
    }
    clearPopoutSelection();
  }

  function copyText() {
    void navigator.clipboard.writeText(actionText()).catch((error: unknown) => {
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
          <DialogTitle className="sr-only">Text block</DialogTitle>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={rawView ? "default" : "outline"}
              size="sm"
              onClick={() => setRawView((value) => !value)}
              title={rawView ? "Show rendered markdown" : "Show raw text"}
            >
              <CodeXml className="h-4 w-4" />
              {rawView ? "Raw" : "Markdown"}
            </Button>
            <Button variant="outline" size="sm" onClick={copyText}>
              <Clipboard className="h-4 w-4" />
              Copy {actionScope}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={!text.trim()}>
                  <Forward className="h-4 w-4" />
                  Send {actionScope} to new agent
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
                        initialPrompt: wrapForwardedText(source, actionText())
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
                  <Forward className="h-4 w-4" />
                  Send {actionScope} to existing agent
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
                        selectedText: actionText(),
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
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                id={selectionRootId}
                tabIndex={0}
                className="max-h-[65vh] overflow-auto rounded-md border border-border bg-background/70 p-3 text-sm leading-6 outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring"
                onPointerDown={(event) => {
                  if (event.button === 0) clearPopoutSelection();
                }}
                onMouseUp={() => capturePopoutSelection()}
                onKeyUp={() => capturePopoutSelection()}
                onContextMenuCapture={preparePopoutContextMenu}
              >
                {rawView ? <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5">{text}</pre> : <ChatMarkdown text={text} query="" />}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={!text.trim()}
                onClick={() => {
                  void navigator.clipboard.writeText(actionText()).catch((error: unknown) => {
                    addError(error instanceof Error ? error.message : String(error));
                  });
                }}
              >
                <Clipboard className="mr-2 h-4 w-4" />
                Copy {contextLabel}
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger
                  className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[disabled]:opacity-45"
                  disabled={!text.trim()}
                >
                  <Forward className="mr-2 h-4 w-4" />
                  <span className="flex-1">Send {contextLabel} to</span>
                  <ChevronRight className="ml-4 h-4 w-4 text-muted-foreground" />
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger className="flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent">
                      New agent
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      {newAgentDefs.map((def) => (
                        <ContextMenuItem
                          key={`${def.provider || "claude"}:${def.name}`}
                          onClick={() => {
                            openLaunchModal({
                              projectId: source.projectId,
                              defName: def.name,
                              initialPrompt: wrapForwardedText(source, actionText())
                            });
                            setOpen(false);
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
                            openSendDialog({
                              sourceAgentId: source.id,
                              targetAgentId: agent.id,
                              selectedText: actionText(),
                              framing: ""
                            });
                            setOpen(false);
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
          </ContextMenu>
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
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const isUse = event.kind === "tool_use";
  const [open, setOpen] = useState(isUse && event.awaitingPermission);
  const detail = result ? toolPairDetail(event, result) : toolDetail(event);
  const pathText = isUse ? toolPath(event.input) : "";
  const commandText = isUse ? fieldText(event.input, ["command"]) : "";
  const awaitingPermission = isUse && event.awaitingPermission;
  const resultIsError = Boolean(result?.isError || (!isUse && event.isError));
  const activity = isUse ? toolActivityText(event, result) : toolSummary(event) || "Tool finished";
  const statusText = awaitingPermission ? "permission required" : resultIsError ? "error" : "";
  const hasDetail = Boolean(detail.trim());
  const permissionRule =
    isUse && event.name ? createPermissionAllowRule(agent, event.name, event.input) : undefined;
  const permissionRuleExists = Boolean(
    permissionRule && (settings.permissionAllowRules || []).some((rule) => permissionAllowRuleKey(rule) === permissionAllowRuleKey(permissionRule))
  );
  const permissionRuleLabel = permissionRule?.command || (isUse ? event.name : "tool");

  useEffect(() => {
    if (awaitingPermission) setOpen(true);
  }, [awaitingPermission]);

  function copyText(text: string) {
    if (!text) return;
    void navigator.clipboard.writeText(text).catch((error: unknown) => {
      addError(error instanceof Error ? error.message : String(error));
    });
  }

  async function alwaysAllowAndApprove() {
    if (!permissionRule) return;
    try {
      const currentRules = settings.permissionAllowRules || [];
      const nextRules = permissionRuleExists ? currentRules : [...currentRules, permissionRule];
      const next = await api.saveSettings({ ...settings, permissionAllowRules: nextRules });
      setSettings(next);
      sendCommand({ type: "permission", id: agent.id, toolUseId: event.toolUseId, decision: "approve" });
    } catch (error) {
      addError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div
      className={cn(
        "min-w-0 w-full max-w-full overflow-hidden rounded-md border bg-card",
        awaitingPermission ? "border-amber-300/70 bg-amber-500/10 shadow-[0_0_0_1px_rgba(251,191,36,0.18)]" : resultIsError ? "border-red-400/50" : "border-border",
        compact ? "text-xs" : "text-sm"
      )}
      data-copy-block="true"
      data-copy-event-id={event.id}
    >
      <button
        className={cn("flex w-full min-w-0 max-w-full items-center justify-between gap-2 overflow-hidden text-left", compact ? "px-2 py-2" : "px-3 py-2")}
        onClick={() => {
          if (hasDetail) setOpen((value) => !value);
        }}
        title={hasDetail ? (open ? "Collapse details" : "Expand details") : undefined}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{activity}</span>
          {statusText && (
            <Badge
              className={cn(
                "shrink-0",
                awaitingPermission && "border-amber-300/60 bg-amber-500/15 text-amber-100",
                resultIsError && "border-red-400/40 text-red-200"
              )}
            >
              {statusText}
            </Badge>
          )}
        </span>
        {hasDetail && (
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
          </span>
        )}
      </button>
      {awaitingPermission && (
        <div className="grid gap-3 border-t border-amber-300/30 bg-amber-500/10 px-3 py-3">
          <div className="grid gap-1">
            <p className="font-medium text-amber-50">Permission required</p>
            <p className="break-words text-xs text-amber-100 [overflow-wrap:anywhere]">
              Claude wants to run {event.name}
            {commandText ? `: ${commandText}` : pathText ? ` on ${pathText}` : ""}.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!agentHasProcess(agent)} onClick={() => sendCommand({ type: "permission", id: agent.id, toolUseId: event.toolUseId, decision: "approve" })}>
              Approve
            </Button>
            {permissionRule && (
              <Button size="sm" variant="outline" disabled={!agentHasProcess(agent)} onClick={() => void alwaysAllowAndApprove()}>
                {permissionRuleExists ? "Approve with saved rule" : `Always allow ${permissionRuleLabel}`}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={!agentHasProcess(agent)} onClick={() => sendCommand({ type: "permission", id: agent.id, toolUseId: event.toolUseId, decision: "deny" })}>
              Deny
            </Button>
          </div>
        </div>
      )}
      {open && (
        <div className="border-t border-border">
          <div className="flex flex-wrap gap-2 px-3 py-2">
            <Button size="sm" variant="outline" onClick={() => copyText(detail)}>
              <Clipboard className="h-3.5 w-3.5" />
              Copy details
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
        const rect = host.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 20) return;
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
    const copySelection = () => {
      const text = terminal.getSelection();
      if (!text) return;
      void navigator.clipboard?.writeText(text).catch((error: unknown) => {
        console.warn("Failed to copy terminal selection", error);
      });
    };
    const pasteClipboard = () => {
      void navigator.clipboard?.readText().then((text) => {
        if (text) sendCommand({ type: "terminalInput", id: session.id, input: text });
      }).catch((error: unknown) => {
        console.warn("Failed to paste into terminal", error);
      });
    };
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "c" && terminal.hasSelection()) {
        event.preventDefault();
        copySelection();
        return false;
      }
      if ((event.ctrlKey || event.metaKey) && key === "v") {
        event.preventDefault();
        pasteClipboard();
        return false;
      }
      return true;
    });
    const handleMouseUp = () => copySelection();
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (terminal.hasSelection()) return;
      pasteClipboard();
    };
    host.addEventListener("mouseup", handleMouseUp);
    host.addEventListener("contextmenu", handleContextMenu);
    const frame = window.requestAnimationFrame(() => {
      resize();
      window.requestAnimationFrame(resize);
      terminal.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      dataDisposable.dispose();
      host.removeEventListener("mouseup", handleMouseUp);
      host.removeEventListener("contextmenu", handleContextMenu);
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
      className={cn("relative min-h-0 min-w-0 overflow-hidden border border-border bg-zinc-950 p-2", active && "ring-1 ring-primary")}
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
      <div ref={hostRef} className="terminal-host h-full min-w-0 max-w-full overflow-hidden" />
    </div>
  );
}

function TerminalPanel({
  popout = false,
  popoutTerminalId,
  poppedOutTerminalIds = new Set<string>(),
  embedded = false
}: {
  popout?: boolean;
  popoutTerminalId?: string;
  poppedOutTerminalIds?: Set<string>;
  embedded?: boolean;
} = {}) {
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const sessionsById = useAppStore((state) => state.terminalSessions);
  const outputById = useAppStore((state) => state.terminalOutput);
  const activeTerminalId = useAppStore((state) => state.activeTerminalId);
  const setActiveTerminal = useAppStore((state) => state.setActiveTerminal);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const setTerminalInFileExplorer = useAppStore((state) => state.setTerminalInFileExplorer);
  const settings = useAppStore((state) => state.settings);
  const setSettings = useAppStore((state) => state.setSettings);
  const addError = useAppStore((state) => state.addError);
  const terminalDock = settings.terminalDock;
  const showMenuText = settings.menuDisplay === "iconText";
  const [height, setHeight] = useState(320);
  const [width, setWidth] = useState(420);
  const [detachedBounds, setDetachedBounds] = useState({ left: 96, top: 72, width: 960, height: 520 });
  const [visiblePaneIds, setVisiblePaneIds] = useState<string[]>([]);
  const pendingSplitRef = useRef(false);
  const floating = !popout && !embedded && terminalDock === "float";
  const sideDock = !popout && !embedded && (terminalDock === "left" || terminalDock === "right");
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
    const terminalId = popoutTerminalId || session?.id;
    if (terminalDock === "float") {
      void api
        .saveSettings({ ...settings, terminalDock: "bottom" })
        .then((next) => {
          setSettings(next);
          notifyTerminalDock(terminalId, true, true, "bottom");
          window.close();
        })
        .catch((error: unknown) => addError(error instanceof Error ? error.message : String(error)));
      return;
    }
    notifyTerminalDock(terminalId, true, true);
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

  function hideTerminalPanel() {
    if (popout) {
      const terminalId = popoutTerminalId || session?.id;
      window.sessionStorage.setItem(TERMINAL_POPOUT_EXPLICIT_HIDE_STORAGE_KEY, "true");
      notifyTerminalDock(terminalId, true, false, undefined, true);
      window.close();
      return;
    }
    if (embedded) setTerminalInFileExplorer(false);
    setTerminalOpen(false);
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
  const PopoutDockIcon = terminalDock === "float" ? PanelBottom : CurrentDockIcon;
  const panelStyle: CSSProperties | undefined = embedded
    ? { height: 260, minHeight: 220, flex: "0 0 260px" }
    : popout
    ? undefined
    : floating
      ? detachedBounds
      : sideDock
        ? { width, minWidth: width, maxWidth: width, flex: `0 0 ${width}px` }
        : { height, minHeight: height, maxHeight: height, flex: `0 0 ${height}px` };

  return (
    <section
      className={cn(
        "flex min-h-0 shrink-0 flex-col overflow-hidden border-border bg-card",
        embedded
          ? "relative border-t"
          : popout
          ? "h-screen border-0"
          : floating
            ? "fixed z-40 rounded-md border shadow-2xl"
            : terminalDock === "left"
              ? "relative h-full border-r"
              : terminalDock === "right"
                ? "relative h-full border-l"
                : "relative border-t"
      )}
      style={panelStyle}
    >
      {!embedded && !popout && terminalDock === "bottom" && (
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
        <Button variant="outline" size={showMenuText ? "sm" : "icon"} className={showMenuText ? undefined : "h-8 w-8"} onClick={() => startTerminal()} disabled={!projects.length && !selectedProjectId} title="New terminal">
          <Plus className="h-4 w-4" />
          {showMenuText && "New"}
        </Button>
        <Button variant="outline" size={showMenuText ? "sm" : "icon"} className={showMenuText ? undefined : "h-8 w-8"} onClick={splitTerminal} disabled={!projects.length && !selectedProjectId} title="Split terminal">
          <Columns2 className="h-4 w-4" />
          {showMenuText && "Split"}
        </Button>
        <Button
          variant="outline"
          size={showMenuText ? "sm" : "icon"}
          className={showMenuText ? undefined : "h-8 w-8"}
          onClick={() => session && sendCommand({ type: "terminalClear", id: session.id })}
          disabled={!session}
          title="Clear terminal output"
        >
          <Trash2 className="h-4 w-4" />
          {showMenuText && "Clear"}
        </Button>
        {!popout && !embedded && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size={showMenuText ? "sm" : "icon"} className={showMenuText ? "gap-1 px-2" : "h-8 w-8"} title={`Terminal: ${terminalDockOption.label}`}>
                <CurrentDockIcon className="h-4 w-4" />
                {showMenuText && (
                  <>
                    Dock
                    <ChevronDown className="h-4 w-4" />
                  </>
                )}
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
          <Button
            variant="outline"
            size={showMenuText ? "sm" : "icon"}
            className={showMenuText ? "gap-1 px-2" : "h-8 w-8"}
            onClick={dockPopout}
            title="Return terminal to the docked panel"
          >
            <PopoutDockIcon className="h-4 w-4" />
            {showMenuText && "Dock"}
          </Button>
        )}
        {popout ? (
          <Button
            variant="ghost"
            size={showMenuText ? "sm" : "icon"}
            className={showMenuText ? "gap-1 px-2" : "h-8 w-8"}
            onClick={hideTerminalPanel}
            title="Hide terminal"
          >
            <X className="h-4 w-4" />
            {showMenuText && "Hide"}
          </Button>
        ) : embedded ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={hideTerminalPanel}
            title="Hide terminal"
          >
            <X className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" onClick={hideTerminalPanel} title="Hide terminal">
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-2 bg-zinc-950 p-2",
          sideDock || visibleSessions.length <= 1 ? "grid-cols-1" : visibleSessions.length === 2 ? "grid-cols-2" : "grid-cols-2"
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
  const line = lastActive ? latestTerminalLine(outputById[lastActive.id] || []) : undefined;
  if (!lastActive) return null;
  const terminalLabel = lastActive.title || lastActive.projectName || "Shell";

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
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-[#e5e5e5]">
        {line?.text ? (
          <>
            <span className="text-emerald-200/85">{terminalLabel}: </span>
            {line.segments.map((segment, index) => (
              <span key={`${index}-${segment.text}`} style={segment.style}>
                {segment.text}
              </span>
            ))}
          </>
        ) : (
          lastActive.cwd
        )}
      </span>
    </button>
  );
}

function ErrorStack() {
  const errors = useAppStore((state) => state.errors);
  const dismissError = useAppStore((state) => state.dismissError);
  if (errors.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 grid max-h-[min(60vh,28rem)] max-w-[calc(100vw-2rem)] justify-items-end gap-2 overflow-y-auto overflow-x-hidden">
      {errors.map((error, index) => (
        <div
          key={`${error}-${index}`}
          className="inline-flex w-fit max-w-[min(34rem,calc(100vw-2rem))] min-w-0 items-start gap-2 overflow-x-hidden rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm text-red-800 shadow-lg backdrop-blur dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-100"
        >
          <span className="max-h-36 min-w-0 max-w-[min(28rem,calc(100vw-5rem))] overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {error}
          </span>
          <button
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-red-800/80 hover:bg-red-500/15 hover:text-red-900 dark:text-red-100/80 dark:hover:bg-red-500/20 dark:hover:text-red-100"
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

function serverStartupErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|load failed|networkerror/i.test(message)) return "The AgentControl server is not responding.";
  return message || "The AgentControl server is not responding.";
}

function ServerOfflinePage({ error, onRetry }: { error?: string; onRetry: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <main className="w-full max-w-2xl rounded-md border border-border bg-card p-6 shadow-lg">
        <div className="mb-5 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
            <Bot className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Start AgentControl</h1>
            <p className="text-sm text-muted-foreground">The web app is loaded, but the local server is not reachable.</p>
          </div>
        </div>

        {error && (
          <p className="mb-4 rounded-md border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="grid gap-3 text-sm">
          <p>If this web page is already open and only the API server is missing, start the backend:</p>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs">npm run dev -w server</pre>
          <p>To start the full dev stack from the project folder:</p>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs">npm run dev</pre>
          <p>For restart/shutdown controls inside the app, start supervised mode:</p>
          <pre className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs">npm run dev:supervised</pre>
          <p className="text-muted-foreground">
            The API should be available at <span className="font-mono">http://127.0.0.1:4317</span>. The web UI normally runs at{" "}
            <span className="font-mono">http://127.0.0.1:4318</span>.
          </p>
        </div>

        <div className="mt-6 flex justify-end">
          <Button onClick={onRetry}>
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      </main>
    </div>
  );
}

export function App() {
  const setProjects = useAppStore((state) => state.setProjects);
  const setCapabilities = useAppStore((state) => state.setCapabilities);
  const setSettings = useAppStore((state) => state.setSettings);
  const projects = useAppStore((state) => state.projects);
  const openLaunchModal = useAppStore((state) => state.openLaunchModal);
  const selectedAgentId = useAppStore((state) => state.selectedAgentId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const setSearchOpen = useAppStore((state) => state.setSearchOpen);
  const setSelectedAgent = useAppStore((state) => state.setSelectedAgent);
  const setActiveTerminal = useAppStore((state) => state.setActiveTerminal);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const terminalSessions = useAppStore((state) => state.terminalSessions);
  const activeTerminalId = useAppStore((state) => state.activeTerminalId);
  const terminalDock = useAppStore((state) => state.settings.terminalDock);
  const fileExplorerOpen = useAppStore((state) => state.fileExplorerOpen);
  const fileExplorerDock = useAppStore((state) => state.settings.fileExplorerDock);
  const terminalInFileExplorer = useAppStore((state) => state.terminalInFileExplorer);
  const agentsById = useAppStore((state) => state.agents);
  const themeMode = useAppStore((state) => state.settings.themeMode);
  const inputNotificationsEnabled = useAppStore((state) => state.settings.inputNotificationsEnabled);
  const [poppedOutTerminalIds, setPoppedOutTerminalIds] = useState(readPoppedOutTerminalIds);
  const [serverStartupError, setServerStartupError] = useState<string | undefined>();
  const [serverRetryCount, setServerRetryCount] = useState(0);
  const inputNotificationStatusRef = useRef<Record<string, RunningAgent["status"]>>({});
  const terminalSideDocked = terminalOpen && !terminalInFileExplorer && (terminalDock === "left" || terminalDock === "right");
  const terminalBottomDocked = terminalOpen && !terminalInFileExplorer && terminalDock === "bottom";
  const fileExplorerSideDocked = fileExplorerOpen && (fileExplorerDock === "left" || fileExplorerDock === "right");
  const fileExplorerBottomDocked = fileExplorerOpen && fileExplorerDock === "bottom";
  const selectedProject = useMemo(() => projects.find((project) => project.id === selectedProjectId) || projects[0], [projects, selectedProjectId]);
  const projectAgents = useMemo(() => agentsForProject(agentsById, selectedProjectId), [agentsById, selectedProjectId]);
  const [topBarDocked, setTopBarDockedState] = useState(() => window.localStorage.getItem("agent-control-top-bar-docked") === "true");
  useThemeMode(themeMode);

  function setTopBarDocked(value: boolean) {
    setTopBarDockedState(value);
    window.localStorage.setItem("agent-control-top-bar-docked", String(value));
  }

  const updatePoppedOutTerminalIds = useCallback((updater: (ids: Set<string>) => Set<string>) => {
    setPoppedOutTerminalIds((current) => {
      const next = updater(new Set(current));
      writePoppedOutTerminalIds(next);
      return next;
    });
  }, []);

  const openTerminalPopout = useCallback(
    (terminalId: string) => {
      updatePoppedOutTerminalIds((ids) => {
        ids.add(terminalId);
        return ids;
      });
      setActiveTerminal(terminalId);
      const params = new URLSearchParams();
      if (selectedProjectId) params.set("projectId", selectedProjectId);
      params.set("terminalId", terminalId);
      const popup = window.open(`/terminal-popout?${params.toString()}`, `agent-control-terminal-${terminalId}`, "popup,width=1100,height=720");
      if (!popup) {
        updatePoppedOutTerminalIds((ids) => {
          ids.delete(terminalId);
          return ids;
        });
      }
    },
    [selectedProjectId, setActiveTerminal, updatePoppedOutTerminalIds]
  );

  const dockTerminal = useCallback(
    (request: { terminalId?: string; dock?: boolean; hide?: boolean; nextDock?: "left" | "bottom" | "right" }) => {
      const terminalId = request.terminalId;
      if (terminalId) {
        updatePoppedOutTerminalIds((ids) => {
          ids.delete(terminalId);
          return ids;
        });
        setActiveTerminal(terminalId);
      }
      if (request.nextDock) setSettings({ ...useAppStore.getState().settings, terminalDock: request.nextDock });
      setTerminalOpen(request.hide ? false : request.dock || useAppStore.getState().settings.terminalDock !== "float");
      window.focus();
    },
    [setActiveTerminal, setSettings, setTerminalOpen, updatePoppedOutTerminalIds]
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.projects(), api.capabilities(), api.settings()])
      .then(([projects, capabilities, settings]) => {
        if (cancelled) return;
        setProjects(projects);
        setCapabilities(capabilities);
        setSettings(settings);
        setServerStartupError(undefined);
        connectWebSocket();
      })
      .catch((error: unknown) => {
        if (!cancelled) setServerStartupError(serverStartupErrorMessage(error));
      });
    return () => {
      cancelled = true;
      disconnectWebSocket();
    };
  }, [serverRetryCount, setCapabilities, setProjects, setSettings]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; terminalId?: string } | undefined;
      if (data?.type === TERMINAL_DOCK_MESSAGE) dockTerminal(data);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === TERMINAL_DOCK_STORAGE_KEY) dockTerminal(readTerminalDockRequest(event.newValue));
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
    if (!terminalOpen || terminalDock !== "float") return;
    const projectSessions = terminalsForProject(terminalSessions, selectedProjectId).filter((session) => !poppedOutTerminalIds.has(session.id));
    const activeSession = activeTerminalId ? projectSessions.find((session) => session.id === activeTerminalId) : undefined;
    const session = activeSession || projectSessions[projectSessions.length - 1];
    if (!session) return;
    openTerminalPopout(session.id);
    setTerminalOpen(false);
  }, [activeTerminalId, openTerminalPopout, poppedOutTerminalIds, selectedProjectId, setTerminalOpen, terminalDock, terminalOpen, terminalSessions]);

  useEffect(() => {
    if (!inputNotificationsEnabled || typeof Notification === "undefined" || Notification.permission !== "granted") {
      inputNotificationStatusRef.current = {};
      return;
    }
    const nextStatuses: Record<string, RunningAgent["status"]> = {};
    for (const agent of Object.values(agentsById)) {
      if (!agentNeedsInput(agent)) continue;
      nextStatuses[agent.id] = agent.status;
      if (inputNotificationStatusRef.current[agent.id] === agent.status) continue;
      const projectName = agent.projectName || "Project";
      const title = agent.status === "awaiting-permission" ? `${projectName}: approval needed` : `${projectName}: answer needed`;
      const notification = new Notification(title, {
        body: agent.displayName,
        tag: `agent-control-input-${agent.id}`
      });
      notification.onclick = () => {
        const store = useAppStore.getState();
        window.focus();
        store.setSelectedAgent(undefined);
        store.setSelectedProject(agent.projectId);
        store.setTileMinimized(agent.id, false);
        store.setFocusedAgent(agent.id);
        notification.close();
      };
    }
    inputNotificationStatusRef.current = nextStatuses;
  }, [agentsById, inputNotificationsEnabled]);

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

  if (serverStartupError) {
    return <ServerOfflinePage error={serverStartupError} onRetry={() => setServerRetryCount((count) => count + 1)} />;
  }

  return (
    <div className="flex h-screen min-w-[900px] flex-col overflow-hidden bg-background text-foreground">
      {topBarDocked ? (
        <div className="flex min-h-0 flex-1">
          <Sidebar topSlot={<Header docked onUndock={() => setTopBarDocked(false)} />} />
          {terminalSideDocked && terminalDock === "left" && (
            <TerminalPanel poppedOutTerminalIds={poppedOutTerminalIds} />
          )}
          {fileExplorerSideDocked && fileExplorerDock === "left" && (
            <FileExplorerDockPanel project={selectedProject} agents={projectAgents} dock={fileExplorerDock} poppedOutTerminalIds={poppedOutTerminalIds} />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <WorktreeTabs />
            <div className="flex min-h-0 flex-1">
              <AgentPanel />
              {fileExplorerSideDocked && fileExplorerDock === "right" && (
                <FileExplorerDockPanel project={selectedProject} agents={projectAgents} dock={fileExplorerDock} poppedOutTerminalIds={poppedOutTerminalIds} />
              )}
              {terminalSideDocked && terminalDock === "right" && (
                <TerminalPanel poppedOutTerminalIds={poppedOutTerminalIds} />
              )}
            </div>
          </div>
        </div>
      ) : (
        <>
          <Header onDock={() => setTopBarDocked(true)} />
          <WorktreeTabs />
          <div className="flex min-h-0 flex-1">
            <Sidebar />
            {terminalSideDocked && terminalDock === "left" && (
              <TerminalPanel poppedOutTerminalIds={poppedOutTerminalIds} />
            )}
            {fileExplorerSideDocked && fileExplorerDock === "left" && (
              <FileExplorerDockPanel project={selectedProject} agents={projectAgents} dock={fileExplorerDock} poppedOutTerminalIds={poppedOutTerminalIds} />
            )}
            <AgentPanel />
            {fileExplorerSideDocked && fileExplorerDock === "right" && (
              <FileExplorerDockPanel project={selectedProject} agents={projectAgents} dock={fileExplorerDock} poppedOutTerminalIds={poppedOutTerminalIds} />
            )}
            {terminalSideDocked && terminalDock === "right" && (
              <TerminalPanel poppedOutTerminalIds={poppedOutTerminalIds} />
            )}
          </div>
        </>
      )}
      {fileExplorerBottomDocked && (
        <FileExplorerDockPanel project={selectedProject} agents={projectAgents} dock={fileExplorerDock} poppedOutTerminalIds={poppedOutTerminalIds} />
      )}
      {terminalBottomDocked && <TerminalPanel poppedOutTerminalIds={poppedOutTerminalIds} />}
      {!terminalOpen && !terminalInFileExplorer && <TerminalMinimizedDock poppedOutTerminalIds={poppedOutTerminalIds} />}
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
    window.sessionStorage.removeItem(TERMINAL_POPOUT_EXPLICIT_HIDE_STORAGE_KEY);
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
    const onBeforeUnload = () => {
      if (window.sessionStorage.getItem(TERMINAL_POPOUT_EXPLICIT_HIDE_STORAGE_KEY) === "true") return;
      notifyTerminalDock(requestedTerminalId);
    };
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

export function FileExplorerPopoutApp() {
  const setProjects = useAppStore((state) => state.setProjects);
  const setCapabilities = useAppStore((state) => state.setCapabilities);
  const setSettings = useAppStore((state) => state.setSettings);
  const setSelectedProject = useAppStore((state) => state.setSelectedProject);
  const projects = useAppStore((state) => state.projects);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const agentsById = useAppStore((state) => state.agents);
  const addError = useAppStore((state) => state.addError);
  const themeMode = useAppStore((state) => state.settings.themeMode);
  const params = new URLSearchParams(window.location.search);
  const requestedProjectId = params.get("projectId") || undefined;
  useThemeMode(themeMode);

  useEffect(() => {
    void Promise.all([api.projects(), api.capabilities(), api.settings()])
      .then(([nextProjects, capabilities, settings]) => {
        setProjects(nextProjects);
        setCapabilities(capabilities);
        setSettings(settings);
        if (requestedProjectId && nextProjects.some((project) => project.id === requestedProjectId)) {
          setSelectedProject(requestedProjectId);
        } else if (nextProjects[0]) {
          setSelectedProject(nextProjects[0].id);
        }
      })
      .catch((error: unknown) => addError(error instanceof Error ? error.message : String(error)));
    connectWebSocket();
    return () => disconnectWebSocket();
  }, [addError, requestedProjectId, setCapabilities, setProjects, setSelectedProject, setSettings]);

  const project = projects.find((candidate) => candidate.id === selectedProjectId) || projects[0];
  const agents = useMemo(() => agentsForProject(agentsById, selectedProjectId), [agentsById, selectedProjectId]);

  return (
    <div className="h-screen overflow-hidden bg-background p-3 text-foreground">
      {project ? (
        <ProjectInspectorTile project={project} agents={agents} fill defaultWidth="100%" onClose={() => window.close()} />
      ) : (
        <div className="grid h-full place-items-center text-sm text-muted-foreground">No project open.</div>
      )}
      <ErrorStack />
    </div>
  );
}
