import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentPermissionMode, AutoApproveMode, ModelProfile } from "@agent-control/shared";

export const DEFAULT_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5"
];

export const DEFAULT_MODEL_PROFILES: ModelProfile[] = [
  { id: "claude-opus-4-7", provider: "claude", default: false, supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-4-6", provider: "claude", supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-4-6", provider: "claude", default: true, supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-4-5", provider: "claude", supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
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
];

export interface DashboardConfig {
  projectsRoot?: string;
  projectPaths?: string[];
  models?: string[];
  modelProfiles?: ModelProfile[];
  gitPath?: string;
  claudePath?: string;
  claudeRuntime?: ClaudeRuntime;
  codexPath?: string;
  claudeAgentDir?: string;
  codexAgentDir?: string;
  openaiAgentDir?: string;
  builtInAgentDir?: string;
  autoApprove?: AutoApproveMode;
  defaultAgentMode?: AgentPermissionMode;
  tileHeight?: number;
  tileColumns?: number;
  sidebarWidth?: number;
  pinLastSentMessage?: boolean;
  terminalDock?: TerminalDockPosition;
  themeMode?: ThemeMode;
}

export type TerminalDockPosition = "float" | "left" | "bottom" | "right";
export type ThemeMode = "auto" | "light" | "dark";
export type ClaudeRuntime = "cli" | "api";

const configDir = path.join(os.homedir(), ".agent-dashboard");
const configPath = path.join(configDir, "config.json");
const secretsPath = path.join(configDir, "secrets.json");
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_BUILT_IN_AGENT_DIR = path.join(APP_ROOT, ".agent-control", "built-in-agents");
const LEGACY_BUILT_IN_AGENT_DIR = "~/.agent-control/built-in-agents";
const LEGACY_REPO_RELATIVE_BUILT_IN_AGENT_DIR = ".agent-control/built-in-agents";

export interface DashboardSecrets {
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export async function readConfig(): Promise<DashboardConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as DashboardConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(config: DashboardConfig): Promise<DashboardConfig> {
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export async function readSecrets(): Promise<DashboardSecrets> {
  try {
    const raw = await readFile(secretsPath, "utf8");
    return JSON.parse(raw) as DashboardSecrets;
  } catch {
    return {};
  }
}

export async function writeSecrets(secrets: DashboardSecrets): Promise<DashboardSecrets> {
  await mkdir(configDir, { recursive: true });
  await writeFile(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return secrets;
}

export function resolveProjectsRoot(config: DashboardConfig): string {
  return path.resolve(expandHome(config.projectsRoot || process.env.PROJECTS_ROOT || "~/projects"));
}

export function resolveModels(config: DashboardConfig): string[] {
  const models = config.models?.map((model) => model.trim()).filter(Boolean);
  return models?.length ? models : DEFAULT_MODELS;
}

export function resolveModelProfiles(config: DashboardConfig): ModelProfile[] {
  const profiles = Array.isArray(config.modelProfiles)
    ? config.modelProfiles
        .filter((profile): profile is ModelProfile =>
          Boolean(profile) &&
          typeof profile.id === "string" &&
          profile.id.trim().length > 0 &&
          (profile.provider === "claude" || profile.provider === "codex" || profile.provider === "openai")
        )
        .map((profile) => ({ ...profile, id: profile.id.trim(), label: profile.label?.trim() || undefined }))
    : [];
  if (profiles.length) return profiles;
  if (!config.models?.length) return DEFAULT_MODEL_PROFILES;
  return resolveModels(config).map((model, index) => ({
    id: model,
    provider: "claude",
    default: index === 0,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"]
  }));
}

export function resolveAgentDirs(config: DashboardConfig): Record<"claude" | "codex" | "openai" | "builtIn", string> {
  const builtInAgentDir = config.builtInAgentDir?.trim();
  const useDefaultBuiltInDir =
    !builtInAgentDir ||
    builtInAgentDir === LEGACY_BUILT_IN_AGENT_DIR ||
    builtInAgentDir === LEGACY_REPO_RELATIVE_BUILT_IN_AGENT_DIR;
  return {
    claude: config.claudeAgentDir?.trim() || ".claude/agents",
    codex: config.codexAgentDir?.trim() || ".codex/agents",
    openai: config.openaiAgentDir?.trim() || ".agent-control/openai-agents",
    builtIn: useDefaultBuiltInDir ? DEFAULT_BUILT_IN_AGENT_DIR : builtInAgentDir
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function resolveTileHeight(config: DashboardConfig): number {
  return clampNumber(config.tileHeight, 460, 320, 760);
}

export function resolveTileColumns(config: DashboardConfig): number {
  return clampNumber(config.tileColumns, 2, 1, 6);
}

export function resolveSidebarWidth(config: DashboardConfig): number {
  return clampNumber(config.sidebarWidth, 280, 240, 420);
}

export function resolvePinLastSentMessage(config: DashboardConfig): boolean {
  return config.pinLastSentMessage !== false;
}

export function resolveDefaultAgentMode(config: DashboardConfig): AgentPermissionMode {
  return config.defaultAgentMode === "default" ||
    config.defaultAgentMode === "acceptEdits" ||
    config.defaultAgentMode === "plan" ||
    config.defaultAgentMode === "bypassPermissions"
    ? config.defaultAgentMode
    : "acceptEdits";
}

export function resolveClaudeRuntime(config: DashboardConfig): ClaudeRuntime {
  return config.claudeRuntime === "api" ? "api" : "cli";
}

export function resolveTerminalDock(config: DashboardConfig): TerminalDockPosition {
  return config.terminalDock === "float" ||
    config.terminalDock === "left" ||
    config.terminalDock === "right" ||
    config.terminalDock === "bottom"
    ? config.terminalDock
    : "bottom";
}

export function resolveThemeMode(config: DashboardConfig): ThemeMode {
  return config.themeMode === "light" || config.themeMode === "dark" || config.themeMode === "auto" ? config.themeMode : "auto";
}
